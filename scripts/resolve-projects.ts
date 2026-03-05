#!/usr/bin/env npx tsx
/**
 * Resolve project_id for commits using a cascade:
 *   1. Jira epic mapping     (epic_key → project_id)
 *   2. Jira project mapping  (jira_project_key → project_id)
 *   3. Message prefix        (commit message prefix → project_id)
 *   4. Repository default    (repository_id → project_id)
 *
 * Usage:
 *   pnpm resolve-projects           # only unresolved commits (project_id IS NULL)
 *   pnpm resolve-projects --force   # re-resolve all commits
 *
 * Requires TURSO_URL (and optionally TURSO_TOKEN) environment variables.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { query, execute, transaction } from '@/lib/db';
import {
  resolveProjectForCommit,
  type MappingContext,
  type JiraIssueInfo,
} from './lib/resolution-utils';

const BATCH_SIZE = 100;

interface CommitRow {
  id: number;
  repository_id: number;
  message: string;
}

interface TicketRow {
  commit_id: number;
  jira_ticket_id: string;
}

/** Load all mapping tables into memory */
async function loadMappings(): Promise<{
  epicMappings: Map<string, number>;
  projectMappings: Map<string, number>;
  prefixMappings: Map<string, number>;
  repoDefaults: Map<number, number>;
}> {
  const [epicRows, projRows, prefixRows, repoRows] = await Promise.all([
    query<{ epic_key: string; project_id: number }>(
      'SELECT epic_key, project_id FROM jira_epic_mappings',
    ),
    query<{ jira_project_key: string; project_id: number }>(
      'SELECT jira_project_key, project_id FROM jira_project_mappings',
    ),
    query<{ prefix: string; project_id: number }>(
      'SELECT prefix, project_id FROM commit_prefix_mappings',
    ),
    query<{ repository_id: number; project_id: number }>(
      'SELECT repository_id, project_id FROM repo_project_defaults',
    ),
  ]);

  return {
    epicMappings: new Map(epicRows.map(r => [r.epic_key, r.project_id])),
    projectMappings: new Map(projRows.map(r => [r.jira_project_key, r.project_id])),
    prefixMappings: new Map(prefixRows.map(r => [r.prefix, r.project_id])),
    repoDefaults: new Map(repoRows.map(r => [r.repository_id, r.project_id])),
  };
}

/** Load jira_issues into a lookup map */
async function loadJiraIssues(): Promise<Map<string, JiraIssueInfo>> {
  const rows = await query<{ key: string; epic_key: string | null; project_key: string }>(
    'SELECT key, epic_key, project_key FROM jira_issues',
  );
  return new Map(rows.map(r => [r.key, { epicKey: r.epic_key, projectKey: r.project_key }]));
}

/** Build a map of commit_id → ticket IDs from the join table */
async function loadTicketAssociations(commitIds: number[]): Promise<Map<number, string[]>> {
  if (commitIds.length === 0) return new Map();

  const placeholders = commitIds.map(() => '?').join(',');
  const rows = await query<TicketRow>(
    `SELECT commit_id, jira_ticket_id FROM commit_jira_tickets WHERE commit_id IN (${placeholders})`,
    commitIds,
  );

  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.commit_id) ?? [];
    list.push(row.jira_ticket_id);
    map.set(row.commit_id, list);
  }
  return map;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  console.log('Loading mapping tables...');
  const { epicMappings, projectMappings, prefixMappings, repoDefaults } = await loadMappings();
  console.log(
    `  Epic mappings: ${epicMappings.size}, Project mappings: ${projectMappings.size}, Prefix mappings: ${prefixMappings.size}, Repo defaults: ${repoDefaults.size}`,
  );

  console.log('Loading Jira issues...');
  const jiraIssues = await loadJiraIssues();
  console.log(`  Jira issues: ${jiraIssues.size}`);

  const ctx: MappingContext = { jiraIssues, epicMappings, projectMappings, prefixMappings, repoDefaults };

  // Load commits
  const whereClause = force ? '' : 'WHERE project_id IS NULL';
  const commits = await query<CommitRow>(
    `SELECT id, repository_id, message FROM commits ${whereClause} ORDER BY id`,
  );
  console.log(`\nCommits to process: ${commits.length}${force ? ' (--force: all)' : ' (unresolved only)'}`);

  if (commits.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Stats per level
  const stats = { epic: 0, jira_project: 0, message_prefix: 0, repo_default: 0, unallocated: 0, total: 0 };

  // Process in batches
  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(c => c.id);

    // Load ticket associations for this batch
    const ticketMap = await loadTicketAssociations(batchIds);

    await transaction(async (tx) => {
      for (const commit of batch) {
        const ticketIds = ticketMap.get(commit.id) ?? [];
        const result = resolveProjectForCommit(
          { ticketIds, repositoryId: commit.repository_id, message: commit.message },
          ctx,
        );

        stats.total++;

        if (result) {
          stats[result.level]++;
          await tx.execute(
            'UPDATE commits SET project_id = ? WHERE id = ?',
            [result.projectId, commit.id],
          );
        } else {
          stats.unallocated++;
        }
      }
    });

    // Progress log every 10 batches
    if ((i / BATCH_SIZE) % 10 === 0 && i > 0) {
      console.log(`  Processed ${i + batch.length}/${commits.length} commits...`);
    }
  }

  console.log('\nResolution complete:');
  console.log(`  Total:          ${stats.total}`);
  console.log(`  Epic mapping:   ${stats.epic}`);
  console.log(`  Jira project:   ${stats.jira_project}`);
  console.log(`  Message prefix: ${stats.message_prefix}`);
  console.log(`  Repo default:   ${stats.repo_default}`);
  console.log(`  Unallocated:    ${stats.unallocated}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

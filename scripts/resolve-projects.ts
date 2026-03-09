#!/usr/bin/env npx tsx
/**
 * Resolve project_id for commits using a cascade:
 *   1. Jira epic mapping     (epic_key → project_id)
 *   2. Jira project mapping  (jira_project_key → project_id)
 *   3. Branch matching       (branch prefix → project_id)
 *   4. Message prefix        (commit message prefix → project_id)
 *   5. Repository default    (repository_id → project_id)
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
import { runMigrations } from '@/lib/migrate';
import {
  resolveProjectForCommit,
  type MappingContext,
  type JiraIssueInfo,
} from './lib/resolution-utils';

const BATCH_SIZE = 100;
const MIN_MESSAGE_LENGTH = 10;

/**
 * Cherry-pick deduplication (V3b algorithm).
 *
 * Groups commits by (author_email, message prefix). Within each group the
 * commit sitting on the fewest branches is treated as canonical — it landed on
 * the most specific branch first (e.g. RELEASE-6.4) rather than being swept
 * into an integration branch (indx, private) via rebase.
 *
 * Short messages (< MIN_MESSAGE_LENGTH chars) are always canonical to avoid
 * false grouping on "WIP", "fix", etc.
 */
async function markCanonicalCommits(): Promise<void> {
  console.log('\nDeduplication pass (V3b)...');

  // Reset: mark everything canonical first
  await execute('UPDATE commits SET is_canonical = 1');

  // Find duplicate groups: same author + message, multiple SHAs, long enough message
  const groups = await query<{ author_email: string; msg_key: string; cnt: number }>(
    `SELECT author_email, SUBSTR(message, 1, 200) AS msg_key, COUNT(*) AS cnt
     FROM commits
     WHERE LENGTH(TRIM(message)) >= ?
     GROUP BY author_email, SUBSTR(message, 1, 200)
     HAVING cnt > 1`,
    [MIN_MESSAGE_LENGTH],
  );

  console.log(`  Duplicate groups: ${groups.length}`);
  if (groups.length === 0) return;

  let totalMarked = 0;

  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE);

    await transaction(async (tx) => {
      for (const group of batch) {
        // Get all commits in this group with their branch count
        const copies = await tx.query<{ id: number; num_branches: number }>(
          `SELECT c.id, COUNT(cb.branch_name) AS num_branches
           FROM commits c
           LEFT JOIN commit_branches cb ON c.id = cb.commit_id
           WHERE c.author_email = ? AND SUBSTR(c.message, 1, 200) = ?
           GROUP BY c.id
           ORDER BY num_branches ASC, c.id ASC`,
          [group.author_email, group.msg_key],
        );

        // First row (fewest branches, lowest id as tiebreak) is canonical; rest are duplicates
        const dupIds = copies.slice(1).map(c => c.id);
        if (dupIds.length > 0) {
          const placeholders = dupIds.map(() => '?').join(',');
          await tx.execute(
            `UPDATE commits SET is_canonical = 0 WHERE id IN (${placeholders})`,
            dupIds,
          );
          totalMarked += dupIds.length;
        }
      }
    });
  }

  const canonical = await query<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM commits WHERE is_canonical = 1');
  console.log(`  Marked ${totalMarked} commits as non-canonical`);
  console.log(`  Canonical commits: ${canonical[0].cnt} / ${canonical[0].cnt + totalMarked}`);
}

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
  branchMappings: Map<string, number>;
  branchExclusions: string[];
  prefixMappings: Map<string, number>;
  repoDefaults: Map<number, number>;
}> {
  const [epicRows, projRows, branchRows, exclRows, prefixRows, repoRows] = await Promise.all([
    query<{ epic_key: string; project_id: number }>(
      'SELECT epic_key, project_id FROM jira_epic_mappings',
    ),
    query<{ jira_project_key: string; project_id: number }>(
      'SELECT jira_project_key, project_id FROM jira_project_mappings',
    ),
    query<{ prefix: string; project_id: number }>(
      'SELECT prefix, project_id FROM branch_project_mappings',
    ),
    query<{ branch_name: string }>(
      'SELECT branch_name FROM branch_exclusions',
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
    branchMappings: new Map(branchRows.map(r => [r.prefix, r.project_id])),
    branchExclusions: exclRows.map(r => r.branch_name),
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

/** Build a map of commit_id → branch names from the join table */
async function loadBranchAssociations(commitIds: number[]): Promise<Map<number, string[]>> {
  if (commitIds.length === 0) return new Map();

  const placeholders = commitIds.map(() => '?').join(',');
  const rows = await query<{ commit_id: number; branch_name: string }>(
    `SELECT commit_id, branch_name FROM commit_branches WHERE commit_id IN (${placeholders})`,
    commitIds,
  );

  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.commit_id) ?? [];
    list.push(row.branch_name);
    map.set(row.commit_id, list);
  }
  return map;
}

async function main(): Promise<void> {
  await runMigrations();
  const force = process.argv.includes('--force');

  console.log('Loading mapping tables...');
  const { epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults } = await loadMappings();
  console.log(
    `  Epic mappings: ${epicMappings.size}, Project mappings: ${projectMappings.size}, Branch mappings: ${branchMappings.size}, Branch exclusions: ${branchExclusions.length}, Prefix mappings: ${prefixMappings.size}, Repo defaults: ${repoDefaults.size}`,
  );

  console.log('Loading Jira issues...');
  const jiraIssues = await loadJiraIssues();
  console.log(`  Jira issues: ${jiraIssues.size}`);

  const ctx: MappingContext = { jiraIssues, epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults };

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
  const stats = { epic: 0, jira_project: 0, branch_match: 0, message_prefix: 0, repo_default: 0, unallocated: 0, total: 0 };

  // Process in batches
  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(c => c.id);

    // Load ticket and branch associations for this batch
    const [ticketMap, branchMap] = await Promise.all([
      loadTicketAssociations(batchIds),
      loadBranchAssociations(batchIds),
    ]);

    await transaction(async (tx) => {
      for (const commit of batch) {
        const ticketIds = ticketMap.get(commit.id) ?? [];
        const branchNames = branchMap.get(commit.id) ?? [];
        const result = resolveProjectForCommit(
          { ticketIds, repositoryId: commit.repository_id, message: commit.message, branchNames },
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
  console.log(`  Branch match:   ${stats.branch_match}`);
  console.log(`  Message prefix: ${stats.message_prefix}`);
  console.log(`  Repo default:   ${stats.repo_default}`);
  console.log(`  Unallocated:    ${stats.unallocated}`);

  // Deduplication pass — mark cherry-pick duplicates as non-canonical
  await markCanonicalCommits();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

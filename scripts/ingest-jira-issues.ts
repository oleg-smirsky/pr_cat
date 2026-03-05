#!/usr/bin/env npx tsx
/**
 * Ingest cached Jira issues into the database.
 *
 * Reads all .cache/jira/*.json files, parses them, resolves epic_key
 * by traversing parent chains, and inserts into the jira_issues table.
 *
 * Usage:
 *   pnpm ingest-jira-issues
 *
 * Requires TURSO_URL (and optionally TURSO_TOKEN) in .env.local
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execute, transaction } from '@/lib/db';
import { runMigrations } from '@/lib/migrate';
import { parseJiraIssue, type ParsedJiraIssue } from './lib/jira-utils';

const JIRA_CACHE_DIR = path.join(process.cwd(), '.cache', 'jira');
const BATCH_SIZE = 100;

/** Read and parse all Jira issue JSON files from cache */
function readCachedIssues(): ParsedJiraIssue[] {
  if (!fs.existsSync(JIRA_CACHE_DIR)) {
    console.warn(`No Jira cache directory found: ${JIRA_CACHE_DIR}`);
    return [];
  }

  const files = fs.readdirSync(JIRA_CACHE_DIR).filter(f => f.endsWith('.json'));
  const issues: ParsedJiraIssue[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(JIRA_CACHE_DIR, file), 'utf-8');
      const parsed = parseJiraIssue(JSON.parse(raw));
      issues.push(parsed);
    } catch (err) {
      console.warn(`Skipping malformed cache file: ${file} (${err})`);
    }
  }

  return issues;
}

/**
 * Build a map of issue key -> ParsedJiraIssue for parent chain lookups,
 * then resolve epic_key for each issue:
 *   - If issue has epicLinkKey -> use it directly
 *   - If issue has parentKey -> look up parent's epicLinkKey
 *   - Otherwise -> null
 */
function resolveEpicKeys(issues: ParsedJiraIssue[]): Map<string, string | null> {
  const issueMap = new Map<string, ParsedJiraIssue>();
  for (const issue of issues) {
    issueMap.set(issue.key, issue);
  }

  const epicKeys = new Map<string, string | null>();

  for (const issue of issues) {
    if (issue.epicLinkKey) {
      epicKeys.set(issue.key, issue.epicLinkKey);
    } else if (issue.parentKey) {
      const parent = issueMap.get(issue.parentKey);
      epicKeys.set(issue.key, parent?.epicLinkKey ?? null);
    } else {
      epicKeys.set(issue.key, null);
    }
  }

  return epicKeys;
}

async function main(): Promise<void> {
  // Run migrations to ensure jira_issues table exists
  await runMigrations();

  const issues = readCachedIssues();

  if (issues.length === 0) {
    console.log('No cached Jira issues found. Nothing to ingest.');
    return;
  }

  console.log(`Found ${issues.length} cached Jira issues.`);

  // Resolve epic keys via parent chain traversal
  const epicKeys = resolveEpicKeys(issues);

  // Log stats by type
  const typeCounts = new Map<string, number>();
  for (const issue of issues) {
    typeCounts.set(issue.issueType, (typeCounts.get(issue.issueType) ?? 0) + 1);
  }
  console.log('\nIssue types:');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Epic coverage
  let withEpic = 0;
  for (const ek of epicKeys.values()) {
    if (ek) withEpic++;
  }
  const coveragePct = ((withEpic / issues.length) * 100).toFixed(1);
  console.log(`\nEpic coverage: ${withEpic}/${issues.length} (${coveragePct}%)`);

  // Insert in batches
  const now = new Date().toISOString();
  let inserted = 0;

  for (let i = 0; i < issues.length; i += BATCH_SIZE) {
    const batch = issues.slice(i, i + BATCH_SIZE);

    await transaction(async (tx) => {
      for (const issue of batch) {
        const epicKey = epicKeys.get(issue.key) ?? null;

        await tx.execute(
          `INSERT OR REPLACE INTO jira_issues
            (key, project_key, summary, issue_type, parent_key, epic_key,
             status, fix_versions, labels, components, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            issue.key,
            issue.projectKey,
            issue.summary,
            issue.issueType,
            issue.parentKey,
            epicKey,
            issue.status,
            JSON.stringify(issue.fixVersions),
            JSON.stringify(issue.labels),
            JSON.stringify(issue.components),
            now,
          ],
        );

        inserted++;
      }
    });

    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted ${batch.length} issues`);
  }

  console.log(`\nDone. ${inserted} issues ingested into jira_issues table.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * Ingest cached GitHub commits into the database.
 *
 * Reads commit JSON files from .cache/github/{owner}/{repo}/commits/
 * and branch lists from .cache/github/{owner}/{repo}/commit-list/,
 * then inserts them into the commits and commit_branches tables.
 *
 * Usage:
 *   pnpm ingest-commits --repos owner/repo1,owner/repo2
 *
 * Requires TURSO_URL (and optionally TURSO_TOKEN) environment variables.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs, parseRepoSlug, getRepoCacheDir } from './lib/cache-utils';
import {
  parseCommitForIngestion,
  unsanitizeBranchName,
  type CachedCommitData,
} from './lib/commit-utils';
import { query, execute, transaction } from '@/lib/db';
import { runMigrations } from '@/lib/migrate';

const BATCH_SIZE = 100;

interface IngestStats {
  inserted: number;
  skipped: number;
  unresolvedAuthors: number;
}

type TxClient = { query: typeof query; execute: typeof execute };

/** Resolve author_id by GitHub ID or email, creating a user if needed */
async function resolveAuthorId(
  tx: TxClient,
  githubAuthorId: string | null,
  githubAuthorLogin: string | null,
  authorEmail: string,
  authorName: string,
): Promise<string | null> {
  // Try GitHub numeric ID first (stored as string in users.id)
  if (githubAuthorId) {
    const rows = await tx.query<{ id: string }>(
      'SELECT id FROM users WHERE id = ?',
      [githubAuthorId],
    );
    if (rows.length > 0) {
      return rows[0].id;
    }
  }

  // Fallback: match by email
  const rows = await tx.query<{ id: string }>(
    'SELECT id FROM users WHERE email = ?',
    [authorEmail],
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  // No match — create a new user from commit data
  if (githubAuthorId) {
    await tx.execute(
      'INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)',
      [githubAuthorId, githubAuthorLogin ?? authorName, authorEmail],
    );
    return githubAuthorId;
  }

  return null;
}

/** Read and parse all commit JSON files from the cache directory */
function readCachedCommits(owner: string, repo: string): CachedCommitData[] {
  const commitsDir = path.join(getRepoCacheDir(owner, repo), 'commits');

  if (!fs.existsSync(commitsDir)) {
    console.warn(`  No commits cache directory found: ${commitsDir}`);
    return [];
  }

  const files = fs.readdirSync(commitsDir).filter(f => f.endsWith('.json'));
  const commits: CachedCommitData[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(commitsDir, file), 'utf-8');
      commits.push(JSON.parse(raw) as CachedCommitData);
    } catch (err) {
      console.warn(`  Skipping malformed cache file: ${file} (${err})`);
    }
  }

  return commits;
}

/** Ingest commits for a single repository */
async function ingestRepoCommits(
  slug: string,
  repositoryId: number,
  owner: string,
  repo: string,
): Promise<IngestStats> {
  const stats: IngestStats = { inserted: 0, skipped: 0, unresolvedAuthors: 0 };
  const cachedCommits = readCachedCommits(owner, repo);

  if (cachedCommits.length === 0) {
    console.log(`  [${slug}] No cached commits found.`);
    return stats;
  }

  console.log(`  [${slug}] Processing ${cachedCommits.length} cached commits...`);

  // Process in batches
  for (let i = 0; i < cachedCommits.length; i += BATCH_SIZE) {
    const batch = cachedCommits.slice(i, i + BATCH_SIZE);

    await transaction(async (tx) => {
      for (const raw of batch) {
        const parsed = parseCommitForIngestion(raw);
        const authorId = await resolveAuthorId(tx, parsed.githubAuthorId, parsed.githubAuthorLogin, parsed.authorEmail, parsed.authorName);

        if (!authorId) {
          stats.unresolvedAuthors++;
        }

        const result = await tx.execute(
          `INSERT OR IGNORE INTO commits
            (sha, repository_id, author_id, author_email, author_name,
             message, committed_at, additions, deletions, jira_ticket_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.sha,
            repositoryId,
            authorId,
            parsed.authorEmail,
            parsed.authorName,
            parsed.message,
            parsed.committedAt,
            parsed.additions,
            parsed.deletions,
            parsed.jiraTicketId,
          ],
        );

        if (result.rowsAffected > 0) {
          stats.inserted++;
        } else if (authorId) {
          // Backfill author_id on existing commits that were missing it
          await tx.execute(
            'UPDATE commits SET author_id = ? WHERE sha = ? AND repository_id = ? AND author_id IS NULL',
            [authorId, parsed.sha, repositoryId],
          );
        } else {
          stats.skipped++;
        }

        // Insert into commit_jira_tickets join table
        if (parsed.jiraTicketIds.length > 0) {
          const commitRows = await tx.query<{ id: number }>(
            'SELECT id FROM commits WHERE sha = ? AND repository_id = ?',
            [parsed.sha, repositoryId],
          );

          if (commitRows.length > 0) {
            const commitId = commitRows[0].id;
            for (const ticketId of parsed.jiraTicketIds) {
              await tx.execute(
                'INSERT OR IGNORE INTO commit_jira_tickets (commit_id, jira_ticket_id) VALUES (?, ?)',
                [commitId, ticketId],
              );
            }
          }
        }
      }
    });
  }

  return stats;
}

/** Ingest branch→commit mappings for a single repository */
async function ingestRepoBranches(
  slug: string,
  repositoryId: number,
  owner: string,
  repo: string,
): Promise<{ branchesProcessed: number; linksInserted: number }> {
  const commitListDir = path.join(getRepoCacheDir(owner, repo), 'commit-list');
  let branchesProcessed = 0;
  let linksInserted = 0;

  if (!fs.existsSync(commitListDir)) {
    console.log(`  [${slug}] No commit-list cache directory found.`);
    return { branchesProcessed, linksInserted };
  }

  const files = fs.readdirSync(commitListDir).filter(f => f.endsWith('.json'));
  console.log(`  [${slug}] Processing ${files.length} branch commit lists...`);

  for (const file of files) {
    const branchName = unsanitizeBranchName(file);
    let shas: string[];

    try {
      const raw = fs.readFileSync(path.join(commitListDir, file), 'utf-8');
      shas = JSON.parse(raw) as string[];
    } catch (err) {
      console.warn(`  Skipping malformed branch list: ${file} (${err})`);
      continue;
    }

    // Process SHAs in batches
    for (let i = 0; i < shas.length; i += BATCH_SIZE) {
      const batch = shas.slice(i, i + BATCH_SIZE);

      await transaction(async (tx) => {
        for (const sha of batch) {
          const rows = await tx.query<{ id: number }>(
            'SELECT id FROM commits WHERE sha = ? AND repository_id = ?',
            [sha, repositoryId],
          );

          if (rows.length === 0) {
            continue; // Commit not in DB yet — skip
          }

          const result = await tx.execute(
            'INSERT OR IGNORE INTO commit_branches (commit_id, branch_name) VALUES (?, ?)',
            [rows[0].id, branchName],
          );

          if (result.rowsAffected > 0) {
            linksInserted++;
          }
        }
      });
    }

    branchesProcessed++;
  }

  return { branchesProcessed, linksInserted };
}

async function main(): Promise<void> {
  const { repos } = parseArgs(process.argv.slice(2));

  if (repos.length === 0) {
    console.error('Error: No repos specified. Use --repos owner/repo1,owner/repo2');
    process.exit(1);
  }

  await runMigrations();

  for (const slug of repos) {
    const { owner, repo } = parseRepoSlug(slug);
    console.log(`\n[${slug}] Starting ingest...`);

    // Look up repository_id
    const repoRows = await query<{ id: number }>(
      'SELECT id FROM repositories WHERE full_name = ?',
      [slug],
    );

    if (repoRows.length === 0) {
      console.warn(`[${slug}] Repository not found in database — skipping.`);
      console.warn(`  Hint: Insert the repo first: INSERT INTO repositories (full_name) VALUES ('${slug}')`);
      continue;
    }

    const repositoryId = repoRows[0].id;

    // Ingest commits
    const commitStats = await ingestRepoCommits(slug, repositoryId, owner, repo);
    console.log(
      `[${slug}] Commits: ${commitStats.inserted} new, ${commitStats.skipped} skipped, ${commitStats.unresolvedAuthors} unresolved authors`,
    );

    // Ingest branch mappings
    const branchStats = await ingestRepoBranches(slug, repositoryId, owner, repo);
    console.log(
      `[${slug}] Branches: ${branchStats.branchesProcessed} processed, ${branchStats.linksInserted} links inserted`,
    );
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

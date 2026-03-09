#!/usr/bin/env npx tsx
/**
 * Ingest cached GitHub commits into the database.
 *
 * Reads commit JSON files from .cache/github/{owner}/{repo}/commits/
 * and branch lists from .cache/github/{owner}/{repo}/commit-list/,
 * then inserts them into the commits and commit_branches tables.
 *
 * Automatically discovers fork cache directories (via fork-of.json marker)
 * and attributes their commits to the parent repository.
 *
 * Usage:
 *   pnpm ingest-commits --repos owner/repo1,owner/repo2
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
import { readForkMarker } from './lib/fork-utils';
import { runMigrations } from '@/lib/migrate';

const BATCH_SIZE = 100;
const forceMode = process.argv.includes('--force');

interface IngestStats {
  inserted: number;
  updated: number;
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
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, unresolvedAuthors: 0 };
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
             message, committed_at, additions, deletions)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ],
        );

        if (result.rowsAffected > 0) {
          stats.inserted++;
        } else if (forceMode) {
          // Re-parse: update parsed fields on existing commit
          await tx.execute(
            `UPDATE commits SET
              author_id = COALESCE(?, author_id),
              author_email = ?, author_name = ?,
              message = ?, additions = ?, deletions = ?
            WHERE sha = ? AND repository_id = ?`,
            [
              authorId,
              parsed.authorEmail, parsed.authorName,
              parsed.message, parsed.additions, parsed.deletions,
              parsed.sha, repositoryId,
            ],
          );
          stats.updated++;
        } else if (authorId) {
          // Backfill author_id on existing commits that were missing it
          await tx.execute(
            'UPDATE commits SET author_id = ? WHERE sha = ? AND repository_id = ? AND author_id IS NULL',
            [authorId, parsed.sha, repositoryId],
          );
        } else {
          stats.skipped++;
        }

        // Upsert commit_jira_tickets join table
        const commitRows = await tx.query<{ id: number }>(
          'SELECT id FROM commits WHERE sha = ? AND repository_id = ?',
          [parsed.sha, repositoryId],
        );

        if (commitRows.length > 0) {
          const commitId = commitRows[0].id;

          // In force mode, clear old tickets so re-parsed ones take over
          if (forceMode) {
            await tx.execute(
              'DELETE FROM commit_jira_tickets WHERE commit_id = ?',
              [commitId],
            );
          }

          for (const ticketId of parsed.jiraTicketIds) {
            await tx.execute(
              'INSERT OR IGNORE INTO commit_jira_tickets (commit_id, jira_ticket_id) VALUES (?, ?)',
              [commitId, ticketId],
            );
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

  // Build list of cache dirs to ingest: explicit repos + discovered fork dirs
  interface IngestTarget {
    slug: string;         // cache directory key (e.g., "alice/my-project")
    owner: string;
    repo: string;
    dbSlug: string;       // repository to resolve in DB (parent slug for forks)
  }

  const targets: IngestTarget[] = [];

  for (const slug of repos) {
    const { owner, repo } = parseRepoSlug(slug);
    targets.push({ slug, owner, repo, dbSlug: slug });

    // Check for fork cache directories that reference this parent
    const cacheRoot = path.join(process.cwd(), '.cache', 'github');
    if (!fs.existsSync(cacheRoot)) continue;

    for (const forkOwner of fs.readdirSync(cacheRoot)) {
      if (forkOwner === owner) continue; // Skip parent itself
      const forkCacheDir = path.join(cacheRoot, forkOwner, repo);
      const parentSlug = readForkMarker(forkCacheDir);
      if (parentSlug === slug) {
        targets.push({
          slug: `${forkOwner}/${repo}`,
          owner: forkOwner,
          repo,
          dbSlug: slug, // Attribute to parent repo
        });
      }
    }
  }

  for (const target of targets) {
    const isFork = target.slug !== target.dbSlug;
    const label = isFork ? `${target.slug} → ${target.dbSlug}` : target.slug;
    console.log(`\n[${label}] Starting ingest...`);

    const repoRows = await query<{ id: number }>(
      'SELECT id FROM repositories WHERE full_name = ?',
      [target.dbSlug],
    );

    if (repoRows.length === 0) {
      console.warn(`[${target.dbSlug}] Repository not found in database — skipping.`);
      continue;
    }

    const repositoryId = repoRows[0].id;

    const commitStats = await ingestRepoCommits(label, repositoryId, target.owner, target.repo);
    const parts = [`${commitStats.inserted} new`];
    if (commitStats.updated > 0) parts.push(`${commitStats.updated} updated`);
    parts.push(`${commitStats.skipped} skipped`, `${commitStats.unresolvedAuthors} unresolved authors`);
    console.log(`[${label}] Commits: ${parts.join(', ')}`);

    const branchStats = await ingestRepoBranches(label, repositoryId, target.owner, target.repo);
    console.log(`[${label}] Branches: ${branchStats.branchesProcessed} processed, ${branchStats.linksInserted} links inserted`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

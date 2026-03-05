#!/usr/bin/env npx tsx
/**
 * Fetch commits from GitHub repos and cache them as local JSON files.
 *
 * Usage:
 *   pnpm fetch-commits --repos owner/repo1,owner/repo2 --since 2025-01-01
 *
 * Requires GITHUB_TOKEN environment variable (loaded from .env.local).
 */

import { config } from 'dotenv';
config({ path: '.env.local' });


import * as path from 'node:path';
import { Octokit } from '@octokit/rest';
import {
  parseArgs,
  parseRepoSlug,
  getRepoCacheDir,
  isCommitCached,
  saveCacheFile,
  sanitizeBranchName,
} from './lib/cache-utils';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleRateLimit(headers: Record<string, string | undefined>): Promise<void> {
  const remaining = Number(headers['x-ratelimit-remaining'] ?? '999');
  if (remaining < 100) {
    const resetEpoch = Number(headers['x-ratelimit-reset'] ?? '0');
    const waitMs = Math.max(0, resetEpoch * 1000 - Date.now()) + 1000;
    console.log(`Rate limit low (${remaining} remaining). Sleeping ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }
}

const CONCURRENCY = 10;

/** Run async tasks with a concurrency limit */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  const { repos, since } = parseArgs(process.argv.slice(2));
  if (repos.length === 0) {
    console.error('Error: No repos specified. Use --repos owner/repo1,owner/repo2');
    process.exit(1);
  }

  const sinceISO = new Date(since).toISOString();
  const octokit = new Octokit({ auth: token });

  for (const slug of repos) {
    const { owner, repo } = parseRepoSlug(slug);
    const cacheDir = getRepoCacheDir(owner, repo);
    console.log(`\n[${owner}/${repo}] Fetching branches...`);

    // Fetch all branches (paginated)
    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });
    saveCacheFile(path.join(cacheDir, 'branches.json'), branches);
    console.log(`[${owner}/${repo}] Found ${branches.length} branches.`);

    // Pre-filter: concurrently check which branches have recent commits
    console.log(`[${owner}/${repo}] Checking branches for recent activity (concurrency=${CONCURRENCY})...`);
    const branchHasCommits = await mapConcurrent(branches, CONCURRENCY, async (branch) => {
      const { data: commits } = await octokit.repos.listCommits({
        owner,
        repo,
        sha: branch.name,
        since: sinceISO,
        per_page: 1,
      });
      return commits.length > 0;
    });

    const activeBranches = branches.filter((_, i) => branchHasCommits[i]);
    console.log(`[${owner}/${repo}] ${activeBranches.length}/${branches.length} branches have recent commits.`);

    // Process only active branches
    for (const branch of activeBranches) {
      const branchName = branch.name;
      const sanitized = sanitizeBranchName(branchName);
      console.log(`\n[${owner}/${repo}] Branch: ${branchName}`);

      // Paginate commits for this branch
      const commits = await octokit.paginate(
        octokit.repos.listCommits,
        {
          owner,
          repo,
          sha: branchName,
          since: sinceISO,
          per_page: 100,
        }
      );

      const shas: string[] = [];
      let fetched = 0;
      let skipped = 0;

      for (const commit of commits) {
        const sha = commit.sha;
        shas.push(sha);

        if (isCommitCached(owner, repo, sha)) {
          skipped++;
          continue;
        }

        // Fetch full commit details
        const response = await octokit.repos.getCommit({ owner, repo, ref: sha });
        const commitPath = path.join(cacheDir, 'commits', `${sha}.json`);
        saveCacheFile(commitPath, response.data);
        fetched++;

        // Rate limit handling
        await handleRateLimit(response.headers as Record<string, string | undefined>);
      }

      // Save ordered commit list per branch
      const commitListPath = path.join(cacheDir, 'commit-list', `${sanitized}.json`);
      saveCacheFile(commitListPath, shas);

      console.log(
        `[${owner}/${repo}] Fetched ${fetched}/${commits.length} commits, ${skipped} skipped (cached)`
      );
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

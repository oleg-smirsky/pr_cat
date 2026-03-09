#!/usr/bin/env npx tsx
/**
 * Fetch commits from GitHub repos and cache them as local JSON files.
 *
 * Usage:
 *   pnpm fetch-commits --repos owner/repo1,owner/repo2 --since 2025-01-01
 *   pnpm fetch-commits --repos owner/repo1 --since 2025-01-01 --team-config ../config/mappings.json
 *
 * With --team-config, also discovers and fetches from team members' forks.
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
import { loadGitHubUsernames, saveForkMarker } from './lib/fork-utils';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isTransient = err instanceof Error && (
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('fetch failed') ||
        (err as { status?: number }).status === 500 ||
        (err as { status?: number }).status === 502 ||
        (err as { status?: number }).status === 503
      );
      if (!isTransient || i === retries - 1) throw err;
      const delay = (i + 1) * 5000;
      console.log(`Transient error, retrying in ${delay / 1000}s... (${(err as Error).message})`);
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

// Shared rate-limit gate: all workers wait on the same promise
let rateLimitGate: Promise<void> | null = null;

async function handleRateLimit(headers: Record<string, string | undefined>): Promise<void> {
  // If another worker already triggered a wait, join it
  if (rateLimitGate) {
    await rateLimitGate;
    return;
  }

  const remaining = Number(headers['x-ratelimit-remaining'] ?? '999');
  if (remaining < 50) {
    const resetEpoch = Number(headers['x-ratelimit-reset'] ?? '0');
    const waitMs = Math.max(0, resetEpoch * 1000 - Date.now()) + 2000;
    console.log(`Rate limit low (${remaining} remaining). All workers sleeping ${Math.round(waitMs / 1000)}s...`);
    rateLimitGate = sleep(waitMs);
    await rateLimitGate;
    rateLimitGate = null;
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

/** Discover forks of tracked repos for each team member GitHub username. */
async function discoverForks(
  octokit: Octokit,
  parentSlugs: string[],
  githubUsernames: string[],
): Promise<Array<{ forkOwner: string; repoName: string; parentSlug: string }>> {
  const forks: Array<{ forkOwner: string; repoName: string; parentSlug: string }> = [];

  for (const parentSlug of parentSlugs) {
    const { repo } = parseRepoSlug(parentSlug);

    await mapConcurrent(githubUsernames, CONCURRENCY, async (username) => {
      try {
        await octokit.repos.get({ owner: username, repo });
        forks.push({ forkOwner: username, repoName: repo, parentSlug });
        console.log(`  Found fork: ${username}/${repo} (fork of ${parentSlug})`);
      } catch (err: unknown) {
        if ((err as { status?: number }).status === 404) {
          // No fork — expected, skip silently
        } else {
          console.warn(`  Warning: Could not check ${username}/${repo}: ${(err as Error).message}`);
        }
      }
    });
  }

  return forks;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  const { repos, since, teamConfig } = parseArgs(process.argv.slice(2));
  if (repos.length === 0) {
    console.error('Error: No repos specified. Use --repos owner/repo1,owner/repo2');
    process.exit(1);
  }

  const sinceISO = new Date(since).toISOString();
  const octokit = new Octokit({ auth: token });

  let forkSlugs: Array<{ forkOwner: string; repoName: string; parentSlug: string }> = [];
  if (teamConfig) {
    const usernames = loadGitHubUsernames(teamConfig);
    if (usernames.length > 0) {
      console.log(`\nDiscovering forks for ${usernames.length} team members...`);
      forkSlugs = await discoverForks(octokit, repos, usernames);
      console.log(`Found ${forkSlugs.length} fork(s).`);
    }
  }

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
      const { data: commits } = await withRetry(() => octokit.repos.listCommits({
        owner,
        repo,
        sha: branch.name,
        since: sinceISO,
        per_page: 1,
      }));
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
      const commits = await withRetry(() => octokit.paginate(
        octokit.repos.listCommits,
        {
          owner,
          repo,
          sha: branchName,
          since: sinceISO,
          per_page: 100,
        }
      ));

      const shas: string[] = commits.map(c => c.sha);

      // Filter to uncached commits
      const uncached = shas.filter(sha => !isCommitCached(owner, repo, sha));
      const skipped = shas.length - uncached.length;

      // Fetch uncached commits concurrently
      await mapConcurrent(uncached, CONCURRENCY, async (sha) => {
        const response = await withRetry(() => octokit.repos.getCommit({ owner, repo, ref: sha }));
        const commitPath = path.join(cacheDir, 'commits', `${sha}.json`);
        saveCacheFile(commitPath, response.data);
        await handleRateLimit(response.headers as Record<string, string | undefined>);
      });
      const fetched = uncached.length;

      // Save ordered commit list per branch
      const commitListPath = path.join(cacheDir, 'commit-list', `${sanitized}.json`);
      saveCacheFile(commitListPath, shas);

      console.log(
        `[${owner}/${repo}] Fetched ${fetched}/${commits.length} commits, ${skipped} skipped (cached)`
      );
    }
  }

  // Fetch from discovered forks
  for (const { forkOwner, repoName, parentSlug } of forkSlugs) {
    const forkSlug = `${forkOwner}/${repoName}`;
    const cacheDir = getRepoCacheDir(forkOwner, repoName);

    // Write fork-of.json marker
    saveForkMarker(cacheDir, parentSlug);

    console.log(`\n[${forkSlug}] (fork of ${parentSlug}) Fetching branches...`);

    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner: forkOwner, repo: repoName, per_page: 100,
    });
    saveCacheFile(path.join(cacheDir, 'branches.json'), branches);
    console.log(`[${forkSlug}] Found ${branches.length} branches.`);

    const branchHasCommits = await mapConcurrent(branches, CONCURRENCY, async (branch) => {
      const { data: commits } = await withRetry(() => octokit.repos.listCommits({
        owner: forkOwner, repo: repoName, sha: branch.name, since: sinceISO, per_page: 1,
      }));
      return commits.length > 0;
    });

    const activeBranches = branches.filter((_, i) => branchHasCommits[i]);
    console.log(`[${forkSlug}] ${activeBranches.length}/${branches.length} branches have recent commits.`);

    for (const branch of activeBranches) {
      const branchName = branch.name;
      const sanitized = sanitizeBranchName(branchName);
      console.log(`\n[${forkSlug}] Branch: ${branchName}`);

      const commits = await withRetry(() => octokit.paginate(
        octokit.repos.listCommits,
        { owner: forkOwner, repo: repoName, sha: branchName, since: sinceISO, per_page: 100 },
      ));

      const shas: string[] = commits.map(c => c.sha);
      const uncached = shas.filter(sha => !isCommitCached(forkOwner, repoName, sha));

      await mapConcurrent(uncached, CONCURRENCY, async (sha) => {
        const response = await withRetry(() => octokit.repos.getCommit({ owner: forkOwner, repo: repoName, ref: sha }));
        const commitPath = path.join(cacheDir, 'commits', `${sha}.json`);
        saveCacheFile(commitPath, response.data);
        await handleRateLimit(response.headers as Record<string, string | undefined>);
      });

      saveCacheFile(path.join(cacheDir, 'commit-list', `${sanitized}.json`), shas);
      console.log(`[${forkSlug}] Fetched ${uncached.length}/${commits.length} commits, ${shas.length - uncached.length} skipped (cached)`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

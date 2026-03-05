#!/usr/bin/env npx tsx
/**
 * Fetch Jira issues referenced by commits and cache them locally.
 * Cache-aware: skips already-cached issues, chases parent/epic refs in waves.
 *
 * Usage:
 *   pnpm fetch-jira-issues
 *   pnpm fetch-jira-issues --force
 *
 * Requires JIRA_BASE_URL and JIRA_TOKEN in .env.local
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import * as fs from 'node:fs';
import * as path from 'node:path';
import { query } from '@/lib/db';
import { runMigrations } from '@/lib/migrate';
import { parseJiraIssue, getReferencedKeys } from './lib/jira-utils';

const JIRA_CACHE_DIR = path.join(process.cwd(), '.cache', 'jira');

const JIRA_FIELDS = [
  'summary',
  'issuetype',
  'parent',
  'status',
  'labels',
  'components',
  'fixVersions',
  'customfield_10000',
  'customfield_10002',
  'project',
].join(',');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read cached issue keys from the .cache/jira directory */
function getCachedKeys(): Set<string> {
  if (!fs.existsSync(JIRA_CACHE_DIR)) {
    return new Set();
  }
  const files = fs.readdirSync(JIRA_CACHE_DIR).filter(f => f.endsWith('.json'));
  return new Set(files.map(f => f.replace(/\.json$/, '')));
}

/** Save a Jira issue response to cache */
function saveCacheFile(issueKey: string, data: unknown): void {
  fs.mkdirSync(JIRA_CACHE_DIR, { recursive: true });
  const filePath = path.join(JIRA_CACHE_DIR, `${issueKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Read a cached issue JSON file */
function readCacheFile(issueKey: string): Record<string, unknown> {
  const filePath = path.join(JIRA_CACHE_DIR, `${issueKey}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Fetch a single issue from the Jira REST API */
async function fetchJiraIssue(
  baseUrl: string,
  token: string,
  issueKey: string,
  delayMs: number,
): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl}/rest/api/2/issue/${issueKey}?fields=${JIRA_FIELDS}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`  Warning: Failed to fetch ${issueKey} (HTTP ${response.status}), skipping.`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    await sleep(delayMs);
    return data;
  } catch (err) {
    console.warn(`  Warning: Error fetching ${issueKey}: ${err instanceof Error ? err.message : err}, skipping.`);
    return null;
  }
}

/** Scan all cached issues and collect referenced parent/epic keys */
function discoverReferencedKeys(knownKeys: Set<string>): Set<string> {
  const discovered = new Set<string>();

  for (const key of knownKeys) {
    try {
      const raw = readCacheFile(key);
      const parsed = parseJiraIssue(raw);
      for (const refKey of getReferencedKeys(parsed)) {
        discovered.add(refKey);
      }
    } catch {
      // Skip issues that fail to parse
    }
  }

  return discovered;
}

async function main(): Promise<void> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;

  if (!baseUrl) {
    console.error('Error: JIRA_BASE_URL environment variable is required.');
    process.exit(1);
  }
  if (!token) {
    console.error('Error: JIRA_TOKEN environment variable is required.');
    process.exit(1);
  }

  const delayMs = Number(process.env.JIRA_DELAY_MS ?? '100');
  const force = process.argv.includes('--force');

  // Ensure DB schema is up to date
  await runMigrations();

  // Step 1: Build WANTED set from commit_jira_tickets
  const rows = await query<{ jira_ticket_id: string }>(
    'SELECT DISTINCT jira_ticket_id FROM commit_jira_tickets',
  );
  const wanted = new Set<string>(rows.map(r => r.jira_ticket_id));
  console.log(`Seed: ${wanted.size} unique Jira keys from commit_jira_tickets.`);

  // Step 2: Build KNOWN from cache (unless --force)
  const known = force ? new Set<string>() : getCachedKeys();
  if (!force && known.size > 0) {
    console.log(`Cache: ${known.size} issues already cached.`);
  }
  if (force) {
    console.log('Force mode: ignoring existing cache.');
  }

  // Step 3: Wave loop — fetch missing, discover references, repeat
  let wave = 0;
  const failed = new Set<string>();

  while (true) {
    wave++;
    const missing = new Set<string>();
    for (const key of wanted) {
      if (!known.has(key) && !failed.has(key)) {
        missing.add(key);
      }
    }

    if (missing.size === 0) {
      break;
    }

    console.log(`\nWave ${wave}: ${missing.size} issues to fetch.`);
    let fetched = 0;

    for (const key of missing) {
      const data = await fetchJiraIssue(baseUrl, token, key, delayMs);
      if (data) {
        saveCacheFile(key, data);
        known.add(key);
        fetched++;
        if (fetched % 10 === 0) {
          console.log(`  Fetched ${fetched}/${missing.size}...`);
        }
      } else {
        failed.add(key);
      }
    }

    console.log(`Wave ${wave}: fetched ${fetched}, failed ${missing.size - fetched}.`);

    // Discover referenced keys from ALL cached issues
    const referenced = discoverReferencedKeys(known);
    let newKeys = 0;
    for (const key of referenced) {
      if (!wanted.has(key)) {
        wanted.add(key);
        newKeys++;
      }
    }

    if (newKeys > 0) {
      console.log(`Discovered ${newKeys} new referenced keys (parents/epics).`);
    }
  }

  console.log(`\nDone. ${known.size} issues cached, ${failed.size} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

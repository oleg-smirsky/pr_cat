import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'github');

/** Sanitize branch names for use as filenames (replace / with __) */
export function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, '__');
}

/** Get the cache directory for a repo */
export function getRepoCacheDir(owner: string, repo: string): string {
  return path.join(CACHE_ROOT, owner, repo);
}

/** Check if a commit is already cached */
export function isCommitCached(owner: string, repo: string, sha: string): boolean {
  const filePath = path.join(getRepoCacheDir(owner, repo), 'commits', `${sha}.json`);
  return fs.existsSync(filePath);
}

/** Save JSON data to a cache file */
export function saveCacheFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Parse --repos and --since CLI arguments */
export function parseArgs(args: string[]): { repos: string[]; since: string } {
  let repos: string[] = [];
  let since = '2025-01-01';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repos' && args[i + 1]) {
      repos = args[i + 1].split(',').map(r => r.trim());
      i++;
    } else if (args[i] === '--since' && args[i + 1]) {
      since = args[i + 1];
      i++;
    }
  }

  return { repos, since };
}

/** Parse owner/repo string into parts */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: "${slug}". Expected format: owner/repo`);
  }
  return { owner, repo };
}

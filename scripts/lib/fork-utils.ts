import * as fs from 'node:fs';
import * as path from 'node:path';

interface TeamMember {
  name: string;
  emails: string[];
  github?: string;
  capacity: number;
}

interface TeamConfig {
  teams: Record<string, { members: TeamMember[] }>;
}

/** Extract unique GitHub usernames from all teams in a mappings config file. */
export function loadGitHubUsernames(configPath: string): string[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config: TeamConfig = JSON.parse(raw);
  const usernames = new Set<string>();

  for (const team of Object.values(config.teams)) {
    for (const member of team.members) {
      if (member.github) {
        usernames.add(member.github);
      }
    }
  }

  return [...usernames];
}

/** Write a fork-of.json marker in a fork's cache directory. */
export function saveForkMarker(cacheDir: string, parentSlug: string): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'fork-of.json'), JSON.stringify(parentSlug));
}

/** Read the parent repo slug from a fork-of.json marker, or null if not a fork. */
export function readForkMarker(cacheDir: string): string | null {
  const markerPath = path.join(cacheDir, 'fork-of.json');
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  const raw = fs.readFileSync(markerPath, 'utf-8');
  return JSON.parse(raw) as string;
}

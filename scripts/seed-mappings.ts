#!/usr/bin/env npx tsx
/**
 * Seed project mappings from an external JSON config file.
 *
 * Usage:
 *   pnpm seed-mappings --config ../pr_cat_prusa/mappings.json
 *   pnpm seed-mappings --config ../pr_cat_prusa/mappings.json --overrides ../pr_cat_prusa/commit-overrides.json
 *
 * Or set MAPPINGS_CONFIG / OVERRIDES_CONFIG env vars.
 *
 * The config file defines projects and mapping types:
 *   - epicMappings:        Jira epic key → project name
 *   - jiraProjectMappings: Jira project key → project name
 *   - prefixMappings:      commit message prefix → project name
 *   - repoDefaults:        repo full_name → project name
 *
 * The overrides file maps individual commit SHAs to project names:
 *   - commitMappings:      sha → project name
 *
 * All inserts are idempotent (INSERT OR REPLACE / INSERT OR IGNORE).
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import * as fs from 'node:fs';
import { query, execute, transaction } from '@/lib/db';
import { runMigrations } from '@/lib/migrate';

interface MappingsConfig {
  projects: { name: string; description: string }[];
  epicMappings: Record<string, string>;        // epic_key → project name
  jiraProjectMappings: Record<string, string>; // jira_project_key → project name
  branchMappings?: Record<string, string>;     // branch prefix → project name
  branchExclusions?: string[];                 // branch names to skip
  prefixMappings: Record<string, string>;      // prefix → project name
  repoDefaults: Record<string, string>;        // repo full_name → project name
}

function getFlagValue(flag: string, envVar: string): string | null {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }
  if (process.env[envVar]) {
    return process.env[envVar]!;
  }
  return null;
}

function getConfigPath(): string {
  const path = getFlagValue('--config', 'MAPPINGS_CONFIG');
  if (!path) {
    console.error('Error: Provide config path via --config <path> or MAPPINGS_CONFIG env var.');
    process.exit(1);
  }
  return path;
}

interface OverridesConfig {
  commitMappings: Record<string, string>; // sha → project name
}

async function main(): Promise<void> {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file not found: ${configPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg: MappingsConfig = JSON.parse(raw);

  await runMigrations();

  // Get organization id
  const orgs = await query<{ id: number }>('SELECT id FROM organizations LIMIT 1');
  const orgId = orgs[0]?.id ?? null;

  await transaction(async (tx) => {
    // 1. Upsert projects (lookup by name, insert if missing, update if exists)
    for (const p of cfg.projects) {
      const existing = await tx.query<{ id: number }>(
        'SELECT id FROM projects WHERE name = ? AND organization_id = ?',
        [p.name, orgId],
      );
      if (existing.length > 0) {
        await tx.execute(
          'UPDATE projects SET description = ? WHERE id = ?',
          [p.description, existing[0].id],
        );
      } else {
        await tx.execute(
          'INSERT INTO projects (name, description, organization_id) VALUES (?, ?, ?)',
          [p.name, p.description, orgId],
        );
      }
    }

    // Build name → id lookup
    const rows = await tx.query<{ id: number; name: string }>('SELECT id, name FROM projects');
    const byName = new Map(rows.map(r => [r.name, r.id]));

    const resolve = (projectName: string, context: string): number | null => {
      const id = byName.get(projectName);
      if (id === undefined) {
        console.warn(`  Warning: project "${projectName}" not found (${context}), skipping.`);
        return null;
      }
      return id;
    };

    // 2. Epic mappings
    let epicCount = 0;
    for (const [epicKey, projectName] of Object.entries(cfg.epicMappings)) {
      const projectId = resolve(projectName, `epic ${epicKey}`);
      if (projectId === null) continue;
      await tx.execute(
        'INSERT OR REPLACE INTO jira_epic_mappings (epic_key, project_id) VALUES (?, ?)',
        [epicKey, projectId],
      );
      epicCount++;
    }

    // 3. Jira project mappings
    let jpCount = 0;
    for (const [jiraKey, projectName] of Object.entries(cfg.jiraProjectMappings)) {
      const projectId = resolve(projectName, `jira project ${jiraKey}`);
      if (projectId === null) continue;
      await tx.execute(
        'INSERT OR REPLACE INTO jira_project_mappings (jira_project_key, project_id) VALUES (?, ?)',
        [jiraKey, projectId],
      );
      jpCount++;
    }

    // 4. Prefix mappings
    let prefixCount = 0;
    for (const [prefix, projectName] of Object.entries(cfg.prefixMappings)) {
      const projectId = resolve(projectName, `prefix ${prefix}`);
      if (projectId === null) continue;
      await tx.execute(
        'INSERT OR REPLACE INTO commit_prefix_mappings (prefix, project_id) VALUES (?, ?)',
        [prefix, projectId],
      );
      prefixCount++;
    }

    // 5. Branch mappings
    let branchCount = 0;
    for (const [prefix, projectName] of Object.entries(cfg.branchMappings ?? {})) {
      const projectId = resolve(projectName, `branch prefix ${prefix}`);
      if (projectId === null) continue;
      await tx.execute(
        'INSERT OR REPLACE INTO branch_project_mappings (prefix, project_id) VALUES (?, ?)',
        [prefix, projectId],
      );
      branchCount++;
    }

    // 6. Branch exclusions
    let exclCount = 0;
    for (const branchName of cfg.branchExclusions ?? []) {
      await tx.execute(
        'INSERT OR IGNORE INTO branch_exclusions (branch_name) VALUES (?)',
        [branchName],
      );
      exclCount++;
    }

    // 7. Repo defaults
    let repoCount = 0;
    for (const [repoSlug, projectName] of Object.entries(cfg.repoDefaults)) {
      const projectId = resolve(projectName, `repo ${repoSlug}`);
      if (projectId === null) continue;
      const repoRows = await tx.query<{ id: number }>(
        'SELECT id FROM repositories WHERE full_name = ?',
        [repoSlug],
      );
      if (repoRows.length === 0) {
        console.warn(`  Warning: repository "${repoSlug}" not found in DB, skipping.`);
        continue;
      }
      await tx.execute(
        'INSERT OR REPLACE INTO repo_project_defaults (repository_id, project_id) VALUES (?, ?)',
        [repoRows[0].id, projectId],
      );
      repoCount++;
    }

    // 8. Commit overrides (from separate file)
    let overrideCount = 0;
    const overridesPath = getFlagValue('--overrides', 'OVERRIDES_CONFIG');
    if (overridesPath && fs.existsSync(overridesPath)) {
      const overrides: OverridesConfig = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
      for (const [sha, projectName] of Object.entries(overrides.commitMappings ?? {})) {
        const projectId = resolve(projectName, `commit ${sha.slice(0, 8)}`);
        if (projectId === null) continue;
        await tx.execute(
          'INSERT OR REPLACE INTO commit_project_overrides (sha, project_id) VALUES (?, ?)',
          [sha, projectId],
        );
        overrideCount++;
      }
    }

    console.log(`\nSeeded:`);
    console.log(`  Projects:           ${cfg.projects.length}`);
    console.log(`  Epic mappings:      ${epicCount}`);
    console.log(`  Jira proj maps:     ${jpCount}`);
    console.log(`  Prefix mappings:    ${prefixCount}`);
    console.log(`  Branch mappings:    ${branchCount}`);
    console.log(`  Branch excl.:       ${exclCount}`);
    console.log(`  Repo defaults:      ${repoCount}`);
    console.log(`  Commit overrides:   ${overrideCount}`);
  });

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

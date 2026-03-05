# Resolution Cascade v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce "General Buddy" catchall from 43.9% by adding epic self-reference resolution and branch-based project matching.

**Architecture:** Two changes to the pure-function resolution cascade in `scripts/lib/resolution-utils.ts`: (1) epic self-reference check in existing level 1, (2) new branch matching at level 3. One new DB table via migration 14. Config and seed-mappings extended.

**Tech Stack:** TypeScript, SQLite (Turso), Jest

---

### Task 1: Epic self-reference — write failing test

**Files:**
- Modify: `__tests__/lib/resolve-projects.test.ts`

**Step 1: Add test for epic self-reference**

Add this test inside the existing `describe('resolveProjectForCommit')` block, after line 58:

```typescript
it('resolves via epic mapping when ticket IS itself a mapped epic (self-reference)', () => {
  // BFW-8007 is an epic with no parent epicKey, but it IS a key in epicMappings
  const issuesWithEpicSelfRef = new Map([
    ...jiraIssues,
    ['BFW-8007', { epicKey: null, projectKey: 'BFW' }],
  ]);
  const ctxWithSelfRef = { ...ctx, jiraIssues: issuesWithEpicSelfRef };
  const r = resolveProjectForCommit(
    { ticketIds: ['BFW-8007'], repositoryId: 10, message: 'some msg' },
    ctxWithSelfRef,
  );
  expect(r).toEqual({ projectId: 1, level: 'epic' });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test __tests__/lib/resolve-projects.test.ts`
Expected: FAIL — currently resolves to `{ projectId: 3, level: 'jira_project' }` instead of epic.

---

### Task 2: Epic self-reference — implement fix

**Files:**
- Modify: `scripts/lib/resolution-utils.ts:59-67`

**Step 1: Update level 1 epic mapping logic**

Replace lines 59-67 in `resolveProjectForCommit`:

```typescript
  // Level 1: epic mapping — check all tickets
  for (const ticketId of commit.ticketIds) {
    const issue = ctx.jiraIssues.get(ticketId);
    if (!issue) continue;

    // Check if the ticket belongs to a mapped epic
    if (issue.epicKey) {
      const projectId = ctx.epicMappings.get(issue.epicKey);
      if (projectId !== undefined) {
        return { projectId, level: 'epic' };
      }
    }

    // Self-reference: ticket has no parent epic but IS itself a mapped epic
    if (!issue.epicKey) {
      const projectId = ctx.epicMappings.get(ticketId);
      if (projectId !== undefined) {
        return { projectId, level: 'epic' };
      }
    }
  }
```

**Step 2: Update the cascade comment at top of file**

Replace lines 1-9:

```typescript
/**
 * Pure functions for resolving commits to projects via a cascade of mappings.
 *
 * Cascade order (stop at first match):
 *   1. Epic mapping      — ticket → jira issue epic_key → epicMappings → project_id
 *                           OR ticket key itself in epicMappings (epic self-reference)
 *   2. Jira project      — ticket → jira issue project_key → projectMappings → project_id
 *   3. Branch matching   — commit branches → prefix match → branchMappings → project_id
 *   4. Message prefix    — commit message prefix (e.g. "INDX:") → prefixMappings → project_id
 *   5. Repo default      — repository_id → repoDefaults → project_id
 *   6. null              — unallocated
 */
```

**Step 3: Run test to verify it passes**

Run: `pnpm test __tests__/lib/resolve-projects.test.ts`
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add scripts/lib/resolution-utils.ts __tests__/lib/resolve-projects.test.ts
git commit -m "fix: resolve epic self-references in cascade level 1"
```

---

### Task 3: Branch matching — add migration

**Files:**
- Modify: `lib/migrate.ts:409` (add new entry to MIGRATIONS array)

**Step 1: Add migration 14**

Add after the version 13 entry (before the closing `];` on line 410):

```typescript
  {
    version: 14,
    name: 'add_branch_project_mappings',
    sql: `
      CREATE TABLE IF NOT EXISTS branch_project_mappings (
        id INTEGER PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `
  }
```

**Step 2: Verify migration applies**

Run: `pnpm test` (full suite — migrations run during test setup)
Expected: All tests PASS, no schema errors.

**Step 3: Commit**

```bash
git add lib/migrate.ts
git commit -m "feat: add branch_project_mappings table (migration 14)"
```

---

### Task 4: Branch matching — write failing tests

**Files:**
- Modify: `__tests__/lib/resolve-projects.test.ts`

**Step 1: Add tests for branch resolution**

Import `resolveBranchProject` (will be created next task). Add a new `describe` block after the existing `describe('extractMessagePrefix')` block:

```typescript
import {
  resolveProjectForCommit,
  extractMessagePrefix,
  resolveBranchProject,
} from '@/scripts/lib/resolution-utils';
```

Then add at the end of the file:

```typescript
describe('resolveBranchProject', () => {
  const branchMappings = new Map([
    ['indx', 10],
    ['ix', 20],
    ['ixbuddy', 20],
    ['core_one', 30],
  ]);
  const branchExclusions = ['private', 'main', 'master'];

  it('matches a single project branch', () => {
    const r = resolveBranchProject(['indx_dev', 'private'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('returns null when only excluded branches', () => {
    const r = resolveBranchProject(['private', 'main'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('returns null when no branches match any prefix', () => {
    const r = resolveBranchProject(['feature/something', 'bugfix/other'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('returns null on ambiguous match (two different projects)', () => {
    const r = resolveBranchProject(['indx_dev', 'core_one_test'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('resolves when multiple branches agree on same project', () => {
    const r = resolveBranchProject(['indx_dev', 'indx_head'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('uses longest prefix match (ixbuddy beats ix)', () => {
    const r = resolveBranchProject(['ixbuddy-anfc'], branchMappings, branchExclusions);
    expect(r).toBe(20);
  });

  it('excludes RELEASE and REL_ prefixed branches', () => {
    const r = resolveBranchProject(['RELEASE-6.4', 'REL_6_5_111', 'indx_dev'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('returns null for empty branch list', () => {
    const r = resolveBranchProject([], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test __tests__/lib/resolve-projects.test.ts`
Expected: FAIL — `resolveBranchProject` is not exported from resolution-utils.

---

### Task 5: Branch matching — implement resolveBranchProject

**Files:**
- Modify: `scripts/lib/resolution-utils.ts`

**Step 1: Add the function**

Add before `resolveProjectForCommit` (before line 55):

```typescript
/**
 * Check if a branch name should be excluded from matching.
 * Excluded: exact matches in the exclusion list, plus RELEASE* and REL_* prefixes.
 */
function isBranchExcluded(branch: string, exclusions: string[]): boolean {
  if (exclusions.includes(branch)) return true;
  if (branch.startsWith('RELEASE') || branch.startsWith('REL_')) return true;
  return false;
}

/**
 * Find the longest matching prefix for a branch name.
 * Returns the project_id or undefined.
 */
function matchBranchPrefix(
  branch: string,
  branchMappings: Map<string, number>,
): number | undefined {
  let bestLen = 0;
  let bestProjectId: number | undefined;
  for (const [prefix, projectId] of branchMappings) {
    if (branch.startsWith(prefix) && prefix.length > bestLen) {
      bestLen = prefix.length;
      bestProjectId = projectId;
    }
  }
  return bestProjectId;
}

/**
 * Resolve a project from branch names.
 * Filters out excluded branches, matches remaining against prefix mappings.
 * Returns project_id if all matching branches agree, null otherwise.
 */
export function resolveBranchProject(
  branches: string[],
  branchMappings: Map<string, number>,
  branchExclusions: string[],
): number | null {
  const matchedProjectIds = new Set<number>();

  for (const branch of branches) {
    if (isBranchExcluded(branch, branchExclusions)) continue;
    const projectId = matchBranchPrefix(branch, branchMappings);
    if (projectId !== undefined) {
      matchedProjectIds.add(projectId);
    }
  }

  if (matchedProjectIds.size === 1) {
    return matchedProjectIds.values().next().value!;
  }

  return null;
}
```

**Step 2: Run tests to verify they pass**

Run: `pnpm test __tests__/lib/resolve-projects.test.ts`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add scripts/lib/resolution-utils.ts __tests__/lib/resolve-projects.test.ts
git commit -m "feat: add resolveBranchProject with prefix matching and exclusions"
```

---

### Task 6: Branch matching — integrate into cascade

**Files:**
- Modify: `scripts/lib/resolution-utils.ts`

**Step 1: Update CommitInfo interface**

Add `branchNames` field (line 12-16):

```typescript
export interface CommitInfo {
  ticketIds: string[];
  repositoryId: number;
  message: string;
  branchNames: string[];
}
```

**Step 2: Update MappingContext interface**

Add branch fields (line 24-29):

```typescript
export interface MappingContext {
  jiraIssues: Map<string, JiraIssueInfo>;
  epicMappings: Map<string, number>;
  projectMappings: Map<string, number>;
  branchMappings: Map<string, number>;     // branch prefix → project_id
  branchExclusions: string[];               // branch names to ignore
  prefixMappings: Map<string, number>;
  repoDefaults: Map<number, number>;
}
```

**Step 3: Update ResolutionResult level type**

```typescript
export interface ResolutionResult {
  projectId: number;
  level: 'epic' | 'jira_project' | 'branch_match' | 'message_prefix' | 'repo_default';
}
```

**Step 4: Add branch matching to resolveProjectForCommit**

Insert after the level 2 block (after jira_project loop) and before the message prefix block:

```typescript
  // Level 3: branch matching
  const branchProjectId = resolveBranchProject(
    commit.branchNames,
    ctx.branchMappings,
    ctx.branchExclusions,
  );
  if (branchProjectId !== null) {
    return { projectId: branchProjectId, level: 'branch_match' };
  }
```

Update the comments on levels 3-5 to be 4-6.

**Step 5: Update existing tests to include new required fields**

In `__tests__/lib/resolve-projects.test.ts`, update the test setup (around line 3-12):

```typescript
describe('resolveProjectForCommit', () => {
  const epicMappings = new Map([['BFW-8007', 1], ['BFW-6855', 2]]);
  const projectMappings = new Map([['BFW', 3]]);
  const branchMappings = new Map([['indx', 5]]);
  const branchExclusions = ['private', 'main'];
  const prefixMappings = new Map([['INDX', 5], ['INDX_HEAD', 5], ['MMU', 6]]);
  const repoDefaults = new Map([[10, 4]]);
  const jiraIssues = new Map([
    ['BFW-8447', { epicKey: 'BFW-8007', projectKey: 'BFW' }],
    ['BFW-7763', { epicKey: null, projectKey: 'BFW' }],
  ]);
  const ctx = { jiraIssues, epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults };
```

Add `branchNames: []` to all existing test commits that don't have it. This preserves existing behavior since empty branches won't match anything.

Add a new test for branch resolution in the cascade:

```typescript
  it('resolves via branch matching (level 3)', () => {
    const r = resolveProjectForCommit(
      { ticketIds: [], repositoryId: 10, message: 'Fix something', branchNames: ['indx_dev', 'private'] },
      ctx,
    );
    expect(r).toEqual({ projectId: 5, level: 'branch_match' });
  });

  it('prioritizes jira project over branch matching', () => {
    const r = resolveProjectForCommit(
      { ticketIds: ['BFW-7763'], repositoryId: 10, message: 'msg', branchNames: ['indx_dev'] },
      ctx,
    );
    expect(r!.level).toBe('jira_project');
  });
```

**Step 6: Run tests**

Run: `pnpm test __tests__/lib/resolve-projects.test.ts`
Expected: All tests PASS.

**Step 7: Commit**

```bash
git add scripts/lib/resolution-utils.ts __tests__/lib/resolve-projects.test.ts
git commit -m "feat: integrate branch matching as cascade level 3"
```

---

### Task 7: Update resolve-projects.ts — load branch data

**Files:**
- Modify: `scripts/resolve-projects.ts`

**Step 1: Add branch mapping loading to loadMappings**

Update the return type and add the query (around line 39-66):

```typescript
async function loadMappings(): Promise<{
  epicMappings: Map<string, number>;
  projectMappings: Map<string, number>;
  branchMappings: Map<string, number>;
  branchExclusions: string[];
  prefixMappings: Map<string, number>;
  repoDefaults: Map<number, number>;
}> {
  const [epicRows, projRows, branchRows, prefixRows, repoRows] = await Promise.all([
    query<{ epic_key: string; project_id: number }>(
      'SELECT epic_key, project_id FROM jira_epic_mappings',
    ),
    query<{ jira_project_key: string; project_id: number }>(
      'SELECT jira_project_key, project_id FROM jira_project_mappings',
    ),
    query<{ prefix: string; project_id: number }>(
      'SELECT prefix, project_id FROM branch_project_mappings',
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
    branchExclusions: [],  // loaded from config at seed time, stored in-memory only
    prefixMappings: new Map(prefixRows.map(r => [r.prefix, r.project_id])),
    repoDefaults: new Map(repoRows.map(r => [r.repository_id, r.project_id])),
  };
}
```

Wait — `branchExclusions` isn't in the DB. It's config-only. Two options: (a) store it in the DB, or (b) pass it as a CLI arg / env var. Since it's small and rarely changes, store it in a new table `branch_exclusions` as part of migration 14.

Update migration 14 (in `lib/migrate.ts`):

```typescript
  {
    version: 14,
    name: 'add_branch_project_mappings',
    sql: `
      CREATE TABLE IF NOT EXISTS branch_project_mappings (
        id INTEGER PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS branch_exclusions (
        branch_name TEXT PRIMARY KEY
      );
    `
  }
```

Then load exclusions in `loadMappings`:

```typescript
  const [epicRows, projRows, branchRows, exclRows, prefixRows, repoRows] = await Promise.all([
    // ... existing queries ...
    query<{ branch_name: string }>('SELECT branch_name FROM branch_exclusions'),
    // ...
  ]);

  return {
    // ...
    branchExclusions: exclRows.map(r => r.branch_name),
    // ...
  };
```

**Step 2: Add loadBranchAssociations function**

Add after `loadTicketAssociations` (after line 93):

```typescript
interface BranchRow {
  commit_id: number;
  branch_name: string;
}

async function loadBranchAssociations(commitIds: number[]): Promise<Map<number, string[]>> {
  if (commitIds.length === 0) return new Map();

  const placeholders = commitIds.map(() => '?').join(',');
  const rows = await query<BranchRow>(
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
```

**Step 3: Update main() to use branch data**

In `main()`, update the mapping loading log (around line 99-101):

```typescript
  const { epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults } = await loadMappings();
  console.log(
    `  Epic: ${epicMappings.size}, Project: ${projectMappings.size}, Branch: ${branchMappings.size}, Prefix: ${prefixMappings.size}, Repo defaults: ${repoDefaults.size}, Branch exclusions: ${branchExclusions.length}`,
  );
```

Update the context (line 108):

```typescript
  const ctx: MappingContext = { jiraIssues, epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults };
```

Update stats (line 123):

```typescript
  const stats = { epic: 0, jira_project: 0, branch_match: 0, message_prefix: 0, repo_default: 0, unallocated: 0, total: 0 };
```

In the batch loop, load branch associations alongside ticket associations (after line 131):

```typescript
    const ticketMap = await loadTicketAssociations(batchIds);
    const branchMap = await loadBranchAssociations(batchIds);
```

Update the commit resolution call (around line 136-138):

```typescript
        const ticketIds = ticketMap.get(commit.id) ?? [];
        const branchNames = branchMap.get(commit.id) ?? [];
        const result = resolveProjectForCommit(
          { ticketIds, repositoryId: commit.repository_id, message: commit.message, branchNames },
          ctx,
        );
```

Add branch_match to the stats log at the end:

```typescript
  console.log(`  Branch match: ${stats.branch_match}`);
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add scripts/resolve-projects.ts lib/migrate.ts
git commit -m "feat: load branch mappings and associations in resolve-projects"
```

---

### Task 8: Update seed-mappings.ts

**Files:**
- Modify: `scripts/seed-mappings.ts`

**Step 1: Update MappingsConfig interface**

Add the new fields (around line 26-32):

```typescript
interface MappingsConfig {
  projects: { name: string; description: string }[];
  epicMappings: Record<string, string>;
  jiraProjectMappings: Record<string, string>;
  branchMappings?: Record<string, string>;       // branch prefix → project name
  branchExclusions?: string[];                     // branch names to skip
  prefixMappings: Record<string, string>;
  repoDefaults: Record<string, string>;
}
```

**Step 2: Add seeding logic**

Add after the prefix mappings block (after line 129) and before the repo defaults block:

```typescript
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
```

Update the summary log to include branch info:

```typescript
    console.log(`  Branch mappings: ${branchCount}`);
    console.log(`  Branch exclusions: ${exclCount}`);
```

Renumber the existing repo defaults section comment from "5." to "7.".

**Step 3: Run tests**

Run: `pnpm test`
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add scripts/seed-mappings.ts
git commit -m "feat: seed branch mappings and exclusions from config"
```

---

### Task 9: Update mappings.json config

**Files:**
- Modify: `../pr_cat_prusa/mappings.json`

**Step 1: Add branchMappings and branchExclusions**

Add after the existing `prefixMappings` block:

```json
  "branchMappings": {
    "indx": "INDX",
    "ix": "AFS",
    "ixbuddy": "AFS",
    "core_one": "CORE One L"
  },
  "branchExclusions": ["private", "main", "master"]
```

**Step 2: Commit**

```bash
cd ../pr_cat_prusa && git add mappings.json && git commit -m "feat: add branch mappings and exclusions for resolution cascade v2"
```

---

### Task 10: End-to-end verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS.

**Step 2: Seed new mappings**

Run: `pnpm seed-mappings --config ../pr_cat_prusa/mappings.json`
Expected: Output shows branch mappings and exclusions seeded.

**Step 3: Re-resolve all commits**

Run: `pnpm resolve-projects --force`
Expected: Output shows non-zero `branch_match` count, reduced `repo_default` and `jira_project` counts compared to before.

**Step 4: Compare results**

Previous stats:
- Epic: 1496 (43%), Jira project: 733 (21%), Message prefix: 509 (15%), Repo default: 703 (20%)

Check the new distribution and verify General Buddy dropped significantly.

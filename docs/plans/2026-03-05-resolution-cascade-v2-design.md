# Resolution Cascade v2

**Status**: Implemented
**Date**: 2026-03-05
**Branch**: `feature/resolution-cascade-v2` (merged to main)

## Problem

43.9% of commits (1509/3441) landed in "General Buddy" catchall, defeating the purpose of cost allocation.

Two root causes:
1. **Epic self-reference gap** — commits referencing a ticket that IS itself a mapped epic (e.g. BFW-8007 = INDX) fell through because the code only checked the ticket's `epic_key` parent field, which is NULL for epics themselves.
2. **No branch-based resolution** — `commit_branches` data existed (all 3441 commits have branch associations) but the cascade didn't use it.

## Results

General Buddy dropped from **43.9% (1509) to 24.7% (851)** — 658 commits reclassified.

| Level | Before | After | Delta |
|-------|--------|-------|-------|
| Epic mapping | 1496 (43%) | 1534 (45%) | +38 (self-reference fix) |
| Jira project | 733 (21%) | 695 (20%) | -38 (moved to epic) |
| Branch match | 0 | 1034 (30%) | +1034 (new level) |
| Message prefix | 509 (15%) | 48 (1%) | -461 (caught by branch) |
| Repo default | 703 (20%) | 130 (4%) | -573 (caught by branch) |

## Cascade (6 levels)

```
1. Epic mapping      — ticket -> issue.epicKey -> epicMappings
                       + self-reference: if issue has no epicKey,
                         check if ticket key itself is in epicMappings
2. Jira project      — ticket -> issue.projectKey -> projectMappings
3. Branch matching   — commit_branches -> prefix match -> branchMappings  [NEW]
4. Message prefix    — commit message prefix -> prefixMappings
5. Repo default      — repository_id -> repoDefaults
6. null              — unallocated
```

## Change 1: Epic self-reference

When a ticket has no `epicKey`, the resolution now checks if the ticket key itself is in `epicMappings`. This catches commits that reference an epic directly (e.g. BFW-8007) rather than a child issue of that epic.

No schema changes. Logic fix in `resolveProjectForCommit`.

## Change 2: Branch pattern matching

### Schema (migration 14)

```sql
CREATE TABLE branch_project_mappings (
  id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE branch_exclusions (
  branch_name TEXT PRIMARY KEY
);
```

### Config

New keys in `mappings.json`:

```json
{
  "branchMappings": {
    "indx": "INDX",
    "ix": "AFS",
    "ixbuddy": "AFS",
    "core_one": "CORE One L"
  },
  "branchExclusions": ["private", "main", "master"]
}
```

- Keys in `branchMappings` are prefixes matched against the start of branch names (case-sensitive).
- `branchExclusions` lists branch names to ignore. `RELEASE*` and `REL_*` are also excluded by convention in code.

### Resolution logic

1. Load commit's branches from `commit_branches`.
2. Filter out excluded branches.
3. For each remaining branch, find the longest matching prefix in `branch_project_mappings`.
4. If all matching branches agree on one project -> resolve as `branch_match`.
5. If they disagree (ambiguous) -> skip, fall through to message prefix.

## Bonus fix: member deduplication

Fixed a bug where the same author with different git names (e.g. "Daniel Cejchan" vs "Daniel") appeared as separate rows in the cost allocation table. The grouping key now uses `author_id` alone when available.

## Files changed

| File | Change |
|------|--------|
| `scripts/lib/resolution-utils.ts` | Epic self-ref fix, `resolveBranchProject` function, updated interfaces |
| `scripts/resolve-projects.ts` | Load branch mappings/exclusions/associations, pass to cascade |
| `scripts/seed-mappings.ts` | Seed `branchMappings` and `branchExclusions` from config |
| `lib/migrate.ts` | Migration 14: `branch_project_mappings` + `branch_exclusions` tables |
| `__tests__/lib/resolve-projects.test.ts` | 10 new tests (27 total, was 17) |
| `components/cost-allocation-table.tsx` | Unique key fix for member rows |
| `lib/infrastructure/adapters/turso/commit-analytics.adapter.ts` | Group by `author_id` only (not name) |

## What didn't change

- `ingest-commits.ts` (branch data was already ingested)
- API routes, hexagonal ports/adapters, UI components (except the key fix)

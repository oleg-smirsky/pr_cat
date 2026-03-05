# Resolution Cascade v2

**Status**: Design approved
**Date**: 2026-03-05

## Problem

43.9% of commits (1509/3441) land in "General Buddy" catchall. This defeats the purpose of cost allocation. Two root causes:

1. **Epic self-reference gap** — commits referencing a ticket that IS itself a mapped epic (e.g. BFW-8007 = INDX) fall through because the code only checks the ticket's `epic_key` parent field, which is NULL for epics.
2. **No branch-based resolution** — `commit_branches` data exists (all 3441 commits have branch associations) but the cascade doesn't use it. Many General Buddy commits sit on clearly project-specific branches like `indx_dev`, `ixbuddy`, etc.

## Updated Cascade

```
1. Epic mapping      — ticket -> issue.epicKey -> epicMappings
                       + self-reference: if issue has no epicKey,
                         check if ticket key itself is in epicMappings
2. Jira project      — ticket -> issue.projectKey -> projectMappings
3. Branch matching   — commit_branches -> prefix match -> branchMappings  [NEW]
4. Message prefix    — commit message prefix -> prefixMappings
5. Repo default      — repository_id -> repoDefaults
```

## Change 1: Epic self-reference

When a ticket has no `epicKey`, check if the ticket key itself exists as a key in `epicMappings`. If so, resolve via that mapping.

No schema changes. Pure logic fix in `resolveProjectForCommit`.

## Change 2: Branch pattern matching

### Schema

New table (new migration):

```sql
CREATE TABLE branch_project_mappings (
  prefix TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  PRIMARY KEY (prefix)
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

- Keys in `branchMappings` are prefixes (case-sensitive, matched against start of branch name).
- `branchExclusions` lists exact branch names and prefixes (`RELEASE`, `REL_`) to ignore.

### Resolution logic

1. Load commit's branches from `commit_branches`.
2. Filter out excluded branches (exact match on exclusion list, plus prefix match on `RELEASE` and `REL_`).
3. For each remaining branch, find the longest matching prefix in `branch_project_mappings`.
4. If all matching branches agree on one project -> resolve as `branch_match`.
5. If they disagree (ambiguous) -> skip, fall through to message prefix.

### Data loading

`resolve-projects.ts` bulk-loads branch associations per batch, same pattern as `loadTicketAssociations`. Branch mappings loaded once into memory at startup like other mapping tables.

## Files touched

| Change | Files | Schema |
|--------|-------|--------|
| Epic self-reference | `scripts/lib/resolution-utils.ts`, test | None |
| Branch matching | `scripts/lib/resolution-utils.ts`, `scripts/resolve-projects.ts`, `scripts/seed-mappings.ts`, test | New migration |
| Config | `../pr_cat_prusa/mappings.json` | New `branchMappings` + `branchExclusions` keys |

## What doesn't change

- `ingest-commits.ts` (branch data already ingested)
- API layer, UI, hexagonal adapters

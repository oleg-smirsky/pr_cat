# Cherry-Pick Deduplication

**Status**: Draft — analysis complete, implementation pending
**Date**: 2026-03-05

## Problem

Some teams use cherry-picking extensively to propagate commits across branches (project branches, release branches, etc.). The same logical change creates multiple commits with different SHAs but identical messages. Currently each SHA counts as a separate commit in cost allocation, inflating totals and skewing percentages for projects with heavy cherry-pick workflows.

### Scale (example)

- **3000+ total commits** in the database
- **~2000 unique pieces of work** (grouping by message)
- **~1000 duplicates (~33%)** — cherry-picks counted multiple times
- **Hundreds of those land in different projects** — the same work gets credited to multiple projects

### Impact on cost allocation

Cherry-picking is not uniform across projects. This distorts allocation:

| Project | With duplicates | Deduplicated | Shift |
|---------|----------------|-------------|-------|
| Project Beta | 14% | 10% | -4% (over half its commits are cherry-picks) |
| Project Gamma | 9% | 14% | +5% (barely cherry-picks) |
| Project Alpha | 48% | 48% | ~0% |
| General | 14% | 14% | ~0% |
| Project Delta | 7% | 7% | — |

Projects with heavy cherry-pick workflows get more credit than they deserve, while projects that rarely cherry-pick are undercounted.

### How to reproduce

1. Run `pnpm resolve-projects --force` to ensure all commits are resolved
2. Compare total vs unique commits per project:

```sql
-- Total commits per project (current, inflated)
SELECT p.name, COUNT(*) as total
FROM commits c JOIN projects p ON c.project_id = p.id
GROUP BY p.name ORDER BY total DESC;

-- Unique work per project (deduplicated by message, earliest commit wins)
WITH canonical AS (
  SELECT MIN(c.id) as id
  FROM commits c
  GROUP BY SUBSTR(c.message, 1, 200)
)
SELECT p.name, COUNT(*) as deduped
FROM canonical cn
JOIN commits c ON c.id = cn.id
JOIN projects p ON c.project_id = p.id
GROUP BY p.name ORDER BY deduped DESC;
```

3. To see specific cherry-pick chains, pick any duplicated message:

```sql
-- Example: "ALPHA: Add build variant" appears as 3 different SHAs in 3 projects
SELECT c.id, c.sha, p.name, c.committed_at
FROM commits c
JOIN projects p ON c.project_id = p.id
WHERE c.message LIKE 'ALPHA: Add build variant%'
ORDER BY c.committed_at;
```

4. To find the most cherry-picked commits:

```sql
SELECT SUBSTR(c.message, 1, 80) as msg, COUNT(DISTINCT c.sha) as copies,
  COUNT(DISTINCT c.project_id) as projects
FROM commits c
GROUP BY SUBSTR(c.message, 1, 200)
HAVING copies > 3
ORDER BY copies DESC LIMIT 20;
```

## Proposed solution

Add an `is_canonical` boolean column to `commits`. During `resolve-projects`, after assigning projects, run a dedup pass:

1. Group commits by `SUBSTR(message, 1, 200)`
2. Within each group, mark the commit with the earliest `committed_at` as canonical
3. Set `is_canonical = 0` on the rest

Cost allocation queries add `WHERE is_canonical = 1`. This counts each piece of work once, attributed to the project where it first appeared.

### Why earliest commit date

The first `committed_at` corresponds to the original authoring — before cherry-picks propagated it to other branches. Example: a commit first authored for the v6.4 release, then cherry-picked to v6.5 branches. The earliest commit is the real one.

### Schema change

Migration 15:

```sql
ALTER TABLE commits ADD COLUMN is_canonical BOOLEAN DEFAULT 1;
CREATE INDEX idx_commits_is_canonical ON commits(is_canonical);
```

### What changes

- `resolve-projects.ts` — adds dedup pass after resolution
- Cost allocation adapter queries — add `WHERE is_canonical = 1`
- CSV export — reflects deduplicated numbers

### What doesn't change

- Ingestion (all commits still stored)
- Branch associations
- Project resolution cascade logic
- `is_canonical` is a soft flag — set `--force` on resolve-projects to recompute

# Commit Analysis & Cost Allocation

**Status**: Implemented (v1)
**Branch**: `feature/commit-analysis`

## Purpose

PR Cat already tracks pull requests. This feature adds **commit-level analysis** to answer a different question: *where does the team's time actually go?*

The primary use case is **cost allocation** — distributing a team's monthly cost across repositories (and eventually projects) in proportion to their commit activity. This gives managers a data-driven view of how engineering investment maps to products.

## Goals

1. **Understand where work goes** — commits across repos, not just PRs
2. **Distribute team costs** to products/projects based on commit activity
3. **Analyze contribution** at the commit level per developer
4. *(Future)* Developer productivity analysis, project-level grouping

## Current Scope

What's built today:

- **Batch pipeline only** — fetch from GitHub, cache locally, ingest into DB. No webhooks, no incremental sync.
- **Cost allocation by raw commit count** — no weighting by lines changed or complexity.
- **Grouping by repository** — `project_id` exists in the schema but is not populated yet.
- **Team filtering** via existing teams infrastructure.
- **UI page** at `/dashboard/cost-allocation` with month picker, team selector, cost input, and CSV export.

What's explicitly out of scope for now — see [Future Phases](#future-phases).

## Architecture

### Data Pipeline: Fetch → Cache → Ingest → Query

The pipeline is intentionally split into two offline steps so ingestion can be re-run without hitting GitHub again.

```
GitHub API ──fetch──▶ .cache/github/{owner}/{repo}/commits/{sha}.json
                                       │
                     ◀──ingest──────────┘
                     │
              ┌──────▼──────┐
              │  commits DB  │──query──▶ /api/analytics/cost-allocation
              │  (LibSQL)    │                        │
              └──────────────┘                        ▼
                                              Cost Allocation UI
```

**Why cache to disk?** GitHub's rate limit is 5000 req/hr. A large repo's full history may need thousands of individual commit fetches. Caching by SHA means we never re-fetch the same commit, and the cache survives across runs. The full GitHub API response is stored — file-level change data is available for future analysis without re-fetching.

**Why separate fetch from ingest?** Ingestion logic (Jira extraction, author resolution) will evolve. Being able to re-run ingestion on cached data without touching GitHub is valuable for development and debugging.

### Hexagonal Architecture Integration

The cost allocation query follows the project's hexagonal pattern:

- **Port**: `ICommitAnalyticsService` in `lib/core/ports/commit-analytics.port.ts`
- **Turso adapter**: `TursoCommitAnalyticsService` — SQL aggregation query
- **Demo adapter**: `DemoCommitAnalyticsService` — hardcoded mock data
- **DI**: Registered as `CommitAnalyticsService` in the DI container, available via `ServiceLocator.getCommitAnalyticsService()`
- **API route**: `GET /api/analytics/cost-allocation` uses `withAuth` + `ServiceLocator`

The fetch and ingest scripts are **not** part of the hexagonal architecture — they're standalone batch scripts in `scripts/` that operate outside the Next.js runtime.

## Data Model

### Tables (migration 5)

**`projects`** — Business-level grouping (e.g. "Core One"). Not tied to GitHub orgs; a project can span multiple repos. Currently unused — exists for future project resolution.

**`commits`** — One row per `(sha, repository_id)`. Key fields:
- `author_id` (nullable) — FK to `users`. Resolved during ingestion by GitHub ID then email fallback. NULL for external contributors or unmatched authors.
- `jira_ticket_id` (nullable) — Extracted from first line of commit message via regex `^[A-Z]+-\d+`.
- `project_id` (nullable) — Reserved for future project resolution. Always NULL today.
- `pull_request_id` (nullable) — Reserved for future PR-commit linking.

**`commit_branches`** — Many-to-many join. A commit can appear on multiple branches. Branch names are signals for future AI project resolution.

### Design Decisions

- **`author_id` is nullable** because not all committers are app users. Bots, external contributors, and unmatched emails result in NULL.
- **`projects` has no organization FK** because projects are business concepts that can span orgs and repos.
- **No alias table** for author email deduplication yet. If multiple emails per person becomes a problem, add `author_aliases` later.
- **Commit count only** (no LOC weighting) for cost allocation — keeps it simple and avoids debates about what "counts."

## Scripts

### `pnpm fetch-commits`

Fetches commits from GitHub and caches them locally.

```bash
pnpm fetch-commits --repos owner/repo1,owner/repo2 --since 2025-01-01
```

- Requires `GITHUB_TOKEN` env var
- Caches to `.cache/github/` (gitignored)
- Skips already-cached SHAs (resumable)
- Respects GitHub rate limits (pauses when remaining < 100)
- Branch names with `/` are sanitized to `__` in filenames

Utilities in `scripts/lib/cache-utils.ts` (tested in `__tests__/lib/cache-utils.test.ts`).

### `pnpm ingest-commits`

Reads cached JSON and populates the database.

```bash
pnpm ingest-commits --repos owner/repo1,owner/repo2
```

- Requires `TURSO_URL` (reads `.env.local` via dotenv)
- Repos must already exist in the `repositories` table (warns and skips if not found)
- Idempotent — uses `INSERT OR IGNORE` on the unique constraint
- Processes in batches of 100 within transactions
- Extracts Jira tickets and resolves authors during ingestion

Utilities in `scripts/lib/commit-utils.ts` (tested in `__tests__/lib/commit-utils.test.ts`).

### Author Resolution

Resolution order during ingestion:
1. `author.id` (GitHub numeric ID from API) → match `users.id`
2. `commit.author.email` → match `users.email`
3. Unmatched → `author_id = NULL`

## Cost Allocation

### Semantics

- **Team membership** = organizational (who's on the team in the app)
- **Commit location** = where they actually contributed (may cross team boundaries)
- A person on Team Firmware committing to a Team Cloud repo → cost comes from Firmware's budget, allocated to Cloud's repository
- Monthly cost is entered by the user in the UI (not stored) — the system provides commit proportions, the user applies their budget number

### API

`GET /api/analytics/cost-allocation?month=YYYY-MM&teamId=N`

Returns `CostAllocationResult`:
- `members[]` — per-author breakdown with nested `repos[].commits`
- `repoTotals[]` — aggregate per-repo with `percentage`
- `totalCommits` — grand total
- `team` — team info if filtered (null otherwise)

### UI

Page at `/dashboard/cost-allocation` (linked from sidebar). Features:
- Month picker, team selector
- Table: rows = developers, columns = repos, cells = commit counts
- Footer row with repo totals and percentages
- Cost input field — multiplies percentages to show per-repo cost allocation
- CSV export

## Test Coverage

| Test file | What it covers | Count |
|-----------|---------------|-------|
| `__tests__/lib/cache-utils.test.ts` | Fetch script utilities (path sanitization, arg parsing) | 20 |
| `__tests__/lib/commit-utils.test.ts` | Jira extraction, commit JSON parsing, branch name desanitization | 17 |
| `__tests__/lib/commit-analytics.test.ts` | Turso adapter SQL grouping, month boundaries, team filtering | 4 |
| `__tests__/api/cost-allocation.test.ts` | API route validation, error handling, happy path | 9 |

All tests mock `@/lib/db` — no real database is used in tests.

## Future Phases

Roughly in priority order:

1. **Project resolution** — populate `project_id` on commits. Strategies: manual assignment, AI inference from commit messages + branch names, Jira ticket → epic → project mapping.
2. **Incremental sync** — webhook-driven commit ingestion instead of batch fetching.
3. **LOC-weighted allocation** — option to weight by `additions + deletions` instead of raw count.
4. **PR-commit linking** — populate `pull_request_id` to connect commits to their PRs.
5. **Jira integration** — full sync of Jira projects/epics for automatic project tree mapping.
6. **File-level analysis** — the cached data already includes per-file changes; build analysis on top.
7. **Fork tracking** — discover and track private forks.
8. **Developer productivity metrics** — commit patterns, velocity, focus areas.
9. **Connected repo discovery** — auto-detect repos related to a product.
10. **Author alias table** — handle multiple emails per person (`author_aliases`).

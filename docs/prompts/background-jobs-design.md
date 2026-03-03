# Design: Background Job System for PR Cat

## Context

PR Cat is a Next.js app that tracks GitHub pull requests for organizations. It runs in two modes:
- **App mode**: GitHub App with webhooks for real-time updates
- **Token mode**: Personal Access Token with poll-based sync (no webhooks, localhost can't receive them)

The app uses SQLite (local file via libsql) for storage. There is no Redis, no external queue, no separate worker process. Everything runs inside the Next.js server.

### The Problem

When a user enables tracking for a repository, we sync all PRs from the GitHub API in a single request handler (`POST /api/github/repositories/[repositoryId]/webhook/route.ts`). For large repos (9000+ PRs), this means:

1. **PR listing**: ~93 paginated API calls (100 per page)
2. **Review sync**: 1 API call per new PR to fetch reviews
3. **Total**: potentially 9000+ API calls in a single request

This causes:
- Request timeouts
- Circuit breaker trips (we have a global limiter at 10 requests/10 seconds in `lib/github.ts`)
- Incomplete data — reviews are only fetched for PRs created during the initial sync, and even those get cut short
- Bad recommendations — the system sees PRs without reviews and concludes "no code reviews happening"

### Current Architecture

Key files to read:
- `AGENTS.md` — project structure, conventions, build commands
- `docs/architecture/README.md` — layer map
- `lib/github.ts` — `GitHubClient` class, all GitHub API calls go through `executeWithTokenRefresh`. Has a global circuit breaker (sliding window, 10 req/10s)
- `lib/services/github-service.ts` — `GitHubService` class with `syncRepositoryPullRequests()` and `syncPullRequestReviews()`
- `lib/repositories/` — DB access layer (SQLite via libsql)
- `app/api/github/repositories/[repositoryId]/webhook/route.ts` — where tracking is enabled (token mode branch does `setRepositoryTracking` + `syncRepositoryPullRequests`)
- `lib/infrastructure/config/environment.ts` — environment/mode detection
- `auth.ts` — authentication, `isTokenMode` detection

### Constraints

- No external services (no Redis, no Bull, no cron daemon). Must work with just Next.js + SQLite.
- Must respect the GitHub API circuit breaker (10 requests per 10 seconds). Jobs should throttle themselves.
- Must work in token mode (PAT-based auth, no GitHub App installation tokens).
- SQLite is single-writer — no concurrent write contention issues, but long-running transactions should be avoided.
- The app runs as a single Next.js process (local dev or single-instance deploy). No need for distributed locking.
- Follow existing code conventions: TypeScript, repository pattern for DB access, services for business logic.

## What to Design

### 1. Background Job Framework

Design a lightweight job system stored in SQLite with:

**Job registry/table:**
- Job name (e.g., `sync-pr-reviews`, `sync-repository-prs`, `cleanup-stale-data`)
- Status: `idle`, `running`, `failed`
- Last run timestamp
- Next scheduled run (optional, for recurring jobs)
- Progress metadata (e.g., `{ completed: 5000, total: 9315, lastProcessedPrId: 4521 }`)
- Error info if failed
- Created/updated timestamps

**Job runner:**
- Triggered via API endpoint (manual) or interval-based polling (automatic)
- Runs inside the Next.js process (no separate worker)
- Respects circuit breaker — processes items in small batches with delays between batches
- Resumable — if interrupted, picks up where it left off using progress metadata
- Only one instance of a job runs at a time (use SQLite row-level status check)

**API endpoints:**
- `GET /api/jobs` — list all jobs with status, last run, progress
- `POST /api/jobs/[jobName]/run` — trigger a job manually
- `DELETE /api/jobs/[jobName]` — cancel a running job

**Optional UI:**
- Simple admin page showing job status, progress bars, last run times, and "Run Now" buttons

### 2. Specific Jobs to Implement

**`sync-pr-reviews` (highest priority):**
- Finds PRs in the DB that have no reviews synced (LEFT JOIN reviews table, WHERE reviews.id IS NULL)
- Processes them in batches (e.g., 5 PRs at a time, then wait)
- For each PR: calls `GitHubService.syncPullRequestReviews(owner, repo, prNumber, prId)`
- Tracks progress: how many PRs processed, how many remaining
- Resumable: stores the last processed PR ID

**`sync-repository-prs` (for incremental updates):**
- For each tracked repository, fetches recent PRs (state=all, sorted by updated_at desc)
- Stops when it hits PRs already in the DB with matching updated_at
- This replaces the "fetch all 9000 PRs" approach for subsequent syncs
- Should run periodically (e.g., every 15 minutes in token mode since there are no webhooks)

**`full-repository-sync` (for initial setup):**
- The heavy "fetch all PRs" operation, moved out of the request handler
- When user clicks "Enable", just set `is_tracked = true` and enqueue this job
- Processes PRs in batches with throttling
- Fetches reviews as part of the same job (not separately)

### 3. Migration for Initial Sync

The existing `syncRepositoryPullRequests` in the webhook route should:
- In token mode: just set `is_tracked = true`, enqueue `full-repository-sync`, and return immediately with a message like "Repository tracked. Initial sync started in background."
- The UI should show sync progress (optional, can be a follow-up)

## Output Expected

1. A SQLite migration for the jobs table
2. The job runner infrastructure (service + repository)
3. API routes for job management
4. The three job implementations listed above
5. Updated webhook route to use background jobs instead of inline sync
6. Any necessary changes to the circuit breaker to support background job throttling

## What NOT to Change

- Don't restructure existing code that works (metrics, dashboard, settings)
- Don't add external dependencies (Redis, Bull, etc.)
- Don't change the GitHub App mode flow — all changes should be additive
- Don't change the auth system

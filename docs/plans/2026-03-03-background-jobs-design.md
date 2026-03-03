# Design: Background Job System

## Problem

When a user enables tracking for a large repository (9000+ PRs), the sync runs inline in the request handler causing timeouts, circuit breaker trips, and incomplete data. Reviews are only partially fetched, leading to bad recommendations.

## Decision: In-process setTimeout loop with SQLite persistence

Approach A from brainstorming. Jobs are stored in SQLite, claimed atomically, and executed in the main Node.js process via a `setTimeout` polling chain. No external dependencies (no Redis, no Bull, no cron).

Why not CQRS or event sourcing: single process, single SQLite writer, no distributed workers. The claim-and-process pattern is sufficient.

## Database Schema (Migration 5)

```sql
CREATE TABLE IF NOT EXISTS background_jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  next_run_at TEXT,
  interval_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_background_jobs_next_run ON background_jobs(next_run_at);
```

- `name` is UNIQUE — one job per logical task (e.g., `full-repository-sync:42`).
- `type` groups jobs for handler registry lookup.
- `progress` is JSON text — flexible per job type, stores cursor for resumability.
- `next_run_at` + `interval_seconds` — recurring jobs re-schedule after completing.

## Architecture

### Hexagonal layer placement

- **Port:** `lib/core/ports/job.port.ts` — `IJobService` interface
- **Adapter:** `lib/infrastructure/adapters/jobs/job.adapter.ts` — SQLite impl
- **Job runner:** `lib/infrastructure/adapters/jobs/job-runner.ts` — singleton, tick loop
- **Job handlers:** `lib/jobs/handlers/` — use legacy GitHubService directly (pragmatic; noted as legacy dependency)
- **DI registration:** `lib/core/container/di-container.ts`

### IJobService port

```typescript
interface IJobService {
  enqueue(type: string, name: string, progress?: Record<string, unknown>): Promise<BackgroundJob>
  cancel(name: string): Promise<void>
  getAll(): Promise<BackgroundJob[]>
  getByName(name: string): Promise<BackgroundJob | null>
  updateProgress(id: number, progress: Record<string, unknown>): Promise<void>
  scheduleRecurring(type: string, intervalSeconds: number): Promise<void>
}
```

### Job runner (singleton)

- Starts on server boot via `instrumentation.ts` (`NEXT_RUNTIME === 'nodejs'`).
- Polls every 10 seconds via `setTimeout` chain (not `setInterval`).
- Claims jobs atomically: `UPDATE ... SET status='running' WHERE id=? AND status='pending'`.
- Detects stale running jobs (started_at > 10 min ago) and resets to pending.
- One job at a time (single-threaded, I/O-bound work yields naturally).

### Tick loop

1. Query oldest pending job where `next_run_at IS NULL OR next_run_at <= now`.
2. Atomically claim it (UPDATE with status check).
3. Look up handler by `type` in registry.
4. Execute handler with `AbortSignal` for cancellation.
5. On success: `status='completed'`. If recurring: insert new pending job with `next_run_at`.
6. On error: `status='failed'`, store error_message.

### Throttling

Each job handler manages its own batching to respect the circuit breaker (10 req / 10s):
- Process 5 items per batch.
- Wait 12 seconds between batches.
- Update progress in DB after each batch.

## Job Implementations

### full-repository-sync

- **Trigger:** User enables tracking (webhook route, token mode only).
- **Name:** `full-repository-sync:<repositoryId>`
- **Phase 1:** Fetch all PRs (paginated, 100/page). Upsert into DB. Track `progress.prsPage`.
- **Phase 2:** Fetch reviews for all PRs missing them. Batch of 5, 12s delay.
- **Resumable:** On restart, skips PRs already in DB and reviews already fetched.

### sync-repository-prs (recurring, 15 min)

- **Token mode only.** Registered on startup.
- **Name:** `sync-repository-prs`
- For each tracked repo: fetch recent PRs sorted by `updated_at desc`.
- Stop when hitting a PR whose `updated_at` matches DB (incremental sync).
- One repo at a time, delays between API calls.

### sync-pr-reviews (recurring, 15 min)

- **Token mode only.** Registered on startup.
- **Name:** `sync-pr-reviews`
- Query PRs with zero reviews (LEFT JOIN pr_reviews WHERE r.id IS NULL).
- Process in batches of 5, 12s delay.
- Track `progress.completed`, `progress.total`, `progress.lastPrId`.

## API Routes

```
GET    /api/jobs              → list all jobs with status/progress
POST   /api/jobs/[jobName]/run → trigger a job manually
DELETE /api/jobs/[jobName]     → cancel a running job
```

All routes use `withAuth` middleware.

## Webhook Route Changes

Token mode POST handler changes from:

```typescript
await githubService.syncRepositoryPullRequests(owner, repo, repositoryId)
```

To:

```typescript
await jobService.enqueue('full-repository-sync', `full-repository-sync:${repositoryId}`, {
  repositoryId, owner, repo
})
return { message: "Repository tracked. Initial sync started in background." }
```

GitHub App mode is unchanged.

## File Layout

```
lib/core/ports/job.port.ts
lib/infrastructure/adapters/jobs/
  job.adapter.ts
  job-runner.ts
lib/jobs/
  types.ts
  handlers/
    full-repository-sync.ts
    sync-repository-prs.ts
    sync-pr-reviews.ts
app/api/jobs/route.ts
app/api/jobs/[jobName]/run/route.ts
app/api/jobs/[jobName]/route.ts
instrumentation.ts
```

## What Does NOT Change

- GitHub App mode flow (webhook-driven sync).
- Auth system.
- Existing metrics, dashboard, settings code.
- No new external dependencies.

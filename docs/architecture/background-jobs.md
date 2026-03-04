# Background Job System

Lightweight SQLite-backed job queue running inside the Next.js process. No external dependencies (no Redis, no Bull, no cron daemon).

## Why

Syncing large repositories (9000+ PRs) inline in request handlers causes timeouts and circuit breaker trips. Background jobs move this work out of the request path with throttled batching.

## How it works

A singleton `JobRunner` starts on server boot via `instrumentation.ts`. It polls the `background_jobs` table every 10 seconds using a `setTimeout` chain (not `setInterval` — one tick completes before the next is scheduled). When it finds a pending job, it atomically claims it (`UPDATE ... WHERE status='pending'`), looks up the handler by type, and executes it.

Jobs are I/O-bound (GitHub API calls with mandatory delays), so they yield the event loop naturally. One job runs at a time.

## Database

Migration 6 adds the `background_jobs` table:

| Column | Purpose |
|---|---|
| `name` | Unique key per logical task, e.g. `full-repository-sync:42` |
| `type` | Handler lookup key, e.g. `full-repository-sync` |
| `status` | `pending` → `running` → `completed` / `failed` |
| `payload` | Immutable JSON — input data set at enqueue time |
| `progress` | Mutable JSON — runtime state updated during execution |
| `interval_seconds` / `next_run_at` | Recurring job scheduling |

## Architecture

Follows the hexagonal pattern used by the rest of the app:

```
lib/core/ports/job.port.ts          — IJobService interface
lib/infrastructure/adapters/jobs/
  job.adapter.ts                     — SQLiteJobService (implements IJobService)
  job-runner.ts                      — JobRunner singleton (tick loop, handler registry)
lib/jobs/
  types.ts                           — BackgroundJob, JobHandler, JobStatus
  handlers/
    full-repository-sync.ts          — Initial full sync of a repository
    sync-repository-prs.ts           — Incremental PR sync (recurring)
    sync-pr-reviews.ts               — Fetch missing reviews (recurring)
app/api/jobs/
  route.ts                           — GET  /api/jobs (list all)
  [jobName]/run/route.ts             — POST /api/jobs/:name/run (trigger)
  [jobName]/route.ts                 — DELETE /api/jobs/:name (cancel)
instrumentation.ts                   — Starts runner, registers handlers
```

Registered in DI container as `JobService`. Accessible via `ServiceLocator.getJobService()`.

## Job lifecycle

```
User enables tracking
  → webhook route enqueues full-repository-sync:<repoId>
  → JobRunner picks it up, fetches all PRs + reviews with throttling
  → On completion, enqueues two recurring jobs:
      sync-repository-prs:<repoId>  (every 15 min)
      sync-pr-reviews:<repoId>      (every 15 min)

User disables tracking
  → webhook route cancels all three jobs for that repo
```

Recurring jobs re-schedule themselves after each successful run by resetting status to `pending` with `next_run_at` pushed forward by `interval_seconds`.

## Throttling

Each handler batches API calls to stay under the circuit breaker (10 req / 10s window in `lib/github.ts`):
- PR pages: one page (100 PRs), then 12s delay
- Reviews: 5 PRs per batch, then 12s delay
- Progress is written to DB after each batch (resumable on restart)

## Stale job recovery

If a job has `status='running'` with `started_at` older than 10 minutes and no progress update, the tick loop resets it to `pending`. This handles process crashes mid-job.

## Adding a new job type

1. Create a handler class implementing `JobHandler` in `lib/jobs/handlers/`
2. Register it in `instrumentation.ts`: `runner.registerHandler('my-job', new MyHandler(...))`
3. Enqueue it: `runner.enqueue('my-job', 'my-job:some-key', { ... })`

## API

All routes require authentication (`withAuth` middleware).

| Method | Path | Description |
|---|---|---|
| GET | `/api/jobs` | List all jobs with status, progress, timestamps |
| POST | `/api/jobs/:name/run` | Re-trigger a completed/failed job |
| DELETE | `/api/jobs/:name` | Cancel a pending or running job |

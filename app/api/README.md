# API Route Guide

API routes live under `app/api/*` and should keep handlers thin.

## Preferred handler pattern

1. parse transport data (query/body/path)
2. apply auth with `withAuth` where needed
3. resolve behavior via `ServiceLocator` from `@/lib/core`
4. return explicit HTTP responses

## Notes on migration

Some routes still import legacy modules from `@/lib/services/*` and `@/lib/repositories/*`.
For new work, avoid extending that pattern unless migration constraints require it.

See:

- `docs/architecture/migration-status.md`
- `docs/playbooks/change-routing.md`


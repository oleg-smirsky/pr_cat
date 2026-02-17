# Migration Status

The architecture is intentionally documented as hybrid to avoid hidden coupling.

## Stable surfaces (use these patterns)

- `app/api/metrics/*` route handlers call `ServiceLocator` from `@/lib/core`.
- `app/api/pull-requests/*` route handlers call `ServiceLocator` from `@/lib/core`.
- `app/api/organizations/route.ts` and `app/api/repositories/route.ts` use `withAuth` + core context.

## Legacy surfaces (touch only when required)

- Routes that directly import from `@/lib/services/*` and `@/lib/repositories/*`.
- Debug and sync endpoints with direct repository or GitHub service access.

## Rule of thumb

- New feature work should land in core ports + infrastructure adapters.
- Legacy modules may be updated for bug fixes, but new behavior should not increase their scope.
- If a task requires legacy edits, add a short note in the PR about why migration was not feasible in that change.


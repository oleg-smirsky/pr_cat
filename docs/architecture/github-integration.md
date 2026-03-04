# GitHub Integration

## Circuit Breaker

All GitHub API calls go through `GitHubClient.executeWithTokenRefresh()` in `lib/github.ts`. A global circuit breaker enforces **10 requests per 10 seconds** across all client instances. Exceeding the limit throws immediately without calling GitHub. The breaker self-heals after the window passes.

Bulk sync for large repos (9000+ PRs) will trip the breaker. Such operations must use background jobs with throttling, not inline request handlers.

## Token Mode

When `GITHUB_TOKEN` is set and GitHub App credentials are absent, the app runs in token mode (PAT-based auth). Key differences from App mode:

- All orgs are marked `isGithubConnected: true` (no App installation check)
- Webhook creation is skipped — repos tracked via `is_tracked` flag + API poll
- `session.isTokenMode` is exposed to client components for conditional rendering
- Accessible-repos API call is skipped (all repos the PAT can see are accessible)

Detection logic: `lib/infrastructure/config/environment.ts` and the module-level `isTokenMode` const in `auth.ts`.

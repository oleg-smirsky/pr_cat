# Repository Guidelines

## Project Structure & Module Organization

- `app/`: Next.js App Router pages, layouts, and route handlers (API under `app/api/*`).
- `components/`: Shared React components (design-system primitives in `components/ui/`).
- `lib/`: Core application logic (DB access, GitHub integrations, services, shared utilities).
- `hooks/`: Reusable React hooks (naming pattern: `use-*.ts(x)`).
- `__tests__/`: Jest tests (`__tests__/lib` for unit-ish logic, `__tests__/api` for route-handler coverage).
- `migrations/`: SQL migration files (ordered `00x_*.sql`).
- `scripts/`: One-off Node scripts (e.g. `scripts/generate-mock-data.js`).
- `public/`: Static assets served by Next.js.

## Agent Orientation Harness

- Start with `docs/README.md` for reading order and architecture entrypoints.
- Canonical architecture map: `docs/architecture/README.md`.
- Current migration state (core vs legacy modules): `docs/architecture/migration-status.md`.
- Route-level implementation playbook: `docs/playbooks/change-routing.md`.
- Machine-readable architecture contracts:
- `docs/architecture/repository-manifest.json`
- `docs/architecture/dependency-rules.json`

## Build, Test, and Development Commands

- `pnpm install`: Install dependencies (pnpm is the expected package manager).
- `pnpm dev`: Run local dev server (Next.js with Turbopack).
- `pnpm build` / `pnpm start`: Production build and local production server.
- `pnpm lint`: Run ESLint and architecture harness checks across the repo.
- `pnpm architecture:check`: Validate architecture manifest and dependency boundaries.
- `pnpm test`: Run the full Jest suite.
- `pnpm test:watch`: Watch mode for local iteration.
- `pnpm test:unit` / `pnpm test:integration`: Narrow runs for `__tests__/lib` and `__tests__/api`.
- `pnpm test:ci`: CI-style run with coverage enabled.

## Coding Style & Naming Conventions

- TypeScript is in `strict` mode; prefer explicit types at module boundaries and for public helpers in `lib/`.
- Use the path alias `@/…` for internal imports (configured in `tsconfig.json`).
- Keep components in PascalCase and hooks in the `use-*.ts(x)` pattern; colocate component-specific helpers nearby.
- Treat `pnpm-lock.yaml` as authoritative; update it only via `pnpm`.

## Testing Guidelines

- Jest + `next/jest` with `jsdom`; tests live under `__tests__/` and use `*.test.ts(x)`.
- Global coverage thresholds are enforced (see `jest.config.js`); include tests for new logic and bug fixes.

## Commit & Pull Request Guidelines

- Commit messages in history are short and topic-focused (e.g. “cleanup”, “db optimizations”); prefer an imperative summary and add an optional scope when helpful (`auth: …`, `db: …`).
- PRs should be small and atomic, include a clear description, and add screenshots for UI changes; run `pnpm lint` and relevant `pnpm test:*` commands before requesting review.

## Cost Allocation Pipeline

Scripts in `scripts/` implement a commit-based cost allocation pipeline. Run in order:

1. `pnpm fetch-commits` — fetch commits from GitHub API into `.cache/` (add `--team-config <path>` to also discover and fetch from team members' forks)
2. `pnpm ingest-commits` — parse and insert commits into the database
3. `pnpm fetch-jira-issues` / `pnpm ingest-jira-issues` — fetch and store Jira ticket data
4. `pnpm seed-mappings --config ../pr_cat_prusa/mappings.json` — load project/epic/prefix mappings
5. `pnpm resolve-projects` — resolve each commit to a project via the cascade (epic → jira project → message prefix → repo default), then deduplicate cherry-picks
6. `pnpm export-csv` — export denormalized canonical commits as CSV (`exports/commits.csv`)
7. `pnpm export-report` — generate interactive HTML allocation report (`exports/allocation-report.html`)

### Allocation Report

`pnpm export-report` generates a drill-down HTML report: Month → Project (team %) → Person (FTE) → Commits.

```
pnpm export-report -- --team <name> --from 2025-10 --to 2026-02
pnpm export-report -- --team <name> --month 2026-02
pnpm export-report                                    # all people, all months
```

- `--team <name>` — filter to a team defined in the config file (loads members and FTE capacity)
- `--config <path>` — path to mappings JSON (default: `../pr_cat_prusa/mappings.json`)
- `--from` / `--to` — month range (YYYY-MM)
- `--month` — single month shorthand

Team configuration (members, emails, capacity) lives in `../pr_cat_prusa/mappings.json` under `"teams"`. The report reads already-computed `project_id` and `is_canonical` from the database — it does not duplicate resolution logic.

## Configuration & Security Tips

- Create local config via `cp environment.example .env.local` (see `ENVIRONMENT_SETUP.md` for GitHub/Turso details).
- For a fresh Turso database in development, initialize schema via `curl -X POST http://localhost:3000/api/migrate`.
- Never commit secrets or private keys; avoid logging raw tokens, webhook secrets, or JWT material.

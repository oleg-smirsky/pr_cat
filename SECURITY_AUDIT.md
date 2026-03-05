# Security Audit Report: pr_cat

**Date:** 2026-03-03

## Prompt Injection: CLEAN

No prompt injection attacks were found anywhere in the project. Specifically:

- No hidden instructions targeting AI assistants
- No zero-width Unicode characters or invisible text
- No base64-encoded payloads in source code
- No HTML comments hiding instructions in non-HTML files
- No "ignore previous instructions" or system prompt override attempts
- No `CLAUDE.md` in the project
- No suspicious npm lifecycle hooks (`preinstall`/`postinstall`)
- The `.claude/`, `.agent/`, `.agents/`, and `.cursor/` directories contain only legitimate coding guidelines (Vercel React best practices, composition patterns, web design guidelines)

**One supply chain note:** `.agents/skills/web-design-guidelines/SKILL.md` fetches content at runtime from `raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`. This is a legitimate Vercel repo, but if that upstream repo were ever compromised, it could introduce injected instructions.

---

## Code Security Vulnerabilities

### CRITICAL

1. **Hardcoded demo JWT secret** (`auth.ts:16`) — If `NEXTAUTH_SECRET` is unset, a publicly-known static string is used to sign JWTs. An attacker can forge any session.

2. **Unauthenticated migration endpoint** (`app/api/migrate/route.ts`) — No auth check. Anyone can POST to `/api/migrate` and run database schema changes. The code even has a comment acknowledging this: *"you might want to add authentication here"*.

3. **SQL injection via dynamic column names** (`lib/repositories/pr-repository.ts:69-93`, `team-repository.ts`, `user-repository.ts`, `category-repository.ts`, `organization-repository.ts`) — While values are parameterized, column names and ORDER BY directions are interpolated directly into SQL strings. If any caller passes user-controlled data, SQL injection is possible.

4. **Webhook verification skipped in dev** (`app/api/webhook/github/route.ts:20-62`) — When `GITHUB_WEBHOOK_SECRET` is unset and `NODE_ENV !== 'production'`, any forged webhook is accepted and processed.

### HIGH

5. **API keys stored in plaintext** (`lib/repositories/settings-repository.ts`) — OpenAI/Google/Anthropic API keys are stored unencrypted in the database.

6. **Debug endpoints leak cross-user data** (`app/api/debug/github-orgs/route.ts`, `app/api/debug/user-data/route.ts`) — Any authenticated user can dump all organizations, all user-organization links, and database schema via `PRAGMA table_info`.

7. **Unauthenticated info disclosure endpoints** — `/api/container-status`, `/api/demo-status`, `/api/mode-switch-test`, `/api/health` expose internal architecture, service registration, and environment variable configuration without any auth.

8. **GitHub access token in client-side session** (`auth.ts:200-211`) — The OAuth access token (with `repo` scope) is stored in the JWT and sent to the browser on every request.

9. **Webhook secret fallback to OAuth client secret** (`lib/github.ts:307`, webhook route) — If `GITHUB_WEBHOOK_SECRET` is unset, the OAuth client secret is used instead, coupling two secrets that should be independent.

### MEDIUM

10. **IDOR in categorize-pr endpoint** (`app/api/debug/categorize-pr/route.ts`) — Any authenticated user can categorize any PR by ID with no ownership check.

11. **Inconsistent authorization** — Some routes use `withAuth` middleware, others do manual `auth()` checks without organization membership verification.

12. **In-memory webhook replay prevention** (`lib/webhook-security.ts`) — Uses a `Map` that resets on every serverless cold start. Not effective on Vercel.

13. **Open redirect via `//`** (`app/api/auth/logout/route.ts`) — `isValidCallbackUrl` accepts URLs starting with `/`, but `//evil.com` is a protocol-relative URL that passes the check.

14. **`trustHost: true`** (`auth.ts:298`) — Trusts the `Host` header, enabling host header injection in non-Vercel deployments.

15. **No CSRF protection** on custom state-changing API routes beyond session cookies.

### LOW

16. **Overly broad OAuth scope** — `repo` grants full read/write to all user repos; app likely only needs read access.

17. **Non-functional proxy timestamp check** (`proxy.ts:22-37`) — Parses `x-github-delivery` (a UUID) as a `Date`, always producing `NaN`. The check never rejects anything.

18. **LIKE wildcard injection** (`team-repository.ts:339`) — `searchUsers` doesn't escape `%` and `_` in search terms.

19. **Missing CSP and HSTS headers** in `vercel.json`.

20. **Excessive sensitive data logging** — SQL parameters, user emails, API key metadata logged in various files.

21. **`.gitignore` only excludes `.env.local`** — Other patterns like `.env`, `.env.production`, `.env.staging` would be committed if created.

22. **`dangerouslySetInnerHTML`** in `components/ui/chart.tsx:83` — Used for dynamic CSS injection from theme config objects. Low risk since values are developer-controlled, not user-supplied.

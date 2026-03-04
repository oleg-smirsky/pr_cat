# Team Auto-Population from Repository Contributors

**Status:** Implemented

## Overview

Bulk-add team members by selecting a repository and importing its contributors. Eliminates the need to manually add members one by one.

## User Flow

1. Settings → Teams tab → click **Populate** on a team card
2. Select a repository from the dropdown
3. Preview matched contributors (checkboxes, all selected by default)
4. Deselect anyone unwanted, click **Add N members**
5. Toast confirms count, dialog closes, team card updates

## Architecture

Follows the hexagonal pattern: port → adapter → DI container → ServiceLocator → route handler.

### Ports

**IOrganizationRepository** (`lib/core/ports/organization.port.ts`):

```typescript
getRepoContributors(organizationId: string, repositoryId: string): Promise<OrganizationMember[]>
```

**IGitHubService** (`lib/core/ports/github.port.ts`):

```typescript
getRepositoryContributors(owner: string, repo: string): Promise<User[]>
```

### Adapters

**TursoOrganizationRepository.getRepoContributors()** — two-tier resolution:

1. Query the `commits` table for distinct authors who are org members:
   ```sql
   SELECT DISTINCT u.id, u.name, u.email, u.image, uo.role, uo.created_at
   FROM commits c
   JOIN users u ON u.id = c.author_id
   JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = ?
   WHERE c.repository_id = ?
   ```
2. If no results (repo not ingested): fall back to `IGitHubService.getRepositoryContributors()` via `octokit.repos.listContributors()`, then match returned GitHub users against org members by user ID.

**DemoOrganizationRepository** — returns first 3 demo users.

**GitHubClient** (`lib/github.ts`) — `getRepositoryContributors()` wraps `octokit.repos.listContributors()`.

### API

`GET /api/organizations/[orgId]/repositories/[repoId]/contributors`

- Auth: `withAuth` middleware
- Returns: `OrganizationMember[]`
- Handler: `app/api/organizations/[orgId]/repositories/[repoId]/contributors/route.ts`

### Frontend

- **Populate button** on each team card in `components/ui/team-management.tsx`
- **Dialog** with repo `<Select>`, contributor checklist with select/deselect all, bulk-add via existing `POST .../teams/{teamId}/members`

## Files Changed

| File | Change |
|------|--------|
| `lib/core/ports/github.port.ts` | Added `getRepositoryContributors` |
| `lib/core/ports/organization.port.ts` | Added `getRepoContributors` |
| `lib/github.ts` | Added `GitHubClient.getRepositoryContributors` |
| `lib/infrastructure/adapters/demo/github.adapter.ts` | Demo implementation |
| `lib/infrastructure/adapters/github/real-github.adapter.ts` | Real implementation |
| `lib/infrastructure/adapters/github/simple-github.adapter.ts` | Delegates to demo |
| `lib/infrastructure/adapters/demo/organization.adapter.ts` | Demo implementation |
| `lib/infrastructure/adapters/turso/organization.adapter.ts` | DB + GitHub fallback |
| `app/api/organizations/[orgId]/repositories/[repoId]/contributors/route.ts` | API route |
| `components/ui/team-management.tsx` | Populate button + dialog |

## No Schema Changes

Uses existing `commits`, `users`, `user_organizations`, and `repositories` tables.

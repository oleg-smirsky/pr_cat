# Team Auto-Population from Repository Contributors

## Problem

Manually adding team members one by one is tedious. Users want to seed a team from the committers of a specific repository.

## Solution

Add a "Populate from repo" button on each team card that lets users pick a repository, preview matched org members who are contributors, and bulk-add them to the team.

## Architecture

Follows the existing hexagonal pattern: port → adapter → DI container → ServiceLocator → route handler.

### Port Changes

**IOrganizationRepository** — add method:

```typescript
getRepoContributors(organizationId: string, repositoryId: string): Promise<OrganizationMember[]>
```

Returns org members who have committed to the given repository.

**IGitHubService** — add method:

```typescript
getRepositoryContributors(owner: string, repo: string): Promise<GitHubUser[]>
```

Wraps `octokit.repos.listContributors()`. Used as fallback when no ingested commits exist.

### Adapter Implementations

**TursoOrganizationRepository.getRepoContributors():**

1. Query the `commits` table for distinct authors on the repo, joined to `users` and `user_organizations`:
   ```sql
   SELECT DISTINCT u.*
   FROM commits c
   JOIN users u ON u.id = c.author_id
   JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = ?
   WHERE c.repository_id = ?
   ```
2. If query returns 0 results (repo not ingested), fall back:
   - Look up repo owner/name from `repositories` table
   - Call `IGitHubService.getRepositoryContributors(owner, repo)`
   - Match returned GitHub users against org members by GitHub user ID
3. Return matched `OrganizationMember[]`

**DemoOrganizationRepository.getRepoContributors():**

Return a subset of `DEMO_USERS` (e.g., first 3) to simulate contributors.

**GitHub adapter (Turso/Real):**

```typescript
async getRepositoryContributors(owner: string, repo: string): Promise<GitHubUser[]> {
  return octokit.repos.listContributors({ owner, repo, per_page: 100 })
}
```

**Demo GitHub adapter:**

Return demo users.

### API Route

`GET /api/organizations/[orgId]/repositories/[repoId]/contributors`

- Uses `withAuth` middleware + `ApplicationContext`
- Calls `ServiceLocator.getOrganizationRepository().getRepoContributors()`
- Returns `OrganizationMember[]`

### Frontend

**Team card:** Add a "Populate" button next to the existing "Manage" button on each team card.

**Populate dialog:**
1. Repo dropdown (fetched from existing org repositories endpoint)
2. User picks repo → calls `GET /api/organizations/{orgId}/repositories/{repoId}/contributors`
3. Checklist of matched members (avatar, name, email, checkbox — all checked by default), excluding members already on the team
4. "Add selected" button → bulk-POSTs via existing `POST /api/organizations/{orgId}/teams/{teamId}/members`
5. Toast with count of added members, closes dialog

**Edge cases:**
- No contributors found → "No contributors found for this repo"
- All contributors already on team → "All contributors are already team members"
- Loading states for contributor fetch and bulk-add

## Data Flow

```
User clicks "Populate" on team card
  → Opens dialog with repo dropdown
  → Selects repo
  → GET /api/organizations/{orgId}/repositories/{repoId}/contributors
    → withAuth → ApplicationContext
    → ServiceLocator.getOrganizationRepository()
    → TursoOrganizationRepository.getRepoContributors()
      → DB query (commits table)
      → If empty: IGitHubService.getRepositoryContributors() → match to org members
    → Returns OrganizationMember[]
  → Preview checklist (deselect unwanted)
  → "Add selected"
  → N × POST /api/organizations/{orgId}/teams/{teamId}/members
  → Toast + close
```

## No Schema Changes

Uses existing `commits`, `users`, `user_organizations`, and `repositories` tables.

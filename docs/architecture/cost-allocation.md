# Cost Allocation & Project Resolution

> How much does each business project cost us per month?

Distributes team-level engineering costs across business projects proportional to commit activity.

## How It Works

Each month, a team has a total cost and headcount. The system calculates per-person cost, then distributes each person's cost across projects based on their commit ratio. Team members with zero commits are marked "unallocated."

Results can be grouped by **repository** or by **project** (a business-level grouping that can span multiple repositories).

## How Commits Map to Projects

Each commit is assigned to exactly one project. The system tries these strategies in order and stops at the first match:

1. **Jira epic** — the commit mentions a Jira ticket that belongs to a mapped epic (or IS itself a mapped epic)
2. **Jira project** — the ticket's Jira project has a default mapping
3. **Branch name** — the commit lives on a branch whose name starts with a known prefix (e.g. `feature-a_dev` matches `feature-a` → Project Alpha). Generic branches like `main`, `private`, and release branches are ignored. If a commit matches multiple conflicting projects, this level is skipped.
4. **Message prefix** — the first word of the commit message matches a known prefix (e.g. `ALPHA:`, `BETA `)
5. **Repository default** — a fallback project for the whole repository
6. **Unallocated** — nothing matched

Levels 1-2 require Jira integration. Levels 3-5 work with GitHub data alone.

## Mapping Configuration

Projects and their mappings are company-specific. Store them in a private config file and apply with:

```
pnpm seed-mappings --config ../pr_cat_prusa/mappings.json
pnpm resolve-projects --force
```

The config defines which projects exist and how to route commits to them:

| Config key | Purpose | Example |
|-----------|---------|---------|
| `projects` | Define project names | `"Project Alpha"`, `"Project Beta"`, `"General"` |
| `epicMappings` | Jira epic → project | `"PROJ-100": "Project Alpha"` |
| `jiraProjectMappings` | Jira project → project | `"PROJ": "General"` |
| `branchMappings` | Branch name prefix → project | `"feature-a": "Project Alpha"`, `"feature-b": "Project Beta"` |
| `branchExclusions` | Branch names to ignore | `["private", "main", "master"]` |
| `prefixMappings` | Commit message prefix → project | `"ALPHA": "Project Alpha"`, `"BETA": "Project Beta"` |
| `repoDefaults` | Repository → fallback project | `"org/repo": "General"` |

## Reducing the Catchall

If too many commits land in your catchall project:

1. **Check which Jira tickets lack epics** — assigning epics in Jira is the highest-signal fix
2. **Add branch prefixes** — look at what branches the unresolved commits sit on
3. **Add message prefixes** — look for consistent commit message conventions
4. **Add more epic mappings** — map newly created epics to projects

Run `pnpm resolve-projects --force` after any mapping change.

## Data Pipeline

Run these commands in order to populate the system:

```
pnpm fetch-commits --repos owner/repo    # download commits from GitHub
pnpm fetch-commits --repos owner/repo \
  --team-config ../config/mappings.json  # also fetch from team members' forks
pnpm ingest-commits --repos owner/repo   # load into database (includes fork commits)
pnpm fetch-jira-issues                   # download referenced Jira issues
pnpm ingest-jira-issues                  # load Jira issues into database
pnpm seed-mappings --config <path>       # load project definitions and mappings
pnpm resolve-projects                    # assign each commit to a project
```

All steps are idempotent. Add `--force` to `resolve-projects` to re-process everything.

## Team Costs

Monthly team costs are entered in the UI on the cost allocation page. They persist automatically and are used to calculate per-project cost shares.

## Fork Fetching

Team members often work on private GitHub forks before merging to the main repository. Without fork fetching, those commits are invisible to the pipeline until the PR merges, creating blind spots in cost allocation.

### How It Works

The `fetch-commits` script can automatically discover and fetch commits from team members' forks when given a `--team-config` flag pointing to the mappings JSON file.

**Discovery:** The script reads the `github` field from every team member across all teams in the config. For each `(username, repo-name)` pair, it probes `GET /repos/{username}/{repo-name}` via the GitHub API. A 404 means the member has no fork of that repo and is skipped silently. Non-404 errors produce a warning.

**Fetching:** Discovered forks go through the same branch-and-commit fetch loop as parent repos: list branches, filter to branches with recent commits (since the `--since` date), then fetch full commit data for uncached SHAs. Fork data is cached separately under `.cache/github/{username}/{repo-name}/`.

**Fork marker:** A `fork-of.json` file is written into each fork's cache directory containing the parent repo slug (e.g., `"acme-org/firmware"`). This marker is how the ingestion step knows a cache directory represents a fork.

**Ingestion:** `ingest-commits` does not need any extra flags. When processing a `--repos` slug, it scans `.cache/github/` for other owner directories containing the same repo name. If a `fork-of.json` marker in that directory points to the current parent slug, those commits are automatically ingested and attributed to the parent repository's `repository_id`. The log labels these as `[forkOwner/repo -> parentOwner/repo]`.

**Deduplication:** If the same commit SHA appears in both a fork and the parent repo (e.g., after a PR merge), the `INSERT OR IGNORE` on the commits table prevents duplicates. Cherry-pick deduplication in `resolve-projects` handles cases where the same change appears with different SHAs.

### Team Config Requirement

Each team member who works on forks needs a `github` field in the mappings JSON:

```json
{
  "name": "Alice Smith",
  "emails": ["alice@example.com"],
  "github": "alice",
  "capacity": 1.0
}
```

Members without a `github` field are skipped during fork discovery. Usernames are deduplicated across all teams.

### CLI Usage

```bash
# Fetch parent repo only (no fork discovery)
pnpm fetch-commits --repos org/repo --since 2025-01-01

# Fetch parent repo + discover and fetch team members' forks
pnpm fetch-commits --repos org/repo --since 2025-01-01 \
  --team-config ../pr_cat_prusa/mappings.json

# Ingest (auto-discovers fork cache dirs, no extra flags needed)
pnpm ingest-commits --repos org/repo
```

### Cache Layout

```
.cache/github/
  acme-org/firmware/                       # parent repo
    branches.json
    commits/{sha}.json
    commit-list/{branch}.json
  alice/firmware/                           # fork
    fork-of.json                           # contains "acme-org/firmware"
    branches.json
    commits/{sha}.json
    commit-list/{branch}.json
```

### Edge Cases

- Member has no fork of a tracked repo: 404, skipped silently
- Fork exists but has no recent commits: skipped by the active-branch filter
- Same SHA in both fork and parent: `INSERT OR IGNORE` deduplicates
- Token lacks access to a private fork: 404, skipped with a warning
- Multiple repos in `--repos`: forks are discovered for each parent repo independently

## Jira Integration

Requires `JIRA_BASE_URL` and `JIRA_TOKEN` environment variables. The fetcher downloads issues referenced in commits and chases parent/epic links automatically. Issues are cached locally so subsequent runs only fetch new data.

## Viewing Results

The cost allocation page at `/dashboard/cost-allocation` provides:

- **Period selection** — single month or date range
- **Repository / Project toggle** — switch between grouping modes
- **Per-member breakdown** — each person's commit count and cost share per group
- **Unallocated row** — cost that couldn't be attributed to any project
- **CSV export** — download the table for either view

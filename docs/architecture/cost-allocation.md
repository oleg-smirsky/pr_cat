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
3. **Branch name** — the commit lives on a branch whose name starts with a known prefix (e.g. `indx_dev` matches `indx` → INDX). Generic branches like `main`, `private`, and release branches are ignored. If a commit matches multiple conflicting projects, this level is skipped.
4. **Message prefix** — the first word of the commit message matches a known prefix (e.g. `INDX:`, `MMU `)
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
| `projects` | Define project names | `"INDX"`, `"AFS"`, `"General Buddy"` |
| `epicMappings` | Jira epic → project | `"BFW-8007": "INDX"` |
| `jiraProjectMappings` | Jira project → project | `"BFW": "General Buddy"` |
| `branchMappings` | Branch name prefix → project | `"indx": "INDX"`, `"ix": "AFS"` |
| `branchExclusions` | Branch names to ignore | `["private", "main", "master"]` |
| `prefixMappings` | Commit message prefix → project | `"INDX": "INDX"`, `"MMU": "MMU (MK4)"` |
| `repoDefaults` | Repository → fallback project | `"org/repo": "General Buddy"` |

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
pnpm ingest-commits --repos owner/repo   # load into database (includes branch data)
pnpm fetch-jira-issues                   # download referenced Jira issues
pnpm ingest-jira-issues                  # load Jira issues into database
pnpm seed-mappings --config <path>       # load project definitions and mappings
pnpm resolve-projects                    # assign each commit to a project
```

All steps are idempotent. Add `--force` to `resolve-projects` to re-process everything.

## Team Costs

Monthly team costs are entered in the UI on the cost allocation page. They persist automatically and are used to calculate per-project cost shares.

## Jira Integration

Requires `JIRA_BASE_URL` and `JIRA_TOKEN` environment variables. The fetcher downloads issues referenced in commits and chases parent/epic links automatically. Issues are cached locally so subsequent runs only fetch new data.

## Viewing Results

The cost allocation page at `/dashboard/cost-allocation` provides:

- **Period selection** — single month or date range
- **Repository / Project toggle** — switch between grouping modes
- **Per-member breakdown** — each person's commit count and cost share per group
- **Unallocated row** — cost that couldn't be attributed to any project
- **CSV export** — download the table for either view

# Cost Allocation & Project Resolution

> How much does each business project cost us per month?

Distributes team-level engineering costs across business projects proportional to commit activity.

## Overview

Each month, a team has a total cost and headcount. The system calculates per-person cost, then distributes each person's cost across projects based on their commit ratio. Team members with zero commits have their full cost marked as "unallocated."

Results can be grouped by **repository** or by **project** (business-level grouping that spans repositories).

## Data Pipeline

Run these commands in order to populate the system:

```
pnpm fetch-commits --repos owner/repo    # download commits from GitHub
pnpm ingest-commits --repos owner/repo   # load commits into database
pnpm fetch-jira-issues                   # download referenced Jira issues
pnpm ingest-jira-issues                  # load Jira issues into database
pnpm seed-mappings --config <path>       # load project definitions and mappings
pnpm resolve-projects                    # assign each commit to a project
```

All steps are idempotent. Add `--force` to re-process everything.

## How Commits Map to Projects

Each commit is assigned to a project through a cascade (first match wins):

1. **Jira epic** — if the commit references a Jira ticket that belongs to a mapped epic
2. **Jira project** — if the ticket's Jira project key has a mapping
3. **Message prefix** — if the commit message starts with a known prefix (e.g. `INDX:`, `MMU `)
4. **Repository default** — fallback project for the repository
5. **Unallocated** — no match found

## Mapping Configuration

Projects and their mappings are company-specific. Store them in a private config file:

```json
{
  "projects": [
    { "name": "INDX", "description": "INDX printer firmware" },
    { "name": "General Buddy", "description": "Catchall for unclassified work" }
  ],
  "epicMappings": {
    "BFW-8007": "INDX",
    "BFW-6855": "CORE One L"
  },
  "jiraProjectMappings": {
    "BFW": "General Buddy"
  },
  "prefixMappings": {
    "INDX": "INDX",
    "INDX_HEAD": "INDX",
    "MMU": "MMU (MK4)"
  },
  "repoDefaults": {
    "prusa3d/Prusa-Firmware-Buddy-Private": "General Buddy"
  }
}
```

Apply with: `pnpm seed-mappings --config ../pr_cat_prusa/mappings.json`

Re-run `pnpm resolve-projects --force` after changing mappings.

## Team Costs

Monthly team costs are stored in the database and managed through the API:

- **Save**: `PUT /api/teams/{teamId}/costs` with `{ month, totalCost, headcount, currency }`
- **Load**: `GET /api/teams/{teamId}/costs?month=YYYY-MM`

The UI on the cost allocation page persists costs automatically when you enter them.

## Jira Integration

Requires two environment variables:

- `JIRA_BASE_URL` — e.g. `https://dev.prusa3d.com`
- `JIRA_TOKEN` — Personal Access Token

The fetcher downloads issues referenced in commits and chases parent/epic links automatically. Issues are cached locally in `.cache/jira/` so subsequent runs only fetch new data.

## Viewing Results

The cost allocation page provides:

- **Repository / Project toggle** — switch between grouping modes
- **Per-member breakdown** — shows each person's commit count and cost share per group
- **Unallocated row** — highlights cost that couldn't be attributed to any project
- **CSV export** — download the table for either view

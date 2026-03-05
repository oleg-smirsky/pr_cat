# Multi-Month Cost Allocation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Per-month project allocation with per-month columns in multi-month ranges, and removal of the repository view.

**Architecture:** Remove `getCostAllocation` (repo-grouped) from the service port. Extend `getCostAllocationByProject` to return `monthlyBreakdowns` when a date range is provided. Frontend renders per-month columns (% + cost) with totals. Single-month view unchanged.

**Tech Stack:** TypeScript, Next.js, React, Turso (libSQL), Jest

---

### Task 1: Remove repository view from service port and types

**Files:**
- Modify: `lib/core/ports/commit-analytics.port.ts`

**Step 1: Remove repo-related types and method from port**

Remove `CostAllocationMember`, `CostAllocationResult`, and `getCostAllocation` from the port. Keep only `getCostAllocationByProject`. Add `MonthlyBreakdown` and the optional `monthlyBreakdowns` field:

```typescript
/**
 * Commit Analytics Service Port
 * Defines the contract for commit-based analytics such as cost allocation
 */

export interface ProjectAllocation {
  project: { id: number; name: string } | null; // null = unallocated
  commits: number;
  percentage: number;
}

export interface MonthlyBreakdown {
  month: string;
  allocations: ProjectAllocation[];
  totalCommits: number;
}

export interface CostAllocationByProjectResult {
  month: string;
  monthEnd?: string;
  team: { id: number; name: string } | null;
  allocations: ProjectAllocation[];
  totalCommits: number;
  monthlyBreakdowns?: MonthlyBreakdown[];
}

export interface CostAllocationParams {
  month: string;         // YYYY-MM (start month)
  monthEnd?: string;     // YYYY-MM (end month, inclusive). If omitted, single month.
  teamId?: number;
}

export interface ICommitAnalyticsService {
  getCostAllocationByProject(params: CostAllocationParams): Promise<CostAllocationByProjectResult>;
}
```

**Step 2: Run tests to see what breaks**

Run: `pnpm test 2>&1 | head -60`
Expected: Compilation errors in files that reference removed types/methods.

**Step 3: Commit**

```bash
git add lib/core/ports/commit-analytics.port.ts
git commit -m "refactor: remove repository view types from service port"
```

---

### Task 2: Update Turso adapter — remove repo method, add monthly breakdowns

**Files:**
- Modify: `lib/infrastructure/adapters/turso/commit-analytics.adapter.ts`

**Step 1: Write failing test for monthly breakdowns**

Add to `__tests__/lib/commit-analytics.test.ts`:

```typescript
it('returns monthly breakdowns when monthEnd is provided', async () => {
  // Jan query
  mockQuery.mockResolvedValueOnce([
    { project_id: 1, project_name: 'Project Alpha', commit_count: 10 },
    { project_id: null, project_name: null, commit_count: 5 },
  ]);
  // Feb query
  mockQuery.mockResolvedValueOnce([
    { project_id: 1, project_name: 'Project Alpha', commit_count: 8 },
    { project_id: 2, project_name: 'Project Beta', commit_count: 3 },
  ]);

  const result = await service.getCostAllocationByProject({
    month: '2026-01',
    monthEnd: '2026-02',
  });

  expect(result.monthlyBreakdowns).toHaveLength(2);

  // January
  const jan = result.monthlyBreakdowns![0];
  expect(jan.month).toBe('2026-01');
  expect(jan.totalCommits).toBe(15);
  expect(jan.allocations).toHaveLength(2);
  expect(jan.allocations.find(a => a.project?.name === 'Project Alpha')?.percentage).toBeCloseTo(66.7, 0);

  // February
  const feb = result.monthlyBreakdowns![1];
  expect(feb.month).toBe('2026-02');
  expect(feb.totalCommits).toBe(11);
  expect(feb.allocations).toHaveLength(2);

  // Aggregated allocations (sum of commits across months)
  expect(result.totalCommits).toBe(26);
  const indx = result.allocations.find(a => a.project?.name === 'Project Alpha');
  expect(indx?.commits).toBe(18); // 10 + 8
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test __tests__/lib/commit-analytics.test.ts -v 2>&1 | tail -20`
Expected: FAIL — `getCostAllocation` tests fail (removed), new test fails.

**Step 3: Rewrite the Turso adapter**

Replace `lib/infrastructure/adapters/turso/commit-analytics.adapter.ts` with:

```typescript
/**
 * Turso Commit Analytics Service Adapter
 * Implements ICommitAnalyticsService using real database queries
 */

import {
  ICommitAnalyticsService,
  CostAllocationParams,
  CostAllocationByProjectResult,
  ProjectAllocation,
  MonthlyBreakdown,
} from '../../../core/ports/commit-analytics.port'
import { query } from '@/lib/db'

interface ProjectAggregationRow {
  project_id: number | null;
  project_name: string | null;
  commit_count: number;
}

interface TeamRow {
  id: number;
  name: string;
}

export class TursoCommitAnalyticsService implements ICommitAnalyticsService {

  async getCostAllocationByProject(params: CostAllocationParams): Promise<CostAllocationByProjectResult> {
    const { month, monthEnd, teamId } = params

    let team: { id: number; name: string } | null = null
    if (teamId) {
      const teamRows = await query<TeamRow>(
        'SELECT id, name FROM teams WHERE id = ?',
        [teamId]
      )
      team = teamRows.length > 0 ? { id: teamRows[0].id, name: teamRows[0].name } : null
    }

    // Single month — same as before
    if (!monthEnd || monthEnd === month) {
      const [timeMin, timeMax] = this.getMonthRange(month)
      const rows = await this.queryProjects(timeMin, timeMax, teamId)
      const { allocations, totalCommits } = this.buildAllocations(rows)
      return { month, monthEnd, team, allocations, totalCommits }
    }

    // Multi-month — query each month individually
    const months = this.expandMonths(month, monthEnd)
    const monthlyBreakdowns: MonthlyBreakdown[] = []

    for (const m of months) {
      const [timeMin, timeMax] = this.getMonthRange(m)
      const rows = await this.queryProjects(timeMin, timeMax, teamId)
      const { allocations, totalCommits } = this.buildAllocations(rows)
      monthlyBreakdowns.push({ month: m, allocations, totalCommits })
    }

    // Aggregate across months
    const { allocations, totalCommits } = this.aggregateBreakdowns(monthlyBreakdowns)

    return { month, monthEnd, team, allocations, totalCommits, monthlyBreakdowns }
  }

  private async queryProjects(
    timeMin: string,
    timeMax: string,
    teamId?: number
  ): Promise<ProjectAggregationRow[]> {
    if (teamId) {
      return query<ProjectAggregationRow>(
        `SELECT p.id AS project_id, p.name AS project_name, COUNT(*) AS commit_count
         FROM commits c
         LEFT JOIN projects p ON c.project_id = p.id
         JOIN team_members tm ON tm.user_id = c.author_id
         WHERE c.committed_at >= ? AND c.committed_at < ?
           AND tm.team_id = ?
         GROUP BY c.project_id
         ORDER BY commit_count DESC`,
        [timeMin, timeMax, teamId]
      )
    }
    return query<ProjectAggregationRow>(
      `SELECT p.id AS project_id, p.name AS project_name, COUNT(*) AS commit_count
       FROM commits c
       LEFT JOIN projects p ON c.project_id = p.id
       WHERE c.committed_at >= ? AND c.committed_at < ?
       GROUP BY c.project_id
       ORDER BY commit_count DESC`,
      [timeMin, timeMax]
    )
  }

  private buildAllocations(rows: ProjectAggregationRow[]): {
    allocations: ProjectAllocation[];
    totalCommits: number;
  } {
    const totalCommits = rows.reduce((sum, r) => sum + r.commit_count, 0)
    const allocations = rows.map(row => ({
      project: row.project_id != null
        ? { id: row.project_id, name: row.project_name! }
        : null,
      commits: row.commit_count,
      percentage: totalCommits > 0
        ? Math.round((row.commit_count / totalCommits) * 1000) / 10
        : 0,
    }))
    return { allocations, totalCommits }
  }

  private aggregateBreakdowns(breakdowns: MonthlyBreakdown[]): {
    allocations: ProjectAllocation[];
    totalCommits: number;
  } {
    const projectMap = new Map<number | 'unallocated', { project: ProjectAllocation['project']; commits: number }>()

    for (const bd of breakdowns) {
      for (const alloc of bd.allocations) {
        const key = alloc.project?.id ?? 'unallocated'
        const existing = projectMap.get(key)
        if (existing) {
          existing.commits += alloc.commits
        } else {
          projectMap.set(key, { project: alloc.project, commits: alloc.commits })
        }
      }
    }

    const totalCommits = Array.from(projectMap.values()).reduce((s, p) => s + p.commits, 0)
    const allocations = Array.from(projectMap.values())
      .map(p => ({
        project: p.project,
        commits: p.commits,
        percentage: totalCommits > 0
          ? Math.round((p.commits / totalCommits) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.commits - a.commits)

    return { allocations, totalCommits }
  }

  private getMonthRange(month: string): [string, string] {
    const timeMin = `${month}-01`
    const [yearStr, monthStr] = month.split('-')
    const year = parseInt(yearStr, 10)
    const monthNum = parseInt(monthStr, 10)

    let nextYear = year
    let nextMonth = monthNum + 1
    if (nextMonth > 12) {
      nextMonth = 1
      nextYear = year + 1
    }

    const timeMax = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
    return [timeMin, timeMax]
  }

  private expandMonths(start: string, end: string): string[] {
    const months: string[] = []
    const [sy, sm] = start.split('-').map(Number)
    const [ey, em] = end.split('-').map(Number)

    let y = sy, m = sm
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`)
      m++
      if (m > 12) { m = 1; y++ }
    }
    return months
  }
}
```

**Step 4: Update existing tests**

Rewrite `__tests__/lib/commit-analytics.test.ts` — remove all `getCostAllocation` tests, keep/add `getCostAllocationByProject` tests:

```typescript
jest.mock('@/lib/db');

import { TursoCommitAnalyticsService } from '@/lib/infrastructure/adapters/turso/commit-analytics.adapter';
import { query } from '@/lib/db';

const mockQuery = query as jest.Mock;

describe('TursoCommitAnalyticsService', () => {
  const service = new TursoCommitAnalyticsService();

  beforeEach(() => jest.clearAllMocks());

  describe('getCostAllocationByProject', () => {
    it('returns project allocations for a single month', async () => {
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'Project Alpha', commit_count: 10 },
        { project_id: null, project_name: null, commit_count: 5 },
      ]);

      const result = await service.getCostAllocationByProject({ month: '2026-01' });

      expect(result.month).toBe('2026-01');
      expect(result.team).toBeNull();
      expect(result.totalCommits).toBe(15);
      expect(result.allocations).toHaveLength(2);
      expect(result.monthlyBreakdowns).toBeUndefined();
    });

    it('includes team info when teamId is provided', async () => {
      mockQuery.mockResolvedValueOnce([
        { id: 1, name: 'Engineering' },
      ]);
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'Project Alpha', commit_count: 10 },
      ]);

      const result = await service.getCostAllocationByProject({ month: '2026-01', teamId: 1 });

      expect(result.team).toEqual({ id: 1, name: 'Engineering' });
    });

    it('returns monthly breakdowns when monthEnd is provided', async () => {
      // Jan query
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'Project Alpha', commit_count: 10 },
        { project_id: null, project_name: null, commit_count: 5 },
      ]);
      // Feb query
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'Project Alpha', commit_count: 8 },
        { project_id: 2, project_name: 'Project Beta', commit_count: 3 },
      ]);

      const result = await service.getCostAllocationByProject({
        month: '2026-01',
        monthEnd: '2026-02',
      });

      expect(result.monthlyBreakdowns).toHaveLength(2);

      const jan = result.monthlyBreakdowns![0];
      expect(jan.month).toBe('2026-01');
      expect(jan.totalCommits).toBe(15);
      expect(jan.allocations).toHaveLength(2);

      const feb = result.monthlyBreakdowns![1];
      expect(feb.month).toBe('2026-02');
      expect(feb.totalCommits).toBe(11);

      expect(result.totalCommits).toBe(26);
      const alpha = result.allocations.find(a => a.project?.name === 'Project Alpha');
      expect(alpha?.commits).toBe(18);
    });

    it('handles December to January boundary in range', async () => {
      mockQuery.mockResolvedValueOnce([]);
      mockQuery.mockResolvedValueOnce([]);

      await service.getCostAllocationByProject({
        month: '2025-12',
        monthEnd: '2026-01',
      });

      // Dec query: 2025-12-01 to 2026-01-01
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['2025-12-01', '2026-01-01'])
      );
      // Jan query: 2026-01-01 to 2026-02-01
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['2026-01-01', '2026-02-01'])
      );
    });

    it('returns empty result when no commits in range', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const result = await service.getCostAllocationByProject({ month: '2026-06' });

      expect(result.totalCommits).toBe(0);
      expect(result.allocations).toHaveLength(0);
    });
  });
});
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test __tests__/lib/commit-analytics.test.ts -v`
Expected: All PASS

**Step 6: Commit**

```bash
git add lib/infrastructure/adapters/turso/commit-analytics.adapter.ts __tests__/lib/commit-analytics.test.ts
git commit -m "refactor: remove repo view from Turso adapter, add monthly breakdowns"
```

---

### Task 3: Update Demo adapter

**Files:**
- Modify: `lib/infrastructure/adapters/demo/commit-analytics.adapter.ts`
- Modify: `__tests__/lib/commit-analytics-project.test.ts`

**Step 1: Rewrite demo adapter — remove `getCostAllocation`, add multi-month support**

```typescript
/**
 * Demo Commit Analytics Service Adapter
 */

import {
  ICommitAnalyticsService,
  CostAllocationParams,
  CostAllocationByProjectResult,
  MonthlyBreakdown,
} from '../../../core/ports/commit-analytics.port';

const DEMO_ALLOCATIONS = [
  { project: { id: 1, name: 'Project Alpha' }, commits: 150, percentage: 37.5 },
  { project: { id: 2, name: 'Project Beta' }, commits: 120, percentage: 30.0 },
  { project: null, commits: 130, percentage: 32.5 },
];

export class DemoCommitAnalyticsService implements ICommitAnalyticsService {
  async getCostAllocationByProject(params: CostAllocationParams): Promise<CostAllocationByProjectResult> {
    const team = params.teamId ? { id: params.teamId, name: 'Demo Team' } : null;

    if (params.monthEnd && params.monthEnd !== params.month) {
      // Generate per-month breakdowns with slightly varied data
      const months = this.expandMonths(params.month, params.monthEnd);
      const monthlyBreakdowns: MonthlyBreakdown[] = months.map((m, i) => ({
        month: m,
        allocations: DEMO_ALLOCATIONS.map(a => ({
          ...a,
          commits: a.commits + (i * 10),
          percentage: 0, // recalculated below
        })),
        totalCommits: 0,
      }));

      // Recalculate percentages per month
      for (const bd of monthlyBreakdowns) {
        bd.totalCommits = bd.allocations.reduce((s, a) => s + a.commits, 0);
        for (const a of bd.allocations) {
          a.percentage = bd.totalCommits > 0
            ? Math.round((a.commits / bd.totalCommits) * 1000) / 10
            : 0;
        }
      }

      // Aggregate
      const totalCommits = monthlyBreakdowns.reduce((s, bd) => s + bd.totalCommits, 0);
      const projectMap = new Map<number | 'unallocated', { project: typeof DEMO_ALLOCATIONS[0]['project']; commits: number }>();
      for (const bd of monthlyBreakdowns) {
        for (const a of bd.allocations) {
          const key = a.project?.id ?? 'unallocated';
          const existing = projectMap.get(key);
          if (existing) existing.commits += a.commits;
          else projectMap.set(key, { project: a.project, commits: a.commits });
        }
      }
      const allocations = Array.from(projectMap.values()).map(p => ({
        project: p.project,
        commits: p.commits,
        percentage: totalCommits > 0 ? Math.round((p.commits / totalCommits) * 1000) / 10 : 0,
      }));

      return {
        month: params.month,
        monthEnd: params.monthEnd,
        team,
        allocations,
        totalCommits,
        monthlyBreakdowns,
      };
    }

    return {
      month: params.month,
      team,
      allocations: DEMO_ALLOCATIONS,
      totalCommits: 400,
    };
  }

  private expandMonths(start: string, end: string): string[] {
    const months: string[] = [];
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return months;
  }
}
```

**Step 2: Update demo test — remove `getCostAllocation` references, add multi-month test**

```typescript
import { DemoCommitAnalyticsService } from '@/lib/infrastructure/adapters/demo/commit-analytics.adapter';

describe('getCostAllocationByProject', () => {
  const service = new DemoCommitAnalyticsService();

  it('returns project allocations with month', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    expect(result.month).toBe('2026-02');
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.totalCommits).toBeGreaterThan(0);
    expect(result.monthlyBreakdowns).toBeUndefined();
  });

  it('includes unallocated bucket (project = null)', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    const unallocated = result.allocations.find(a => a.project === null);
    expect(unallocated).toBeDefined();
  });

  it('percentages sum to 100', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    const sum = result.allocations.reduce((s, a) => s + a.percentage, 0);
    expect(sum).toBeCloseTo(100, 0);
  });

  it('accepts optional teamId', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02', teamId: 1 });
    expect(result.team).toEqual({ id: 1, name: 'Demo Team' });
  });

  it('returns monthly breakdowns for multi-month range', async () => {
    const result = await service.getCostAllocationByProject({
      month: '2026-01',
      monthEnd: '2026-03',
    });
    expect(result.monthlyBreakdowns).toHaveLength(3);
    expect(result.monthlyBreakdowns![0].month).toBe('2026-01');
    expect(result.monthlyBreakdowns![2].month).toBe('2026-03');
    expect(result.totalCommits).toBeGreaterThan(0);
  });
});
```

**Step 3: Run tests**

Run: `pnpm test __tests__/lib/commit-analytics-project.test.ts -v`
Expected: All PASS

**Step 4: Commit**

```bash
git add lib/infrastructure/adapters/demo/commit-analytics.adapter.ts __tests__/lib/commit-analytics-project.test.ts
git commit -m "refactor: remove repo view from demo adapter, add monthly breakdowns"
```

---

### Task 4: Update API route — remove repo path, always use project

**Files:**
- Modify: `app/api/analytics/cost-allocation/route.ts`
- Modify: `__tests__/api/cost-allocation.test.ts`

**Step 1: Simplify the route handler**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { withAuth, ApplicationContext } from '@/lib/core';
import { ServiceLocator } from '@/lib/core/container';

export const runtime = 'nodejs';

const handler = async (
  context: ApplicationContext,
  request: NextRequest
): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month');
  const monthEnd = searchParams.get('monthEnd');

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: 'month parameter required (YYYY-MM format)' },
      { status: 400 }
    );
  }

  if (monthEnd && !/^\d{4}-\d{2}$/.test(monthEnd)) {
    return NextResponse.json(
      { error: 'monthEnd must be YYYY-MM format' },
      { status: 400 }
    );
  }

  if (monthEnd && monthEnd < month) {
    return NextResponse.json(
      { error: 'monthEnd must not be before month' },
      { status: 400 }
    );
  }

  const teamIdStr = searchParams.get('teamId');
  const teamId = teamIdStr ? parseInt(teamIdStr, 10) : undefined;

  if (teamIdStr && (isNaN(teamId!) || teamId! < 1)) {
    return NextResponse.json(
      { error: 'teamId must be a positive integer' },
      { status: 400 }
    );
  }

  try {
    const service = await ServiceLocator.getCommitAnalyticsService();
    const result = await service.getCostAllocationByProject({
      month,
      monthEnd: monthEnd ?? undefined,
      teamId,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Cost allocation error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch cost allocation data' },
      { status: 500 }
    );
  }
};

export const GET = withAuth(handler);
```

**Step 2: Rewrite API tests to use `getCostAllocationByProject`**

Update `__tests__/api/cost-allocation.test.ts` — replace `mockGetCostAllocation` with `mockGetCostAllocationByProject`, remove all repo-related mock data and assertions. Keep the validation tests (400 for bad month, bad teamId, etc.), update the 200 tests to verify project data, and remove the `groupBy` parameter tests.

Key changes:
- Mock name: `mockGetCostAllocationByProject`
- ServiceLocator mock returns `{ getCostAllocationByProject: mockGetCostAllocationByProject }`
- Mock result uses `CostAllocationByProjectResult` shape (allocations, not members/repoTotals)
- Remove the `groupBy=project` test — it's now the only mode
- Remove all `CostAllocationResult` / `CostAllocationMember` type imports

**Step 3: Run tests**

Run: `pnpm test __tests__/api/cost-allocation.test.ts -v`
Expected: All PASS

**Step 4: Commit**

```bash
git add app/api/analytics/cost-allocation/route.ts __tests__/api/cost-allocation.test.ts
git commit -m "refactor: remove groupBy param, always return project allocation"
```

---

### Task 5: Rewrite frontend component — remove repo view, add multi-month columns

**Files:**
- Modify: `components/cost-allocation-table.tsx`

**Step 1: Remove all repository-related code**

Delete: `CostAllocationResult` type, `getRepoColumns`, `getCommitCount`, `buildRepoCsvContent`, `RepositoryTable`, `GroupBy` type, `groupBy` state, the Repository/Project toggle, and `repoData` state.

**Step 2: Add multi-month table rendering**

When `data.monthlyBreakdowns` is present, render the multi-month layout:

| Project | Jan % | Jan Cost | Feb % | Feb Cost | ... | Total Cost | Total % |

- Per-month cost = `(month % / 100) * that month's team cost`
- Total Cost = sum of per-month costs
- Total % = project total cost / grand total cost
- If a month has no saved team cost, show `—` for cost cells

The component needs to load team costs for all months in the range. Add a `monthCosts` state: `Map<string, TeamCostData | null>`. When `rangeMode` is on, fetch costs for each month. In single-month mode, fetch just the one month (current behavior).

**Step 3: Update CSV export**

`buildProjectCsvContent` should handle both single-month and multi-month formats. For multi-month, columns follow the table layout.

**Step 4: Hide cost form in range mode**

The cost entry form only appears in single-month mode (costs are entered per month individually).

**Step 5: Run dev server and visually verify**

Run: `pnpm dev`
- Test single month — should look identical to before
- Test range — should show per-month columns with costs and totals
- Test CSV export in both modes

**Step 6: Commit**

```bash
git add components/cost-allocation-table.tsx
git commit -m "feat: multi-month project cost allocation with per-month columns"
```

---

### Task 6: Clean up container and remaining references

**Files:**
- Modify: `lib/core/container/di-container.ts` — verify no references to removed types
- Modify: `lib/core/container/service-locator.ts` — verify return type is updated

**Step 1: Check for stale imports**

Run: `pnpm lint`
Run: `pnpm build`

Fix any import errors referencing `CostAllocationResult`, `CostAllocationMember`, or `getCostAllocation`.

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: clean up stale references after removing repository view"
```

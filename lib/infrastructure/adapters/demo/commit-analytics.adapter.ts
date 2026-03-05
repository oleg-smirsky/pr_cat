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

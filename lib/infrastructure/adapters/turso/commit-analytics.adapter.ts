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

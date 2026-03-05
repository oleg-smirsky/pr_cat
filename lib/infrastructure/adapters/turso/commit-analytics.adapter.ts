/**
 * Turso Commit Analytics Service Adapter
 * Implements ICommitAnalyticsService using real database queries
 */

import {
  ICommitAnalyticsService,
  CostAllocationParams,
  CostAllocationResult,
  CostAllocationMember,
  CostAllocationByProjectResult,
} from '../../../core/ports/commit-analytics.port'
import { query } from '@/lib/db'

interface ProjectAggregationRow {
  project_id: number | null;
  project_name: string | null;
  commit_count: number;
}

interface CommitAggregationRow {
  author_id: string | null;
  author_name: string;
  repository_id: number;
  repo_name: string;
  commit_count: number;
}

interface TeamRow {
  id: number;
  name: string;
}

export class TursoCommitAnalyticsService implements ICommitAnalyticsService {

  async getCostAllocation(params: CostAllocationParams): Promise<CostAllocationResult> {
    const { month, monthEnd, teamId } = params
    const [timeMin, timeMax] = this.getDateRange(month, monthEnd)

    const rows = teamId
      ? await this.queryWithTeam(timeMin, timeMax, teamId)
      : await this.queryAll(timeMin, timeMax)

    let team: { id: number; name: string } | null = null
    if (teamId) {
      const teamRows = await query<TeamRow>(
        'SELECT id, name FROM teams WHERE id = ?',
        [teamId]
      )
      team = teamRows.length > 0 ? { id: teamRows[0].id, name: teamRows[0].name } : null
    }

    return this.buildResult(month, monthEnd, team, rows)
  }

  async getCostAllocationByProject(params: CostAllocationParams): Promise<CostAllocationByProjectResult> {
    const { month, monthEnd, teamId } = params
    const [timeMin, timeMax] = this.getDateRange(month, monthEnd)

    let team: { id: number; name: string } | null = null
    if (teamId) {
      const teamRows = await query<TeamRow>(
        'SELECT id, name FROM teams WHERE id = ?',
        [teamId]
      )
      team = teamRows.length > 0 ? { id: teamRows[0].id, name: teamRows[0].name } : null
    }

    const rows = teamId
      ? await query<ProjectAggregationRow>(
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
      : await query<ProjectAggregationRow>(
          `SELECT p.id AS project_id, p.name AS project_name, COUNT(*) AS commit_count
           FROM commits c
           LEFT JOIN projects p ON c.project_id = p.id
           WHERE c.committed_at >= ? AND c.committed_at < ?
           GROUP BY c.project_id
           ORDER BY commit_count DESC`,
          [timeMin, timeMax]
        )

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

    return { month, monthEnd, team, allocations, totalCommits }
  }

  private async queryAll(timeMin: string, timeMax: string): Promise<CommitAggregationRow[]> {
    return query<CommitAggregationRow>(
      `SELECT
        c.author_id,
        c.author_name,
        c.repository_id,
        r.name AS repo_name,
        COUNT(*) AS commit_count
      FROM commits c
      JOIN repositories r ON r.id = c.repository_id
      WHERE c.committed_at >= ? AND c.committed_at < ?
      GROUP BY c.author_id, c.author_name, c.repository_id
      ORDER BY commit_count DESC`,
      [timeMin, timeMax]
    )
  }

  private async queryWithTeam(
    timeMin: string,
    timeMax: string,
    teamId: number
  ): Promise<CommitAggregationRow[]> {
    return query<CommitAggregationRow>(
      `SELECT
        c.author_id,
        c.author_name,
        c.repository_id,
        r.name AS repo_name,
        COUNT(*) AS commit_count
      FROM commits c
      JOIN repositories r ON r.id = c.repository_id
      JOIN team_members tm ON tm.user_id = c.author_id
      WHERE c.committed_at >= ? AND c.committed_at < ?
        AND tm.team_id = ?
      GROUP BY c.author_id, c.author_name, c.repository_id
      ORDER BY commit_count DESC`,
      [timeMin, timeMax, teamId]
    )
  }

  private buildResult(
    month: string,
    monthEnd: string | undefined,
    team: { id: number; name: string } | null,
    rows: CommitAggregationRow[]
  ): CostAllocationResult {
    // Group rows by (author_id, author_name) -> members with nested repos
    const memberMap = new Map<string, CostAllocationMember>()

    for (const row of rows) {
      // Group by author_id when available (ignores name variations),
      // fall back to author_name for unknown authors
      const key = row.author_id ?? `name::${row.author_name}`
      let member = memberMap.get(key)
      if (!member) {
        member = {
          userId: row.author_id,
          name: row.author_name,
          repos: [],
          totalCommits: 0,
        }
        memberMap.set(key, member)
      }
      member.repos.push({
        repositoryId: row.repository_id,
        name: row.repo_name,
        commits: row.commit_count,
      })
      member.totalCommits += row.commit_count
    }

    const members = Array.from(memberMap.values())

    // Aggregate repo totals across all members
    const repoMap = new Map<number, { repositoryId: number; name: string; commits: number }>()
    for (const row of rows) {
      const existing = repoMap.get(row.repository_id)
      if (existing) {
        existing.commits += row.commit_count
      } else {
        repoMap.set(row.repository_id, {
          repositoryId: row.repository_id,
          name: row.repo_name,
          commits: row.commit_count,
        })
      }
    }

    const totalCommits = members.reduce((sum, m) => sum + m.totalCommits, 0)

    const repoTotals = Array.from(repoMap.values()).map(repo => ({
      ...repo,
      percentage: totalCommits > 0 ? Math.round((repo.commits / totalCommits) * 100) : 0,
    }))

    return {
      month,
      monthEnd,
      team,
      members,
      repoTotals,
      totalCommits,
    }
  }

  private getDateRange(month: string, monthEnd?: string): [string, string] {
    const timeMin = `${month}-01`

    const endMonth = monthEnd ?? month
    const [yearStr, monthStr] = endMonth.split('-')
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
}

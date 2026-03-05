/**
 * Turso Team Cost Service Adapter
 * Implements ITeamCostService using real database queries
 */

import { ITeamCostService, TeamCost } from '../../../core/ports/team-cost.port'
import { query, execute } from '@/lib/db'

interface TeamCostRow {
  id: number;
  team_id: number;
  month: string;
  total_cost: number;
  headcount: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: TeamCostRow): TeamCost {
  return {
    id: row.id,
    teamId: row.team_id,
    month: row.month,
    totalCost: row.total_cost,
    headcount: row.headcount,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class TursoTeamCostService implements ITeamCostService {

  async getCost(teamId: number, month: string): Promise<TeamCost | null> {
    const rows = await query<TeamCostRow>(
      'SELECT * FROM team_costs WHERE team_id = ? AND month = ?',
      [teamId, month]
    )
    return rows.length > 0 ? mapRow(rows[0]) : null
  }

  async upsertCost(params: {
    teamId: number;
    month: string;
    totalCost: number;
    headcount: number;
    currency: string;
  }): Promise<TeamCost> {
    await execute(
      `INSERT INTO team_costs (team_id, month, total_cost, headcount, currency)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id, month) DO UPDATE SET
         total_cost = excluded.total_cost,
         headcount = excluded.headcount,
         currency = excluded.currency,
         updated_at = datetime('now')`,
      [params.teamId, params.month, params.totalCost, params.headcount, params.currency]
    )

    const cost = await this.getCost(params.teamId, params.month)
    return cost!
  }

  async getCostRange(teamId: number, fromMonth: string, toMonth: string): Promise<TeamCost[]> {
    const rows = await query<TeamCostRow>(
      'SELECT * FROM team_costs WHERE team_id = ? AND month >= ? AND month <= ? ORDER BY month',
      [teamId, fromMonth, toMonth]
    )
    return rows.map(mapRow)
  }
}

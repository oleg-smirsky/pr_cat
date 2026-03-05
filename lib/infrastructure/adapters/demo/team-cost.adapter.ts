/**
 * Demo Team Cost Service Adapter
 * Implements ITeamCostService using in-memory data
 */

import { ITeamCostService, TeamCost } from '../../../core/ports/team-cost.port'

const now = new Date().toISOString()

export class DemoTeamCostService implements ITeamCostService {
  private costs: TeamCost[] = [
    {
      id: 1,
      teamId: 1,
      month: '2026-02',
      totalCost: 500000,
      headcount: 5,
      currency: 'CZK',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 2,
      teamId: 1,
      month: '2026-03',
      totalCost: 520000,
      headcount: 5,
      currency: 'CZK',
      createdAt: now,
      updatedAt: now,
    },
  ]

  private nextId = 3

  async getCost(teamId: number, month: string): Promise<TeamCost | null> {
    return this.costs.find(c => c.teamId === teamId && c.month === month) ?? null
  }

  async upsertCost(params: {
    teamId: number;
    month: string;
    totalCost: number;
    headcount: number;
    currency: string;
  }): Promise<TeamCost> {
    const existing = this.costs.find(c => c.teamId === params.teamId && c.month === params.month)

    if (existing) {
      existing.totalCost = params.totalCost
      existing.headcount = params.headcount
      existing.currency = params.currency
      existing.updatedAt = new Date().toISOString()
      return existing
    }

    const cost: TeamCost = {
      id: this.nextId++,
      teamId: params.teamId,
      month: params.month,
      totalCost: params.totalCost,
      headcount: params.headcount,
      currency: params.currency,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.costs.push(cost)
    return cost
  }

  async getCostRange(teamId: number, fromMonth: string, toMonth: string): Promise<TeamCost[]> {
    return this.costs
      .filter(c => c.teamId === teamId && c.month >= fromMonth && c.month <= toMonth)
      .sort((a, b) => a.month.localeCompare(b.month))
  }
}

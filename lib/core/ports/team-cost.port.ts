/**
 * Team Cost Service Port
 * Defines the contract for managing monthly team cost data
 */

export interface TeamCost {
  id: number;
  teamId: number;
  month: string;
  totalCost: number;
  headcount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface ITeamCostService {
  getCost(teamId: number, month: string): Promise<TeamCost | null>;
  upsertCost(params: {
    teamId: number;
    month: string;
    totalCost: number;
    headcount: number;
    currency: string;
  }): Promise<TeamCost>;
  getCostRange(teamId: number, fromMonth: string, toMonth: string): Promise<TeamCost[]>;
}

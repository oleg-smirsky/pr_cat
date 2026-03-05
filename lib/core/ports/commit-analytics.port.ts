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

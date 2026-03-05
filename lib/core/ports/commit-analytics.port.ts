/**
 * Commit Analytics Service Port
 * Defines the contract for commit-based analytics such as cost allocation
 */

export interface CostAllocationMember {
  userId: string | null;
  name: string;
  repos: Array<{
    repositoryId: number;
    name: string;
    commits: number;
  }>;
  totalCommits: number;
}

export interface CostAllocationResult {
  month: string;          // start month
  monthEnd?: string;      // end month if range
  team: { id: number; name: string } | null;
  members: CostAllocationMember[];
  repoTotals: Array<{
    repositoryId: number;
    name: string;
    commits: number;
    percentage: number;
  }>;
  totalCommits: number;
}

export interface ProjectAllocation {
  project: { id: number; name: string } | null; // null = unallocated
  commits: number;
  percentage: number;
}

export interface CostAllocationByProjectResult {
  month: string;
  monthEnd?: string;
  team: { id: number; name: string } | null;
  allocations: ProjectAllocation[];
  totalCommits: number;
}

export interface CostAllocationParams {
  month: string;         // YYYY-MM (start month)
  monthEnd?: string;     // YYYY-MM (end month, inclusive). If omitted, single month.
  teamId?: number;
}

export interface ICommitAnalyticsService {
  getCostAllocation(params: CostAllocationParams): Promise<CostAllocationResult>;
  getCostAllocationByProject(params: CostAllocationParams): Promise<CostAllocationByProjectResult>;
}

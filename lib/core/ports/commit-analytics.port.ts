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
  month: string;
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
  team: { id: number; name: string } | null;
  allocations: ProjectAllocation[];
  totalCommits: number;
}

export interface ICommitAnalyticsService {
  getCostAllocation(params: {
    month: string;       // YYYY-MM
    teamId?: number;
  }): Promise<CostAllocationResult>;

  getCostAllocationByProject(params: {
    month: string;
    teamId?: number;
  }): Promise<CostAllocationByProjectResult>;
}

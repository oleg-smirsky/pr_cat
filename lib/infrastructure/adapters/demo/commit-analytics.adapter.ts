/**
 * Demo Commit Analytics Service Adapter
 * Implements ICommitAnalyticsService using hardcoded mock data
 */

import { ICommitAnalyticsService, CostAllocationResult } from '../../../core/ports/commit-analytics.port';

export class DemoCommitAnalyticsService implements ICommitAnalyticsService {
  async getCostAllocation(params: { month: string; teamId?: number }): Promise<CostAllocationResult> {
    const totalCommits = 400;
    return {
      month: params.month,
      team: params.teamId ? { id: params.teamId, name: 'Demo Team' } : null,
      members: [
        {
          userId: 'demo-user-1',
          name: 'Alice Chen',
          repos: [
            { repositoryId: 1, name: 'PrusaBuddyPrivate', commits: 120 },
            { repositoryId: 2, name: 'PrusaOS', commits: 60 },
            { repositoryId: 3, name: 'other-repo', commits: 20 },
          ],
          totalCommits: 200,
        },
        {
          userId: 'demo-user-2',
          name: 'Bob Martinez',
          repos: [
            { repositoryId: 1, name: 'PrusaBuddyPrivate', commits: 80 },
            { repositoryId: 2, name: 'PrusaOS', commits: 100 },
            { repositoryId: 3, name: 'other-repo', commits: 20 },
          ],
          totalCommits: 200,
        },
      ],
      repoTotals: [
        { repositoryId: 1, name: 'PrusaBuddyPrivate', commits: 200, percentage: 50 },
        { repositoryId: 2, name: 'PrusaOS', commits: 160, percentage: 40 },
        { repositoryId: 3, name: 'other-repo', commits: 40, percentage: 10 },
      ],
      totalCommits,
    };
  }
}

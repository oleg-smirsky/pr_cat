jest.mock('@/lib/db');

import { TursoCommitAnalyticsService } from '@/lib/infrastructure/adapters/turso/commit-analytics.adapter';
import { query } from '@/lib/db';

const mockQuery = query as jest.Mock;

describe('TursoCommitAnalyticsService', () => {
  const service = new TursoCommitAnalyticsService();

  beforeEach(() => jest.clearAllMocks());

  it('returns cost allocation grouped by author and repo for a month', async () => {
    mockQuery.mockResolvedValueOnce([
      { author_id: 'user-1', author_name: 'Alice', repository_id: 1, repo_name: 'repo-a', commit_count: 10 },
      { author_id: 'user-2', author_name: 'Bob', repository_id: 1, repo_name: 'repo-a', commit_count: 5 },
      { author_id: 'user-1', author_name: 'Alice', repository_id: 2, repo_name: 'repo-b', commit_count: 3 },
    ]);

    const result = await service.getCostAllocation({ month: '2025-03' });

    expect(result.month).toBe('2025-03');
    expect(result.team).toBeNull();
    expect(result.totalCommits).toBe(18);
    expect(result.members).toHaveLength(2);

    // Alice: 10 + 3 = 13
    const alice = result.members.find(m => m.name === 'Alice');
    expect(alice?.totalCommits).toBe(13);
    expect(alice?.repos).toHaveLength(2);

    // Bob: 5
    const bob = result.members.find(m => m.name === 'Bob');
    expect(bob?.totalCommits).toBe(5);

    // Repo totals
    expect(result.repoTotals).toHaveLength(2);
    const repoA = result.repoTotals.find(r => r.name === 'repo-a');
    expect(repoA?.commits).toBe(15);
    expect(repoA?.percentage).toBe(83); // 15/18 * 100 ≈ 83
  });

  it('returns empty result when no commits in range', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const result = await service.getCostAllocation({ month: '2025-06' });

    expect(result.totalCommits).toBe(0);
    expect(result.members).toHaveLength(0);
    expect(result.repoTotals).toHaveLength(0);
  });

  it('includes team info when teamId is provided', async () => {
    // First call: commit aggregation (with team filter)
    mockQuery.mockResolvedValueOnce([
      { author_id: 'user-1', author_name: 'Alice', repository_id: 1, repo_name: 'repo-a', commit_count: 10 },
    ]);
    // Second call: team lookup
    mockQuery.mockResolvedValueOnce([
      { id: 1, name: 'Firmware' },
    ]);

    const result = await service.getCostAllocation({ month: '2025-03', teamId: 1 });

    expect(result.team).toEqual({ id: 1, name: 'Firmware' });
    // Verify team filter was used in SQL
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('handles December to January month boundary correctly', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await service.getCostAllocation({ month: '2025-12' });

    // Should query from 2025-12-01 to 2026-01-01
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['2025-12-01', '2026-01-01'])
    );
  });
});

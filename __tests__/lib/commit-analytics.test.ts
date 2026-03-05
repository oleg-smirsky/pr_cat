jest.mock('@/lib/db');

import { TursoCommitAnalyticsService } from '@/lib/infrastructure/adapters/turso/commit-analytics.adapter';
import { query } from '@/lib/db';

const mockQuery = query as jest.Mock;

describe('TursoCommitAnalyticsService', () => {
  const service = new TursoCommitAnalyticsService();

  beforeEach(() => jest.clearAllMocks());

  describe('getCostAllocationByProject', () => {
    it('returns project allocations for a single month', async () => {
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'INDX', commit_count: 10 },
        { project_id: null, project_name: null, commit_count: 5 },
      ]);

      const result = await service.getCostAllocationByProject({ month: '2026-01' });

      expect(result.month).toBe('2026-01');
      expect(result.team).toBeNull();
      expect(result.totalCommits).toBe(15);
      expect(result.allocations).toHaveLength(2);
      expect(result.monthlyBreakdowns).toBeUndefined();
    });

    it('includes team info when teamId is provided', async () => {
      mockQuery.mockResolvedValueOnce([
        { id: 1, name: 'Firmware' },
      ]);
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'INDX', commit_count: 10 },
      ]);

      const result = await service.getCostAllocationByProject({ month: '2026-01', teamId: 1 });

      expect(result.team).toEqual({ id: 1, name: 'Firmware' });
    });

    it('returns monthly breakdowns when monthEnd is provided', async () => {
      // Jan query
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'INDX', commit_count: 10 },
        { project_id: null, project_name: null, commit_count: 5 },
      ]);
      // Feb query
      mockQuery.mockResolvedValueOnce([
        { project_id: 1, project_name: 'INDX', commit_count: 8 },
        { project_id: 2, project_name: 'Core One', commit_count: 3 },
      ]);

      const result = await service.getCostAllocationByProject({
        month: '2026-01',
        monthEnd: '2026-02',
      });

      expect(result.monthlyBreakdowns).toHaveLength(2);

      const jan = result.monthlyBreakdowns![0];
      expect(jan.month).toBe('2026-01');
      expect(jan.totalCommits).toBe(15);
      expect(jan.allocations).toHaveLength(2);

      const feb = result.monthlyBreakdowns![1];
      expect(feb.month).toBe('2026-02');
      expect(feb.totalCommits).toBe(11);

      expect(result.totalCommits).toBe(26);
      const indx = result.allocations.find(a => a.project?.name === 'INDX');
      expect(indx?.commits).toBe(18);
    });

    it('handles December to January boundary in range', async () => {
      mockQuery.mockResolvedValueOnce([]);
      mockQuery.mockResolvedValueOnce([]);

      await service.getCostAllocationByProject({
        month: '2025-12',
        monthEnd: '2026-01',
      });

      // Dec query: 2025-12-01 to 2026-01-01
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['2025-12-01', '2026-01-01'])
      );
      // Jan query: 2026-01-01 to 2026-02-01
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['2026-01-01', '2026-02-01'])
      );
    });

    it('returns empty result when no commits in range', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const result = await service.getCostAllocationByProject({ month: '2026-06' });

      expect(result.totalCommits).toBe(0);
      expect(result.allocations).toHaveLength(0);
    });
  });
});

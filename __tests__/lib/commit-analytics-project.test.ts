import { DemoCommitAnalyticsService } from '@/lib/infrastructure/adapters/demo/commit-analytics.adapter';

describe('getCostAllocationByProject', () => {
  const service = new DemoCommitAnalyticsService();

  it('returns project allocations with month', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    expect(result.month).toBe('2026-02');
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.totalCommits).toBeGreaterThan(0);
  });

  it('includes unallocated bucket (project = null)', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    const unallocated = result.allocations.find(a => a.project === null);
    expect(unallocated).toBeDefined();
  });

  it('percentages sum to 100', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    const sum = result.allocations.reduce((s, a) => s + a.percentage, 0);
    expect(sum).toBeCloseTo(100, 0);
  });

  it('accepts optional teamId', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02', teamId: 1 });
    expect(result.team).toEqual({ id: 1, name: 'Demo Team' });
  });
});

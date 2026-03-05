import { DemoCommitAnalyticsService } from '@/lib/infrastructure/adapters/demo/commit-analytics.adapter';

describe('getCostAllocationByProject', () => {
  const service = new DemoCommitAnalyticsService();

  it('returns project allocations with month', async () => {
    const result = await service.getCostAllocationByProject({ month: '2026-02' });
    expect(result.month).toBe('2026-02');
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.totalCommits).toBeGreaterThan(0);
    expect(result.monthlyBreakdowns).toBeUndefined();
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

  it('returns monthly breakdowns for multi-month range', async () => {
    const result = await service.getCostAllocationByProject({
      month: '2026-01',
      monthEnd: '2026-03',
    });
    expect(result.monthlyBreakdowns).toHaveLength(3);
    expect(result.monthlyBreakdowns![0].month).toBe('2026-01');
    expect(result.monthlyBreakdowns![2].month).toBe('2026-03');
    expect(result.totalCommits).toBeGreaterThan(0);
  });
});

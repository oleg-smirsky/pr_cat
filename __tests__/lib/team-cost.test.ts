import { DemoTeamCostService } from '@/lib/infrastructure/adapters/demo/team-cost.adapter';

describe('DemoTeamCostService', () => {
  let service: DemoTeamCostService;

  beforeEach(() => {
    service = new DemoTeamCostService();
  });

  it('getCost returns existing cost', async () => {
    const cost = await service.getCost(1, '2026-02');
    expect(cost).not.toBeNull();
    expect(cost!.totalCost).toBe(500000);
  });

  it('getCost returns null for missing', async () => {
    const cost = await service.getCost(1, '2025-01');
    expect(cost).toBeNull();
  });

  it('upsertCost creates new entry', async () => {
    const cost = await service.upsertCost({
      teamId: 2, month: '2026-01', totalCost: 300000, headcount: 3, currency: 'EUR'
    });
    expect(cost.teamId).toBe(2);
    expect(cost.totalCost).toBe(300000);
  });

  it('upsertCost updates existing entry', async () => {
    await service.upsertCost({
      teamId: 1, month: '2026-02', totalCost: 600000, headcount: 6, currency: 'CZK'
    });
    const cost = await service.getCost(1, '2026-02');
    expect(cost!.totalCost).toBe(600000);
    expect(cost!.headcount).toBe(6);
  });

  it('getCostRange returns costs in range', async () => {
    const costs = await service.getCostRange(1, '2026-01', '2026-12');
    expect(costs.length).toBe(2);
  });

  it('getCostRange returns empty for no match', async () => {
    const costs = await service.getCostRange(99, '2026-01', '2026-12');
    expect(costs).toEqual([]);
  });
});

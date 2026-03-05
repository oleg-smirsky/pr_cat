import type { ApplicationContext } from '@/lib/core/application/context';
import type { CostAllocationByProjectResult } from '@/lib/core/ports/commit-analytics.port';

jest.mock('next/server', () => {
  class MockNextResponse {
    private _body: unknown;
    readonly status: number;
    readonly headers: Headers;

    constructor(body: unknown, init?: { status?: number; headers?: Headers }) {
      this._body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? new Headers();
    }

    async json() {
      return this._body;
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, {
        status: init?.status,
        headers: new Headers(init?.headers),
      });
    }
  }

  return {
    __esModule: true,
    NextResponse: MockNextResponse,
    NextRequest: jest.fn(),
  };
});

const mockContext: ApplicationContext = {
  user: {
    id: 'user-123',
    name: 'Test User',
    email: 'test@example.com',
  },
  organizationId: '1',
  primaryOrganization: {
    id: 1,
    github_id: 12345,
    name: 'test-org',
    avatar_url: 'https://example.com/org-avatar.jpg',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    installation_id: 67890,
  },
  organizations: [{
    id: 1,
    github_id: 12345,
    name: 'test-org',
    avatar_url: 'https://example.com/org-avatar.jpg',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    installation_id: 67890,
  }],
  permissions: {
    canRead: true,
    canWrite: true,
    canAdmin: false,
    role: 'member',
  },
  requestId: 'req_test_123',
};

jest.mock('@/lib/core', () => ({
  withAuth: (handler: (...args: unknown[]) => unknown) => {
    return (request: unknown) => handler(mockContext, request);
  },
  ApplicationContext: {},
}));

const mockGetCostAllocationByProject = jest.fn();

jest.mock('@/lib/core/container', () => ({
  ServiceLocator: {
    getCommitAnalyticsService: () => Promise.resolve({
      getCostAllocationByProject: mockGetCostAllocationByProject,
    }),
  },
}));

import { GET } from '@/app/api/analytics/cost-allocation/route';

function createRequest(url: string) {
  return { url } as unknown;
}

const mockProjectResult: CostAllocationByProjectResult = {
  month: '2025-03',
  team: null,
  allocations: [
    { project: { id: 1, name: 'INDX' }, commits: 20, percentage: 66.7 },
    { project: null, commits: 10, percentage: 33.3 },
  ],
  totalCommits: 30,
};

describe('GET /api/analytics/cost-allocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCostAllocationByProject.mockResolvedValue(mockProjectResult);
  });

  it('returns 400 when month param is missing', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation');
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'month parameter required (YYYY-MM format)' });
  });

  it('returns 400 when month param has invalid format', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-13-01');
    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it('returns 400 when teamId is not a valid number', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=abc');
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'teamId must be a positive integer' });
  });

  it('returns 400 when teamId is zero', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=0');
    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it('returns 400 when monthEnd has invalid format', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03&monthEnd=bad');
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'monthEnd must be YYYY-MM format' });
  });

  it('returns 400 when monthEnd is before month', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03&monthEnd=2025-01');
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'monthEnd must not be before month' });
  });

  it('returns project allocation data for a valid month', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json() as CostAllocationByProjectResult;

    expect(data.month).toBe('2025-03');
    expect(data.team).toBeNull();
    expect(data.allocations).toHaveLength(2);
    expect(data.totalCommits).toBe(30);

    expect(mockGetCostAllocationByProject).toHaveBeenCalledWith({
      month: '2025-03',
      monthEnd: undefined,
      teamId: undefined,
    });
  });

  it('passes monthEnd to service when provided', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-01&monthEnd=2025-03');
    await GET(request);

    expect(mockGetCostAllocationByProject).toHaveBeenCalledWith({
      month: '2025-01',
      monthEnd: '2025-03',
      teamId: undefined,
    });
  });

  it('passes teamId to service when provided', async () => {
    const resultWithTeam = { ...mockProjectResult, team: { id: 7, name: 'Engineering' } };
    mockGetCostAllocationByProject.mockResolvedValue(resultWithTeam);

    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=7');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.team).toEqual({ id: 7, name: 'Engineering' });

    expect(mockGetCostAllocationByProject).toHaveBeenCalledWith({
      month: '2025-03',
      monthEnd: undefined,
      teamId: 7,
    });
  });

  it('returns 500 when service throws', async () => {
    mockGetCostAllocationByProject.mockRejectedValue(new Error('DB error'));

    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation?month=2025-03');
    const response = await GET(request);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data).toEqual({ error: 'Failed to fetch cost allocation data' });
  });
});

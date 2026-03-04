// Integration tests for cost allocation API route
import type { ApplicationContext } from '@/lib/core/application/context';
import type { CostAllocationResult } from '@/lib/core/ports/commit-analytics.port';

// Mock next/server with a NextResponse that works in jsdom without native Response.json
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

// Build a mock ApplicationContext
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

// Mock withAuth to pass through to handler with mockContext
jest.mock('@/lib/core', () => ({
  withAuth: (handler: Function) => {
    return (request: unknown) => handler(mockContext, request);
  },
  ApplicationContext: {},
}));

// Jest allows variables prefixed with "mock" to be referenced in hoisted jest.mock calls
const mockGetCostAllocation = jest.fn();

jest.mock('@/lib/core/container', () => ({
  ServiceLocator: {
    getCommitAnalyticsService: () => Promise.resolve({
      getCostAllocation: mockGetCostAllocation,
    }),
  },
}));

import { GET } from '@/app/api/analytics/cost-allocation/route';

/**
 * Helper to create a minimal request-like object with a url property.
 * The handler only reads request.url via `new URL(request.url)`.
 */
function createRequest(url: string) {
  return { url } as unknown;
}

const mockCostAllocationResult: CostAllocationResult = {
  month: '2025-03',
  team: null,
  members: [
    {
      userId: 'user-123',
      name: 'Test User',
      repos: [
        { repositoryId: 1, name: 'test-repo', commits: 15 },
        { repositoryId: 2, name: 'other-repo', commits: 5 },
      ],
      totalCommits: 20,
    },
    {
      userId: 'user-456',
      name: 'Another User',
      repos: [
        { repositoryId: 1, name: 'test-repo', commits: 10 },
      ],
      totalCommits: 10,
    },
  ],
  repoTotals: [
    { repositoryId: 1, name: 'test-repo', commits: 25, percentage: 83.33 },
    { repositoryId: 2, name: 'other-repo', commits: 5, percentage: 16.67 },
  ],
  totalCommits: 30,
};

const mockCostAllocationWithTeam: CostAllocationResult = {
  ...mockCostAllocationResult,
  team: { id: 7, name: 'Engineering' },
};

describe('GET /api/analytics/cost-allocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCostAllocation.mockResolvedValue(mockCostAllocationResult);
  });

  it('returns 400 when month param is missing', async () => {
    const request = createRequest('http://localhost:3000/api/analytics/cost-allocation');
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'month parameter required (YYYY-MM format)' });
  });

  it('returns 400 when month param has invalid format (extra segments)', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-13-01'
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'month parameter required (YYYY-MM format)' });
  });

  it('returns 400 when month param is just text', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=march'
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'month parameter required (YYYY-MM format)' });
  });

  it('returns 400 when teamId is not a valid number', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=abc'
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'teamId must be a positive integer' });
  });

  it('returns 400 when teamId is zero', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=0'
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'teamId must be a positive integer' });
  });

  it('returns 400 when teamId is negative', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=-1'
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'teamId must be a positive integer' });
  });

  it('returns valid cost allocation data for a valid month', async () => {
    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03'
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json() as CostAllocationResult;

    expect(data.month).toBe('2025-03');
    expect(data.team).toBeNull();
    expect(data.members).toHaveLength(2);
    expect(data.repoTotals).toHaveLength(2);
    expect(data.totalCommits).toBe(30);

    // Verify member shape
    expect(data.members[0]).toEqual({
      userId: 'user-123',
      name: 'Test User',
      repos: [
        { repositoryId: 1, name: 'test-repo', commits: 15 },
        { repositoryId: 2, name: 'other-repo', commits: 5 },
      ],
      totalCommits: 20,
    });

    // Verify repo totals shape
    expect(data.repoTotals[0]).toEqual({
      repositoryId: 1,
      name: 'test-repo',
      commits: 25,
      percentage: 83.33,
    });

    // Verify service was called correctly
    expect(mockGetCostAllocation).toHaveBeenCalledWith({
      month: '2025-03',
      teamId: undefined,
    });
  });

  it('returns data with team info when teamId is provided', async () => {
    mockGetCostAllocation.mockResolvedValue(mockCostAllocationWithTeam);

    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03&teamId=7'
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json() as CostAllocationResult;

    expect(data.month).toBe('2025-03');
    expect(data.team).toEqual({ id: 7, name: 'Engineering' });
    expect(data.members).toHaveLength(2);
    expect(data.totalCommits).toBe(30);

    // Verify service was called with teamId
    expect(mockGetCostAllocation).toHaveBeenCalledWith({
      month: '2025-03',
      teamId: 7,
    });
  });

  it('returns 500 when service throws an error', async () => {
    mockGetCostAllocation.mockRejectedValue(new Error('Database connection failed'));

    const request = createRequest(
      'http://localhost:3000/api/analytics/cost-allocation?month=2025-03'
    );
    const response = await GET(request);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data).toEqual({ error: 'Failed to fetch cost allocation data' });
  });
});

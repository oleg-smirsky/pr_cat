import { NextRequest, NextResponse } from 'next/server';
import { Pagination, ServiceLocator } from '@/lib/core';
import type { MetricsSummary, PaginatedResult, PullRequestSummary } from '@/lib/core';
import { getUserWithOrganizations } from '@/lib/auth-context';

export const runtime = 'nodejs';

type DashboardInclude = 'repositories' | 'metrics-summary' | 'recent-prs';

type DashboardRepository = {
  id: string;
  name: string;
  full_name: string;
  organization: {
    id: string;
    name: string;
  };
  is_tracked: boolean;
  private: boolean;
  description: string | null;
};

type DashboardDataResponse = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
  organizations: Array<{
    id: string;
    name: string | null;
    role?: string;
  }>;
  primaryOrganization: {
    id: string;
    name: string | null;
  };
  repositories?: DashboardRepository[];
  metricsSummary?: MetricsSummary;
  recentPRs?: PaginatedResult<PullRequestSummary>;
};

function parseInclude(searchParams: URLSearchParams): Set<DashboardInclude> {
  const includeValues = searchParams.get('include')?.split(',') ?? [];
  return new Set(
    includeValues
      .map((value) => value.trim())
      .filter((value): value is DashboardInclude =>
        value === 'repositories' ||
        value === 'metrics-summary' ||
        value === 'recent-prs'
      )
  );
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const include = parseInclude(searchParams);
    const teamId = parseOptionalInt(searchParams.get('teamId'));
    const timeRange = searchParams.get('timeRange') ?? '14d';
    const page = Math.max(1, parseOptionalInt(searchParams.get('page')) ?? 1);
    const limit = Math.max(
      1,
      Math.min(100, parseOptionalInt(searchParams.get('limit')) ?? 10)
    );
    
    // Use cached user context
    const { user, organizations, primaryOrganization } = await getUserWithOrganizations(request);
    const organizationId = String(primaryOrganization.id);
    
    const repositoriesPromise: Promise<DashboardRepository[] | undefined> = include.has('repositories')
      ? (async () => {
          const organizationRepository = await ServiceLocator.getOrganizationRepository();
          const repositories = await organizationRepository.getRepositories(organizationId);
          return repositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            full_name: repository.fullName,
            organization: {
              id: organizationId,
              name: primaryOrganization.name ?? 'Demo Organization',
            },
            is_tracked: repository.isTracked,
            private: repository.isPrivate,
            description: repository.description,
          }));
        })()
      : Promise.resolve(undefined);

    const metricsSummaryPromise: Promise<MetricsSummary | undefined> = include.has('metrics-summary')
      ? (async () => {
          const metricsService = await ServiceLocator.getMetricsService();
          return metricsService.getSummary(organizationId, teamId, timeRange);
        })()
      : Promise.resolve(undefined);

    const recentPullRequestsPromise: Promise<PaginatedResult<PullRequestSummary> | undefined> = include.has('recent-prs')
      ? (async () => {
          const prRepository = await ServiceLocator.getPullRequestRepository();
          return prRepository.getRecent(
            organizationId,
            Pagination.create(page, limit),
            teamId,
            timeRange
          );
        })()
      : Promise.resolve(undefined);

    const [repositories, metricsSummary, recentPRs] = await Promise.all([
      repositoriesPromise,
      metricsSummaryPromise,
      recentPullRequestsPromise,
    ]);

    const response: DashboardDataResponse = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      organizations: organizations.map(org => ({
        id: String(org.id),
        name: org.name,
        role: org.role
      })),
      primaryOrganization: {
        id: organizationId,
        name: primaryOrganization.name
      }
    };

    if (repositories) {
      response.repositories = repositories;
    }

    if (metricsSummary) {
      response.metricsSummary = metricsSummary;
    }

    if (recentPRs) {
      response.recentPRs = recentPRs;
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    
    if (error instanceof Error && error.message.includes('Not authenticated')) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    
    return NextResponse.json({ 
      error: 'Failed to fetch dashboard data',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
} 

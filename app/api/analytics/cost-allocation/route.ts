import { NextRequest, NextResponse } from 'next/server';
import { withAuth, ApplicationContext } from '@/lib/core';
import { ServiceLocator } from '@/lib/core/container';

export const runtime = 'nodejs';

const handler = async (
  context: ApplicationContext,
  request: NextRequest
): Promise<NextResponse> => {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month');
  const monthEnd = searchParams.get('monthEnd');

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: 'month parameter required (YYYY-MM format)' },
      { status: 400 }
    );
  }

  if (monthEnd && !/^\d{4}-\d{2}$/.test(monthEnd)) {
    return NextResponse.json(
      { error: 'monthEnd must be YYYY-MM format' },
      { status: 400 }
    );
  }

  if (monthEnd && monthEnd < month) {
    return NextResponse.json(
      { error: 'monthEnd must not be before month' },
      { status: 400 }
    );
  }

  const teamIdStr = searchParams.get('teamId');
  const teamId = teamIdStr ? parseInt(teamIdStr, 10) : undefined;

  if (teamIdStr && (isNaN(teamId!) || teamId! < 1)) {
    return NextResponse.json(
      { error: 'teamId must be a positive integer' },
      { status: 400 }
    );
  }

  try {
    const service = await ServiceLocator.getCommitAnalyticsService();
    const result = await service.getCostAllocationByProject({
      month,
      monthEnd: monthEnd ?? undefined,
      teamId,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Cost allocation error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch cost allocation data' },
      { status: 500 }
    );
  }
};

export const GET = withAuth(handler);

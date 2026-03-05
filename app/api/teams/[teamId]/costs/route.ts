import { NextRequest, NextResponse } from 'next/server';
import { withAuth, ApplicationContext } from '@/lib/core';
import { ServiceLocator } from '@/lib/core/container/service-locator';

export const runtime = 'nodejs';

// GET handler — fetch team cost for a given month
const getHandler = async (
  context: ApplicationContext,
  request: NextRequest,
  params: { teamId: string }
): Promise<NextResponse> => {
  const teamId = parseInt(params.teamId, 10);
  if (isNaN(teamId) || teamId < 1) {
    return NextResponse.json(
      { error: 'teamId must be a positive integer' },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month');

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: 'month query parameter required (YYYY-MM format)' },
      { status: 400 }
    );
  }

  try {
    const service = await ServiceLocator.getTeamCostService();
    const cost = await service.getCost(teamId, month);
    return NextResponse.json(cost);
  } catch (error) {
    console.error('Error fetching team cost:', error);
    return NextResponse.json(
      { error: 'Failed to fetch team cost' },
      { status: 500 }
    );
  }
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const resolvedParams = await params;
  const authHandler = withAuth(async (ctx, req) =>
    getHandler(ctx, req, resolvedParams)
  );
  return authHandler(request);
}

// PUT handler — upsert team cost
const putHandler = async (
  context: ApplicationContext,
  request: NextRequest,
  params: { teamId: string }
): Promise<NextResponse> => {
  const teamId = parseInt(params.teamId, 10);
  if (isNaN(teamId) || teamId < 1) {
    return NextResponse.json(
      { error: 'teamId must be a positive integer' },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { month, totalCost, headcount, currency } = body as {
    month?: string;
    totalCost?: number;
    headcount?: number;
    currency?: string;
  };

  // Validate required fields
  const errors: string[] = [];
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    errors.push('month is required (YYYY-MM format)');
  }
  if (totalCost === undefined || typeof totalCost !== 'number' || totalCost <= 0) {
    errors.push('totalCost is required and must be greater than 0');
  }
  if (headcount === undefined || typeof headcount !== 'number' || headcount <= 0 || !Number.isInteger(headcount)) {
    errors.push('headcount is required and must be a positive integer');
  }

  if (errors.length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', details: errors },
      { status: 400 }
    );
  }

  try {
    const service = await ServiceLocator.getTeamCostService();
    const result = await service.upsertCost({
      teamId,
      month: month!,
      totalCost: totalCost!,
      headcount: headcount!,
      currency: currency || 'CZK',
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error upserting team cost:', error);
    return NextResponse.json(
      { error: 'Failed to save team cost' },
      { status: 500 }
    );
  }
};

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const resolvedParams = await params;
  const authHandler = withAuth(async (ctx, req) =>
    putHandler(ctx, req, resolvedParams)
  );
  return authHandler(request);
}

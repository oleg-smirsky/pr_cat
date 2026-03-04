import { NextRequest, NextResponse } from 'next/server'
import { ServiceLocator, withAuth, ApplicationContext } from '@/lib/core'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = async (
  context: ApplicationContext,
  request: NextRequest
): Promise<NextResponse> => {
  try {
    const jobService = await ServiceLocator.getJobService()
    const jobs = await jobService.getAll()

    return NextResponse.json({ jobs })
  } catch (error) {
    console.error('Error listing jobs:', error)
    return NextResponse.json(
      { error: 'Failed to list jobs' },
      { status: 500 }
    )
  }
}

export const GET = withAuth(handler)

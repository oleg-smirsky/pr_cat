import { NextRequest, NextResponse } from 'next/server'
import { withAuth, ApplicationContext } from '@/lib/core'
import { JobRunner } from '@/lib/infrastructure/adapters/jobs/job-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = async (
  context: ApplicationContext,
  request: NextRequest,
): Promise<NextResponse> => {
  const jobName = request.nextUrl.pathname.split('/').pop()
  if (!jobName) {
    return NextResponse.json({ error: 'Job name required' }, { status: 400 })
  }

  try {
    const runner = JobRunner.getInstance()
    await runner.cancel(decodeURIComponent(jobName))
    return NextResponse.json({ message: 'Job cancelled' })
  } catch (error) {
    console.error('Error cancelling job:', error)
    return NextResponse.json(
      { error: 'Failed to cancel job' },
      { status: 500 }
    )
  }
}

export const DELETE = withAuth(handler)

import { NextRequest, NextResponse } from 'next/server'
import { withAuth, ApplicationContext } from '@/lib/core'
import { JobRunner } from '@/lib/infrastructure/adapters/jobs/job-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = async (
  context: ApplicationContext,
  request: NextRequest,
): Promise<NextResponse> => {
  const jobName = request.nextUrl.pathname.split('/').at(-2)
  if (!jobName) {
    return NextResponse.json({ error: 'Job name required' }, { status: 400 })
  }

  try {
    const runner = JobRunner.getInstance()
    const jobService = runner.getJobService()
    const job = await jobService.getByName(decodeURIComponent(jobName))

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status === 'running') {
      return NextResponse.json({ error: 'Job is already running' }, { status: 409 })
    }

    // Re-enqueue the job to reset it to pending
    const updated = await jobService.enqueue(job.type, job.name, job.payload ?? undefined)
    return NextResponse.json({ job: updated, message: 'Job triggered' })
  } catch (error) {
    console.error('Error triggering job:', error)
    return NextResponse.json(
      { error: 'Failed to trigger job' },
      { status: 500 }
    )
  }
}

export const POST = withAuth(handler)

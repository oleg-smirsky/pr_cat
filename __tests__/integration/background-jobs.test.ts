/**
 * Integration test for the background job system.
 *
 * Uses a real in-memory libsql database — no mock functions.
 * The only jest.mock is the import redirect so that all production
 * code that does `import { query, execute } from '@/lib/db'`
 * hits the in-memory database instead of Turso.
 */
import { createClient } from '@libsql/client'

// ── Real in-memory DB wired into the @/lib/db import ────────────
// Must live outside jest.mock factory to be accessible in tests.
// Use a shared module-level reference that the factory closure captures.
const db = createClient({ url: ':memory:' })

function realQuery(sql: string, params: unknown[] = []) {
  return db.execute({ sql, args: params as never[] }).then(r => r.rows)
}

function realExecute(sql: string, params: unknown[] = []) {
  return db.execute({ sql, args: params as never[] }).then(r => ({
    lastInsertId: r.lastInsertRowid ? Number(r.lastInsertRowid) : undefined,
    rowsAffected: r.rowsAffected,
  }))
}

jest.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => realQuery(args[0] as string, args[1] as unknown[]),
  execute: (...args: unknown[]) => realExecute(args[0] as string, args[1] as unknown[]),
  getDbClient: () => db,
  transaction: async (callback: (tx: { query: Function; execute: Function }) => Promise<unknown>) => {
    return callback({ query: realQuery, execute: realExecute })
  },
}))

import { runMigrations } from '@/lib/migrate'
import { SQLiteJobService } from '@/lib/infrastructure/adapters/jobs/job.adapter'
import { JobRunner } from '@/lib/infrastructure/adapters/jobs/job-runner'
import type { JobHandler, BackgroundJob } from '@/lib/jobs/types'

// ── Test job handler — no GitHub, just records what it did ───────
const executionLog: { jobName: string; payload: unknown; progressUpdates: number }[] = []

class TestJobHandler implements JobHandler {
  constructor(private jobService: SQLiteJobService) {}

  async execute(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const entry = { jobName: job.name, payload: job.payload, progressUpdates: 0 }

    // Simulate doing work in 3 steps
    for (let step = 1; step <= 3; step++) {
      if (signal.aborted) throw new Error('Cancelled')
      await this.jobService.updateProgress(job.id, { step, total: 3 })
      entry.progressUpdates++
    }

    executionLog.push(entry)
  }
}

// ── Tests ────────────────────────────────────────────────────────
describe('Background Jobs (integration)', () => {
  let jobService: SQLiteJobService

  beforeAll(async () => {
    await runMigrations()
    jobService = new SQLiteJobService()
  })

  beforeEach(() => {
    executionLog.length = 0
  })

  afterAll(() => {
    JobRunner.reset()
  })

  it('migration creates the background_jobs table', async () => {
    const rows = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='background_jobs'",
      args: [],
    })
    expect(rows.rows).toHaveLength(1)
  })

  it('enqueue creates a pending job with payload', async () => {
    const job = await jobService.enqueue('test-type', 'test-job-1', {
      repositoryId: 42,
      owner: 'acme',
      repo: 'widgets',
    })

    expect(job.status).toBe('pending')
    expect(job.type).toBe('test-type')
    expect(job.name).toBe('test-job-1')
    expect(job.payload).toEqual({ repositoryId: 42, owner: 'acme', repo: 'widgets' })
    expect(job.progress).toBeNull()
  })

  it('getByName retrieves the job', async () => {
    const job = await jobService.getByName('test-job-1')
    expect(job).not.toBeNull()
    expect(job!.name).toBe('test-job-1')
  })

  it('getAll returns all jobs', async () => {
    await jobService.enqueue('test-type', 'test-job-2')
    const jobs = await jobService.getAll()
    expect(jobs.length).toBeGreaterThanOrEqual(2)
  })

  it('claimJob atomically transitions pending → running', async () => {
    const job = (await jobService.getByName('test-job-1'))!
    const claimed = await jobService.claimJob(job.id)
    expect(claimed).toBe(true)

    const updated = (await jobService.getByName('test-job-1'))!
    expect(updated.status).toBe('running')
    expect(updated.started_at).not.toBeNull()
  })

  it('claimJob returns false if already running', async () => {
    const job = (await jobService.getByName('test-job-1'))!
    const claimed = await jobService.claimJob(job.id)
    expect(claimed).toBe(false)
  })

  it('updateProgress persists progress JSON', async () => {
    const job = (await jobService.getByName('test-job-1'))!
    await jobService.updateProgress(job.id, { step: 2, total: 5 })

    const updated = (await jobService.getByName('test-job-1'))!
    expect(updated.progress).toEqual({ step: 2, total: 5 })
  })

  it('updateStatus marks job completed', async () => {
    const job = (await jobService.getByName('test-job-1'))!
    await jobService.updateStatus(job.id, 'completed')

    const updated = (await jobService.getByName('test-job-1'))!
    expect(updated.status).toBe('completed')
    expect(updated.completed_at).not.toBeNull()
  })

  it('cancel sets a pending job to failed with Cancelled message', async () => {
    // test-job-2 is still pending
    await jobService.cancel('test-job-2')
    const job = (await jobService.getByName('test-job-2'))!
    expect(job.status).toBe('failed')
    expect(job.error_message).toBe('Cancelled')
  })

  it('enqueue re-enqueues a completed job back to pending', async () => {
    // test-job-1 was completed above — re-enqueue it
    const job = await jobService.enqueue('test-type', 'test-job-1', { fresh: true })
    expect(job.status).toBe('pending')
    expect(job.payload).toEqual({ fresh: true })
    expect(job.progress).toBeNull()
    expect(job.error_message).toBeNull()
  })

  it('getNextPendingJob returns the oldest ready job', async () => {
    const next = await jobService.getNextPendingJob()
    expect(next).not.toBeNull()
    expect(next!.status).toBe('pending')
  })

  it('rescheduleRecurring sets next_run_at for recurring jobs', async () => {
    // Create and mark a recurring job completed
    const job = await jobService.enqueue('recurring-type', 'recurring-1')
    await jobService.claimJob(job.id)

    // Manually set interval_seconds (normally set by enqueueRecurring)
    await db.execute({
      sql: 'UPDATE background_jobs SET interval_seconds = 900 WHERE id = ?',
      args: [job.id],
    })

    const withInterval = (await jobService.getByName('recurring-1'))!
    await jobService.rescheduleRecurring(withInterval)

    const rescheduled = (await jobService.getByName('recurring-1'))!
    expect(rescheduled.status).toBe('pending')
    expect(rescheduled.next_run_at).not.toBeNull()
    expect(rescheduled.started_at).toBeNull()
  })

  it('resetStaleJobs recovers jobs stuck in running state', async () => {
    // Create a job and claim it, then backdate started_at
    const job = await jobService.enqueue('stale-type', 'stale-job')
    await jobService.claimJob(job.id)
    await db.execute({
      sql: "UPDATE background_jobs SET started_at = datetime('now', '-30 minutes') WHERE id = ?",
      args: [job.id],
    })

    const resetCount = await jobService.resetStaleJobs(10)
    expect(resetCount).toBe(1)

    const recovered = (await jobService.getByName('stale-job'))!
    expect(recovered.status).toBe('pending')
    expect(recovered.started_at).toBeNull()
  })

  describe('JobRunner end-to-end', () => {
    beforeEach(async () => {
      // Clean all jobs so leftover pending jobs don't interfere
      await db.execute({ sql: 'DELETE FROM background_jobs', args: [] })
      executionLog.length = 0
      JobRunner.reset()
    })

    /** Call tick() without starting the setTimeout loop */
    async function runOneTick(runner: JobRunner) {
      // tick() guards on this.running — enable it without starting the loop
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(runner as any).running = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (runner as any).tick()
      // Prevent the tick from scheduling the next setTimeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(runner as any).running = false
      if ((runner as any).timeoutId) {
        clearTimeout((runner as any).timeoutId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(runner as any).timeoutId = null
      }
    }

    function setupRunner() {
      const runner = JobRunner.getInstance()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(runner as any).jobService = jobService
      return runner
    }

    it('picks up a job, executes the handler, and marks it completed', async () => {
      const runner = setupRunner()
      const handler = new TestJobHandler(jobService)
      runner.registerHandler('e2e-test', handler)

      await runner.enqueue('e2e-test', 'e2e-job-1', { message: 'hello' })
      await runOneTick(runner)

      // Verify the handler ran
      expect(executionLog).toHaveLength(1)
      expect(executionLog[0].jobName).toBe('e2e-job-1')
      expect(executionLog[0].payload).toEqual({ message: 'hello' })
      expect(executionLog[0].progressUpdates).toBe(3)

      // Verify DB state
      const job = (await jobService.getByName('e2e-job-1'))!
      expect(job.status).toBe('completed')
      expect(job.completed_at).not.toBeNull()
      expect(job.progress).toEqual({ step: 3, total: 3 })
    })

    it('marks job as failed when handler throws', async () => {
      const runner = setupRunner()

      const failingHandler: JobHandler = {
        async execute() {
          throw new Error('intentional failure')
        },
      }
      runner.registerHandler('fail-type', failingHandler)

      await runner.enqueue('fail-type', 'fail-job-1')
      await runOneTick(runner)

      const job = (await jobService.getByName('fail-job-1'))!
      expect(job.status).toBe('failed')
      expect(job.error_message).toBe('intentional failure')
    })

    it('reschedules a recurring job after successful execution', async () => {
      const runner = setupRunner()

      const noopHandler: JobHandler = {
        async execute() { /* nothing */ },
      }
      runner.registerHandler('recurring-e2e', noopHandler)

      // enqueueRecurring sets next_run_at in the future — override to now so tick picks it up
      await runner.enqueueRecurring('recurring-e2e', 'recurring-e2e-1', 900, { repoId: 7 })
      await db.execute({
        sql: "UPDATE background_jobs SET next_run_at = datetime('now') WHERE name = ?",
        args: ['recurring-e2e-1'],
      })

      await runOneTick(runner)

      const job = (await jobService.getByName('recurring-e2e-1'))!
      // Should be rescheduled back to pending with a future next_run_at
      expect(job.status).toBe('pending')
      expect(job.next_run_at).not.toBeNull()
      expect(job.started_at).toBeNull()
    })

    it('processes multiple jobs sequentially across ticks', async () => {
      const runner = setupRunner()

      const handler = new TestJobHandler(jobService)
      runner.registerHandler('multi-test', handler)

      await runner.enqueue('multi-test', 'multi-1', { order: 1 })
      await runner.enqueue('multi-test', 'multi-2', { order: 2 })
      await runner.enqueue('multi-test', 'multi-3', { order: 3 })

      await runOneTick(runner)
      await runOneTick(runner)
      await runOneTick(runner)

      expect(executionLog).toHaveLength(3)
      expect(executionLog.map(e => e.jobName)).toEqual(['multi-1', 'multi-2', 'multi-3'])

      for (const name of ['multi-1', 'multi-2', 'multi-3']) {
        const job = (await jobService.getByName(name))!
        expect(job.status).toBe('completed')
      }
    })

    it('cancel stops a pending job from being picked up', async () => {
      const runner = setupRunner()

      runner.registerHandler('cancel-type', new TestJobHandler(jobService))
      await runner.enqueue('cancel-type', 'cancel-me', { data: 1 })
      await runner.cancel('cancel-me')

      await runOneTick(runner)

      expect(executionLog.find(e => e.jobName === 'cancel-me')).toBeUndefined()

      const job = (await jobService.getByName('cancel-me'))!
      expect(job.status).toBe('failed')
      expect(job.error_message).toBe('Cancelled')
    })
  })
})

import type { IJobService } from '@/lib/core/ports/job.port'
import type { BackgroundJob, JobHandler } from '@/lib/jobs/types'

// Mock the adapter module so JobRunner's constructor uses our mock
jest.mock('@/lib/infrastructure/adapters/jobs/job.adapter', () => ({
  SQLiteJobService: jest.fn(),
}))

// Mock db for enqueueRecurring's direct execute call
jest.mock('@/lib/db', () => ({
  execute: jest.fn().mockResolvedValue({ rowsAffected: 1 }),
}))

import { JobRunner } from '@/lib/infrastructure/adapters/jobs/job-runner'

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 1,
    name: 'test-job',
    type: 'test',
    status: 'pending',
    payload: null,
    progress: null,
    error_message: null,
    started_at: null,
    completed_at: null,
    next_run_at: null,
    interval_seconds: null,
    created_at: '2024-01-01T00:00:00',
    updated_at: '2024-01-01T00:00:00',
    ...overrides,
  }
}

describe('JobRunner', () => {
  let runner: JobRunner
  let mockJobService: jest.Mocked<IJobService>

  beforeEach(() => {
    // Reset singleton
    JobRunner.reset()

    runner = JobRunner.getInstance()

    // Replace the internal jobService with a mock
    mockJobService = {
      enqueue: jest.fn(),
      cancel: jest.fn(),
      getAll: jest.fn(),
      getByName: jest.fn(),
      updateProgress: jest.fn(),
      updateStatus: jest.fn(),
      claimJob: jest.fn(),
      getNextPendingJob: jest.fn(),
      resetStaleJobs: jest.fn().mockResolvedValue(0),
      rescheduleRecurring: jest.fn(),
    }

    // Inject mock via the getter (override private field)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(runner as any).jobService = mockJobService
  })

  afterEach(() => {
    runner.stop()
    JobRunner.reset()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = JobRunner.getInstance()
      const b = JobRunner.getInstance()
      expect(a).toBe(b)
    })

    it('creates new instance after reset', () => {
      const a = JobRunner.getInstance()
      JobRunner.reset()
      const b = JobRunner.getInstance()
      expect(a).not.toBe(b)
    })
  })

  describe('registerHandler', () => {
    it('registers a handler by type', () => {
      const handler: JobHandler = { execute: jest.fn() }
      runner.registerHandler('my-type', handler)

      // Verify via internal state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((runner as any).handlers.get('my-type')).toBe(handler)
    })
  })

  describe('enqueue', () => {
    it('delegates to jobService.enqueue', async () => {
      const job = makeJob()
      mockJobService.enqueue.mockResolvedValue(job)

      const result = await runner.enqueue('test', 'test-job', { foo: 'bar' })

      expect(mockJobService.enqueue).toHaveBeenCalledWith('test', 'test-job', { foo: 'bar' })
      expect(result).toBe(job)
    })
  })

  describe('cancel', () => {
    it('delegates to jobService.cancel', async () => {
      await runner.cancel('test-job')
      expect(mockJobService.cancel).toHaveBeenCalledWith('test-job')
    })
  })

  describe('enqueueRecurring', () => {
    it('creates a new recurring job when none exists', async () => {
      mockJobService.getByName.mockResolvedValue(null)
      mockJobService.enqueue.mockResolvedValue(makeJob({ id: 5 }))

      const result = await runner.enqueueRecurring('sync', 'sync:1', 900, { repoId: 1 })

      expect(mockJobService.enqueue).toHaveBeenCalledWith('sync', 'sync:1', { repoId: 1 })
      expect(result.interval_seconds).toBe(900)
    })

    it('skips creation when active job exists', async () => {
      mockJobService.getByName.mockResolvedValue(makeJob({ status: 'pending' }))

      const result = await runner.enqueueRecurring('sync', 'sync:1', 900)

      expect(mockJobService.enqueue).not.toHaveBeenCalled()
      expect(result.status).toBe('pending')
    })

    it('re-creates when existing job has failed', async () => {
      mockJobService.getByName.mockResolvedValue(makeJob({ status: 'failed' }))
      mockJobService.enqueue.mockResolvedValue(makeJob({ id: 6 }))

      await runner.enqueueRecurring('sync', 'sync:1', 900)

      expect(mockJobService.enqueue).toHaveBeenCalled()
    })
  })

  describe('tick loop', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('executes a pending job and marks it completed', async () => {
      const job = makeJob({ type: 'test-type' })
      const handler: JobHandler = { execute: jest.fn().mockResolvedValue(undefined) }

      runner.registerHandler('test-type', handler)
      mockJobService.getNextPendingJob.mockResolvedValueOnce(job)
      mockJobService.claimJob.mockResolvedValueOnce(true)

      runner.start()

      // Advance past the poll interval to trigger tick
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.claimJob).toHaveBeenCalledWith(1)
      expect(handler.execute).toHaveBeenCalledWith(job, expect.any(AbortSignal))
      expect(mockJobService.updateStatus).toHaveBeenCalledWith(1, 'completed')
    })

    it('marks job as failed when handler throws', async () => {
      const job = makeJob({ type: 'failing-type' })
      const handler: JobHandler = {
        execute: jest.fn().mockRejectedValue(new Error('boom')),
      }

      runner.registerHandler('failing-type', handler)
      mockJobService.getNextPendingJob.mockResolvedValueOnce(job)
      mockJobService.claimJob.mockResolvedValueOnce(true)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.updateStatus).toHaveBeenCalledWith(1, 'failed', 'boom')
    })

    it('skips when no pending jobs', async () => {
      mockJobService.getNextPendingJob.mockResolvedValue(null)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.claimJob).not.toHaveBeenCalled()
    })

    it('skips when claim fails (race condition)', async () => {
      const job = makeJob()
      const handler: JobHandler = { execute: jest.fn() }

      runner.registerHandler('test', handler)
      mockJobService.getNextPendingJob.mockResolvedValueOnce(job)
      mockJobService.claimJob.mockResolvedValueOnce(false)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(handler.execute).not.toHaveBeenCalled()
    })

    it('fails job when no handler registered for type', async () => {
      const job = makeJob({ type: 'unknown-type' })
      mockJobService.getNextPendingJob.mockResolvedValueOnce(job)
      mockJobService.claimJob.mockResolvedValueOnce(true)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.updateStatus).toHaveBeenCalledWith(
        1,
        'failed',
        "No handler registered for type 'unknown-type'"
      )
    })

    it('reschedules recurring job on success', async () => {
      const job = makeJob({ type: 'recurring', interval_seconds: 900 })
      const handler: JobHandler = { execute: jest.fn().mockResolvedValue(undefined) }

      runner.registerHandler('recurring', handler)
      mockJobService.getNextPendingJob.mockResolvedValueOnce(job)
      mockJobService.claimJob.mockResolvedValueOnce(true)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.rescheduleRecurring).toHaveBeenCalledWith(job)
      expect(mockJobService.updateStatus).not.toHaveBeenCalled()
    })

    it('resets stale jobs on each tick', async () => {
      mockJobService.getNextPendingJob.mockResolvedValue(null)

      runner.start()
      await jest.advanceTimersByTimeAsync(10_000)

      expect(mockJobService.resetStaleJobs).toHaveBeenCalledWith(10)
    })
  })
})

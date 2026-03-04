import { mockQuery, mockExecute, setupDbMocks, resetDbMocks } from '../../utils/db-mock'

jest.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}))

import { SQLiteJobService } from '@/lib/infrastructure/adapters/jobs/job.adapter'

describe('SQLiteJobService', () => {
  let service: SQLiteJobService

  beforeEach(() => {
    resetDbMocks()
    setupDbMocks()
    service = new SQLiteJobService()
  })

  describe('enqueue', () => {
    it('inserts a new job with pending status', async () => {
      mockQuery.mockResolvedValueOnce([{
        id: 1,
        name: 'full-repository-sync:42',
        type: 'full-repository-sync',
        status: 'pending',
        payload: '{"repositoryId":42}',
        progress: null,
        error_message: null,
        started_at: null,
        completed_at: null,
        next_run_at: null,
        interval_seconds: null,
        created_at: '2024-01-01T00:00:00',
        updated_at: '2024-01-01T00:00:00',
      }])

      const job = await service.enqueue(
        'full-repository-sync',
        'full-repository-sync:42',
        { repositoryId: 42 }
      )

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO background_jobs'),
        ['full-repository-sync:42', 'full-repository-sync', '{"repositoryId":42}']
      )
      expect(job.name).toBe('full-repository-sync:42')
      expect(job.payload).toEqual({ repositoryId: 42 })
      expect(job.status).toBe('pending')
    })

    it('enqueues without payload', async () => {
      mockQuery.mockResolvedValueOnce([{
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
      }])

      const job = await service.enqueue('test', 'test-job')

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO background_jobs'),
        ['test-job', 'test', null]
      )
      expect(job.payload).toBeNull()
    })
  })

  describe('cancel', () => {
    it('sets status to failed with Cancelled message', async () => {
      await service.cancel('full-repository-sync:42')

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        ['full-repository-sync:42']
      )
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("'Cancelled'"),
        expect.any(Array)
      )
    })

    it('only cancels pending or running jobs', async () => {
      await service.cancel('some-job')

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status IN ('pending', 'running')"),
        expect.any(Array)
      )
    })
  })

  describe('getAll', () => {
    it('returns all jobs ordered by created_at desc', async () => {
      mockQuery.mockResolvedValueOnce([
        {
          id: 2, name: 'job-b', type: 'test', status: 'running',
          payload: null, progress: '{"step":1}', error_message: null,
          started_at: '2024-01-01T00:01:00', completed_at: null,
          next_run_at: null, interval_seconds: null,
          created_at: '2024-01-01T00:01:00', updated_at: '2024-01-01T00:01:00',
        },
        {
          id: 1, name: 'job-a', type: 'test', status: 'completed',
          payload: '{"x":1}', progress: null, error_message: null,
          started_at: '2024-01-01T00:00:00', completed_at: '2024-01-01T00:00:30',
          next_run_at: null, interval_seconds: null,
          created_at: '2024-01-01T00:00:00', updated_at: '2024-01-01T00:00:30',
        },
      ])

      const jobs = await service.getAll()

      expect(jobs).toHaveLength(2)
      expect(jobs[0].progress).toEqual({ step: 1 })
      expect(jobs[1].payload).toEqual({ x: 1 })
    })

    it('parses JSON fields correctly', async () => {
      mockQuery.mockResolvedValueOnce([{
        id: 1, name: 'j', type: 't', status: 'pending',
        payload: '{"a":"b"}', progress: '{"c":3}', error_message: null,
        started_at: null, completed_at: null, next_run_at: null,
        interval_seconds: null, created_at: '2024-01-01', updated_at: '2024-01-01',
      }])

      const jobs = await service.getAll()

      expect(jobs[0].payload).toEqual({ a: 'b' })
      expect(jobs[0].progress).toEqual({ c: 3 })
    })
  })

  describe('getByName', () => {
    it('returns job when found', async () => {
      mockQuery.mockResolvedValueOnce([{
        id: 1, name: 'my-job', type: 'test', status: 'pending',
        payload: null, progress: null, error_message: null,
        started_at: null, completed_at: null, next_run_at: null,
        interval_seconds: null, created_at: '2024-01-01', updated_at: '2024-01-01',
      }])

      const job = await service.getByName('my-job')
      expect(job).not.toBeNull()
      expect(job!.name).toBe('my-job')
    })

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce([])

      const job = await service.getByName('nonexistent')
      expect(job).toBeNull()
    })
  })

  describe('claimJob', () => {
    it('returns true when claim succeeds', async () => {
      mockExecute.mockResolvedValueOnce({ rowsAffected: 1 })

      const claimed = await service.claimJob(1)
      expect(claimed).toBe(true)
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'running'"),
        [1]
      )
    })

    it('returns false when job already claimed', async () => {
      mockExecute.mockResolvedValueOnce({ rowsAffected: 0 })

      const claimed = await service.claimJob(1)
      expect(claimed).toBe(false)
    })
  })

  describe('getNextPendingJob', () => {
    it('returns oldest pending job respecting next_run_at', async () => {
      mockQuery.mockResolvedValueOnce([{
        id: 3, name: 'oldest', type: 'test', status: 'pending',
        payload: null, progress: null, error_message: null,
        started_at: null, completed_at: null, next_run_at: null,
        interval_seconds: null, created_at: '2024-01-01', updated_at: '2024-01-01',
      }])

      const job = await service.getNextPendingJob()

      expect(job).not.toBeNull()
      expect(job!.name).toBe('oldest')
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("next_run_at IS NULL OR next_run_at <= datetime('now')")
      )
    })

    it('returns null when no pending jobs', async () => {
      mockQuery.mockResolvedValueOnce([])

      const job = await service.getNextPendingJob()
      expect(job).toBeNull()
    })
  })

  describe('updateProgress', () => {
    it('serializes progress to JSON', async () => {
      await service.updateProgress(1, { phase: 'reviews', completed: 5, total: 100 })

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE background_jobs SET progress'),
        ['{"phase":"reviews","completed":5,"total":100}', 1]
      )
    })
  })

  describe('updateStatus', () => {
    it('sets completed status with timestamp', async () => {
      await service.updateStatus(1, 'completed')

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'completed'"),
        [1]
      )
    })

    it('sets failed status with error message', async () => {
      await service.updateStatus(1, 'failed', 'Something broke')

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        ['Something broke', 1]
      )
    })
  })

  describe('resetStaleJobs', () => {
    it('resets running jobs older than threshold', async () => {
      mockExecute.mockResolvedValueOnce({ rowsAffected: 2 })

      const count = await service.resetStaleJobs(10)

      expect(count).toBe(2)
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'running'"),
        [-10]
      )
    })
  })

  describe('rescheduleRecurring', () => {
    it('resets job to pending with next_run_at', async () => {
      const job = {
        id: 1, name: 'sync:1', type: 'sync', status: 'completed' as const,
        payload: null, progress: null, error_message: null,
        started_at: '2024-01-01', completed_at: '2024-01-01',
        next_run_at: null, interval_seconds: 900,
        created_at: '2024-01-01', updated_at: '2024-01-01',
      }

      await service.rescheduleRecurring(job)

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending'"),
        [900, 1]
      )
    })

    it('does nothing for non-recurring jobs', async () => {
      const job = {
        id: 1, name: 'one-shot', type: 'sync', status: 'completed' as const,
        payload: null, progress: null, error_message: null,
        started_at: null, completed_at: null, next_run_at: null,
        interval_seconds: null,
        created_at: '2024-01-01', updated_at: '2024-01-01',
      }

      await service.rescheduleRecurring(job)
      expect(mockExecute).not.toHaveBeenCalled()
    })
  })
})

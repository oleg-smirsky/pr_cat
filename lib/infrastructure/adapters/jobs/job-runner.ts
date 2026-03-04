import type { IJobService } from '@/lib/core/ports/job.port'
import type { JobHandler, BackgroundJob } from '@/lib/jobs/types'
import { SQLiteJobService } from './job.adapter'

const POLL_INTERVAL_MS = 10_000
const STALE_JOB_MINUTES = 10

export class JobRunner {
  private static instance: JobRunner | null = null

  private jobService: IJobService
  private handlers = new Map<string, JobHandler>()
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private running = false
  private currentAbortController: AbortController | null = null

  private constructor() {
    this.jobService = new SQLiteJobService()
  }

  static getInstance(): JobRunner {
    if (!JobRunner.instance) {
      JobRunner.instance = new JobRunner()
    }
    return JobRunner.instance
  }

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
    console.log(`[JobRunner] Registered handler for '${type}'`)
  }

  getJobService(): IJobService {
    return this.jobService
  }

  start(): void {
    if (this.running) return
    this.running = true
    console.log('[JobRunner] Started')
    this.scheduleTick()
  }

  stop(): void {
    this.running = false
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    console.log('[JobRunner] Stopped')
  }

  private scheduleTick(): void {
    if (!this.running) return
    this.timeoutId = setTimeout(() => this.tick(), POLL_INTERVAL_MS)
  }

  private async tick(): Promise<void> {
    if (!this.running) return

    try {
      // Reset stale running jobs
      const resetCount = await this.jobService.resetStaleJobs(STALE_JOB_MINUTES)
      if (resetCount > 0) {
        console.log(`[JobRunner] Reset ${resetCount} stale job(s)`)
      }

      // Find next pending job
      const job = await this.jobService.getNextPendingJob()
      if (!job) {
        this.scheduleTick()
        return
      }

      // Claim it atomically
      const claimed = await this.jobService.claimJob(job.id)
      if (!claimed) {
        this.scheduleTick()
        return
      }

      // Look up handler
      const handler = this.handlers.get(job.type)
      if (!handler) {
        console.error(`[JobRunner] No handler for job type '${job.type}'`)
        await this.jobService.updateStatus(job.id, 'failed', `No handler registered for type '${job.type}'`)
        this.scheduleTick()
        return
      }

      // Execute
      console.log(`[JobRunner] Executing job '${job.name}' (type: ${job.type})`)
      this.currentAbortController = new AbortController()

      try {
        await handler.execute(job, this.currentAbortController.signal)

        // Success — check if recurring
        if (job.interval_seconds) {
          await this.jobService.rescheduleRecurring(job)
          console.log(`[JobRunner] Rescheduled recurring job '${job.name}'`)
        } else {
          await this.jobService.updateStatus(job.id, 'completed')
          console.log(`[JobRunner] Completed job '${job.name}'`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[JobRunner] Job '${job.name}' failed:`, message)
        await this.jobService.updateStatus(job.id, 'failed', message)
      } finally {
        this.currentAbortController = null
      }
    } catch (error) {
      console.error('[JobRunner] Tick error:', error)
    }

    this.scheduleTick()
  }

  /** Enqueue a one-shot job */
  async enqueue(type: string, name: string, payload?: Record<string, unknown>): Promise<BackgroundJob> {
    return this.jobService.enqueue(type, name, payload)
  }

  /** Enqueue a recurring job (idempotent — skips if already exists and is active) */
  async enqueueRecurring(
    type: string,
    name: string,
    intervalSeconds: number,
    payload?: Record<string, unknown>
  ): Promise<BackgroundJob> {
    const existing = await this.jobService.getByName(name)
    if (existing && existing.status !== 'failed') {
      return existing
    }

    const job = await this.jobService.enqueue(type, name, payload)
    // Set interval_seconds and next_run_at on the newly created job
    const { execute } = await import('@/lib/db')
    await execute(
      `UPDATE background_jobs SET interval_seconds = ?, next_run_at = datetime('now', '+' || ? || ' seconds'), updated_at = datetime('now') WHERE id = ?`,
      [intervalSeconds, intervalSeconds, job.id]
    )
    return { ...job, interval_seconds: intervalSeconds }
  }

  /** Cancel a job by name */
  async cancel(name: string): Promise<void> {
    return this.jobService.cancel(name)
  }

  /** For testing */
  static reset(): void {
    if (JobRunner.instance) {
      JobRunner.instance.stop()
      JobRunner.instance = null
    }
  }
}

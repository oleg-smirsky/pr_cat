import type { BackgroundJob } from '@/lib/jobs/types'

export interface IJobService {
  enqueue(type: string, name: string, payload?: Record<string, unknown>): Promise<BackgroundJob>
  cancel(name: string): Promise<void>
  getAll(): Promise<BackgroundJob[]>
  getByName(name: string): Promise<BackgroundJob | null>
  updateProgress(id: number, progress: Record<string, unknown>): Promise<void>
  updateStatus(id: number, status: 'completed' | 'failed', errorMessage?: string): Promise<void>
  claimJob(id: number): Promise<boolean>
  getNextPendingJob(): Promise<BackgroundJob | null>
  resetStaleJobs(staleMinutes: number): Promise<number>
  rescheduleRecurring(job: BackgroundJob): Promise<void>
}

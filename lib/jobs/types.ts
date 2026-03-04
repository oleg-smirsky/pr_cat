export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface BackgroundJob {
  id: number
  name: string
  type: string
  status: JobStatus
  payload: Record<string, unknown> | null
  progress: Record<string, unknown> | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  next_run_at: string | null
  interval_seconds: number | null
  created_at: string
  updated_at: string
}

export interface JobHandler {
  execute(job: BackgroundJob, signal: AbortSignal): Promise<void>
}

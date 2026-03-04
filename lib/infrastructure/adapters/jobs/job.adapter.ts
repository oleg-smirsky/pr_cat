import { query, execute } from '@/lib/db'
import type { IJobService } from '@/lib/core/ports/job.port'
import type { BackgroundJob } from '@/lib/jobs/types'

interface DbBackgroundJob {
  id: number
  name: string
  type: string
  status: string
  payload: string | null
  progress: string | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  next_run_at: string | null
  interval_seconds: number | null
  created_at: string
  updated_at: string
}

function mapDbRow(row: DbBackgroundJob): BackgroundJob {
  return {
    ...row,
    status: row.status as BackgroundJob['status'],
    payload: row.payload ? JSON.parse(row.payload) : null,
    progress: row.progress ? JSON.parse(row.progress) : null,
  }
}

export class SQLiteJobService implements IJobService {
  async enqueue(type: string, name: string, payload?: Record<string, unknown>): Promise<BackgroundJob> {
    // Use INSERT OR REPLACE to allow re-enqueuing a completed/failed job
    const result = await execute(
      `INSERT INTO background_jobs (name, type, status, payload, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, datetime('now'), datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         status = 'pending',
         payload = excluded.payload,
         error_message = NULL,
         started_at = NULL,
         completed_at = NULL,
         progress = NULL,
         updated_at = datetime('now')`,
      [name, type, payload ? JSON.stringify(payload) : null]
    )

    const rows = await query<DbBackgroundJob>(
      'SELECT * FROM background_jobs WHERE name = ?',
      [name]
    )
    return mapDbRow(rows[0])
  }

  async cancel(name: string): Promise<void> {
    await execute(
      `UPDATE background_jobs SET status = 'failed', error_message = 'Cancelled', updated_at = datetime('now')
       WHERE name = ? AND status IN ('pending', 'running')`,
      [name]
    )
  }

  async getAll(): Promise<BackgroundJob[]> {
    const rows = await query<DbBackgroundJob>(
      'SELECT * FROM background_jobs ORDER BY created_at DESC'
    )
    return rows.map(mapDbRow)
  }

  async getByName(name: string): Promise<BackgroundJob | null> {
    const rows = await query<DbBackgroundJob>(
      'SELECT * FROM background_jobs WHERE name = ?',
      [name]
    )
    return rows.length > 0 ? mapDbRow(rows[0]) : null
  }

  async updateProgress(id: number, progress: Record<string, unknown>): Promise<void> {
    await execute(
      `UPDATE background_jobs SET progress = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(progress), id]
    )
  }

  async updateStatus(id: number, status: 'completed' | 'failed', errorMessage?: string): Promise<void> {
    if (status === 'completed') {
      await execute(
        `UPDATE background_jobs SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        [id]
      )
    } else {
      await execute(
        `UPDATE background_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
        [errorMessage ?? null, id]
      )
    }
  }

  async claimJob(id: number): Promise<boolean> {
    const result = await execute(
      `UPDATE background_jobs SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [id]
    )
    return result.rowsAffected > 0
  }

  async getNextPendingJob(): Promise<BackgroundJob | null> {
    const rows = await query<DbBackgroundJob>(
      `SELECT * FROM background_jobs
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= datetime('now'))
       ORDER BY created_at ASC
       LIMIT 1`
    )
    return rows.length > 0 ? mapDbRow(rows[0]) : null
  }

  async resetStaleJobs(staleMinutes: number): Promise<number> {
    const result = await execute(
      `UPDATE background_jobs SET status = 'pending', started_at = NULL, updated_at = datetime('now')
       WHERE status = 'running'
         AND started_at < datetime('now', ? || ' minutes')`,
      [-staleMinutes]
    )
    return result.rowsAffected
  }

  async rescheduleRecurring(job: BackgroundJob): Promise<void> {
    if (!job.interval_seconds) return

    await execute(
      `UPDATE background_jobs SET
         status = 'pending',
         started_at = NULL,
         completed_at = NULL,
         progress = NULL,
         error_message = NULL,
         next_run_at = datetime('now', '+' || ? || ' seconds'),
         updated_at = datetime('now')
       WHERE id = ?`,
      [job.interval_seconds, job.id]
    )
  }
}

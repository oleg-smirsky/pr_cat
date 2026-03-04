import type { IJobService } from '@/lib/core/ports/job.port'
import type { BackgroundJob, JobHandler } from '@/lib/jobs/types'
import { query, execute } from '@/lib/db'
import { User } from '@/lib/types'
import { GitHubClient } from '@/lib/github'

interface BackfillPayload {
  organizationId: number
}

interface BackfillProgress {
  processed: number
  updated: number
  lastUserId: string | null
}

export class BackfillUserProfilesHandler implements JobHandler {
  constructor(
    private jobService: IJobService,
    private getAccessToken: () => string
  ) {}

  async execute(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const payload = job.payload as unknown as BackfillPayload
    if (!payload?.organizationId) {
      throw new Error('Missing required payload: organizationId')
    }

    const progress: BackfillProgress = (job.progress as unknown as BackfillProgress) || {
      processed: 0,
      updated: 0,
      lastUserId: null
    }

    // Find users in this org whose full profile has never been fetched
    const users = await query<User>(`
      SELECT DISTINCT u.*
      FROM users u
      JOIN user_organizations uo ON u.id = uo.user_id
      WHERE uo.organization_id = ?
      AND u.profile_fetched_at IS NULL
      ORDER BY u.id
    `, [payload.organizationId])

    // Resume from where we left off
    const startIndex = progress.lastUserId
      ? users.findIndex(u => u.id === progress.lastUserId) + 1
      : 0

    const client = new GitHubClient(this.getAccessToken())

    for (let i = startIndex; i < users.length; i++) {
      if (signal.aborted) throw new Error('Job cancelled')

      const user = users[i]
      if (!user.login) continue

      try {
        const ghUser = await client.getUser(user.login)

        // Update name and email if the API returned them
        const updates: string[] = ["profile_fetched_at = datetime('now')"]
        const values: (string | null)[] = []

        if (ghUser.name) {
          updates.push('name = ?')
          values.push(ghUser.name)
        }
        if (ghUser.email) {
          updates.push('email = COALESCE(?, email)')
          values.push(ghUser.email)
        }

        values.push(user.id)
        await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values)
        if (ghUser.name) progress.updated++
      } catch (err) {
        // Log but don't fail the whole job for one user
        console.warn(`Failed to fetch profile for ${user.login}:`, err)
      }

      progress.processed++
      progress.lastUserId = user.id
      await this.jobService.updateProgress(job.id, progress as unknown as Record<string, unknown>)

      // Throttle: 1 second between API calls to stay well under rate limits
      await delay(1000, signal)
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Job cancelled'))
    }, { once: true })
  })
}

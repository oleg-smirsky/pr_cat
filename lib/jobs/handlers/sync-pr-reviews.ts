import type { JobHandler, BackgroundJob } from '@/lib/jobs/types'
import type { IJobService } from '@/lib/core/ports/job.port'
import { GitHubClient } from '@/lib/github'
import {
  findReviewByGitHubId,
  createPullRequestReview,
  findOrCreateUserByGitHubId,
  findRepositoryByGitHubId,
} from '@/lib/repositories'
import { query } from '@/lib/db'

const BATCH_DELAY_MS = 12_000
const REVIEW_BATCH_SIZE = 5

interface SyncReviewsPayload {
  repositoryId: number
  owner?: string
  repo?: string
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

function mapReviewState(state: string): 'approved' | 'changes_requested' | 'commented' | 'dismissed' {
  switch (state.toLowerCase()) {
    case 'approved': return 'approved'
    case 'changes_requested': return 'changes_requested'
    case 'commented': return 'commented'
    case 'dismissed': return 'dismissed'
    default: return 'commented'
  }
}

export class SyncPrReviewsHandler implements JobHandler {
  constructor(
    private jobService: IJobService,
    private getAccessToken: () => string
  ) {}

  async execute(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const payload = job.payload as unknown as SyncReviewsPayload
    if (!payload?.repositoryId) {
      throw new Error('Missing required payload: repositoryId')
    }

    const { repositoryId } = payload
    let owner = payload.owner
    let repo = payload.repo

    // Resolve owner/repo from DB if not in payload
    if (!owner || !repo) {
      const repository = await query<{ full_name: string }>(
        'SELECT full_name FROM repositories WHERE id = ?',
        [repositoryId]
      )
      if (repository.length === 0) throw new Error(`Repository ${repositoryId} not found`)
      const parts = repository[0].full_name.split('/')
      owner = parts[0]
      repo = parts[1]
    }

    const client = new GitHubClient(this.getAccessToken())

    // Find PRs in this repo without any reviews
    const prsWithoutReviews = await query<{ id: number; number: number }>(
      `SELECT pr.id, pr.number FROM pull_requests pr
       LEFT JOIN pr_reviews r ON r.pull_request_id = pr.id
       WHERE pr.repository_id = ? AND r.id IS NULL
       GROUP BY pr.id`,
      [repositoryId]
    )

    const total = prsWithoutReviews.length
    if (total === 0) {
      console.log(`[sync-pr-reviews] No PRs without reviews for repo ${repositoryId}`)
      return
    }

    let completed = 0

    for (let i = 0; i < prsWithoutReviews.length; i += REVIEW_BATCH_SIZE) {
      if (signal.aborted) throw new Error('Job cancelled')

      const batch = prsWithoutReviews.slice(i, i + REVIEW_BATCH_SIZE)

      for (const pr of batch) {
        try {
          const reviews = await client.getPullRequestReviews(owner!, repo!, pr.number)

          for (const review of reviews) {
            if (!review.id || !review.user) continue
            const existing = await findReviewByGitHubId(review.id)
            if (existing) continue

            const reviewAuthor = await findOrCreateUserByGitHubId({
              id: review.user.id.toString(),
              login: review.user.login,
              avatar_url: review.user.avatar_url,
              name: review.user.name,
            })
            if (!reviewAuthor) continue

            await createPullRequestReview({
              github_id: review.id,
              pull_request_id: pr.id,
              reviewer_id: reviewAuthor.id,
              state: mapReviewState(review.state),
              submitted_at: review.submitted_at,
            })
          }
        } catch (error) {
          console.warn(`[sync-pr-reviews] Failed for PR #${pr.number}:`, error)
        }

        completed++
      }

      await this.jobService.updateProgress(job.id, {
        completed,
        total,
      })

      if (i + REVIEW_BATCH_SIZE < prsWithoutReviews.length) {
        await delay(BATCH_DELAY_MS, signal)
      }
    }

    console.log(`[sync-pr-reviews] Synced reviews for ${completed}/${total} PRs in repo ${repositoryId}`)
  }
}

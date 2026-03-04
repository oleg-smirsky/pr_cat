import type { JobHandler, BackgroundJob } from '@/lib/jobs/types'
import type { IJobService } from '@/lib/core/ports/job.port'
import { GitHubClient } from '@/lib/github'
import {
  findRepositoryByGitHubId,
  findPullRequestByNumber,
  createPullRequest,
  updatePullRequest,
  findReviewByGitHubId,
  createPullRequestReview,
  findOrCreateUserByGitHubId,
} from '@/lib/repositories'
import { query } from '@/lib/db'

const BATCH_DELAY_MS = 12_000
const REVIEW_BATCH_SIZE = 5

interface FullSyncPayload {
  repositoryId: number
  owner: string
  repo: string
}

interface FullSyncProgress {
  phase: 'prs' | 'reviews'
  prsPage?: number
  prsFetched?: number
  reviewsCompleted?: number
  reviewsTotal?: number
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

export class FullRepositorySyncHandler implements JobHandler {
  constructor(
    private jobService: IJobService,
    private getAccessToken: () => string
  ) {}

  async execute(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const payload = job.payload as unknown as FullSyncPayload
    if (!payload?.repositoryId || !payload?.owner || !payload?.repo) {
      throw new Error('Missing required payload: repositoryId, owner, repo')
    }

    const { repositoryId, owner, repo } = payload
    const client = new GitHubClient(this.getAccessToken())

    // Phase 1: Fetch all PRs with pagination and throttling
    await this.syncPullRequests(job, client, owner, repo, repositoryId, signal)

    // Phase 2: Fetch reviews for PRs that don't have any
    await this.syncMissingReviews(job, client, owner, repo, repositoryId, signal)

    // On completion: enqueue recurring jobs for this repo
    const { JobRunner } = await import('@/lib/infrastructure/adapters/jobs/job-runner')
    const runner = JobRunner.getInstance()
    await runner.enqueueRecurring(
      'sync-repository-prs',
      `sync-repository-prs:${repositoryId}`,
      15 * 60,
      { repositoryId, owner, repo }
    )
    await runner.enqueueRecurring(
      'sync-pr-reviews',
      `sync-pr-reviews:${repositoryId}`,
      15 * 60,
      { repositoryId, owner, repo }
    )
    console.log(`[full-repository-sync] Enqueued recurring jobs for repo ${owner}/${repo}`)
  }

  private async syncPullRequests(
    job: BackgroundJob,
    client: GitHubClient,
    owner: string,
    repo: string,
    repositoryId: number,
    signal: AbortSignal
  ): Promise<void> {
    let page = 1
    let totalFetched = 0

    // Resume from where we left off if progress exists
    const existingProgress = job.progress as unknown as FullSyncProgress | null
    if (existingProgress?.phase === 'reviews') {
      // PRs already done, skip to reviews
      return
    }
    if (existingProgress?.prsPage) {
      page = existingProgress.prsPage
      totalFetched = existingProgress.prsFetched ?? 0
    }

    while (true) {
      if (signal.aborted) throw new Error('Job cancelled')

      const prs = await client.getPullRequests(owner, repo, 'all', page, 100)
      if (prs.length === 0) break

      for (const pr of prs) {
        const existingPR = await findPullRequestByNumber(repositoryId, pr.number)
        const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open'

        const prAuthor = pr.user ? await findOrCreateUserByGitHubId({
          id: pr.user.id.toString(),
          login: pr.user.login,
          avatar_url: pr.user.avatar_url,
          name: pr.user.name
        }) : null

        if (existingPR) {
          await updatePullRequest(existingPR.id, {
            title: pr.title,
            description: pr.body || null,
            state,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            merged_at: pr.merged_at,
            draft: pr.draft,
          })
        } else if (prAuthor) {
          await createPullRequest({
            github_id: pr.id,
            repository_id: repositoryId,
            number: pr.number,
            title: pr.title,
            description: pr.body || null,
            author_id: prAuthor.id,
            state,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            merged_at: pr.merged_at,
            draft: pr.draft,
            additions: pr.additions || null,
            deletions: pr.deletions || null,
            changed_files: pr.changed_files || null,
            category_id: null,
            category_confidence: null,
          })
        }
      }

      totalFetched += prs.length
      page++

      await this.jobService.updateProgress(job.id, {
        phase: 'prs',
        prsPage: page,
        prsFetched: totalFetched,
      } satisfies FullSyncProgress)

      // Throttle between pages
      if (prs.length === 100) {
        await delay(BATCH_DELAY_MS, signal)
      }
    }

    console.log(`[full-repository-sync] Fetched ${totalFetched} PRs for ${owner}/${repo}`)
  }

  private async syncMissingReviews(
    job: BackgroundJob,
    client: GitHubClient,
    owner: string,
    repo: string,
    repositoryId: number,
    signal: AbortSignal
  ): Promise<void> {
    // Find PRs without any reviews
    const prsWithoutReviews = await query<{ id: number; number: number }>(
      `SELECT pr.id, pr.number FROM pull_requests pr
       LEFT JOIN pr_reviews r ON r.pull_request_id = pr.id
       WHERE pr.repository_id = ? AND r.id IS NULL
       GROUP BY pr.id`,
      [repositoryId]
    )

    const total = prsWithoutReviews.length
    let completed = 0

    await this.jobService.updateProgress(job.id, {
      phase: 'reviews',
      reviewsCompleted: 0,
      reviewsTotal: total,
    } satisfies FullSyncProgress)

    // Process in batches
    for (let i = 0; i < prsWithoutReviews.length; i += REVIEW_BATCH_SIZE) {
      if (signal.aborted) throw new Error('Job cancelled')

      const batch = prsWithoutReviews.slice(i, i + REVIEW_BATCH_SIZE)

      for (const pr of batch) {
        try {
          const reviews = await client.getPullRequestReviews(owner, repo, pr.number)

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
          console.warn(`[full-repository-sync] Failed to sync reviews for PR #${pr.number}:`, error)
        }

        completed++
      }

      await this.jobService.updateProgress(job.id, {
        phase: 'reviews',
        reviewsCompleted: completed,
        reviewsTotal: total,
      } satisfies FullSyncProgress)

      // Throttle between batches
      if (i + REVIEW_BATCH_SIZE < prsWithoutReviews.length) {
        await delay(BATCH_DELAY_MS, signal)
      }
    }

    console.log(`[full-repository-sync] Synced reviews for ${completed}/${total} PRs in ${owner}/${repo}`)
  }
}

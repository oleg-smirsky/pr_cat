import type { JobHandler, BackgroundJob } from '@/lib/jobs/types'
import type { IJobService } from '@/lib/core/ports/job.port'
import { GitHubClient } from '@/lib/github'
import {
  findPullRequestByNumber,
  createPullRequest,
  updatePullRequest,
  findOrCreateUserByGitHubId,
} from '@/lib/repositories'

const BATCH_DELAY_MS = 12_000

interface SyncPrsPayload {
  repositoryId: number
  owner: string
  repo: string
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

export class SyncRepositoryPrsHandler implements JobHandler {
  constructor(
    private jobService: IJobService,
    private getAccessToken: () => string
  ) {}

  async execute(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const payload = job.payload as unknown as SyncPrsPayload
    if (!payload?.repositoryId || !payload?.owner || !payload?.repo) {
      throw new Error('Missing required payload: repositoryId, owner, repo')
    }

    const { repositoryId, owner, repo } = payload
    const client = new GitHubClient(this.getAccessToken())

    let page = 1
    let newOrUpdated = 0
    let hitExisting = false

    while (!hitExisting) {
      if (signal.aborted) throw new Error('Job cancelled')

      const prs = await client.getPullRequests(owner, repo, 'all', page, 100)
      if (prs.length === 0) break

      for (const pr of prs) {
        const existingPR = await findPullRequestByNumber(repositoryId, pr.number)
        const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open'

        if (existingPR) {
          // If updated_at matches, we've caught up — stop
          if (existingPR.updated_at === pr.updated_at) {
            hitExisting = true
            break
          }
          await updatePullRequest(existingPR.id, {
            title: pr.title,
            description: pr.body || null,
            state,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            merged_at: pr.merged_at,
            draft: pr.draft,
          })
          newOrUpdated++
        } else {
          const prAuthor = pr.user ? await findOrCreateUserByGitHubId({
            id: pr.user.id.toString(),
            login: pr.user.login,
            avatar_url: pr.user.avatar_url,
            name: pr.user.name,
          }) : null

          if (prAuthor) {
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
            newOrUpdated++
          }
        }
      }

      page++

      await this.jobService.updateProgress(job.id, {
        page,
        newOrUpdated,
      })

      if (prs.length === 100 && !hitExisting) {
        await delay(BATCH_DELAY_MS, signal)
      }
    }

    console.log(`[sync-repository-prs] ${owner}/${repo}: ${newOrUpdated} new/updated PRs`)
  }
}

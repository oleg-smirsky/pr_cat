import { mockQuery, mockExecute, resetDbMocks, setupDbMocks } from '../../utils/db-mock'

jest.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}))

const mockGetUser = jest.fn()
jest.mock('@/lib/github', () => ({
  GitHubClient: jest.fn().mockImplementation(() => ({
    getUser: mockGetUser,
  })),
}))

import type { IJobService } from '@/lib/core/ports/job.port'
import type { BackgroundJob } from '@/lib/jobs/types'
import { BackfillUserProfilesHandler } from '@/lib/jobs/handlers/backfill-user-profiles'

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 1,
    name: 'backfill-user-profiles:42',
    type: 'backfill-user-profiles',
    status: 'running',
    payload: { organizationId: 42 },
    progress: null,
    error_message: null,
    started_at: '2024-01-01T00:00:00',
    completed_at: null,
    next_run_at: null,
    interval_seconds: null,
    created_at: '2024-01-01T00:00:00',
    updated_at: '2024-01-01T00:00:00',
    ...overrides,
  }
}

function makeUser(id: string, login: string, name: string | null = null) {
  return {
    id,
    login,
    name,
    email: null,
    image: null,
    profile_fetched_at: null,
    created_at: '2024-01-01T00:00:00',
    updated_at: '2024-01-01T00:00:00',
  }
}

describe('BackfillUserProfilesHandler', () => {
  let handler: BackfillUserProfilesHandler
  let mockJobService: jest.Mocked<IJobService>
  let signal: AbortSignal
  let abortController: AbortController

  beforeEach(() => {
    jest.useFakeTimers()
    resetDbMocks()
    setupDbMocks()
    mockGetUser.mockReset()

    mockJobService = {
      enqueue: jest.fn(),
      cancel: jest.fn(),
      getAll: jest.fn(),
      getByName: jest.fn(),
      updateProgress: jest.fn(),
      updateStatus: jest.fn(),
      claimJob: jest.fn(),
      getNextPendingJob: jest.fn(),
      resetStaleJobs: jest.fn(),
      rescheduleRecurring: jest.fn(),
    }

    handler = new BackfillUserProfilesHandler(
      mockJobService,
      () => 'test-token'
    )

    abortController = new AbortController()
    signal = abortController.signal
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('throws when organizationId is missing', async () => {
    const job = makeJob({ payload: {} })

    await expect(handler.execute(job, signal)).rejects.toThrow('Missing required payload: organizationId')
  })

  it('fetches profiles and updates users with real names', async () => {
    const users = [
      makeUser('100', 'alice'),
      makeUser('200', 'bob'),
    ]
    mockQuery.mockResolvedValueOnce(users)

    mockGetUser
      .mockResolvedValueOnce({ name: 'Alice Smith', email: 'alice@example.com', login: 'alice' })
      .mockResolvedValueOnce({ name: 'Bob Jones', email: null, login: 'bob' })

    const job = makeJob()

    // Run handler — the 1s delays will be resolved by fake timers
    const promise = handler.execute(job, signal)

    // Advance through the two 1-second delays
    await jest.advanceTimersByTimeAsync(1000)
    await jest.advanceTimersByTimeAsync(1000)

    await promise

    // Verify GitHub API calls
    expect(mockGetUser).toHaveBeenCalledWith('alice')
    expect(mockGetUser).toHaveBeenCalledWith('bob')
    expect(mockGetUser).toHaveBeenCalledTimes(2)

    // Verify DB updates — alice has name + email, bob has name only
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('profile_fetched_at'),
      expect.arrayContaining(['Alice Smith', 'alice@example.com', '100'])
    )
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('profile_fetched_at'),
      expect.arrayContaining(['Bob Jones', '200'])
    )

    // Verify progress was tracked
    expect(mockJobService.updateProgress).toHaveBeenCalledTimes(2)
    expect(mockJobService.updateProgress).toHaveBeenLastCalledWith(1, {
      processed: 2,
      updated: 2,
      lastUserId: '200',
    })
  })

  it('skips users without a login', async () => {
    mockQuery.mockResolvedValueOnce([makeUser('100', null as unknown as string)])

    const job = makeJob()
    await handler.execute(job, signal)

    expect(mockGetUser).not.toHaveBeenCalled()
  })

  it('continues when a single user fetch fails', async () => {
    const users = [
      makeUser('100', 'failing-user'),
      makeUser('200', 'good-user'),
    ]
    mockQuery.mockResolvedValueOnce(users)

    mockGetUser
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce({ name: 'Good User', email: null, login: 'good-user' })

    const job = makeJob()
    const promise = handler.execute(job, signal)

    await jest.advanceTimersByTimeAsync(1000)
    await jest.advanceTimersByTimeAsync(1000)

    await promise

    // Both users were processed, but only the second one updated name
    expect(mockJobService.updateProgress).toHaveBeenCalledTimes(2)
    expect(mockJobService.updateProgress).toHaveBeenLastCalledWith(1, {
      processed: 2,
      updated: 1,
      lastUserId: '200',
    })
  })

  it('resumes from progress.lastUserId', async () => {
    const users = [
      makeUser('100', 'alice'),
      makeUser('200', 'bob'),
      makeUser('300', 'carol'),
    ]
    mockQuery.mockResolvedValueOnce(users)

    // Bob's profile was already fetched — resume from after bob
    mockGetUser.mockResolvedValueOnce({ name: 'Carol Lee', email: null, login: 'carol' })

    const job = makeJob({
      progress: { processed: 2, updated: 1, lastUserId: '200' } as unknown as Record<string, unknown>,
    })

    const promise = handler.execute(job, signal)
    await jest.advanceTimersByTimeAsync(1000)
    await promise

    // Only carol should be fetched
    expect(mockGetUser).toHaveBeenCalledTimes(1)
    expect(mockGetUser).toHaveBeenCalledWith('carol')
  })

  it('stops when signal is aborted before processing', async () => {
    const users = [
      makeUser('100', 'alice'),
      makeUser('200', 'bob'),
    ]
    mockQuery.mockResolvedValueOnce(users)

    const job = makeJob()

    // Abort immediately — the signal.aborted check at top of loop fires
    abortController.abort()
    const promise = handler.execute(job, signal)

    await expect(promise).rejects.toThrow('Job cancelled')
    expect(mockGetUser).not.toHaveBeenCalled()
  })

  it('does nothing when no users need backfill', async () => {
    mockQuery.mockResolvedValueOnce([])

    const job = makeJob()
    await handler.execute(job, signal)

    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockJobService.updateProgress).not.toHaveBeenCalled()
  })

  it('marks profile_fetched_at even when GitHub returns no name', async () => {
    mockQuery.mockResolvedValueOnce([makeUser('100', 'noname-user')])
    mockGetUser.mockResolvedValueOnce({ name: null, email: null, login: 'noname-user' })

    const job = makeJob()
    const promise = handler.execute(job, signal)
    await jest.advanceTimersByTimeAsync(1000)
    await promise

    // Should still set profile_fetched_at even without name/email
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining("profile_fetched_at = datetime('now')"),
      ['100']
    )

    // updated count should NOT increment (no name was set)
    expect(mockJobService.updateProgress).toHaveBeenCalledWith(1, {
      processed: 1,
      updated: 0,
      lastUserId: '100',
    })
  })
})

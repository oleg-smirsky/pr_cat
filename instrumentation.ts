export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Run database migrations before anything else — fail fast if they fail
    const { runMigrations } = await import('@/lib/migrate')
    const migrationResult = await runMigrations()
    if (migrationResult?.success === false) {
      throw new Error(`Database migrations failed: ${migrationResult.error}`)
    }

    const { JobRunner } = await import('@/lib/infrastructure/adapters/jobs/job-runner')
    const { FullRepositorySyncHandler } = await import('@/lib/jobs/handlers/full-repository-sync')
    const { SyncRepositoryPrsHandler } = await import('@/lib/jobs/handlers/sync-repository-prs')
    const { SyncPrReviewsHandler } = await import('@/lib/jobs/handlers/sync-pr-reviews')
    const { BackfillUserProfilesHandler } = await import('@/lib/jobs/handlers/backfill-user-profiles')

    const runner = JobRunner.getInstance()

    const getAccessToken = () => {
      const token = process.env.GITHUB_TOKEN
      if (!token) throw new Error('GITHUB_TOKEN not set — cannot run background sync jobs')
      return token
    }

    runner.registerHandler('full-repository-sync', new FullRepositorySyncHandler(
      runner.getJobService(),
      getAccessToken
    ))
    runner.registerHandler('sync-repository-prs', new SyncRepositoryPrsHandler(
      runner.getJobService(),
      getAccessToken
    ))
    runner.registerHandler('sync-pr-reviews', new SyncPrReviewsHandler(
      runner.getJobService(),
      getAccessToken
    ))
    runner.registerHandler('backfill-user-profiles', new BackfillUserProfilesHandler(
      runner.getJobService(),
      getAccessToken
    ))

    runner.start()
    console.log('[instrumentation] JobRunner started with all handlers registered')
  }
}

import { DemoGitHubService } from '@/lib/infrastructure/adapters/demo/github.adapter'

describe('DemoGitHubService.getRepositoryContributors', () => {
  const service = new DemoGitHubService()

  it('returns an array of users', async () => {
    const contributors = await service.getRepositoryContributors('owner', 'repo')
    expect(Array.isArray(contributors)).toBe(true)
    expect(contributors.length).toBeGreaterThan(0)
  })

  it('returns users with required domain fields', async () => {
    const contributors = await service.getRepositoryContributors('owner', 'repo')
    const user = contributors[0]
    expect(user).toHaveProperty('id')
    expect(user).toHaveProperty('login')
    expect(user).toHaveProperty('name')
    expect(user).toHaveProperty('avatarUrl')
  })

  it('returns at most 3 demo users', async () => {
    const contributors = await service.getRepositoryContributors('owner', 'repo')
    expect(contributors.length).toBeLessThanOrEqual(3)
  })
})

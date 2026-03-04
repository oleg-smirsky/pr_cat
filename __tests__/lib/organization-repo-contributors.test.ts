import { DemoOrganizationRepository } from '@/lib/infrastructure/adapters/demo/organization.adapter'

describe('DemoOrganizationRepository.getRepoContributors', () => {
  const repo = new DemoOrganizationRepository()

  it('returns an array of organization members', async () => {
    const contributors = await repo.getRepoContributors('demo-org-1', 'demo-repo-1')
    expect(Array.isArray(contributors)).toBe(true)
    expect(contributors.length).toBeGreaterThan(0)
  })

  it('returns members with required OrganizationMember fields', async () => {
    const contributors = await repo.getRepoContributors('demo-org-1', 'demo-repo-1')
    const member = contributors[0]
    expect(member).toHaveProperty('id')
    expect(member).toHaveProperty('login')
    expect(member).toHaveProperty('name')
    expect(member).toHaveProperty('email')
    expect(member).toHaveProperty('avatarUrl')
    expect(member).toHaveProperty('role')
    expect(member).toHaveProperty('joinedAt')
    expect(['admin', 'member']).toContain(member.role)
    expect(member.joinedAt).toBeInstanceOf(Date)
  })

  it('returns at most 3 contributors', async () => {
    const contributors = await repo.getRepoContributors('demo-org-1', 'demo-repo-1')
    expect(contributors.length).toBeLessThanOrEqual(3)
  })
})

import { DemoOrganizationRepository } from '@/lib/infrastructure/adapters/demo/organization.adapter'

// Test that the demo adapter returns valid contributor data
// (Integration test for the full route would require auth mocking)
describe('Repo Contributors API - adapter layer', () => {
  const orgRepo = new DemoOrganizationRepository()

  it('getRepoContributors returns contributors as OrganizationMember[]', async () => {
    const contributors = await orgRepo.getRepoContributors('demo-org-1', 'demo-repo-1')

    expect(Array.isArray(contributors)).toBe(true)
    expect(contributors.length).toBeGreaterThan(0)

    for (const c of contributors) {
      expect(c).toMatchObject({
        id: expect.any(String),
        login: expect.any(String),
        avatarUrl: expect.any(String),
        role: expect.stringMatching(/^(admin|member)$/),
        joinedAt: expect.any(Date),
      })
    }
  })

  it('returns contributors that are a subset of org members', async () => {
    const members = await orgRepo.getMembers('demo-org-1')
    const contributors = await orgRepo.getRepoContributors('demo-org-1', 'demo-repo-1')

    const memberIds = new Set(members.data.map(m => m.id))
    for (const c of contributors) {
      expect(memberIds.has(c.id)).toBe(true)
    }
  })
})

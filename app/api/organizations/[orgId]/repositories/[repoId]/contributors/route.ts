import { NextRequest, NextResponse } from 'next/server'
import { ServiceLocator, withAuth, ApplicationContext } from '@/lib/core'
import { OrganizationMember } from '@/lib/core/domain/entities/organization'

export const runtime = 'nodejs'

const contributorsHandler = async (
  context: ApplicationContext,
  request: NextRequest
): Promise<NextResponse> => {
  try {
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    const orgIdx = pathParts.indexOf('organizations')
    const repoIdx = pathParts.indexOf('repositories')
    const orgId = pathParts[orgIdx + 1]
    const repoId = pathParts[repoIdx + 1]

    if (!orgId || !repoId) {
      return NextResponse.json(
        { error: 'Organization ID and Repository ID are required' },
        { status: 400 }
      )
    }

    const source = url.searchParams.get('source')
    const orgRepository = await ServiceLocator.getOrganizationRepository()

    let contributors: OrganizationMember[]

    if (source === 'github') {
      // Orchestrate: GitHub API contributors matched against org members
      const [repos, members] = await Promise.all([
        orgRepository.getRepositories(orgId),
        orgRepository.getMembers(orgId),
      ])

      const repo = repos.find(r => r.id === repoId)
      if (!repo) {
        return NextResponse.json(
          { error: 'Repository not found' },
          { status: 404 }
        )
      }

      // Get access token from session for GitHub API calls
      const authService = await ServiceLocator.getAuthService()
      const session = await authService.getSession()
      if (!session?.accessToken) {
        return NextResponse.json(
          { error: 'GitHub access token not available' },
          { status: 401 }
        )
      }

      const { createGitHubClient } = await import('@/lib/github')
      const client = createGitHubClient(session.accessToken)
      const [owner, repoName] = repo.fullName.split('/')
      const ghContributors = await client.getRepositoryContributors(owner, repoName)

      // Build a lookup of org members by ID for enrichment
      const memberById = new Map(members.data.map(m => [m.id, m]))

      // Map GitHub contributors to OrganizationMember format
      // Prefer org member data when available, otherwise use GitHub data
      contributors = ghContributors.map(c => {
        const ghId = c.id.toString()
        const member = memberById.get(ghId)
        if (member) return member
        return {
          id: ghId,
          login: c.login,
          name: null, // listContributors doesn't return names
          email: null,
          avatarUrl: c.avatar_url || '',
          role: 'member' as const,
          joinedAt: new Date(),
        }
      })

      // TODO: Enrich display names via getUser() calls — blocked by circuit breaker (max 10 req/10s).
      // Needs circuit breaker rework to support bulk lookups.
    } else {
      // Default: DB-only (ingested commit data)
      contributors = await orgRepository.getRepoContributors(orgId, repoId)
    }

    return NextResponse.json(contributors)
  } catch (error) {
    console.error('Error fetching repo contributors:', error)
    return NextResponse.json(
      { error: 'Failed to fetch contributors' },
      { status: 500 }
    )
  }
}

export const GET = withAuth(contributorsHandler)

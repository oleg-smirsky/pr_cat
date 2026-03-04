import { NextRequest, NextResponse } from 'next/server'
import { ServiceLocator, withAuth, ApplicationContext } from '@/lib/core'

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

    const orgRepository = await ServiceLocator.getOrganizationRepository()
    const contributors = await orgRepository.getRepoContributors(orgId, repoId)

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

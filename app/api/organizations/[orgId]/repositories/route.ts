import { NextRequest, NextResponse } from 'next/server'
import { ServiceLocator, withAuth, ApplicationContext } from '@/lib/core'

export const runtime = 'nodejs'

const repositoriesHandler = async (
  context: ApplicationContext,
  request: NextRequest
): Promise<NextResponse> => {
  try {
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    const orgIdx = pathParts.indexOf('organizations')
    const orgId = pathParts[orgIdx + 1]

    if (!orgId) {
      return NextResponse.json(
        { error: 'Organization ID is required' },
        { status: 400 }
      )
    }

    const orgRepository = await ServiceLocator.getOrganizationRepository()
    const repositories = await orgRepository.getRepositories(orgId)

    return NextResponse.json(repositories)
  } catch (error) {
    console.error('Error fetching repositories:', error)
    return NextResponse.json(
      { error: 'Failed to fetch repositories' },
      { status: 500 }
    )
  }
}

export const GET = withAuth(repositoriesHandler)

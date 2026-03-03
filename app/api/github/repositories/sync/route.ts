import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { GitHubService } from '@/lib/services';
import { findUserById, findUserByEmail, findOrCreateOrganization, findOrCreateRepository } from '@/lib/repositories';


export const runtime = 'nodejs';

export async function POST() {
  const session = await auth();
  
  if (!session || !session.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  if (!session.accessToken) {
    return NextResponse.json({ error: 'No GitHub access token' }, { status: 400 });
  }
  
  try {
    // First try to get user directly by session ID
    let user = await findUserById(session.user.id);
    
    // If not found by ID but we have an email, try to find by email
    if (!user && session.user.email) {
      user = await findUserByEmail(session.user.email);
      console.log('User found by email instead of ID:', !!user);
    }
    
    if (!user) {
      return NextResponse.json({ error: 'User not found in database' }, { status: 404 });
    }
    
    const githubService = new GitHubService(session.accessToken);
    const repositories = await githubService.getCurrentUserRepositories();

    // Persist org repos to DB
    const orgRepos = repositories.filter((r: { owner: { type: string } }) => r.owner.type === 'Organization');
    let persistedCount = 0;

    for (const repo of orgRepos) {
      try {
        const org = await findOrCreateOrganization({
          github_id: repo.owner.id,
          name: repo.owner.login,
          avatar_url: '',
        });
        await findOrCreateRepository({
          github_id: repo.id,
          organization_id: org.id,
          name: repo.name,
          full_name: repo.full_name,
          description: repo.description || null,
          private: repo.private,
          is_tracked: false,
        });
        persistedCount++;
      } catch (err) {
        console.error(`Failed to persist repo ${repo.full_name}:`, err);
      }
    }

    return NextResponse.json({
      success: true,
      repositories,
      persistedCount,
      message: `Synced ${persistedCount} org repositories to database`,
    });
  } catch (error) {
    console.error('GitHub repository sync error:', error);
    return NextResponse.json(
      { error: 'Failed to sync GitHub repositories' }, 
      { status: 500 }
    );
  }
} 
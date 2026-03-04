import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { GitHubService } from '@/lib/services';
import { findRepositoryByGitHubId, setRepositoryTracking } from '@/lib/repositories/repository-repository';
import { JobRunner } from '@/lib/infrastructure/adapters/jobs/job-runner';

const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
  (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY);

// Create a new webhook for a repository
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ repositoryId: string }> }
) {
  const { repositoryId } = await params;

  const session = await auth();

  if (!session || !session.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!session.accessToken) {
    return NextResponse.json({ error: 'No GitHub access token' }, { status: 400 });
  }

  // Token mode: skip webhook creation, just track and sync PRs
  if (isTokenMode) {
    try {
      const repository = await findRepositoryByGitHubId(parseInt(repositoryId));
      if (!repository) {
        return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
      }
      await setRepositoryTracking(repository.id, true);
      const [owner, repo] = repository.full_name.split('/');
      const runner = JobRunner.getInstance();
      await runner.enqueue('full-repository-sync', `full-repository-sync:${repository.id}`, {
        repositoryId: repository.id,
        owner,
        repo,
      });
      return NextResponse.json({
        success: true,
        message: 'Repository tracked. Initial sync started in background.',
      });
    } catch (error) {
      console.error('Token mode tracking error:', error);
      return NextResponse.json(
        { error: `Failed to track repository: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }
  }

  try {
    const appUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    const githubService = new GitHubService(session.accessToken);
    const result = await githubService.setupRepositoryTracking(parseInt(repositoryId), appUrl);

    return NextResponse.json(result);
  } catch (error) {
    console.error('GitHub API error:', error);
    return NextResponse.json(
      { error: `Failed to set up webhook: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

// Delete a webhook from a repository
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ repositoryId: string }> }
) {
  const { repositoryId } = await params;

  const session = await auth();

  if (!session || !session.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!session.accessToken) {
    return NextResponse.json({ error: 'No GitHub access token' }, { status: 400 });
  }

  // Token mode: just untrack the repository
  if (isTokenMode) {
    try {
      const repository = await findRepositoryByGitHubId(parseInt(repositoryId));
      if (!repository) {
        return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
      }
      await setRepositoryTracking(repository.id, false);
      const runner = JobRunner.getInstance();
      await runner.cancel(`full-repository-sync:${repository.id}`);
      await runner.cancel(`sync-repository-prs:${repository.id}`);
      await runner.cancel(`sync-pr-reviews:${repository.id}`);
      return NextResponse.json({
        success: true,
        message: 'Repository untracked and background jobs cancelled.',
      });
    } catch (error) {
      console.error('Token mode untracking error:', error);
      return NextResponse.json(
        { error: `Failed to untrack repository: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }
  }

  try {
    const appUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    const githubService = new GitHubService(session.accessToken);
    const result = await githubService.removeRepositoryTracking(parseInt(repositoryId), appUrl);

    return NextResponse.json(result);
  } catch (error) {
    console.error('GitHub API error:', error);
    return NextResponse.json(
      { error: `Failed to remove webhook: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
} 
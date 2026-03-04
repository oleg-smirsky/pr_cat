import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getService } from '@/lib/core/container/di-container';
import { IGitHubAppService } from '@/lib/core/ports';

export const runtime = 'nodejs';

export async function GET() {
  console.log(`GitHub Organizations installation-status API called: ${new Date().toISOString()}`);
  
  const session = await auth();
  
  if (!session?.user) {
    console.log('Organizations installation-status: No authenticated user session found');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  try {
    // Fetch organizations from session
    const organizations = session.organizations || [];
    console.log(`Organizations installation-status: Found ${organizations.length} organizations in session`);
    
    if (organizations.length === 0) {
      console.log('Organizations installation-status: No organizations found in session');
      return NextResponse.json({ installations: [] });
    }

    // Token mode: PAT validated at sign-in, all orgs are connected
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY);

    if (isTokenMode) {
      console.log('Organizations installation-status: Token mode — marking all orgs as connected');
      const orgsWithInstallationStatus = organizations.map(org => ({
        ...org,
        isGithubConnected: true,
        installationId: null,
      }));
      return NextResponse.json({ installations: orgsWithInstallationStatus });
    }

    // Get GitHub App service
    const githubAppService = await getService<IGitHubAppService>('GitHubAppService');
    
    // Validate GitHub App configuration
    const config = await githubAppService.validateConfiguration();
    if (!config.isValid) {
      console.log('Organizations installation-status: GitHub App not properly configured');
      return NextResponse.json({ 
        installations: [],
        configured: false,
        errors: config.errors
      });
    }
    
    // Get all app installations
    console.log('Organizations installation-status: Fetching app installations');
    const installationsData = await githubAppService.listInstallations();
    console.log(`Organizations installation-status: Found ${installationsData.length} app installations`);
    
    // Map organizations to include installation status
    const orgsWithInstallationStatus = organizations.map(org => {
      // Find if this organization has the app installed by comparing names
      const installation = installationsData.find(
        install => install.account && 
          install.account.login.toLowerCase() === org.name.toLowerCase()
      );
      
      const isGithubConnected = !!installation;
      console.log(`Organizations installation-status: Org ${org.name} isGithubConnected=${isGithubConnected}`);
      
      return {
        ...org,
        isGithubConnected,
        installationId: installation?.id || null
      };
    });
    
    console.log(`Organizations installation-status: Returning ${orgsWithInstallationStatus.length} organizations with installation status`);
    return NextResponse.json({
      installations: orgsWithInstallationStatus
    });
  } catch (error) {
    console.error('Error fetching GitHub App installations:', error);
    return NextResponse.json(
      { error: `Failed to fetch GitHub App installations: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
} 

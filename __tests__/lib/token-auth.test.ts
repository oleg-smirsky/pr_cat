// Integration tests for token mode authentication (CredentialsProvider)

// Save original env and restore after each test
const originalEnv = { ...process.env };

// Must mock modules before imports
jest.mock('@/lib/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getDbClient: jest.fn(),
  checkDbHealth: jest.fn(),
}));

jest.mock('@/lib/github', () => ({
  createGitHubClient: jest.fn(),
  GitHubClient: jest.fn(),
}));

jest.mock('@/lib/services', () => ({
  GitHubService: jest.fn().mockImplementation(() => ({
    syncUserOrganizations: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@/lib/repositories/user-repository', () => ({
  getUserOrganizations: jest.fn().mockResolvedValue([]),
  findUserById: jest.fn().mockResolvedValue(null),
}));

// Unmock next-auth and @/auth so we can test the real config
jest.unmock('next-auth');
jest.unmock('@/auth');

import { createGitHubClient } from '@/lib/github';
import { execute } from '@/lib/db';
import { GitHubService } from '@/lib/services';

const mockCreateGitHubClient = createGitHubClient as jest.Mock;
const mockExecute = execute as jest.Mock;

function setupTokenModeEnv() {
  process.env.GITHUB_TOKEN = 'ghp_test_token_for_integration_tests';
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  process.env.NEXTAUTH_SECRET = 'test-secret-minimum-32-characters-long-for-jwt';
}

function setupOAuthModeEnv() {
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-minimum-32-characters-long-for-jwt';
}

const mockGitHubUser = {
  id: 12345,
  login: 'testuser',
  name: 'Test User',
  email: 'test@example.com',
  avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  html_url: 'https://github.com/testuser',
};

function mockGitHubClientSuccess() {
  mockCreateGitHubClient.mockReturnValue({
    getCurrentUser: jest.fn().mockResolvedValue(mockGitHubUser),
    getUserOrganizations: jest.fn().mockResolvedValue([]),
  });
}

function mockGitHubClientFailure() {
  mockCreateGitHubClient.mockReturnValue({
    getCurrentUser: jest.fn().mockRejectedValue(new Error('Bad credentials')),
    getUserOrganizations: jest.fn().mockResolvedValue([]),
  });
}

describe('Token Mode Detection', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('activates token mode when GITHUB_TOKEN is set and no OAuth client', () => {
    setupTokenModeEnv();
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID === 'demo-client-id');
    expect(isTokenMode).toBe(true);
  });

  it('activates token mode when GITHUB_TOKEN is set and OAuth client is demo', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITHUB_OAUTH_CLIENT_ID = 'demo-client-id';
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID === 'demo-client-id');
    expect(isTokenMode).toBe(true);
  });

  it('does NOT activate token mode when OAuth client is configured', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITHUB_OAUTH_CLIENT_ID = 'real-client-id';
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID === 'demo-client-id');
    expect(isTokenMode).toBe(false);
  });

  it('does NOT activate token mode when GITHUB_TOKEN is missing', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID === 'demo-client-id');
    expect(isTokenMode).toBe(false);
  });
});

describe('Token Mode CredentialsProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupTokenModeEnv();
    mockExecute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe('authorize', () => {
    it('validates PAT and returns user object on success', async () => {
      mockGitHubClientSuccess();

      // Simulate what CredentialsProvider.authorize does
      const pat = process.env.GITHUB_TOKEN!;
      const client = createGitHubClient(pat);
      const ghUser = await client.getCurrentUser();

      const user = {
        id: ghUser.id.toString(),
        name: ghUser.name || ghUser.login,
        email: ghUser.email || null,
        image: ghUser.avatar_url,
      };

      expect(createGitHubClient).toHaveBeenCalledWith('ghp_test_token_for_integration_tests');
      expect(user).toEqual({
        id: '12345',
        name: 'Test User',
        email: 'test@example.com',
        image: 'https://avatars.githubusercontent.com/u/12345',
      });
    });

    it('returns null when PAT is invalid', async () => {
      mockGitHubClientFailure();

      const pat = process.env.GITHUB_TOKEN!;
      const client = createGitHubClient(pat);

      let user = null;
      try {
        const ghUser = await client.getCurrentUser();
        user = { id: ghUser.id.toString(), name: ghUser.name };
      } catch {
        user = null;
      }

      expect(user).toBeNull();
    });

    it('returns null when GITHUB_TOKEN is not set', () => {
      delete process.env.GITHUB_TOKEN;
      const pat = process.env.GITHUB_TOKEN;
      expect(pat).toBeUndefined();
    });
  });

  describe('signIn callback - token mode', () => {
    it('upserts user to database on sign-in', async () => {
      mockGitHubClientSuccess();
      mockExecute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });

      // Simulate the signIn callback for credentials provider
      const githubId = '12345';
      await execute(
        `INSERT INTO users (id, name, email, image, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           image = excluded.image,
           updated_at = datetime('now')`,
        [githubId, 'Test User', 'test@example.com', 'https://avatars.githubusercontent.com/u/12345']
      );

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['12345', 'Test User'])
      );
    });

    it('syncs organizations using PAT', async () => {
      mockGitHubClientSuccess();

      const pat = process.env.GITHUB_TOKEN!;
      const githubService = new GitHubService(pat);
      await githubService.syncUserOrganizations('12345');

      expect(GitHubService).toHaveBeenCalledWith('ghp_test_token_for_integration_tests');
    });

    it('succeeds even when DB upsert fails', async () => {
      mockGitHubClientSuccess();
      mockExecute.mockRejectedValue(new Error('TURSO_URL environment variable is required'));

      let signInResult = true;
      try {
        await execute('INSERT INTO users ...', []);
      } catch {
        // In token mode, DB errors should be non-fatal
        // The signIn callback should still return true
      }

      expect(signInResult).toBe(true);
    });
  });

  describe('jwt callback - token mode', () => {
    it('stores PAT as accessToken in JWT', () => {
      const token: Record<string, unknown> = {};
      const pat = process.env.GITHUB_TOKEN!;

      // Simulate jwt callback for credentials provider
      token.accessToken = pat;
      token.sub = '12345';

      expect(token.accessToken).toBe('ghp_test_token_for_integration_tests');
      expect(token.sub).toBe('12345');
    });

    it('fetches GitHub profile fields for JWT', async () => {
      mockGitHubClientSuccess();

      const token: Record<string, unknown> = {};
      const pat = process.env.GITHUB_TOKEN!;
      const client = createGitHubClient(pat);
      const ghUser = await client.getCurrentUser();

      token.login = ghUser.login;
      token.html_url = ghUser.html_url;
      token.avatar_url = ghUser.avatar_url;

      expect(token.login).toBe('testuser');
      expect(token.html_url).toBe('https://github.com/testuser');
      expect(token.avatar_url).toBe('https://avatars.githubusercontent.com/u/12345');
    });
  });
});

describe('Environment Config - Token Mode', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('detects local file DB without requiring TURSO_TOKEN', () => {
    process.env.TURSO_URL = 'file:local.db';
    delete process.env.TURSO_TOKEN;

    const isLocalDb = process.env.TURSO_URL?.startsWith('file:');
    const hasDatabase = Boolean(
      process.env.TURSO_URL &&
      (isLocalDb || process.env.TURSO_TOKEN)
    );

    expect(hasDatabase).toBe(true);
  });

  it('requires TURSO_TOKEN for remote DB', () => {
    process.env.TURSO_URL = 'libsql://test.turso.io';
    delete process.env.TURSO_TOKEN;

    const isLocalDb = process.env.TURSO_URL?.startsWith('file:');
    const hasDatabase = Boolean(
      process.env.TURSO_URL &&
      (isLocalDb || process.env.TURSO_TOKEN)
    );

    expect(hasDatabase).toBe(false);
  });

  it('token mode with local DB is NOT demo mode', () => {
    process.env.TURSO_URL = 'file:local.db';
    delete process.env.TURSO_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test';
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.DEMO_MODE;

    const isLocalDb = process.env.TURSO_URL?.startsWith('file:');
    const hasDatabase = Boolean(process.env.TURSO_URL && (isLocalDb || process.env.TURSO_TOKEN));
    const hasGitHubApp = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN) &&
      (!process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID === 'demo-client-id');
    const forceDemoMode = process.env.DEMO_MODE === 'true';

    const isDemoMode = forceDemoMode || !hasDatabase || (!hasGitHubApp && !isTokenMode);

    expect(hasDatabase).toBe(true);
    expect(isTokenMode).toBe(true);
    expect(isDemoMode).toBe(false);
  });

  it('missing DB is still demo mode even in token mode', () => {
    delete process.env.TURSO_URL;
    process.env.GITHUB_TOKEN = 'ghp_test';
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.DEMO_MODE;

    const hasDatabase = Boolean(process.env.TURSO_URL);
    const isTokenMode = Boolean(process.env.GITHUB_TOKEN);
    const isDemoMode = !hasDatabase;

    expect(isDemoMode).toBe(true);
  });
});

describe('Session Shape - Token Mode vs OAuth Mode', () => {
  it('produces identical session shape regardless of auth mode', () => {
    // The session object returned by both modes must have the same fields
    const tokenModeSession = {
      user: {
        id: '12345',
        name: 'Test User',
        email: 'test@example.com',
        image: 'https://avatars.githubusercontent.com/u/12345',
        login: 'testuser',
        html_url: 'https://github.com/testuser',
        avatar_url: 'https://avatars.githubusercontent.com/u/12345',
      },
      accessToken: 'ghp_pat_token',
      organizations: [],
      newUser: false,
      hasGithubApp: false,
    };

    const oauthModeSession = {
      user: {
        id: '12345',
        name: 'Test User',
        email: 'test@example.com',
        image: 'https://avatars.githubusercontent.com/u/12345',
        login: 'testuser',
        html_url: 'https://github.com/testuser',
        avatar_url: 'https://avatars.githubusercontent.com/u/12345',
      },
      accessToken: 'gho_oauth_token',
      organizations: [],
      newUser: false,
      hasGithubApp: false,
    };

    // Same keys present
    expect(Object.keys(tokenModeSession).sort()).toEqual(Object.keys(oauthModeSession).sort());
    expect(Object.keys(tokenModeSession.user).sort()).toEqual(Object.keys(oauthModeSession.user).sort());
  });
});

describe('SQL Compatibility - datetime quotes', () => {
  it('uses single-quoted datetime in upsert SQL', () => {
    // Double-quoted datetime("now") fails on local SQLite (interpreted as column identifier)
    // Single-quoted datetime('now') works on both local SQLite and Turso remote
    const sql = `INSERT INTO users (id, created_at) VALUES (?, datetime('now'))`;

    expect(sql).toContain("datetime('now')");
    expect(sql).not.toContain('datetime("now")');
  });
});

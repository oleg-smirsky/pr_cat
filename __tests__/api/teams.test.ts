/**
 * @jest-environment node
 */
// Tests for team API routes
//
// The routes use `withAuth` (hexagonal auth middleware) and `TeamService`
// which imports from the `@/lib/repositories` barrel.  We mock `@/lib/core`
// to inject a fake ApplicationContext and mock the individual repository
// modules that the barrel re-exports.

import { NextRequest } from 'next/server';
import type { ApplicationContext } from '@/lib/core/application/context';
import { mockTeam, mockOrganization, createMockTeams } from '../fixtures';

// ── Shared mock context ────────────────────────────────────────────
const mockContext: ApplicationContext = {
  user: { id: 'user-123', name: 'Test User', email: 'test@example.com' },
  organizationId: '1',
  primaryOrganization: mockOrganization,
  organizations: [mockOrganization],
  permissions: { canRead: true, canWrite: true, canAdmin: true, role: 'admin' },
  requestId: 'req_test_123',
};

let withAuthContext: ApplicationContext | null = mockContext;

// ── Mock @/lib/core — controls whether the user is authenticated ───
jest.mock('@/lib/core', () => ({
  withAuth: (handler: (...args: unknown[]) => unknown) => {
    return (request: unknown) => {
      if (!withAuthContext) {
        const { NextResponse } = jest.requireActual('next/server');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return handler(withAuthContext, request);
    };
  },
  ApplicationContext: {},
}));

// ── Mock @/auth for routes that still use direct auth() calls ──────
jest.mock('@/auth', () => ({
  auth: jest.fn(),
}));

// ── Mock database ──────────────────────────────────────────────────
jest.mock('@/lib/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  transaction: jest.fn(),
  getDbClient: jest.fn(),
  checkDbHealth: jest.fn(),
  getConnectionStatus: jest.fn(() => ({ isConnected: true, hasClient: true })),
}));

// ── Mock GitHub client (prevent ESM import issues) ─────────────────
jest.mock('@/lib/github', () => ({
  GitHubClient: jest.fn(),
  createGitHubClient: jest.fn(),
  createGitHubInstallationClient: jest.fn(),
}));

// ── Mock repositories ──────────────────────────────────────────────
jest.mock('@/lib/repositories/user-repository', () => ({
  getOrganizationRole: jest.fn(),
  findUserById: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  findUserWithOrganizations: jest.fn(),
  findOrCreateUserByGitHubId: jest.fn(),
}));

jest.mock('@/lib/repositories/team-repository', () => ({
  findTeamsByOrganization: jest.fn(),
  findTeamsByOrganizationWithMembers: jest.fn(),
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
  deleteTeam: jest.fn(),
  findTeamById: jest.fn(),
  findTeamMember: jest.fn(),
  addTeamMember: jest.fn(),
  updateTeamMember: jest.fn(),
  removeTeamMember: jest.fn(),
  getTeamMembers: jest.fn(),
  getTeamWithMembers: jest.fn(),
  getTeamsByOrganizationWithMembers: jest.fn(),
  getUserTeams: jest.fn(),
  getOrganizationMembers: jest.fn(),
  searchUsers: jest.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────
import { GET as getTeams, POST as createTeam } from '@/app/api/organizations/[orgId]/teams/route';
import { PUT as updateTeam, DELETE as deleteTeam } from '@/app/api/organizations/[orgId]/teams/[teamId]/route';
import { POST as addMember, DELETE as removeMember } from '@/app/api/organizations/[orgId]/teams/[teamId]/members/route';

const { auth } = require('@/auth');
const UserRepository = require('@/lib/repositories/user-repository');
const TeamRepository = require('@/lib/repositories/team-repository');

// ── Helpers ────────────────────────────────────────────────────────
function req(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost:3000${url}`, init);
}

// ── Tests ──────────────────────────────────────────────────────────
describe('Team API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withAuthContext = mockContext;

    // Auth mock for routes that use auth() directly (members route)
    auth.mockResolvedValue({
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      organizations: [mockOrganization],
    });

    // Default mocks — happy path
    UserRepository.getOrganizationRole.mockResolvedValue('admin');
    TeamRepository.findTeamsByOrganizationWithMembers.mockResolvedValue([]);
    TeamRepository.findTeamById.mockResolvedValue(mockTeam);
    TeamRepository.createTeam.mockResolvedValue(mockTeam);
    TeamRepository.updateTeam.mockResolvedValue(mockTeam);
    TeamRepository.deleteTeam.mockResolvedValue(true);
    TeamRepository.addTeamMember.mockResolvedValue({ id: 1, team_id: 1, user_id: 'user-456', role: 'member' });
    TeamRepository.removeTeamMember.mockResolvedValue(true);
    TeamRepository.getTeamMembers.mockResolvedValue([]);
    TeamRepository.getTeamWithMembers.mockResolvedValue({ ...mockTeam, members: [] });
  });

  // ── GET /api/organizations/[orgId]/teams ──────────────────────
  describe('GET /api/organizations/[orgId]/teams', () => {
    it('should return teams for an organization', async () => {
      const teams = createMockTeams(3);
      TeamRepository.findTeamsByOrganizationWithMembers.mockResolvedValue(teams);

      const response = await getTeams(
        req('/api/organizations/1/teams'),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(teams);
    });

    it('should return 401 if user is not authenticated', async () => {
      withAuthContext = null;

      const response = await getTeams(
        req('/api/organizations/1/teams'),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not part of organization', async () => {
      UserRepository.getOrganizationRole.mockResolvedValue(null);

      const response = await getTeams(
        req('/api/organizations/1/teams'),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(403);
    });

    it('should return 400 for invalid organization ID', async () => {
      const response = await getTeams(
        req('/api/organizations/invalid/teams'),
        { params: Promise.resolve({ orgId: 'invalid' }) }
      );

      expect(response.status).toBe(400);
    });
  });

  // ── POST /api/organizations/[orgId]/teams ─────────────────────
  describe('POST /api/organizations/[orgId]/teams', () => {
    it('should create a new team', async () => {
      const response = await createTeam(
        req('/api/organizations/1/teams', {
          method: 'POST',
          body: JSON.stringify({ name: 'New Team', description: 'A new team', color: '#10B981' }),
        }),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toMatchObject(mockTeam);
    });

    it('should return 400 when team name is missing', async () => {
      const response = await createTeam(
        req('/api/organizations/1/teams', {
          method: 'POST',
          body: JSON.stringify({ description: 'Missing name' }),
        }),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid color format', async () => {
      const response = await createTeam(
        req('/api/organizations/1/teams', {
          method: 'POST',
          body: JSON.stringify({ name: 'Team', color: 'invalid-color' }),
        }),
        { params: Promise.resolve({ orgId: '1' }) }
      );

      expect(response.status).toBe(400);
    });
  });

  // ── PUT /api/organizations/[orgId]/teams/[teamId] ─────────────
  describe('PUT /api/organizations/[orgId]/teams/[teamId]', () => {
    it('should update a team', async () => {
      const response = await updateTeam(
        req('/api/organizations/1/teams/1', {
          method: 'PUT',
          body: JSON.stringify({ name: 'Updated Team', description: 'Updated description' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject(mockTeam);
    });

    it('should return 404 if team not found', async () => {
      TeamRepository.findTeamById.mockResolvedValue(null);

      const response = await updateTeam(
        req('/api/organizations/1/teams/999', {
          method: 'PUT',
          body: JSON.stringify({ name: 'Update' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '999' }) }
      );

      expect(response.status).toBe(404);
    });

    it('should return 404 when team belongs to different organization', async () => {
      TeamRepository.findTeamById.mockResolvedValue({ ...mockTeam, organization_id: 2 });

      const response = await updateTeam(
        req('/api/organizations/1/teams/1', {
          method: 'PUT',
          body: JSON.stringify({ name: 'Update' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(404);
    });
  });

  // ── DELETE /api/organizations/[orgId]/teams/[teamId] ──────────
  describe('DELETE /api/organizations/[orgId]/teams/[teamId]', () => {
    it('should delete a team', async () => {
      const response = await deleteTeam(
        req('/api/organizations/1/teams/1', { method: 'DELETE' }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(200);
    });

    it('should return 404 if deletion fails', async () => {
      TeamRepository.deleteTeam.mockResolvedValue(false);

      const response = await deleteTeam(
        req('/api/organizations/1/teams/1', { method: 'DELETE' }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(404);
    });
  });

  // ── POST /api/organizations/[orgId]/teams/[teamId]/members ────
  describe('POST /api/organizations/[orgId]/teams/[teamId]/members', () => {
    it('should add a member to a team', async () => {
      const response = await addMember(
        req('/api/organizations/1/teams/1/members', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'user-456', role: 'member' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(201);
    });

    it('should return 400 if target user is not part of organization', async () => {
      UserRepository.getOrganizationRole.mockImplementation((userId: string) => {
        if (userId === 'user-outside-org') return null;
        return 'admin';
      });

      const response = await addMember(
        req('/api/organizations/1/teams/1/members', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'user-outside-org', role: 'member' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(400);
    });

    it('should return 409 for duplicate member', async () => {
      TeamRepository.addTeamMember.mockRejectedValue(new Error('UNIQUE constraint failed'));

      const response = await addMember(
        req('/api/organizations/1/teams/1/members', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'user-123', role: 'member' }),
        }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(409);
    });
  });

  // ── DELETE /api/organizations/[orgId]/teams/[teamId]/members ──
  describe('DELETE /api/organizations/[orgId]/teams/[teamId]/members', () => {
    it('should remove a member from a team', async () => {
      const response = await removeMember(
        req('/api/organizations/1/teams/1/members?user_id=user-123', { method: 'DELETE' }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(200);
    });

    it('should return 400 if user_id is missing', async () => {
      const response = await removeMember(
        req('/api/organizations/1/teams/1/members', { method: 'DELETE' }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(400);
    });

    it('should return 404 if member not found', async () => {
      TeamRepository.removeTeamMember.mockResolvedValue(false);

      const response = await removeMember(
        req('/api/organizations/1/teams/1/members?user_id=user-999', { method: 'DELETE' }),
        { params: Promise.resolve({ orgId: '1', teamId: '1' }) }
      );

      expect(response.status).toBe(404);
    });
  });
});

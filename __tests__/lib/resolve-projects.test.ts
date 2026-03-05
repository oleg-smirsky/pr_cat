import { resolveProjectForCommit } from '@/scripts/lib/resolution-utils';

describe('resolveProjectForCommit', () => {
  const epicMappings = new Map([['BFW-8007', 1], ['BFW-6855', 2]]);
  const projectMappings = new Map([['BFW', 3]]);
  const repoDefaults = new Map([[10, 4]]);
  const jiraIssues = new Map([
    ['BFW-8447', { epicKey: 'BFW-8007', projectKey: 'BFW' }],
    ['BFW-7763', { epicKey: null, projectKey: 'BFW' }],
  ]);
  const ctx = { jiraIssues, epicMappings, projectMappings, repoDefaults };

  it('resolves via epic mapping (level 1)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-8447'], repositoryId: 10 }, ctx);
    expect(r).toEqual({ projectId: 1, level: 'epic' });
  });

  it('falls back to project mapping (level 2)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-7763'], repositoryId: 10 }, ctx);
    expect(r).toEqual({ projectId: 3, level: 'jira_project' });
  });

  it('falls back to repo default (level 3)', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10 }, ctx);
    expect(r).toEqual({ projectId: 4, level: 'repo_default' });
  });

  it('returns null when nothing matches', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 999 }, ctx);
    expect(r).toBeNull();
  });

  it('prioritizes epic over project mapping', () => {
    // BFW-8447 matches both epic (projectId=1) and project (projectId=3)
    const r = resolveProjectForCommit({ ticketIds: ['BFW-8447'], repositoryId: 10 }, ctx);
    expect(r!.level).toBe('epic');
    expect(r!.projectId).toBe(1);
  });

  it('uses first matching ticket for multi-ticket commits', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-7763', 'BFW-8447'], repositoryId: 10 }, ctx);
    // Cascade checks ALL tickets for epic first, then ALL for project.
    // BFW-8447 has epicKey BFW-8007 -> matched at epic level
    expect(r!.level).toBe('epic');
  });
});

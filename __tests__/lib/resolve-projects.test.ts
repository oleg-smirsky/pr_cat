import {
  resolveProjectForCommit,
  extractMessagePrefix,
  resolveBranchProject,
} from '@/scripts/lib/resolution-utils';

describe('resolveProjectForCommit', () => {
  const epicMappings = new Map([['PROJ-1', 1], ['PROJ-2', 2]]);
  const projectMappings = new Map([['PROJ', 3]]);
  const prefixMappings = new Map([['ALPHA', 5], ['ALPHA_HEAD', 5], ['BETA', 6]]);
  const repoDefaults = new Map([[10, 4]]);
  const jiraIssues = new Map([
    ['PROJ-3', { epicKey: 'PROJ-1', projectKey: 'PROJ' }],
    ['PROJ-4', { epicKey: null, projectKey: 'PROJ' }],
  ]);
  const branchMappings = new Map([['feature-a', 5]]);
  const branchExclusions = ['private', 'main'];
  const ctx = { jiraIssues, epicMappings, projectMappings, branchMappings, branchExclusions, prefixMappings, repoDefaults };

  it('resolves via epic mapping (level 1)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['PROJ-3'], repositoryId: 10, message: 'some msg', branchNames: [] }, ctx);
    expect(r).toEqual({ projectId: 1, level: 'epic' });
  });

  it('falls back to project mapping (level 2)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['PROJ-4'], repositoryId: 10, message: 'some msg', branchNames: [] }, ctx);
    expect(r).toEqual({ projectId: 3, level: 'jira_project' });
  });

  it('falls back to message prefix (level 3)', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'ALPHA: Fix probe offset', branchNames: [] }, ctx);
    expect(r).toEqual({ projectId: 5, level: 'message_prefix' });
  });

  it('matches underscore prefixes like ALPHA_HEAD', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'ALPHA_HEAD: Use hardware CRC', branchNames: [] }, ctx);
    expect(r).toEqual({ projectId: 5, level: 'message_prefix' });
  });

  it('falls back to repo default (level 4)', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'Fix typo', branchNames: [] }, ctx);
    expect(r).toEqual({ projectId: 4, level: 'repo_default' });
  });

  it('returns null when nothing matches', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 999, message: 'Fix typo', branchNames: [] }, ctx);
    expect(r).toBeNull();
  });

  it('prioritizes epic over project mapping', () => {
    const r = resolveProjectForCommit({ ticketIds: ['PROJ-3'], repositoryId: 10, message: 'ALPHA: something', branchNames: [] }, ctx);
    expect(r!.level).toBe('epic');
    expect(r!.projectId).toBe(1);
  });

  it('prioritizes jira project over message prefix', () => {
    const r = resolveProjectForCommit({ ticketIds: ['PROJ-4'], repositoryId: 10, message: 'ALPHA: something', branchNames: [] }, ctx);
    expect(r!.level).toBe('jira_project');
  });

  it('uses first matching ticket for multi-ticket commits', () => {
    const r = resolveProjectForCommit({ ticketIds: ['PROJ-4', 'PROJ-3'], repositoryId: 10, message: 'msg', branchNames: [] }, ctx);
    expect(r!.level).toBe('epic');
  });

  it('resolves via branch matching (level 3)', () => {
    const r = resolveProjectForCommit(
      { ticketIds: [], repositoryId: 10, message: 'Fix something', branchNames: ['feature-a_dev', 'private'] },
      ctx,
    );
    expect(r).toEqual({ projectId: 5, level: 'branch_match' });
  });

  it('prioritizes jira project over branch matching', () => {
    const r = resolveProjectForCommit(
      { ticketIds: ['PROJ-4'], repositoryId: 10, message: 'msg', branchNames: ['feature-a_dev'] },
      ctx,
    );
    expect(r!.level).toBe('jira_project');
  });

  it('resolves via epic mapping when ticket IS itself a mapped epic (self-reference)', () => {
    const issuesWithEpicSelfRef = new Map([
      ...jiraIssues,
      ['PROJ-1', { epicKey: null, projectKey: 'PROJ' }],
    ]);
    const ctxWithSelfRef = { ...ctx, jiraIssues: issuesWithEpicSelfRef };
    const r = resolveProjectForCommit(
      { ticketIds: ['PROJ-1'], repositoryId: 10, message: 'some msg', branchNames: [] },
      ctxWithSelfRef,
    );
    expect(r).toEqual({ projectId: 1, level: 'epic' });
  });
});

describe('extractMessagePrefix', () => {
  it('extracts colon-separated prefix', () => {
    expect(extractMessagePrefix('ALPHA: Fix something')).toBe('ALPHA');
  });

  it('extracts space-separated prefix', () => {
    expect(extractMessagePrefix('BETA implement feature')).toBe('BETA');
  });

  it('extracts underscore prefix', () => {
    expect(extractMessagePrefix('ALPHA_HEAD: Use CRC')).toBe('ALPHA_HEAD');
  });

  it('returns null for no prefix', () => {
    expect(extractMessagePrefix('Fix a bug')).toBe('FIX');
  });

  it('returns null for single char prefix', () => {
    expect(extractMessagePrefix('A thing')).toBeNull();
  });

  it('uppercases the prefix', () => {
    expect(extractMessagePrefix('alpha: lowercase')).toBe('ALPHA');
  });

  it('uses first line only', () => {
    expect(extractMessagePrefix('ALPHA: first\nBETA: second')).toBe('ALPHA');
  });
});

describe('resolveBranchProject', () => {
  const branchMappings = new Map([
    ['feature-a', 10],
    ['feat', 20],
    ['feat-special', 20],
    ['feature-b', 30],
  ]);
  const branchExclusions = ['private', 'main', 'master'];

  it('matches a single project branch', () => {
    const r = resolveBranchProject(['feature-a_dev', 'private'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('returns null when only excluded branches', () => {
    const r = resolveBranchProject(['private', 'main'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('returns null when no branches match any prefix', () => {
    const r = resolveBranchProject(['feature/something', 'bugfix/other'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('returns null on ambiguous match (two different projects)', () => {
    const r = resolveBranchProject(['feature-a_dev', 'feature-b_test'], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });

  it('resolves when multiple branches agree on same project', () => {
    const r = resolveBranchProject(['feature-a_dev', 'feature-a_head'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('uses longest prefix match (feat-special beats feat)', () => {
    const r = resolveBranchProject(['feat-special-v2'], branchMappings, branchExclusions);
    expect(r).toBe(20);
  });

  it('excludes RELEASE and REL_ prefixed branches', () => {
    const r = resolveBranchProject(['RELEASE-6.4', 'REL_6_5_111', 'feature-a_dev'], branchMappings, branchExclusions);
    expect(r).toBe(10);
  });

  it('returns null for empty branch list', () => {
    const r = resolveBranchProject([], branchMappings, branchExclusions);
    expect(r).toBeNull();
  });
});

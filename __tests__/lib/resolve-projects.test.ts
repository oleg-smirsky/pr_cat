import { resolveProjectForCommit, extractMessagePrefix } from '@/scripts/lib/resolution-utils';

describe('resolveProjectForCommit', () => {
  const epicMappings = new Map([['BFW-8007', 1], ['BFW-6855', 2]]);
  const projectMappings = new Map([['BFW', 3]]);
  const prefixMappings = new Map([['INDX', 5], ['INDX_HEAD', 5], ['MMU', 6]]);
  const repoDefaults = new Map([[10, 4]]);
  const jiraIssues = new Map([
    ['BFW-8447', { epicKey: 'BFW-8007', projectKey: 'BFW' }],
    ['BFW-7763', { epicKey: null, projectKey: 'BFW' }],
  ]);
  const ctx = { jiraIssues, epicMappings, projectMappings, prefixMappings, repoDefaults };

  it('resolves via epic mapping (level 1)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-8447'], repositoryId: 10, message: 'some msg' }, ctx);
    expect(r).toEqual({ projectId: 1, level: 'epic' });
  });

  it('falls back to project mapping (level 2)', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-7763'], repositoryId: 10, message: 'some msg' }, ctx);
    expect(r).toEqual({ projectId: 3, level: 'jira_project' });
  });

  it('falls back to message prefix (level 3)', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'INDX: Fix probe offset' }, ctx);
    expect(r).toEqual({ projectId: 5, level: 'message_prefix' });
  });

  it('matches underscore prefixes like INDX_HEAD', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'INDX_HEAD: Use hardware CRC' }, ctx);
    expect(r).toEqual({ projectId: 5, level: 'message_prefix' });
  });

  it('falls back to repo default (level 4)', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 10, message: 'Fix typo' }, ctx);
    expect(r).toEqual({ projectId: 4, level: 'repo_default' });
  });

  it('returns null when nothing matches', () => {
    const r = resolveProjectForCommit({ ticketIds: [], repositoryId: 999, message: 'Fix typo' }, ctx);
    expect(r).toBeNull();
  });

  it('prioritizes epic over project mapping', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-8447'], repositoryId: 10, message: 'INDX: something' }, ctx);
    expect(r!.level).toBe('epic');
    expect(r!.projectId).toBe(1);
  });

  it('prioritizes jira project over message prefix', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-7763'], repositoryId: 10, message: 'INDX: something' }, ctx);
    expect(r!.level).toBe('jira_project');
  });

  it('uses first matching ticket for multi-ticket commits', () => {
    const r = resolveProjectForCommit({ ticketIds: ['BFW-7763', 'BFW-8447'], repositoryId: 10, message: 'msg' }, ctx);
    expect(r!.level).toBe('epic');
  });
});

describe('extractMessagePrefix', () => {
  it('extracts colon-separated prefix', () => {
    expect(extractMessagePrefix('INDX: Fix something')).toBe('INDX');
  });

  it('extracts space-separated prefix', () => {
    expect(extractMessagePrefix('MMU implement feature')).toBe('MMU');
  });

  it('extracts underscore prefix', () => {
    expect(extractMessagePrefix('INDX_HEAD: Use CRC')).toBe('INDX_HEAD');
  });

  it('returns null for no prefix', () => {
    expect(extractMessagePrefix('Fix a bug')).toBe('FIX');
  });

  it('returns null for single char prefix', () => {
    expect(extractMessagePrefix('A thing')).toBeNull();
  });

  it('uppercases the prefix', () => {
    expect(extractMessagePrefix('indx: lowercase')).toBe('INDX');
  });

  it('uses first line only', () => {
    expect(extractMessagePrefix('INDX: first\nMMU: second')).toBe('INDX');
  });
});

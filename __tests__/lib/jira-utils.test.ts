import { parseJiraIssue, getReferencedKeys, ParsedJiraIssue } from '@/scripts/lib/jira-utils';

describe('parseJiraIssue', () => {
  it('parses a Task with epic link', () => {
    const raw = {
      key: 'PROJ-100',
      fields: {
        project: { key: 'PROJ' },
        summary: 'Implement login page',
        issuetype: { name: 'Task' },
        customfield_10000: 'PROJ-200',
        customfield_10002: 'Q1 Auth Epic',
        status: { name: 'In Progress' },
        fixVersions: [{ name: '3.14.0' }, { name: '3.15.0' }],
        labels: ['frontend', 'auth'],
        components: [{ name: 'Web UI' }, { name: 'Auth' }],
      },
    };

    const result = parseJiraIssue(raw);

    expect(result).toEqual<ParsedJiraIssue>({
      key: 'PROJ-100',
      projectKey: 'PROJ',
      summary: 'Implement login page',
      issueType: 'Task',
      parentKey: null,
      epicLinkKey: 'PROJ-200',
      epicName: 'Q1 Auth Epic',
      status: 'In Progress',
      fixVersions: ['3.14.0', '3.15.0'],
      labels: ['frontend', 'auth'],
      components: ['Web UI', 'Auth'],
    });
  });

  it('parses a Sub-task with parent, no epic link', () => {
    const raw = {
      key: 'PROJ-301',
      fields: {
        project: { key: 'PROJ' },
        summary: 'Add password validation',
        issuetype: { name: 'Sub-task' },
        parent: { key: 'PROJ-300' },
        status: { name: 'Done' },
        fixVersions: [],
        labels: [],
        components: [],
      },
    };

    const result = parseJiraIssue(raw);

    expect(result).toEqual<ParsedJiraIssue>({
      key: 'PROJ-301',
      projectKey: 'PROJ',
      summary: 'Add password validation',
      issueType: 'Sub-task',
      parentKey: 'PROJ-300',
      epicLinkKey: null,
      epicName: null,
      status: 'Done',
      fixVersions: [],
      labels: [],
      components: [],
    });
  });

  it('handles missing optional fields gracefully', () => {
    const raw = {
      key: 'PROJ-400',
      fields: {
        project: { key: 'PROJ' },
        summary: 'Minimal issue',
        issuetype: { name: 'Bug' },
        status: { name: 'Open' },
      },
    };

    const result = parseJiraIssue(raw);

    expect(result).toEqual<ParsedJiraIssue>({
      key: 'PROJ-400',
      projectKey: 'PROJ',
      summary: 'Minimal issue',
      issueType: 'Bug',
      parentKey: null,
      epicLinkKey: null,
      epicName: null,
      status: 'Open',
      fixVersions: [],
      labels: [],
      components: [],
    });
  });

  it('throws if raw.fields is missing', () => {
    expect(() => parseJiraIssue({ key: 'PROJ-1' })).toThrow('missing fields');
  });

  it('throws if raw.fields is null', () => {
    expect(() => parseJiraIssue({ key: 'PROJ-1', fields: null })).toThrow('missing fields');
  });
});

describe('getReferencedKeys', () => {
  it('returns parentKey and epicLinkKey when both exist', () => {
    const parsed: ParsedJiraIssue = {
      key: 'PROJ-100',
      projectKey: 'PROJ',
      summary: 'test',
      issueType: 'Sub-task',
      parentKey: 'PROJ-99',
      epicLinkKey: 'PROJ-50',
      epicName: null,
      status: 'Open',
      fixVersions: [],
      labels: [],
      components: [],
    };

    expect(getReferencedKeys(parsed)).toEqual(['PROJ-99', 'PROJ-50']);
  });

  it('returns only parentKey when epicLinkKey is null', () => {
    const parsed: ParsedJiraIssue = {
      key: 'PROJ-100',
      projectKey: 'PROJ',
      summary: 'test',
      issueType: 'Sub-task',
      parentKey: 'PROJ-99',
      epicLinkKey: null,
      epicName: null,
      status: 'Open',
      fixVersions: [],
      labels: [],
      components: [],
    };

    expect(getReferencedKeys(parsed)).toEqual(['PROJ-99']);
  });

  it('returns only epicLinkKey when parentKey is null', () => {
    const parsed: ParsedJiraIssue = {
      key: 'PROJ-100',
      projectKey: 'PROJ',
      summary: 'test',
      issueType: 'Task',
      parentKey: null,
      epicLinkKey: 'PROJ-50',
      epicName: null,
      status: 'Open',
      fixVersions: [],
      labels: [],
      components: [],
    };

    expect(getReferencedKeys(parsed)).toEqual(['PROJ-50']);
  });

  it('returns empty array when no references exist', () => {
    const parsed: ParsedJiraIssue = {
      key: 'PROJ-100',
      projectKey: 'PROJ',
      summary: 'test',
      issueType: 'Epic',
      parentKey: null,
      epicLinkKey: null,
      epicName: null,
      status: 'Open',
      fixVersions: [],
      labels: [],
      components: [],
    };

    expect(getReferencedKeys(parsed)).toEqual([]);
  });
});

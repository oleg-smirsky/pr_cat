import {
  extractJiraTickets,
  parseCommitForIngestion,
  unsanitizeBranchName,
  type CachedCommitData,
} from '@/scripts/lib/commit-utils';

describe('commit-utils', () => {
  describe('extractJiraTickets', () => {
    it('extracts a ticket from the first line', () => {
      expect(extractJiraTickets('PROJ-1234 fix sensor')).toEqual(['PROJ-1234']);
    });

    it('extracts a ticket from the body', () => {
      expect(extractJiraTickets('marlin: strong types\n\nPROJ-200')).toEqual(['PROJ-200']);
    });

    it('extracts multiple tickets from the body', () => {
      expect(extractJiraTickets('ALPHA: support\n\nPROJ-100\nPROJ-200\nPROJ-300')).toEqual([
        'PROJ-100',
        'PROJ-200',
        'PROJ-300',
      ]);
    });

    it('deduplicates tickets', () => {
      expect(extractJiraTickets('Fix PROJ-1234\n\nRelated to PROJ-1234')).toEqual(['PROJ-1234']);
    });

    it('extracts tickets with different project keys', () => {
      expect(extractJiraTickets('OTHER-42 feature')).toEqual(['OTHER-42']);
    });

    it('returns empty array for conventional commit messages', () => {
      expect(extractJiraTickets('fix: resolve issue')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(extractJiraTickets('')).toEqual([]);
    });

    it('extracts multiple inline references', () => {
      expect(extractJiraTickets('cherry-picking PROJ-400 without PROJ-500')).toEqual([
        'PROJ-400',
        'PROJ-500',
      ]);
    });

    it('does not match lowercase ticket patterns', () => {
      expect(extractJiraTickets('bfw-1234')).toEqual([]);
    });
  });

  describe('parseCommitForIngestion', () => {
    const fullCommit: CachedCommitData = {
      sha: 'abc123def456',
      commit: {
        message: 'PROJ-42 fix temperature sensor\n\nDetailed description here',
        author: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          date: '2025-06-15T10:30:00Z',
        },
      },
      author: {
        login: 'janedoe',
        id: 12345,
      },
      stats: {
        additions: 50,
        deletions: 10,
      },
    };

    it('parses all fields from a complete commit', () => {
      const result = parseCommitForIngestion(fullCommit);

      expect(result).toEqual({
        sha: 'abc123def456',
        authorEmail: 'jane@example.com',
        authorName: 'Jane Doe',
        message: 'PROJ-42 fix temperature sensor\n\nDetailed description here',
        committedAt: '2025-06-15T10:30:00Z',
        additions: 50,
        deletions: 10,
        jiraTicketIds: ['PROJ-42'],
        githubAuthorLogin: 'janedoe',
        githubAuthorId: '12345',
      });
    });

    it('handles null author', () => {
      const commit: CachedCommitData = {
        ...fullCommit,
        author: null,
      };
      const result = parseCommitForIngestion(commit);

      expect(result.githubAuthorLogin).toBeNull();
      expect(result.githubAuthorId).toBeNull();
    });

    it('defaults additions and deletions to 0 when stats are missing', () => {
      const commit: CachedCommitData = {
        ...fullCommit,
        stats: undefined,
      };
      const result = parseCommitForIngestion(commit);

      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it('returns empty jiraTicketIds for non-Jira messages', () => {
      const commit: CachedCommitData = {
        ...fullCommit,
        commit: {
          ...fullCommit.commit,
          message: 'fix: resolve a bug in the widget',
        },
      };
      const result = parseCommitForIngestion(commit);

      expect(result.jiraTicketIds).toEqual([]);
    });

    it('converts numeric author ID to string', () => {
      const result = parseCommitForIngestion(fullCommit);

      expect(result.githubAuthorId).toBe('12345');
      expect(typeof result.githubAuthorId).toBe('string');
    });

    it('populates jiraTicketIds with multiple tickets from body', () => {
      const commit: CachedCommitData = {
        ...fullCommit,
        commit: {
          ...fullCommit.commit,
          message: 'ALPHA: support\n\nPROJ-6883\nPROJ-7154\nPROJ-7182',
        },
      };
      const result = parseCommitForIngestion(commit);

      expect(result.jiraTicketIds).toEqual(['PROJ-6883', 'PROJ-7154', 'PROJ-7182']);
    });
  });

  describe('unsanitizeBranchName', () => {
    it('reverses double underscores to slashes and strips .json', () => {
      expect(unsanitizeBranchName('feature__foo.json')).toBe('feature/foo');
    });

    it('handles filenames without underscores', () => {
      expect(unsanitizeBranchName('main.json')).toBe('main');
    });

    it('handles multiple double underscores', () => {
      expect(unsanitizeBranchName('release__v1.0__hotfix.json')).toBe('release/v1.0/hotfix');
    });

    it('handles filename without .json extension', () => {
      expect(unsanitizeBranchName('feature__bar')).toBe('feature/bar');
    });
  });
});

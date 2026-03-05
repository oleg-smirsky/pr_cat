import {
  extractJiraTicket,
  extractJiraTickets,
  parseCommitForIngestion,
  unsanitizeBranchName,
  type CachedCommitData,
} from '@/scripts/lib/commit-utils';

describe('commit-utils', () => {
  describe('extractJiraTickets', () => {
    it('extracts a ticket from the first line', () => {
      expect(extractJiraTickets('BFW-1234 fix sensor')).toEqual(['BFW-1234']);
    });

    it('extracts a ticket from the body', () => {
      expect(extractJiraTickets('marlin: strong types\n\nBFW-7962')).toEqual(['BFW-7962']);
    });

    it('extracts multiple tickets from the body', () => {
      expect(extractJiraTickets('C1L: support\n\nBFW-6883\nBFW-7154\nBFW-7182')).toEqual([
        'BFW-6883',
        'BFW-7154',
        'BFW-7182',
      ]);
    });

    it('deduplicates tickets', () => {
      expect(extractJiraTickets('Fix BFW-1234\n\nRelated to BFW-1234')).toEqual(['BFW-1234']);
    });

    it('extracts tickets with different project keys', () => {
      expect(extractJiraTickets('PRUSA-42 feature')).toEqual(['PRUSA-42']);
    });

    it('returns empty array for conventional commit messages', () => {
      expect(extractJiraTickets('fix: resolve issue')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(extractJiraTickets('')).toEqual([]);
    });

    it('extracts multiple inline references', () => {
      expect(extractJiraTickets('cherry-picking BFW-7766 without BFW-7702')).toEqual([
        'BFW-7766',
        'BFW-7702',
      ]);
    });

    it('does not match lowercase ticket patterns', () => {
      expect(extractJiraTickets('bfw-1234')).toEqual([]);
    });
  });

  describe('extractJiraTicket (deprecated, backward compat)', () => {
    it('extracts a ticket from the start of the first line', () => {
      expect(extractJiraTicket('BFW-1234 fix sensor calibration')).toBe('BFW-1234');
    });

    it('extracts tickets with different project keys', () => {
      expect(extractJiraTicket('PRUSA-42 add new feature')).toBe('PRUSA-42');
    });

    it('returns null for conventional commit messages', () => {
      expect(extractJiraTicket('fix: resolve sensor issue')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractJiraTicket('')).toBeNull();
    });

    it('only checks the first line', () => {
      expect(extractJiraTicket('fix stuff\nBFW-999 in body')).toBeNull();
    });

    it('extracts ticket when first line has only the ticket', () => {
      expect(extractJiraTicket('BFW-1234\nsecond line')).toBe('BFW-1234');
    });

    it('extracts ticket with large numbers', () => {
      expect(extractJiraTicket('PROJ-99999 large ticket number')).toBe('PROJ-99999');
    });

    it('returns null when ticket is not at start of line', () => {
      expect(extractJiraTicket('refs BFW-1234 fix something')).toBeNull();
    });
  });

  describe('parseCommitForIngestion', () => {
    const fullCommit: CachedCommitData = {
      sha: 'abc123def456',
      commit: {
        message: 'BFW-42 fix temperature sensor\n\nDetailed description here',
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
        message: 'BFW-42 fix temperature sensor\n\nDetailed description here',
        committedAt: '2025-06-15T10:30:00Z',
        additions: 50,
        deletions: 10,
        jiraTicketId: 'BFW-42',
        jiraTicketIds: ['BFW-42'],
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

    it('returns null jiraTicketId and empty jiraTicketIds for non-Jira messages', () => {
      const commit: CachedCommitData = {
        ...fullCommit,
        commit: {
          ...fullCommit.commit,
          message: 'fix: resolve a bug in the widget',
        },
      };
      const result = parseCommitForIngestion(commit);

      expect(result.jiraTicketId).toBeNull();
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
          message: 'C1L: support\n\nBFW-6883\nBFW-7154\nBFW-7182',
        },
      };
      const result = parseCommitForIngestion(commit);

      expect(result.jiraTicketIds).toEqual(['BFW-6883', 'BFW-7154', 'BFW-7182']);
      expect(result.jiraTicketId).toBeNull(); // no ticket at start of first line
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

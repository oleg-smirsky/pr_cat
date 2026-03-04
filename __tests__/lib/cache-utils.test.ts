import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  sanitizeBranchName,
  getRepoCacheDir,
  isCommitCached,
  saveCacheFile,
  parseArgs,
  parseRepoSlug,
} from '@/scripts/lib/cache-utils';

// Mock fs module for tests that interact with the filesystem
jest.mock('node:fs');

const mockedFs = jest.mocked(fs);

describe('cache-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeBranchName', () => {
    it('replaces slashes with double underscores', () => {
      expect(sanitizeBranchName('feature/foo')).toBe('feature__foo');
    });

    it('returns the same string if no slashes', () => {
      expect(sanitizeBranchName('main')).toBe('main');
    });

    it('handles multiple slashes', () => {
      expect(sanitizeBranchName('release/v1.0/hotfix')).toBe('release__v1.0__hotfix');
    });

    it('handles empty string', () => {
      expect(sanitizeBranchName('')).toBe('');
    });
  });

  describe('getRepoCacheDir', () => {
    it('returns a path under .cache/github/owner/repo', () => {
      const result = getRepoCacheDir('myorg', 'myrepo');
      expect(result).toBe(path.join(process.cwd(), '.cache', 'github', 'myorg', 'myrepo'));
    });
  });

  describe('isCommitCached', () => {
    it('returns true when the commit file exists', () => {
      mockedFs.existsSync.mockReturnValue(true);

      expect(isCommitCached('org', 'repo', 'abc123')).toBe(true);

      const expectedPath = path.join(
        process.cwd(),
        '.cache',
        'github',
        'org',
        'repo',
        'commits',
        'abc123.json'
      );
      expect(mockedFs.existsSync).toHaveBeenCalledWith(expectedPath);
    });

    it('returns false when the commit file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      expect(isCommitCached('org', 'repo', 'def456')).toBe(false);
    });
  });

  describe('saveCacheFile', () => {
    it('creates the directory and writes the file', () => {
      const filePath = '/some/path/to/file.json';
      const data = { key: 'value' };

      saveCacheFile(filePath, data);

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/some/path/to', { recursive: true });
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        filePath,
        JSON.stringify(data, null, 2)
      );
    });

    it('serializes complex objects correctly', () => {
      const filePath = '/cache/data.json';
      const data = { items: [1, 2, 3], nested: { a: true } };

      saveCacheFile(filePath, data);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        filePath,
        JSON.stringify(data, null, 2)
      );
    });
  });

  describe('parseArgs', () => {
    it('parses --repos and --since arguments', () => {
      const result = parseArgs(['--repos', 'org/repo1,org/repo2', '--since', '2025-06-01']);
      expect(result).toEqual({
        repos: ['org/repo1', 'org/repo2'],
        since: '2025-06-01',
      });
    });

    it('returns defaults when no arguments are given', () => {
      const result = parseArgs([]);
      expect(result).toEqual({
        repos: [],
        since: '2025-01-01',
      });
    });

    it('trims whitespace from repo names', () => {
      const result = parseArgs(['--repos', ' org/repo1 , org/repo2 ']);
      expect(result).toEqual({
        repos: ['org/repo1', 'org/repo2'],
        since: '2025-01-01',
      });
    });

    it('handles --repos without --since', () => {
      const result = parseArgs(['--repos', 'org/repo1']);
      expect(result).toEqual({
        repos: ['org/repo1'],
        since: '2025-01-01',
      });
    });

    it('handles --since without --repos', () => {
      const result = parseArgs(['--since', '2024-03-15']);
      expect(result).toEqual({
        repos: [],
        since: '2024-03-15',
      });
    });

    it('ignores unknown arguments', () => {
      const result = parseArgs(['--unknown', 'value', '--repos', 'org/repo']);
      expect(result).toEqual({
        repos: ['org/repo'],
        since: '2025-01-01',
      });
    });
  });

  describe('parseRepoSlug', () => {
    it('parses a valid owner/repo slug', () => {
      expect(parseRepoSlug('org/repo')).toEqual({ owner: 'org', repo: 'repo' });
    });

    it('parses slugs with hyphens and dots', () => {
      expect(parseRepoSlug('my-org/my.repo')).toEqual({ owner: 'my-org', repo: 'my.repo' });
    });

    it('throws for a slug without a slash', () => {
      expect(() => parseRepoSlug('invalid')).toThrow(
        'Invalid repo slug: "invalid". Expected format: owner/repo'
      );
    });

    it('throws for an empty string', () => {
      expect(() => parseRepoSlug('')).toThrow(
        'Invalid repo slug: "". Expected format: owner/repo'
      );
    });

    it('throws for a slug with only a slash', () => {
      expect(() => parseRepoSlug('/')).toThrow(
        'Invalid repo slug: "/". Expected format: owner/repo'
      );
    });
  });
});

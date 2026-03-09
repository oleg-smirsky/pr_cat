import * as fs from 'node:fs';
import {
  loadGitHubUsernames,
  saveForkMarker,
  readForkMarker,
} from '@/scripts/lib/fork-utils';

jest.mock('node:fs');
const mockedFs = jest.mocked(fs);

describe('fork-utils', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('loadGitHubUsernames', () => {
    it('extracts github usernames from team config', () => {
      const config = {
        teams: {
          Buddy: {
            members: [
              { name: 'Alice', emails: [], github: 'alice-gh', capacity: 1.0 },
              { name: 'Bob', emails: [], capacity: 1.0 },
              { name: 'Carol', emails: [], github: 'carol-gh', capacity: 0.4 },
            ],
          },
          Other: {
            members: [
              { name: 'Dave', emails: [], github: 'dave-gh', capacity: 1.0 },
            ],
          },
        },
      };
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
      mockedFs.existsSync.mockReturnValue(true);

      const usernames = loadGitHubUsernames('/path/to/config.json');
      expect(usernames).toEqual(['alice-gh', 'carol-gh', 'dave-gh']);
    });

    it('returns empty array when no members have github field', () => {
      const config = {
        teams: {
          Buddy: {
            members: [
              { name: 'Alice', emails: [], capacity: 1.0 },
            ],
          },
        },
      };
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
      mockedFs.existsSync.mockReturnValue(true);

      expect(loadGitHubUsernames('/path/to/config.json')).toEqual([]);
    });

    it('deduplicates usernames across teams', () => {
      const config = {
        teams: {
          A: { members: [{ name: 'X', emails: [], github: 'same', capacity: 1.0 }] },
          B: { members: [{ name: 'Y', emails: [], github: 'same', capacity: 1.0 }] },
        },
      };
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
      mockedFs.existsSync.mockReturnValue(true);

      expect(loadGitHubUsernames('/path')).toEqual(['same']);
    });
  });

  describe('saveForkMarker', () => {
    it('writes fork-of.json with parent repo slug', () => {
      saveForkMarker('/cache/alice/Repo', 'acme-org/Repo');

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/cache/alice/Repo', { recursive: true });
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        '/cache/alice/Repo/fork-of.json',
        JSON.stringify('acme-org/Repo'),
      );
    });
  });

  describe('readForkMarker', () => {
    it('returns parent slug when fork-of.json exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify('acme-org/Repo'));

      expect(readForkMarker('/cache/alice/Repo')).toBe('acme-org/Repo');
    });

    it('returns null when fork-of.json does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      expect(readForkMarker('/cache/alice/Repo')).toBeNull();
    });
  });
});

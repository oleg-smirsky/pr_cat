/** Extract all Jira ticket IDs from anywhere in a commit message (deduplicated) */
export function extractJiraTickets(message: string): string[] {
  const matches = message.match(/\b[A-Z]+-\d+\b/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

/** Shape of the cached GitHub commit JSON we read from disk */
export interface CachedCommitData {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  author: {
    login: string;
    id: number;
  } | null;
  stats?: {
    additions: number;
    deletions: number;
  };
}

/** Fields extracted from a cached commit, ready for DB insertion */
export interface ParsedCommit {
  sha: string;
  authorEmail: string;
  authorName: string;
  message: string;
  committedAt: string;
  additions: number;
  deletions: number;
  jiraTicketIds: string[];
  githubAuthorLogin: string | null;
  githubAuthorId: string | null;
}

/** Parse cached commit JSON into the fields we need for DB insertion */
export function parseCommitForIngestion(data: CachedCommitData): ParsedCommit {
  return {
    sha: data.sha,
    authorEmail: data.commit.author.email,
    authorName: data.commit.author.name,
    committedAt: data.commit.author.date,
    message: data.commit.message,
    additions: data.stats?.additions ?? 0,
    deletions: data.stats?.deletions ?? 0,
    jiraTicketIds: extractJiraTickets(data.commit.message),
    githubAuthorLogin: data.author?.login ?? null,
    githubAuthorId: data.author?.id ? String(data.author.id) : null,
  };
}

/** Reverse the filename sanitization: replace __ back to / and strip .json */
export function unsanitizeBranchName(filename: string): string {
  return filename.replace(/\.json$/, '').replace(/__/g, '/');
}

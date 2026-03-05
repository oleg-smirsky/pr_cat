/**
 * Pure functions for resolving commits to projects via a cascade of mappings.
 *
 * Cascade order (stop at first match):
 *   1. Epic mapping      — ticket → jira issue epic_key → epicMappings → project_id
 *                           OR ticket key itself in epicMappings (epic self-reference)
 *   2. Jira project      — ticket → jira issue project_key → projectMappings → project_id
 *   3. Message prefix    — commit message prefix (e.g. "INDX:") → prefixMappings → project_id
 *   4. Repo default      — repository_id → repoDefaults → project_id
 *   5. null              — unallocated
 */

export interface CommitInfo {
  ticketIds: string[];
  repositoryId: number;
  message: string;
}

export interface JiraIssueInfo {
  epicKey: string | null;
  projectKey: string;
}

export interface MappingContext {
  jiraIssues: Map<string, JiraIssueInfo>;
  epicMappings: Map<string, number>;      // epic_key → project_id
  projectMappings: Map<string, number>;   // jira_project_key → project_id
  prefixMappings: Map<string, number>;    // UPPERCASE prefix → project_id
  repoDefaults: Map<number, number>;      // repository_id → project_id
}

export interface ResolutionResult {
  projectId: number;
  level: 'epic' | 'jira_project' | 'message_prefix' | 'repo_default';
}

/**
 * Extract the leading prefix from a commit message first line.
 * Matches patterns like "INDX:", "INDX_HEAD:", "MMU ", "C1L:" etc.
 * Returns the prefix uppercased, or null.
 */
export function extractMessagePrefix(message: string): string | null {
  const firstLine = message.split('\n')[0];
  const match = firstLine.match(/^([A-Za-z][A-Za-z0-9_]+)[:\s]/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Resolve a commit to a project using the cascade:
 *   1. For ALL tickets: check epic mapping
 *   2. For ALL tickets: check jira project mapping
 *   3. Check commit message prefix
 *   4. Check repo default
 *   5. Return null
 */
export function resolveProjectForCommit(
  commit: CommitInfo,
  ctx: MappingContext,
): ResolutionResult | null {
  // Level 1: epic mapping — check all tickets
  for (const ticketId of commit.ticketIds) {
    const issue = ctx.jiraIssues.get(ticketId);
    if (!issue) continue;

    // Check if the ticket belongs to a mapped epic
    if (issue.epicKey) {
      const projectId = ctx.epicMappings.get(issue.epicKey);
      if (projectId !== undefined) {
        return { projectId, level: 'epic' };
      }
    }

    // Self-reference: ticket has no parent epic but IS itself a mapped epic
    if (!issue.epicKey) {
      const projectId = ctx.epicMappings.get(ticketId);
      if (projectId !== undefined) {
        return { projectId, level: 'epic' };
      }
    }
  }

  // Level 2: jira project mapping — check all tickets
  for (const ticketId of commit.ticketIds) {
    const issue = ctx.jiraIssues.get(ticketId);
    if (!issue) continue;
    const projectId = ctx.projectMappings.get(issue.projectKey);
    if (projectId !== undefined) {
      return { projectId, level: 'jira_project' };
    }
  }

  // Level 3: message prefix
  const prefix = extractMessagePrefix(commit.message);
  if (prefix) {
    const projectId = ctx.prefixMappings.get(prefix);
    if (projectId !== undefined) {
      return { projectId, level: 'message_prefix' };
    }
  }

  // Level 4: repo default
  const repoProjectId = ctx.repoDefaults.get(commit.repositoryId);
  if (repoProjectId !== undefined) {
    return { projectId: repoProjectId, level: 'repo_default' };
  }

  // Level 5: unallocated
  return null;
}

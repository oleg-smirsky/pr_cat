/**
 * Pure functions for resolving commits to projects via a cascade of mappings.
 *
 * Cascade order (stop at first match):
 *   1. Epic mapping   — ticket → jira issue epic_key → epicMappings → project_id
 *   2. Jira project   — ticket → jira issue project_key → projectMappings → project_id
 *   3. Repo default   — repository_id → repoDefaults → project_id
 *   4. null            — unallocated
 */

export interface CommitInfo {
  ticketIds: string[];
  repositoryId: number;
}

export interface JiraIssueInfo {
  epicKey: string | null;
  projectKey: string;
}

export interface MappingContext {
  jiraIssues: Map<string, JiraIssueInfo>;
  epicMappings: Map<string, number>;      // epic_key → project_id
  projectMappings: Map<string, number>;   // jira_project_key → project_id
  repoDefaults: Map<number, number>;      // repository_id → project_id
}

export interface ResolutionResult {
  projectId: number;
  level: 'epic' | 'jira_project' | 'repo_default';
}

/**
 * Resolve a commit to a project using the cascade:
 *   1. For ALL tickets: check epic mapping
 *   2. For ALL tickets: check jira project mapping
 *   3. Check repo default
 *   4. Return null
 */
export function resolveProjectForCommit(
  commit: CommitInfo,
  ctx: MappingContext,
): ResolutionResult | null {
  // Level 1: epic mapping — check all tickets
  for (const ticketId of commit.ticketIds) {
    const issue = ctx.jiraIssues.get(ticketId);
    if (!issue || !issue.epicKey) continue;
    const projectId = ctx.epicMappings.get(issue.epicKey);
    if (projectId !== undefined) {
      return { projectId, level: 'epic' };
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

  // Level 3: repo default
  const repoProjectId = ctx.repoDefaults.get(commit.repositoryId);
  if (repoProjectId !== undefined) {
    return { projectId: repoProjectId, level: 'repo_default' };
  }

  // Level 4: unallocated
  return null;
}

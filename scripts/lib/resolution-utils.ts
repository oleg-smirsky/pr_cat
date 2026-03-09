/**
 * Pure functions for resolving commits to projects via a cascade of mappings.
 *
 * Cascade order (stop at first match):
 *   1. Epic mapping      — ticket → jira issue epic_key → epicMappings → project_id
 *                           OR ticket key itself in epicMappings (epic self-reference)
 *   2. Jira project      — ticket → jira issue project_key → projectMappings → project_id
 *   3. Branch matching   — commit branches → branchMappings prefix → project_id
 *   4. Message prefix    — commit message prefix (e.g. "INDX:") → prefixMappings → project_id
 *   5. Repo default      — repository_id → repoDefaults → project_id
 *   6. null              — unallocated
 */

export interface CommitInfo {
  ticketIds: string[];
  repositoryId: number;
  message: string;
  branchNames: string[];
}

export interface JiraIssueInfo {
  epicKey: string | null;
  projectKey: string;
}

export interface MappingContext {
  jiraIssues: Map<string, JiraIssueInfo>;
  epicMappings: Map<string, number>;      // epic_key → project_id
  projectMappings: Map<string, number>;   // jira_project_key → project_id
  branchMappings: Map<string, number>;    // branch prefix → project_id
  branchExclusions: string[];             // branch names to skip
  prefixMappings: Map<string, number>;    // UPPERCASE prefix → project_id
  repoDefaults: Map<number, number>;      // repository_id → project_id
}

export interface ResolutionResult {
  projectId: number;
  level: 'epic' | 'jira_project' | 'branch_match' | 'message_prefix' | 'repo_default';
}

/**
 * Extract project-identifying prefixes from a commit message first line.
 * Returns all matched prefixes (uppercased) so the caller can look up each one.
 *
 * Strategies (in order):
 *   1. Leading prefix:  "INDX: foo"  → ["INDX"]
 *   2. Nested prefix:   "fixup! INDX: foo", "(HACK) INDX: foo" → ["INDX"]
 *      Chains:          "fixup! fixup! INDX: foo" → ["INDX"]
 *      Reverts:         'Revert "INDX: foo"' → ["INDX"]
 *   3. Slash prefix:    "homing/corexy: foo" → ["HOMING/COREXY", "HOMING"]
 *   4. Multi-word:      "phstep calib: foo"  → ["PHSTEP CALIB", "PHSTEP"]
 *   5. Keyword scan:    "Fix induction heater on INDX_HEAD" → ["INDX_HEAD", "INDX"]
 */
export function extractMessagePrefixes(message: string): string[] {
  const firstLine = message.split('\n')[0];
  const prefixes: string[] = [];

  // Strip leading noise: fixup!, squash!, (HACK), (DEBUG), (SQUASH), (PRIVATE), (CHECK), (TMP), (REVERT)
  // Also handle chains: "fixup! fixup! INDX:"
  // Also handle: Revert "INDX: foo"
  let cleaned = firstLine;
  cleaned = cleaned.replace(/^(?:(?:fixup!|squash!)\s*)+/i, '');
  cleaned = cleaned.replace(/^\([^)]+\)\s*/g, '');
  cleaned = cleaned.replace(/^Revert\s+"?/i, '');
  cleaned = cleaned.replace(/"$/, '');
  cleaned = cleaned.trim();

  // Strategy 1: leading prefix from cleaned line  "WORD:" or "WORD "
  const leading = cleaned.match(/^([A-Za-z][A-Za-z0-9_]+)[:\s]/);
  if (leading) {
    prefixes.push(leading[1].toUpperCase());
  }

  // Strategy 2: slash-separated prefix  "homing/corexy:"
  const slash = cleaned.match(/^([A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z0-9_]+)+)[:\s]/);
  if (slash) {
    const full = slash[1].toUpperCase();
    prefixes.push(full);
    prefixes.push(full.split('/')[0]);
  }

  // Strategy 3: multi-word prefix before colon  "phstep calib:"
  const multiWord = cleaned.match(/^([A-Za-z][A-Za-z0-9_]+(?:\s+[A-Za-z][A-Za-z0-9_]+)*):\s/);
  if (multiWord) {
    const full = multiWord[1].toUpperCase();
    if (full.includes(' ')) {
      prefixes.push(full);
      prefixes.push(full.split(' ')[0]);
    }
  }

  // Strategy 4: keyword scan — find known project identifiers anywhere in the first line
  // Matches word boundaries: "Fix something on INDX_HEAD" → INDX_HEAD
  const keywords = firstLine.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g);
  for (const m of keywords) {
    const word = m[1];
    prefixes.push(word);
    // Also try base prefix: INDX_HEAD → INDX
    if (word.includes('_')) {
      prefixes.push(word.split('_')[0]);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(prefixes)];
}

/** @deprecated Use extractMessagePrefixes instead */
export function extractMessagePrefix(message: string): string | null {
  const prefixes = extractMessagePrefixes(message);
  return prefixes.length > 0 ? prefixes[0] : null;
}

/**
 * Check if a branch name should be excluded from matching.
 * Excluded: exact matches in the exclusion list, plus RELEASE* and REL_* prefixes.
 */
function isBranchExcluded(branch: string, exclusions: string[]): boolean {
  for (const excl of exclusions) {
    if (branch.startsWith(excl)) return true;
  }
  if (branch.startsWith('RELEASE') || branch.startsWith('REL_')) return true;
  return false;
}

/**
 * Find the longest matching prefix for a branch name.
 * Returns the project_id or undefined.
 */
function matchBranchPrefix(
  branch: string,
  branchMappings: Map<string, number>,
): number | undefined {
  let bestLen = 0;
  let bestProjectId: number | undefined;
  for (const [prefix, projectId] of branchMappings) {
    if (branch.startsWith(prefix) && prefix.length > bestLen) {
      bestLen = prefix.length;
      bestProjectId = projectId;
    }
  }
  return bestProjectId;
}

/**
 * Resolve a project from branch names.
 * Filters out excluded branches, matches remaining against prefix mappings.
 * Returns project_id if all matching branches agree, null otherwise.
 */
export function resolveBranchProject(
  branches: string[],
  branchMappings: Map<string, number>,
  branchExclusions: string[],
): number | null {
  const matchedProjectIds = new Set<number>();

  for (const branch of branches) {
    if (isBranchExcluded(branch, branchExclusions)) continue;
    const projectId = matchBranchPrefix(branch, branchMappings);
    if (projectId !== undefined) {
      matchedProjectIds.add(projectId);
    }
  }

  if (matchedProjectIds.size === 1) {
    return matchedProjectIds.values().next().value!;
  }

  return null;
}

/**
 * Resolve a commit to a project using the cascade:
 *   1. For ALL tickets: check epic mapping
 *   2. For ALL tickets: check jira project mapping
 *   3. Check branch matching
 *   4. Check commit message prefix
 *   5. Check repo default
 *   6. Return null
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

  // Level 3: message prefix (branch matching removed — unreliable after merge)
  const prefixes = extractMessagePrefixes(commit.message);
  for (const prefix of prefixes) {
    const projectId = ctx.prefixMappings.get(prefix);
    if (projectId !== undefined) {
      return { projectId, level: 'message_prefix' };
    }
  }

  // Level 5: repo default
  const repoProjectId = ctx.repoDefaults.get(commit.repositoryId);
  if (repoProjectId !== undefined) {
    return { projectId: repoProjectId, level: 'repo_default' };
  }

  // Level 6: unallocated
  return null;
}

export interface ParsedJiraIssue {
  key: string;
  projectKey: string;
  summary: string;
  issueType: string;
  parentKey: string | null;
  epicLinkKey: string | null;
  epicName: string | null;
  status: string;
  fixVersions: string[];
  labels: string[];
  components: string[];
}

/**
 * Parse a Jira REST API v2 issue response into a structured object.
 * Handles Jira Server custom fields: customfield_10000 (epic link), customfield_10002 (epic name).
 * Throws if `raw.fields` is missing or null.
 */
export function parseJiraIssue(raw: Record<string, unknown>): ParsedJiraIssue {
  const fields = raw.fields as Record<string, unknown> | undefined | null;
  if (!fields) {
    throw new Error(`Jira issue ${raw.key ?? 'unknown'}: missing fields`);
  }

  const project = fields.project as { key: string } | undefined;
  const issuetype = fields.issuetype as { name: string } | undefined;
  const parent = fields.parent as { key: string } | undefined;
  const status = fields.status as { name: string } | undefined;
  const fixVersions = (fields.fixVersions as Array<{ name: string }>) ?? [];
  const labels = (fields.labels as string[]) ?? [];
  const components = (fields.components as Array<{ name: string }>) ?? [];

  return {
    key: raw.key as string,
    projectKey: project?.key ?? '',
    summary: (fields.summary as string) ?? '',
    issueType: issuetype?.name ?? '',
    parentKey: parent?.key ?? null,
    epicLinkKey: (fields.customfield_10000 as string) ?? null,
    epicName: (fields.customfield_10002 as string) ?? null,
    status: status?.name ?? '',
    fixVersions: fixVersions.map((v) => v.name),
    labels,
    components: components.map((c) => c.name),
  };
}

/**
 * Return issue keys referenced by a parsed issue (parent and/or epic link).
 * Used by the fetch script to discover keys to chase.
 */
export function getReferencedKeys(parsed: ParsedJiraIssue): string[] {
  const keys: string[] = [];
  if (parsed.parentKey) keys.push(parsed.parentKey);
  if (parsed.epicLinkKey) keys.push(parsed.epicLinkKey);
  return keys;
}

#!/usr/bin/env npx tsx
/**
 * Export denormalized commit data as CSV for analysis in Datasette, DuckDB, or Sheets.
 *
 * Reads already-computed project_id and is_canonical from the database —
 * no resolution logic is duplicated here.
 *
 * Usage:
 *   pnpm export-csv                    # all canonical commits
 *   pnpm export-csv --all              # include non-canonical (cherry-pick dupes)
 *   pnpm export-csv --out data.csv     # custom output path (default: exports/commits.csv)
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { query } from '@/lib/db';
import * as fs from 'fs';
import * as path from 'path';

interface CommitExportRow {
  id: number;
  sha: string;
  author_name: string;
  author_email: string;
  committed_at: string;
  message: string;
  repository_id: number;
  project_id: number | null;
  project_name: string | null;
  is_canonical: number;
}

interface TicketJoin {
  commit_id: number;
  jira_ticket_id: string;
}

interface BranchJoin {
  commit_id: number;
  branch_name: string;
}

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

async function main(): Promise<void> {
  const includeAll = process.argv.includes('--all');
  const outIdx = process.argv.indexOf('--out');
  const outDir = path.join(process.cwd(), 'exports');
  const outPath = outIdx !== -1 && process.argv[outIdx + 1]
    ? process.argv[outIdx + 1]
    : path.join(outDir, 'commits.csv');

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const canonicalFilter = includeAll ? '' : 'AND c.is_canonical = 1';

  console.log(`Querying commits${includeAll ? ' (all)' : ' (canonical only)'}...`);

  const commits = await query<CommitExportRow>(
    `SELECT c.id, c.sha, c.author_name, c.author_email, c.committed_at,
            c.message, c.repository_id, c.project_id,
            p.name AS project_name, c.is_canonical
     FROM commits c
     LEFT JOIN projects p ON c.project_id = p.id
     WHERE 1=1 ${canonicalFilter}
     ORDER BY c.committed_at, c.id`,
  );

  console.log(`  Commits: ${commits.length}`);

  // Load ticket associations
  const tickets = await query<TicketJoin>(
    'SELECT commit_id, jira_ticket_id FROM commit_jira_tickets',
  );
  const ticketMap = new Map<number, string[]>();
  for (const t of tickets) {
    const list = ticketMap.get(t.commit_id) ?? [];
    list.push(t.jira_ticket_id);
    ticketMap.set(t.commit_id, list);
  }

  // Load branch associations
  const branches = await query<BranchJoin>(
    'SELECT commit_id, branch_name FROM commit_branches',
  );
  const branchMap = new Map<number, string[]>();
  for (const b of branches) {
    const list = branchMap.get(b.commit_id) ?? [];
    list.push(b.branch_name);
    branchMap.set(b.commit_id, list);
  }

  // Build CSV
  const header = [
    'id', 'sha', 'author_name', 'author_email', 'committed_at', 'month',
    'project_id', 'project_name', 'is_canonical',
    'first_line', 'tickets', 'branch_count', 'branches',
  ].join(',');

  const lines: string[] = [header];

  for (const c of commits) {
    const firstLine = c.message.split('\n')[0];
    const month = c.committed_at.slice(0, 7); // YYYY-MM
    const commitTickets = ticketMap.get(c.id) ?? [];
    const commitBranches = branchMap.get(c.id) ?? [];

    lines.push([
      c.id,
      c.sha,
      escapeCSV(c.author_name),
      escapeCSV(c.author_email),
      c.committed_at,
      month,
      c.project_id ?? '',
      escapeCSV(c.project_name ?? 'Unallocated'),
      c.is_canonical,
      escapeCSV(firstLine),
      escapeCSV(commitTickets.join(';')),
      commitBranches.length,
      escapeCSV(commitBranches.join(';')),
    ].join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\nExported ${commits.length} commits to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

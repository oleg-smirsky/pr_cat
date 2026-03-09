#!/usr/bin/env npx tsx
/**
 * Generate an interactive HTML report of team cost allocation.
 *
 * Hierarchy: Month → Project (team %) → Person (FTE) → Commits
 *
 * Reads already-computed project_id and is_canonical from the database.
 *
 * Usage:
 *   pnpm export-report                                    # all months, all people
 *   pnpm export-report --team Buddy                       # team from mappings.json
 *   pnpm export-report --team Buddy --config path.json    # custom config path
 *   pnpm export-report --month 2026-02                    # single month
 *   pnpm export-report --from 2025-10 --to 2026-02
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { query } from '@/lib/db';
import * as fs from 'fs';
import * as path from 'path';

interface CommitRow {
  id: number;
  sha: string;
  author_name: string;
  author_email: string;
  committed_at: string;
  message: string;
  project_id: number | null;
  project_name: string | null;
}

interface TicketRow {
  commit_id: number;
  jira_ticket_id: string;
}

interface TeamMember {
  name: string;
  emails: string[];
  capacity: number;
}

interface TeamConfig {
  members: TeamMember[];
}

function loadTeamConfig(configPath: string, teamName: string): TeamConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const teams = raw.teams ?? {};
  const team = teams[teamName];
  if (!team) {
    const available = Object.keys(teams).join(', ') || '(none)';
    throw new Error(`Team "${teamName}" not found in config. Available: ${available}`);
  }
  return team;
}

function getTeamEmails(team: TeamConfig): Set<string> {
  const emails = new Set<string>();
  for (const member of team.members) {
    for (const e of member.emails) emails.add(e);
  }
  return emails;
}

function getCapacityByEmail(team: TeamConfig): Map<string, number> {
  const map = new Map<string, number>();
  for (const member of team.members) {
    for (const e of member.emails) map.set(e, member.capacity);
  }
  return map;
}

// ── Data loading (no resolution logic — reads computed values) ──────────

async function loadCanonicalCommits(
  monthFrom?: string,
  monthTo?: string,
  teamEmails?: Set<string>,
): Promise<CommitRow[]> {
  let where = 'c.is_canonical = 1';
  const params: (string | number)[] = [];

  if (monthFrom) {
    where += ' AND c.committed_at >= ?';
    params.push(`${monthFrom}-01`);
  }
  if (monthTo) {
    where += ' AND c.committed_at < ?';
    const [y, m] = monthTo.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    params.push(`${ny}-${String(nm).padStart(2, '0')}-01`);
  }
  if (teamEmails) {
    const placeholders = Array.from(teamEmails).map(() => '?').join(',');
    where += ` AND c.author_email IN (${placeholders})`;
    params.push(...teamEmails);
  }

  return query<CommitRow>(
    `SELECT c.id, c.sha, c.author_name, c.author_email, c.committed_at,
            c.message, c.project_id, p.name AS project_name
     FROM commits c
     LEFT JOIN projects p ON c.project_id = p.id
     WHERE ${where}
     ORDER BY c.committed_at DESC`,
    params,
  );
}

async function loadTickets(): Promise<Map<number, string[]>> {
  const rows = await query<TicketRow>('SELECT commit_id, jira_ticket_id FROM commit_jira_tickets');
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const list = map.get(r.commit_id) ?? [];
    list.push(r.jira_ticket_id);
    map.set(r.commit_id, list);
  }
  return map;
}

// ── Data structuring ────────────────────────────────────────────────────

interface CommitDisplay {
  sha: string;
  firstLine: string;
  date: string;
  tickets: string[];
}

interface PersonInProject {
  name: string;
  email: string;
  commits: CommitDisplay[];
  fte: number; // capacity-weighted fraction of this person's month on this project
  capacity: number; // 1.0 = full-time, 0.4 = part-time
}

interface ProjectInMonth {
  name: string;
  totalCommits: number;
  people: PersonInProject[];
  teamFte: number; // sum of FTE contributions
  teamPct: number; // percentage of total team FTEs
}

interface MonthData {
  month: string;
  totalFtes: number;
  projects: ProjectInMonth[];
}

function buildReport(commits: CommitRow[], ticketMap: Map<number, string[]>, capacityMap?: Map<string, number>): MonthData[] {
  // Group: month → author → project → commits
  const tree = new Map<string, Map<string, Map<string, CommitDisplay[]>>>();

  for (const c of commits) {
    const month = c.committed_at.slice(0, 7);
    const authorKey = c.author_email;
    const projectName = c.project_name ?? 'Unallocated';

    if (!tree.has(month)) tree.set(month, new Map());
    const monthMap = tree.get(month)!;
    if (!monthMap.has(authorKey)) monthMap.set(authorKey, new Map());
    const authorMap = monthMap.get(authorKey)!;
    if (!authorMap.has(projectName)) authorMap.set(projectName, []);
    authorMap.get(projectName)!.push({
      sha: c.sha.slice(0, 10),
      firstLine: c.message.split('\n')[0],
      date: c.committed_at.slice(0, 10),
      tickets: ticketMap.get(c.id) ?? [],
    });
  }

  // Build author name lookup (email → most recent name)
  const nameByEmail = new Map<string, string>();
  for (const c of commits) {
    nameByEmail.set(c.author_email, c.author_name);
  }

  const months: MonthData[] = [];

  for (const [month, authors] of [...tree.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    // For each author, compute total commits that month → FTE fraction per project
    const authorTotals = new Map<string, number>();
    for (const [email, projects] of authors) {
      let total = 0;
      for (const commits of projects.values()) total += commits.length;
      authorTotals.set(email, total);
    }

    // Build project-first structure
    const projectMap = new Map<string, PersonInProject[]>();

    for (const [email, projects] of authors) {
      const authorTotal = authorTotals.get(email)!;
      const capacity = capacityMap?.get(email) ?? 1.0;
      for (const [projectName, projectCommits] of projects) {
        if (!projectMap.has(projectName)) projectMap.set(projectName, []);
        projectMap.get(projectName)!.push({
          name: nameByEmail.get(email) ?? email,
          email,
          commits: projectCommits,
          fte: capacity * (projectCommits.length / authorTotal), // capacity-weighted fraction
          capacity,
        });
      }
    }

    // Total FTEs = sum of capacities of active authors this month
    let totalFtes = 0;
    for (const email of authors.keys()) {
      totalFtes += capacityMap?.get(email) ?? 1.0;
    }
    const projects: ProjectInMonth[] = [];

    for (const [name, people] of projectMap) {
      const teamFte = people.reduce((s, p) => s + p.fte, 0);
      people.sort((a, b) => b.fte - a.fte);
      projects.push({
        name,
        totalCommits: people.reduce((s, p) => s + p.commits.length, 0),
        people,
        teamFte,
        teamPct: totalFtes > 0 ? Math.round((teamFte / totalFtes) * 1000) / 10 : 0,
      });
    }

    projects.sort((a, b) => b.teamFte - a.teamFte);
    months.push({ month, totalFtes, projects });
  }

  return months;
}

// ── HTML generation ─────────────────────────────────────────────────────

function generateHTML(months: MonthData[]): string {
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function commitHTML(c: CommitDisplay): string {
    const tickets = c.tickets.length > 0
      ? ` <span class="ticket">${c.tickets.map(esc).join(', ')}</span>`
      : '';
    return `<div class="commit"><span class="sha">${esc(c.sha)}</span> <span class="date">${c.date}</span> ${esc(c.firstLine)}${tickets}</div>`;
  }

  function personHTML(p: PersonInProject, projectName: string, month: string): string {
    const id = `${month}-${projectName}-${p.email}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const ftePct = Math.round((p.fte / p.capacity) * 100); // % of this person's time on this project
    const capacityBadge = p.capacity < 1.0 ? ` <span class="badge parttime">${p.capacity} cap</span>` : '';
    return `
      <div class="person">
        <div class="row" onclick="toggle('${id}')">
          <span class="arrow" id="arrow-${id}">▸</span>
          <span class="person-name">${esc(p.name)}</span>${capacityBadge}
          <span class="badge fte">${p.fte.toFixed(2)} FTE</span>
          <span class="badge">${ftePct}%</span>
          <span class="badge subtle">${p.commits.length} commits</span>
        </div>
        <div class="children" id="${id}" style="display:none">
          ${p.commits.map(commitHTML).join('\n')}
        </div>
      </div>`;
  }

  function projectHTML(proj: ProjectInMonth, month: string): string {
    const id = `${month}-${proj.name}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const colorClass = proj.name === 'Unallocated' ? 'unallocated' : '';
    return `
      <div class="project ${colorClass}">
        <div class="row" onclick="toggle('${id}')">
          <span class="arrow" id="arrow-${id}">▸</span>
          <span class="project-name">${esc(proj.name)}</span>
          <span class="badge accent">${proj.teamPct}%</span>
          <span class="badge fte">${proj.teamFte.toFixed(1)} FTE</span>
          <span class="badge subtle">${proj.totalCommits} commits</span>
          <span class="badge subtle">${proj.people.length} people</span>
        </div>
        <div class="children" id="${id}" style="display:none">
          ${proj.people.map(p => personHTML(p, proj.name, month)).join('\n')}
        </div>
      </div>`;
  }

  function monthHTML(m: MonthData): string {
    const id = `month-${m.month}`;
    return `
      <div class="month">
        <div class="row month-header" onclick="toggle('${id}')">
          <span class="arrow" id="arrow-${id}">▸</span>
          <span class="month-label">${m.month}</span>
          <span class="badge fte">${m.totalFtes.toFixed(1)} FTE</span>
          <span class="badge subtle">${m.projects.reduce((s, p) => s + p.totalCommits, 0)} commits</span>
        </div>
        <div class="children" id="${id}" style="display:none">
          ${m.projects.map(p => projectHTML(p, m.month)).join('\n')}
        </div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Team Cost Allocation Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #f0f6fc; }
  .controls { margin-bottom: 16px; display: flex; gap: 8px; }
  .controls button { background: #21262d; border: 1px solid #30363d; color: #e6edf3; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .controls button:hover { background: #30363d; }
  .row { padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 8px; }
  .row:hover { background: #161b22; }
  .arrow { font-size: 12px; color: #8b949e; width: 14px; display: inline-block; user-select: none; }
  .children { padding-left: 20px; }
  .month-header { padding: 10px 8px; }
  .month-label { font-size: 16px; font-weight: 600; color: #f0f6fc; }
  .project-name { font-weight: 600; color: #79c0ff; min-width: 160px; }
  .person-name { color: #e6edf3; min-width: 160px; }
  .badge { background: #21262d; border: 1px solid #30363d; padding: 1px 8px; border-radius: 10px; font-size: 12px; color: #8b949e; white-space: nowrap; }
  .badge.accent { background: #1f3a2e; border-color: #2d5a3f; color: #56d364; }
  .badge.fte { background: #1c2a4a; border-color: #264a7a; color: #79c0ff; }
  .badge.parttime { background: #2a1f1a; border-color: #5a3f2a; color: #f0a050; }
  .badge.subtle { border-color: transparent; background: transparent; }
  .unallocated .project-name { color: #f85149; }
  .commit { padding: 3px 8px; font-size: 13px; color: #8b949e; font-family: 'SF Mono', Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .commit .sha { color: #58a6ff; }
  .commit .date { color: #484f58; margin-right: 4px; }
  .commit .ticket { background: #2d1f3a; color: #d2a8ff; padding: 0 4px; border-radius: 3px; font-size: 11px; }
  .month { border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .project { border-top: 1px solid #161b22; }
  .person { border-top: 1px solid #0d1117; }
</style>
</head>
<body>
<h1>Team Cost Allocation Report</h1>
<div class="controls">
  <button onclick="expandAll(1)">Expand months</button>
  <button onclick="expandAll(2)">Expand projects</button>
  <button onclick="expandAll(3)">Expand people</button>
  <button onclick="collapseAll()">Collapse all</button>
</div>
<div id="report">
${months.map(monthHTML).join('\n')}
</div>
<script>
function toggle(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById('arrow-' + id);
  if (!el) return;
  const show = el.style.display === 'none';
  el.style.display = show ? 'block' : 'none';
  if (arrow) arrow.textContent = show ? '▾' : '▸';
}

function expandAll(depth) {
  const months = document.querySelectorAll('.month > .children');
  const projects = document.querySelectorAll('.project > .children');
  const people = document.querySelectorAll('.person > .children');

  if (depth >= 1) months.forEach(el => { el.style.display = 'block'; el.previousElementSibling.querySelector('.arrow').textContent = '▾'; });
  if (depth >= 2) projects.forEach(el => { el.style.display = 'block'; el.previousElementSibling.querySelector('.arrow').textContent = '▾'; });
  if (depth >= 3) people.forEach(el => { el.style.display = 'block'; el.previousElementSibling.querySelector('.arrow').textContent = '▾'; });
}

function collapseAll() {
  document.querySelectorAll('.children').forEach(el => {
    el.style.display = 'none';
    const arrow = el.previousElementSibling?.querySelector('.arrow');
    if (arrow) arrow.textContent = '▸';
  });
}
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const monthIdx = process.argv.indexOf('--month');
  const fromIdx = process.argv.indexOf('--from');
  const toIdx = process.argv.indexOf('--to');

  const teamIdx = process.argv.indexOf('--team');
  const configIdx = process.argv.indexOf('--config');

  let monthFrom: string | undefined;
  let monthTo: string | undefined;

  if (monthIdx !== -1 && process.argv[monthIdx + 1]) {
    monthFrom = monthTo = process.argv[monthIdx + 1];
  }
  if (fromIdx !== -1 && process.argv[fromIdx + 1]) monthFrom = process.argv[fromIdx + 1];
  if (toIdx !== -1 && process.argv[toIdx + 1]) monthTo = process.argv[toIdx + 1];

  let teamEmails: Set<string> | undefined;
  let capacityMap: Map<string, number> | undefined;
  let teamLabel = '';

  if (teamIdx !== -1) {
    const teamName = process.argv[teamIdx + 1] ?? 'Buddy';
    const configPath = configIdx !== -1 && process.argv[configIdx + 1]
      ? process.argv[configIdx + 1]
      : path.join(process.cwd(), '..', 'pr_cat_prusa', 'mappings.json');
    console.log(`Loading team "${teamName}" from ${configPath}`);
    const team = loadTeamConfig(configPath, teamName);
    teamEmails = getTeamEmails(team);
    capacityMap = getCapacityByEmail(team);
    teamLabel = ` (${teamName} team, ${team.members.length} members)`;
  }
  console.log(`Loading commits${monthFrom ? ` from ${monthFrom}` : ''}${monthTo ? ` to ${monthTo}` : ''}${teamLabel}...`);

  const [commits, ticketMap] = await Promise.all([
    loadCanonicalCommits(monthFrom, monthTo, teamEmails),
    loadTickets(),
  ]);

  console.log(`  Canonical commits: ${commits.length}`);

  const report = buildReport(commits, ticketMap, capacityMap);

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'allocation-report.html');
  fs.writeFileSync(outPath, generateHTML(report), 'utf-8');

  console.log(`\nReport: ${outPath}`);
  console.log(`  Months: ${report.length}`);
  console.log(`  Open in browser: file://${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

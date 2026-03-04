-- Projects table — business-level grouping (e.g. "Core One")
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Commits table — one row per unique (sha, repository_id) pair
CREATE TABLE IF NOT EXISTS commits (
  id              INTEGER PRIMARY KEY,
  sha             TEXT NOT NULL,
  repository_id   INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  author_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_email    TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  message         TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  additions       INTEGER DEFAULT 0,
  deletions       INTEGER DEFAULT 0,
  pull_request_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  jira_ticket_id  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sha, repository_id)
);

-- Many-to-many: a commit can appear on multiple branches
CREATE TABLE IF NOT EXISTS commit_branches (
  commit_id   INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  UNIQUE(commit_id, branch_name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_commits_repository_id ON commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_commits_author_id ON commits(author_id);
CREATE INDEX IF NOT EXISTS idx_commits_committed_at ON commits(committed_at);
CREATE INDEX IF NOT EXISTS idx_commits_project_id ON commits(project_id);
CREATE INDEX IF NOT EXISTS idx_commits_jira_ticket_id ON commits(jira_ticket_id);
CREATE INDEX IF NOT EXISTS idx_commit_branches_commit_id ON commit_branches(commit_id);

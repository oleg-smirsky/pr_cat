-- Enable Foreign Key constraints
PRAGMA foreign_keys = ON;

-- Schema version tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT,
  name TEXT,
  email TEXT UNIQUE,
  image TEXT,
  profile_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Organizations table (GitHub organizations)
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  github_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  installation_id INTEGER NULL,
  production_access BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User-Organization relationship (many-to-many)
CREATE TABLE IF NOT EXISTS user_organizations (
  user_id TEXT NOT NULL,
  organization_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- 'member', 'admin', 'owner'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, organization_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY,
  github_id INTEGER UNIQUE,
  organization_id INTEGER,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  private BOOLEAN NOT NULL DEFAULT 0,
  is_tracked BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Categories for PR classification
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  is_default BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Pull Requests table
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  author_id TEXT,
  state TEXT NOT NULL, -- 'open', 'closed', 'merged'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  merged_at TEXT,
  draft BOOLEAN NOT NULL DEFAULT 0,
  additions INTEGER,
  deletions INTEGER,
  changed_files INTEGER,
  category_id INTEGER,
  category_confidence REAL,
  embedding_id INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  UNIQUE (repository_id, number)
);

-- PR Reviews table
CREATE TABLE IF NOT EXISTS pr_reviews (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL,
  pull_request_id INTEGER NOT NULL,
  reviewer_id TEXT,
  state TEXT NOT NULL, -- 'approved', 'changes_requested', 'commented', 'dismissed'
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Settings table for user/org preferences
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  organization_id INTEGER,
  key TEXT NOT NULL,
  value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, organization_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CHECK ((user_id IS NULL) != (organization_id IS NULL)) -- Exactly one of user_id or organization_id must be NULL
);

-- Recommendations table
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  recommendation_type TEXT NOT NULL, -- 'process', 'technical', 'workflow', etc.
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'accepted', 'rejected', 'implemented'
  priority INTEGER NOT NULL DEFAULT 1, -- 1-5
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Table for vector embeddings (when enabled)
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL, -- 'pull_request', 'category', etc.
  source_id INTEGER NOT NULL,
  vector BLOB, -- Will store the vector embedding
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_id)
);

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

-- Indexes for commits and commit_branches
CREATE INDEX IF NOT EXISTS idx_commits_repository_id ON commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_commits_author_id ON commits(author_id);
CREATE INDEX IF NOT EXISTS idx_commits_committed_at ON commits(committed_at);
CREATE INDEX IF NOT EXISTS idx_commits_project_id ON commits(project_id);
CREATE INDEX IF NOT EXISTS idx_commits_jira_ticket_id ON commits(jira_ticket_id);
CREATE INDEX IF NOT EXISTS idx_commit_branches_commit_id ON commit_branches(commit_id);

-- Create initial schema version
INSERT INTO schema_migrations (version) VALUES (1); 
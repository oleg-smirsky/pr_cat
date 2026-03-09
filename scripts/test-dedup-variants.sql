-- Dedup Algorithm Variants — tested against real commit data
-- Run: sqlite3 -header -column local.db < scripts/test-dedup-variants.sql

-- ============================================================
-- VARIANT 1: Message only (original plan)
-- Group by SUBSTR(message, 1, 200), earliest commit wins
-- ============================================================
-- Risk: collisions on generic messages like "WIP", "fix"

-- ============================================================
-- VARIANT 2: Author + Message
-- Group by (author_email, SUBSTR(message, 1, 200))
-- ============================================================
-- Avoids cross-author collisions but still groups "WIP" by same author

-- ============================================================
-- VARIANT 3: Author + Message + Min Length
-- Like V2 but messages < 10 chars are never grouped (always canonical)
-- ============================================================
-- Protects against "WIP", "fix", "wip" etc.

-- ============================================================
-- VARIANT 4: Author + Message + Min Length + 30-day window
-- Like V3 but copies must be within 30 days of the earliest
-- ============================================================
-- Protects against same author reusing a message months later

--------------------------------------------------------------
-- 1. OVERVIEW: how many commits does each variant deduplicate?
--------------------------------------------------------------

.print ""
.print "=== OVERVIEW: Total commits vs canonical per variant ==="
.print ""

SELECT
  (SELECT COUNT(*) FROM commits) as total_commits,

  -- V1: message only
  (SELECT COUNT(DISTINCT SUBSTR(message, 1, 200)) FROM commits) as v1_canonical,

  -- V2: author + message
  (SELECT COUNT(*) FROM (
    SELECT DISTINCT author_email, SUBSTR(message, 1, 200) FROM commits
  )) as v2_canonical,

  -- V3: author + message + min length (short msgs each count as 1)
  (SELECT
    (SELECT COUNT(*) FROM (
      SELECT DISTINCT author_email, SUBSTR(message, 1, 200)
      FROM commits WHERE LENGTH(TRIM(message)) >= 10
    )) +
    (SELECT COUNT(*) FROM commits WHERE LENGTH(TRIM(message)) < 10)
  ) as v3_canonical,

  -- V4: author + message + min length + 30-day window
  -- (computed below separately since it needs a window join)
  'see below' as v4_canonical;

--------------------------------------------------------------
-- 2. V4 canonical count (needs self-join for time window)
--------------------------------------------------------------

.print ""
.print "=== V4: Author + Message + MinLen + 30-day window ==="

WITH groupable AS (
  SELECT id, author_email, SUBSTR(message, 1, 200) as msg_key,
    committed_at,
    LENGTH(TRIM(message)) as msg_len
  FROM commits
),
-- For groupable commits (len >= 10), find the earliest in each author+message group
earliest AS (
  SELECT author_email, msg_key, MIN(committed_at) as first_at
  FROM groupable
  WHERE msg_len >= 10
  GROUP BY author_email, msg_key
),
v4_canonical AS (
  SELECT g.id,
    CASE
      -- Short messages: always canonical
      WHEN g.msg_len < 10 THEN 1
      -- First occurrence: canonical
      WHEN g.committed_at = e.first_at THEN 1
      -- Within 30 days of first: duplicate
      WHEN julianday(g.committed_at) - julianday(e.first_at) <= 30 THEN 0
      -- Beyond 30 days: treat as new work, canonical
      ELSE 1
    END as is_canonical
  FROM groupable g
  LEFT JOIN earliest e ON g.author_email = e.author_email AND g.msg_key = e.msg_key
)
SELECT
  COUNT(*) as total,
  SUM(is_canonical) as canonical,
  COUNT(*) - SUM(is_canonical) as duplicates,
  ROUND(100.0 * (COUNT(*) - SUM(is_canonical)) / COUNT(*), 1) as dup_pct
FROM v4_canonical;

--------------------------------------------------------------
-- 3. DISAGREEMENTS: where do variants differ?
--------------------------------------------------------------

.print ""
.print "=== Cases where V1 and V2 disagree (cross-author collision) ==="
.print ""

-- Messages that V1 groups together but V2 keeps separate (different authors, same message)
SELECT SUBSTR(c.message, 1, 60) as msg,
  COUNT(DISTINCT c.author_email) as num_authors,
  COUNT(*) as total_copies,
  GROUP_CONCAT(DISTINCT c.author_name) as authors
FROM commits c
GROUP BY SUBSTR(c.message, 1, 200)
HAVING num_authors > 1 AND total_copies > 1
ORDER BY total_copies DESC
LIMIT 20;

.print ""
.print "=== Cases where V2 and V3 disagree (short messages grouped by V2) ==="
.print ""

-- Short messages that V2 would group but V3 treats as individual
SELECT SUBSTR(c.message, 1, 60) as msg,
  LENGTH(TRIM(c.message)) as msg_len,
  c.author_name,
  COUNT(*) as copies
FROM commits c
WHERE LENGTH(TRIM(c.message)) < 10
GROUP BY c.author_email, SUBSTR(c.message, 1, 200)
HAVING copies > 1
ORDER BY copies DESC;

.print ""
.print "=== Cases where V3 and V4 disagree (same msg reused > 30 days apart) ==="
.print ""

-- Groups where the time span exceeds 30 days
WITH groupable AS (
  SELECT author_email, author_name, SUBSTR(message, 1, 200) as msg_key,
    SUBSTR(message, 1, 60) as msg_short,
    MIN(committed_at) as earliest,
    MAX(committed_at) as latest,
    COUNT(*) as copies
  FROM commits
  WHERE LENGTH(TRIM(message)) >= 10
  GROUP BY author_email, SUBSTR(message, 1, 200)
  HAVING copies > 1
)
SELECT msg_short, author_name, copies, earliest, latest,
  CAST(julianday(latest) - julianday(earliest) AS INTEGER) as span_days
FROM groupable
WHERE julianday(latest) - julianday(earliest) > 30
ORDER BY span_days DESC;

--------------------------------------------------------------
-- 4. PROJECT ALLOCATION: Feb 2026 FTEs per variant
--------------------------------------------------------------

.print ""
.print "=== Feb 2026 FTE allocation — V1 (message only) ==="
.print ""

WITH v1_canonical AS (
  SELECT MIN(id) as id
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
  GROUP BY SUBSTR(message, 1, 200)
),
person_totals AS (
  SELECT c.author_email, COUNT(*) as total
  FROM commits c JOIN v1_canonical v ON c.id = v.id
  GROUP BY c.author_email
),
person_project AS (
  SELECT c.author_email, c.project_id, COUNT(*) as cnt
  FROM commits c JOIN v1_canonical v ON c.id = v.id
  GROUP BY c.author_email, c.project_id
)
SELECT p.name as project,
  ROUND(SUM(CAST(pp.cnt AS REAL) / pt.total), 2) as FTEs,
  SUM(pp.cnt) as commits
FROM person_project pp
JOIN person_totals pt ON pp.author_email = pt.author_email
LEFT JOIN projects p ON pp.project_id = p.id
GROUP BY p.name
ORDER BY FTEs DESC;

.print ""
.print "=== Feb 2026 FTE allocation — V2 (author + message) ==="
.print ""

WITH v2_canonical AS (
  SELECT MIN(id) as id
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
  GROUP BY author_email, SUBSTR(message, 1, 200)
),
person_totals AS (
  SELECT c.author_email, COUNT(*) as total
  FROM commits c JOIN v2_canonical v ON c.id = v.id
  GROUP BY c.author_email
),
person_project AS (
  SELECT c.author_email, c.project_id, COUNT(*) as cnt
  FROM commits c JOIN v2_canonical v ON c.id = v.id
  GROUP BY c.author_email, c.project_id
)
SELECT p.name as project,
  ROUND(SUM(CAST(pp.cnt AS REAL) / pt.total), 2) as FTEs,
  SUM(pp.cnt) as commits
FROM person_project pp
JOIN person_totals pt ON pp.author_email = pt.author_email
LEFT JOIN projects p ON pp.project_id = p.id
GROUP BY p.name
ORDER BY FTEs DESC;

.print ""
.print "=== Feb 2026 FTE allocation — V3 (author + message + min length) ==="
.print ""

WITH v3_canonical AS (
  -- Long messages: deduplicate by author + message
  SELECT MIN(id) as id
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
    AND LENGTH(TRIM(message)) >= 10
  GROUP BY author_email, SUBSTR(message, 1, 200)
  UNION ALL
  -- Short messages: always canonical
  SELECT id
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
    AND LENGTH(TRIM(message)) < 10
),
person_totals AS (
  SELECT c.author_email, COUNT(*) as total
  FROM commits c JOIN v3_canonical v ON c.id = v.id
  GROUP BY c.author_email
),
person_project AS (
  SELECT c.author_email, c.project_id, COUNT(*) as cnt
  FROM commits c JOIN v3_canonical v ON c.id = v.id
  GROUP BY c.author_email, c.project_id
)
SELECT p.name as project,
  ROUND(SUM(CAST(pp.cnt AS REAL) / pt.total), 2) as FTEs,
  SUM(pp.cnt) as commits
FROM person_project pp
JOIN person_totals pt ON pp.author_email = pt.author_email
LEFT JOIN projects p ON pp.project_id = p.id
GROUP BY p.name
ORDER BY FTEs DESC;

.print ""
.print "=== Feb 2026 FTE allocation — V4 (author + message + min length + 30d window) ==="
.print ""

WITH groupable AS (
  SELECT id, author_email, SUBSTR(message, 1, 200) as msg_key,
    committed_at, LENGTH(TRIM(message)) as msg_len
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
),
earliest AS (
  SELECT author_email, msg_key, MIN(committed_at) as first_at
  FROM groupable WHERE msg_len >= 10
  GROUP BY author_email, msg_key
),
v4_ids AS (
  SELECT g.id FROM groupable g
  LEFT JOIN earliest e ON g.author_email = e.author_email AND g.msg_key = e.msg_key
  WHERE
    g.msg_len < 10  -- short: always keep
    OR g.committed_at = e.first_at  -- first occurrence
    OR julianday(g.committed_at) - julianday(e.first_at) > 30  -- beyond window: new work
),
person_totals AS (
  SELECT c.author_email, COUNT(*) as total
  FROM commits c JOIN v4_ids v ON c.id = v.id
  GROUP BY c.author_email
),
person_project AS (
  SELECT c.author_email, c.project_id, COUNT(*) as cnt
  FROM commits c JOIN v4_ids v ON c.id = v.id
  GROUP BY c.author_email, c.project_id
)
SELECT p.name as project,
  ROUND(SUM(CAST(pp.cnt AS REAL) / pt.total), 2) as FTEs,
  SUM(pp.cnt) as commits
FROM person_project pp
JOIN person_totals pt ON pp.author_email = pt.author_email
LEFT JOIN projects p ON pp.project_id = p.id
GROUP BY p.name
ORDER BY FTEs DESC;

--------------------------------------------------------------
-- 5. SPOT CHECK: Oleg's Feb 2026 allocation per variant
--------------------------------------------------------------

.print ""
.print "=== Oleg Feb 2026 — No dedup (current) ==="
.print ""

WITH person_totals AS (
  SELECT COUNT(*) as total FROM commits
  WHERE author_email LIKE '%oleg%'
    AND committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
)
SELECT p.name as project, COUNT(*) as commits,
  ROUND(CAST(COUNT(*) AS REAL) / pt.total, 2) as FTE
FROM commits c, person_totals pt
LEFT JOIN projects p ON c.project_id = p.id
WHERE c.author_email LIKE '%oleg%'
  AND c.committed_at >= '2026-02-01' AND c.committed_at < '2026-03-01'
GROUP BY p.name ORDER BY FTE DESC;

.print ""
.print "=== Oleg Feb 2026 — V3 (author + message + min length) ==="
.print ""

WITH v3_canonical AS (
  SELECT MIN(id) as id
  FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
    AND LENGTH(TRIM(message)) >= 10
    AND author_email LIKE '%oleg%'
  GROUP BY author_email, SUBSTR(message, 1, 200)
  UNION ALL
  SELECT id FROM commits
  WHERE committed_at >= '2026-02-01' AND committed_at < '2026-03-01'
    AND LENGTH(TRIM(message)) < 10
    AND author_email LIKE '%oleg%'
),
person_totals AS (
  SELECT COUNT(*) as total FROM v3_canonical
)
SELECT p.name as project, COUNT(*) as commits,
  ROUND(CAST(COUNT(*) AS REAL) / pt.total, 2) as FTE
FROM commits c
JOIN v3_canonical v ON c.id = v.id, person_totals pt
LEFT JOIN projects p ON c.project_id = p.id
GROUP BY p.name ORDER BY FTE DESC;

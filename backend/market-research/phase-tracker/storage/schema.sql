-- Phase-tracker SQLite schema
-- All times stored as ISO-8601 strings (UTC)

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  industry      TEXT NOT NULL,
  country       TEXT NOT NULL,
  client_context TEXT,              -- JSON blob
  target_stage  TEXT,               -- stage to stop at (run-through-and-stop)
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','completed','failed','cancelled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  error         TEXT                -- JSON blob if failed
);

CREATE TABLE IF NOT EXISTS stage_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  stage         TEXT NOT NULL,      -- e.g. '2', '2a', '3', '4a'
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','completed','failed','skipped')),
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  duration_ms   INTEGER,
  error         TEXT,               -- JSON blob if failed
  UNIQUE(run_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  stage         TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  filename      TEXT NOT NULL,      -- e.g. 'output.json', 'error.json'
  path          TEXT NOT NULL,      -- relative path from project root
  size_bytes    INTEGER,
  content_type  TEXT NOT NULL DEFAULT 'application/json',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(run_id, stage, attempt, filename)
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  stage         TEXT,
  attempt       INTEGER,
  type          TEXT NOT NULL,      -- 'info','warn','error','metric','gate'
  message       TEXT NOT NULL,
  data          TEXT,               -- JSON blob
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS run_locks (
  run_id        TEXT PRIMARY KEY REFERENCES runs(id),
  holder        TEXT NOT NULL,      -- identifier of lock holder
  acquired_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL       -- auto-expire stale locks
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_stage_attempts_run   ON stage_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_attempts_stage ON stage_attempts(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_artifacts_run        ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt    ON artifacts(run_id, stage, attempt);
CREATE INDEX IF NOT EXISTS idx_events_run           ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_stage         ON events(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_runs_status          ON runs(status);

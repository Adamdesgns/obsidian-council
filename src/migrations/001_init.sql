PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT,
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chambers (
  id TEXT PRIMARY KEY,
  title TEXT,
  created TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS sessions (
  member TEXT NOT NULL,
  chamber_id TEXT NOT NULL,
  provider_session_id TEXT,
  lease_gen INTEGER NOT NULL DEFAULT 0,
  resume_kind TEXT,
  updated TEXT NOT NULL,
  PRIMARY KEY (member, chamber_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chamber_id TEXT,
  sender TEXT NOT NULL,
  recipients TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id TEXT,
  content TEXT,
  idempotency_key TEXT UNIQUE,
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_gen INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  updated TEXT NOT NULL,
  UNIQUE(message_id, recipient)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER,
  producer TEXT,
  run_id TEXT,
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  member TEXT NOT NULL,
  chamber_id TEXT,
  message_id TEXT,
  argv TEXT,
  started TEXT NOT NULL,
  ended TEXT,
  exit INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_reported REAL,
  checkpoint TEXT
);

CREATE TABLE IF NOT EXISTS sanctions (
  id TEXT PRIMARY KEY,
  directive_id TEXT,
  content_hash TEXT NOT NULL,
  scopes TEXT,
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT,
  used_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  ref_table TEXT,
  ref_id TEXT,
  payload TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status ON deliveries(recipient, status, lease_until);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_runs_member_started ON runs(member, started);
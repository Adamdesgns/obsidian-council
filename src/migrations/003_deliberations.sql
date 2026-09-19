CREATE TABLE deliberations (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  chamber_id TEXT NOT NULL UNIQUE,
  source_chamber_id TEXT,
  question TEXT NOT NULL,
  deliberators TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '{}',
  candidate TEXT,
  candidate_hash TEXT,
  final_answer TEXT,
  flag TEXT,
  stall_detail TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE deliberation_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  deliberation_id TEXT NOT NULL REFERENCES deliberations(id),
  phase TEXT NOT NULL,
  round INTEGER NOT NULL,
  member TEXT NOT NULL,
  response TEXT,
  UNIQUE(deliberation_id, phase, round, member)
);
CREATE INDEX idx_deliberation_message_owner ON deliberation_messages(deliberation_id);

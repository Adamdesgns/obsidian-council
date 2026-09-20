-- 003_deliberations.sql — one row per owner question under deliberation.
-- state is the phase; round is the debate round (0 until debate begins).
-- deliberators and answers are JSON strings written with an explicit JSON.stringify.

CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  chamber_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  flag TEXT,
  deliberators TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  final_answer TEXT,
  content_hash TEXT,
  stall_detail TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delib_state ON deliberations(state);
CREATE INDEX IF NOT EXISTS idx_delib_chamber ON deliberations(chamber_id);

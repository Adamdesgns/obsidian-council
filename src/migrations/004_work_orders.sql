CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  chamber_id TEXT NOT NULL UNIQUE,
  source_chamber_id TEXT,
  objective TEXT NOT NULL,
  workspace TEXT NOT NULL,
  planner TEXT NOT NULL,
  worker TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  plan TEXT,
  plan_hash TEXT,
  specialist_output TEXT,
  result TEXT,
  stall_detail TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_order_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  phase TEXT NOT NULL,
  member TEXT NOT NULL,
  response TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_orders_state ON work_orders(state, updated);
CREATE INDEX IF NOT EXISTS idx_work_order_messages_order ON work_order_messages(work_order_id, phase);

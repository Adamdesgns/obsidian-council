ALTER TABLE work_orders ADD COLUMN worker_model TEXT;
ALTER TABLE work_orders ADD COLUMN review TEXT;
ALTER TABLE work_orders ADD COLUMN context TEXT;
ALTER TABLE work_orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE work_order_revisions (work_order_id TEXT NOT NULL, request_key TEXT NOT NULL, feedback_hash TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(work_order_id,request_key));

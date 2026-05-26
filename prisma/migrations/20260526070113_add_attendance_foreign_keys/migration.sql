-- Hand-authored GIN indexes (Prisma cannot emit GIN DDL; maintained manually).
-- DROP IF EXISTS prevents shadow DB errors when replaying from scratch.
-- CREATE IF NOT EXISTS at the end re-asserts them so the final schema state
-- always includes these indexes regardless of prior migration order.
DROP INDEX IF EXISTS "leave_approvals_event_snapshot_gin_idx";
DROP INDEX IF EXISTS "leave_requests_payload_gin_idx";
DROP INDEX IF EXISTS "users_full_name_trgm_idx";
DROP INDEX IF EXISTS "users_payload_gin_idx";

CREATE INDEX IF NOT EXISTS "users_payload_gin_idx"
  ON "users" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_requests_payload_gin_idx"
  ON "leave_requests" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_approvals_event_snapshot_gin_idx"
  ON "leave_approvals" USING GIN ("event_snapshot" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "users_full_name_trgm_idx"
  ON "users" USING GIN ("full_name" gin_trgm_ops);

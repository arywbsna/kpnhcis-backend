-- DropIndex
DROP INDEX "leave_approvals_event_snapshot_gin_idx";

-- DropIndex
DROP INDEX "leave_requests_payload_gin_idx";

-- DropIndex
DROP INDEX "users_full_name_trgm_idx";

-- DropIndex
DROP INDEX "users_payload_gin_idx";

-- =============================================================================
-- Re-assert hand-authored GIN indexes
-- Prisma cannot emit GIN DDL and detects these as drift on every subsequent
-- migrate dev, generating DROP INDEX statements. The IF EXISTS / IF NOT EXISTS
-- pattern makes this block idempotent across shadow DB replays.
-- =============================================================================
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

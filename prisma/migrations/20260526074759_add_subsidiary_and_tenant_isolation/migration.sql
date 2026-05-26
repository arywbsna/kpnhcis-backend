-- DropIndex
DROP INDEX IF EXISTS "leave_approvals_event_snapshot_gin_idx";

-- DropIndex
DROP INDEX IF EXISTS "leave_requests_payload_gin_idx";

-- DropIndex
DROP INDEX IF EXISTS "users_full_name_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "users_payload_gin_idx";

-- AlterTable
ALTER TABLE "subsidiaries" ALTER COLUMN "updated_at" DROP DEFAULT;

-- =============================================================================
-- Re-assert hand-authored GIN indexes
-- Prisma detected these as drift and auto-generated DROP INDEX statements above.
-- The CREATE IF NOT EXISTS block below restores them so the shadow DB and real DB
-- remain in sync. Every migration that follows this pattern is idempotent.
-- =============================================================================
CREATE INDEX IF NOT EXISTS "users_payload_gin_idx"
    ON "users" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_requests_payload_gin_idx"
    ON "leave_requests" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_approvals_event_snapshot_gin_idx"
    ON "leave_approvals" USING GIN ("event_snapshot" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "users_full_name_trgm_idx"
    ON "users" USING GIN ("full_name" gin_trgm_ops);

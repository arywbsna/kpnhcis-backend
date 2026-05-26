-- DropIndex (IF EXISTS: these are hand-authored GIN indexes not tracked by Prisma schema;
-- shadow database won't have them, real DB may or may not depending on apply order)
DROP INDEX IF EXISTS "leave_approvals_event_snapshot_gin_idx";

-- DropIndex
DROP INDEX IF EXISTS "leave_requests_payload_gin_idx";

-- DropIndex
DROP INDEX IF EXISTS "users_full_name_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "users_payload_gin_idx";

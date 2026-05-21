-- =============================================================================
-- Hand-authored migration: GIN indexes on JSONB payload columns
-- Prisma does not generate GIN index DDL, so these are maintained manually.
-- Run AFTER the Prisma-generated baseline migration has applied all tables.
-- =============================================================================

-- GIN index on users.payload
-- Enables efficient queries like: WHERE payload @> '{"department": "Engineering"}'
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_payload_gin_idx"
  ON "users" USING GIN ("payload" jsonb_path_ops);

-- GIN index on leave_requests.payload
-- Enables efficient XState context / dynamic field queries on leave records
CREATE INDEX CONCURRENTLY IF NOT EXISTS "leave_requests_payload_gin_idx"
  ON "leave_requests" USING GIN ("payload" jsonb_path_ops);

-- GIN index on leave_approvals.event_snapshot
-- Supports audit searches like: WHERE event_snapshot @> '{"type":"APPROVE"}'
CREATE INDEX CONCURRENTLY IF NOT EXISTS "leave_approvals_event_snapshot_gin_idx"
  ON "leave_approvals" USING GIN ("event_snapshot" jsonb_path_ops);

-- pg_trgm trigram index on users.full_name for fast ILIKE searches
-- Requires the pg_trgm extension (declared in schema.prisma extensions[])
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_full_name_trgm_idx"
  ON "users" USING GIN ("full_name" gin_trgm_ops);

-- =============================================================================
-- P0: Subsidiary Tenant Isolation
--
-- Steps:
--   1.  Create subsidiaries table
--   2.  Seed one default Subsidiary row (KPN_HO) so existing units can be
--       backfilled before the NOT NULL constraint is applied.
--   3.  Add subsidiary_id to units as NULLABLE, backfill, then enforce NOT NULL.
--   4.  Add subsidiary_id to users (stays nullable — derived from unit).
--   5.  Drop old FK constraints that need behaviour changes.
--   6.  Re-create FKs with explicit onDelete rules.
--   7.  Add new composite indexes.
--   8.  Re-assert GIN indexes (hand-authored; Prisma cannot emit GIN DDL).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: Create subsidiaries
-- Must come before any FK reference to subsidiaries(id).
-- -----------------------------------------------------------------------------
CREATE TABLE "subsidiaries" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "code"       TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "company_id" TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subsidiaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subsidiaries_code_key"       ON "subsidiaries"("code");
CREATE UNIQUE INDEX "subsidiaries_company_id_key" ON "subsidiaries"("company_id");

-- -----------------------------------------------------------------------------
-- Step 2: Seed the default Subsidiary anchor
-- All existing units will be assigned to this row during backfill (Step 3).
-- After go-live, create proper Subsidiary rows per legal entity and re-assign.
-- The placeholder companyId value is intentionally descriptive so it is easy
-- to identify and replace during the initial configuration phase.
-- -----------------------------------------------------------------------------
INSERT INTO "subsidiaries" ("id", "code", "name", "company_id", "created_at", "updated_at")
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'KPN_HO',
    'KPN Holding (Default — replace after go-live)',
    'KPN_DEFAULT_LEGACY_ID',
    NOW(),
    NOW()
);

-- -----------------------------------------------------------------------------
-- Step 3: Add subsidiary_id to units
-- Strategy: add NULLABLE → backfill → enforce NOT NULL → add FK.
-- This sequence avoids a constraint violation error on existing rows.
-- -----------------------------------------------------------------------------
ALTER TABLE "units" ADD COLUMN "subsidiary_id" UUID;

-- Backfill: assign all existing units to the default Subsidiary anchor.
UPDATE "units" SET "subsidiary_id" = '00000000-0000-0000-0000-000000000001'
WHERE "subsidiary_id" IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "units" ALTER COLUMN "subsidiary_id" SET NOT NULL;

-- -----------------------------------------------------------------------------
-- Step 4: Add subsidiary_id to users (nullable — derived from unit assignment)
-- -----------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "subsidiary_id" UUID;

-- -----------------------------------------------------------------------------
-- Step 5: Drop FK constraints that need onDelete behaviour changes
-- -----------------------------------------------------------------------------

-- users.unit_id: was implicit Restrict (no explicit declaration), now explicit Restrict.
-- Drop and re-add to lock in the explicit rule.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_unit_id_fkey";

-- attendance_daily.user_id: was implicit Restrict → now Cascade.
ALTER TABLE "attendance_daily" DROP CONSTRAINT IF EXISTS "attendance_daily_user_id_fkey";

-- attendance_logs.user_id: was implicit Restrict → now Cascade.
-- Needed to avoid FK Restrict blocking the User → AttendanceDaily cascade chain.
ALTER TABLE "attendance_logs" DROP CONSTRAINT IF EXISTS "attendance_logs_user_id_fkey";

-- leave_requests.user_id: was implicit Restrict → now Cascade.
ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "leave_requests_user_id_fkey";

-- leave_approvals.approver_id: was implicit Restrict → explicit Restrict (audit lock).
ALTER TABLE "leave_approvals" DROP CONSTRAINT IF EXISTS "leave_approvals_approver_id_fkey";

-- -----------------------------------------------------------------------------
-- Step 6: Re-create FK constraints with explicit onDelete rules
-- -----------------------------------------------------------------------------

-- units → subsidiaries: Restrict — cannot delete Subsidiary with active Units.
ALTER TABLE "units"
    ADD CONSTRAINT "units_subsidiary_id_fkey"
    FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- users → units: Restrict — cannot delete Unit with assigned employees.
ALTER TABLE "users"
    ADD CONSTRAINT "users_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- users → subsidiaries: Restrict — cannot delete Subsidiary with active users.
ALTER TABLE "users"
    ADD CONSTRAINT "users_subsidiary_id_fkey"
    FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- attendance_daily → users: Cascade — owned timeline data purged with the user.
ALTER TABLE "attendance_daily"
    ADD CONSTRAINT "attendance_daily_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- attendance_logs → users: Cascade — secondary path prevents Restrict blocking
-- the User → AttendanceDaily → AttendanceLog cascade chain.
ALTER TABLE "attendance_logs"
    ADD CONSTRAINT "attendance_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- leave_requests → users: Cascade — owned ledger data purged with the user.
ALTER TABLE "leave_requests"
    ADD CONSTRAINT "leave_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- leave_approvals → users (approver): Restrict — approver identity is part of
-- the immutable audit trail; hard-delete of approver users is blocked.
ALTER TABLE "leave_approvals"
    ADD CONSTRAINT "leave_approvals_approver_id_fkey"
    FOREIGN KEY ("approver_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Step 7: New composite and single-column indexes
-- -----------------------------------------------------------------------------

-- units: tenant-scoped org-chart lookup (subsidiaryId prefix for planner).
CREATE INDEX "units_subsidiary_id_id_idx"        ON "units"("subsidiary_id", "id");

-- users: tenant + status composite for HR dashboard headcount queries.
CREATE INDEX "users_subsidiary_id_idx"           ON "users"("subsidiary_id");
CREATE INDEX "users_subsidiary_id_status_idx"    ON "users"("subsidiary_id", "status");

-- users: unit + status composite for org-chart and CASL condition evaluation.
CREATE INDEX "users_unit_id_status_idx"          ON "users"("unit_id", "status");

-- leave_requests: employee + status composite for dashboard + XState pre-check.
CREATE INDEX "leave_requests_user_id_status_idx" ON "leave_requests"("user_id", "status");

-- leave_approvals: approver inbox — "show all requests I have decided on".
CREATE INDEX "leave_approvals_approver_id_idx"   ON "leave_approvals"("approver_id");

-- -----------------------------------------------------------------------------
-- Step 8: Re-assert hand-authored GIN indexes
-- Prisma cannot emit GIN DDL and detects these as schema drift, generating
-- DROP INDEX statements in new migrations. IF EXISTS / IF NOT EXISTS makes
-- every migration idempotent so shadow DB replay never fails.
-- -----------------------------------------------------------------------------
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

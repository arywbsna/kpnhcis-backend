-- CreateEnum
CREATE TYPE "DayType" AS ENUM ('WORKING_DAY', 'WEEKOFF', 'PUBLIC_HOLIDAY', 'REST_DAY');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('BIOMETRIC', 'MOBILE_GPS', 'WEB');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "manager_id" UUID;

-- CreateTable
CREATE TABLE "shift_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "is_overnight" BOOLEAN NOT NULL DEFAULT false,
    "grace_period_mins" INTEGER NOT NULL DEFAULT 0,
    "overtime_eligible" BOOLEAN NOT NULL DEFAULT true,
    "weekend_days" INTEGER[],
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiry_date" DATE,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_daily" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "shift_id" UUID,
    "first_clock_in" TIMESTAMP(3),
    "last_clock_out" TIMESTAMP(3),
    "total_work_mins" INTEGER,
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "late_by_mins" INTEGER,
    "overtime_mins" INTEGER,
    "day_type" "DayType" NOT NULL DEFAULT 'WORKING_DAY',
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "daily_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "source" "AttendanceSource" NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "resolved_location" TEXT,
    "geofence_matched" BOOLEAN,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "entitled" DECIMAL(5,1) NOT NULL,
    "used" DECIMAL(5,1) NOT NULL,
    "pending" DECIMAL(5,1) NOT NULL,
    "carried" DECIMAL(5,1) NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "region_code" TEXT,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,

    CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_name_key" ON "shift_definitions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_code_key" ON "shift_definitions"("code");

-- CreateIndex
CREATE INDEX "shift_assignments_user_id_effective_date_idx" ON "shift_assignments"("user_id", "effective_date");

-- CreateIndex
CREATE INDEX "attendance_daily_user_id_idx" ON "attendance_daily"("user_id");

-- CreateIndex
CREATE INDEX "attendance_daily_attendance_date_idx" ON "attendance_daily"("attendance_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_daily_user_id_attendance_date_key" ON "attendance_daily"("user_id", "attendance_date");

-- CreateIndex
CREATE INDEX "attendance_logs_daily_id_idx" ON "attendance_logs"("daily_id");

-- CreateIndex
CREATE INDEX "attendance_logs_user_id_logged_at_idx" ON "attendance_logs"("user_id", "logged_at");

-- CreateIndex
CREATE INDEX "leave_balances_user_id_year_idx" ON "leave_balances"("user_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_user_id_year_leave_type_key" ON "leave_balances"("user_id", "year", "leave_type");

-- CreateIndex
CREATE INDEX "public_holidays_date_idx" ON "public_holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "public_holidays_date_country_code_key" ON "public_holidays"("date", "country_code");

-- CreateIndex
CREATE INDEX "users_manager_id_idx" ON "users"("manager_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily" ADD CONSTRAINT "attendance_daily_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_daily" ADD CONSTRAINT "attendance_daily_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_daily_id_fkey" FOREIGN KEY ("daily_id") REFERENCES "attendance_daily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-authored GIN indexes (Prisma cannot emit GIN DDL; maintained manually).
-- These are re-asserted here because Prisma drift detection drops them whenever
-- it generates a migration. IF NOT EXISTS makes this idempotent.
CREATE INDEX IF NOT EXISTS "users_payload_gin_idx"
  ON "users" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_requests_payload_gin_idx"
  ON "leave_requests" USING GIN ("payload" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "leave_approvals_event_snapshot_gin_idx"
  ON "leave_approvals" USING GIN ("event_snapshot" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "users_full_name_trgm_idx"
  ON "users" USING GIN ("full_name" gin_trgm_ops);

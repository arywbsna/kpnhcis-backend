-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'PROCESSING', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayslipLineType" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "WorkflowModule" AS ENUM ('LEAVE', 'ATTENDANCE', 'MUTATION', 'PAYROLL');

-- CreateEnum
CREATE TYPE "WorkflowInstanceStatus" AS ENUM ('RUNNING', 'COMPLETED', 'REJECTED', 'TERMINATED');

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subsidiary_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "payroll_period_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "total_basic" DECIMAL(15,2) NOT NULL,
    "total_allowance" DECIMAL(15,2) NOT NULL,
    "total_deduction" DECIMAL(15,2) NOT NULL,
    "take_home_pay" DECIMAL(15,2) NOT NULL,
    "status" "PayslipStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payslip_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PayslipLineType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subsidiary_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" "WorkflowModule" NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "definition_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "current_state" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "status" "WorkflowInstanceStatus" NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_periods_start_date_end_date_idx" ON "payroll_periods"("start_date", "end_date");

-- CreateIndex
CREATE INDEX "payroll_periods_subsidiary_id_status_idx" ON "payroll_periods"("subsidiary_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_subsidiary_id_code_key" ON "payroll_periods"("subsidiary_id", "code");

-- CreateIndex
CREATE INDEX "payslips_subsidiary_id_status_idx" ON "payslips"("subsidiary_id", "status");

-- CreateIndex
CREATE INDEX "payslips_user_id_idx" ON "payslips"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_payroll_period_id_user_id_key" ON "payslips"("payroll_period_id", "user_id");

-- CreateIndex
CREATE INDEX "payslip_lines_payslip_id_type_idx" ON "payslip_lines"("payslip_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_subsidiary_id_code_key" ON "workflow_definitions"("subsidiary_id", "code");

-- CreateIndex
CREATE INDEX "workflow_instances_definition_id_entity_id_idx" ON "workflow_instances"("definition_id", "entity_id");

-- CreateIndex
CREATE INDEX "workflow_instances_subsidiary_id_status_idx" ON "workflow_instances"("subsidiary_id", "status");

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_period_id_fkey" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Re-assert hand-authored GIN indexes
-- Prisma cannot emit GIN DDL and generates DROP INDEX drift on every subsequent
-- migrate dev. IF EXISTS / IF NOT EXISTS makes this block fully idempotent.
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

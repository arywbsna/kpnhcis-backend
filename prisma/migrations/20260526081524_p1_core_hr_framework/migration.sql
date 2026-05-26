-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('PKWTT', 'PKWT', 'INTERN', 'CONTRACT');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "MutationType" AS ENUM ('PROMOTION', 'DEMOTION', 'MUTATION', 'TRANSFER_PT');

-- CreateEnum
CREATE TYPE "MutationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "grade_level_id" UUID,
ADD COLUMN     "job_position_id" UUID;

-- CreateTable
CREATE TABLE "job_positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "unit_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_levels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subsidiary_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "salary_band_min" DECIMAL(15,2),
    "salary_band_max" DECIMAL(15,2),
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_contracts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "contract_number" TEXT,
    "contract_type" "ContractType" NOT NULL,
    "contract_status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "job_position_id" UUID,
    "grade_level_id" UUID,
    "signed_at" TIMESTAMP(3),
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_mutations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "mutation_type" "MutationType" NOT NULL,
    "mutation_status" "MutationStatus" NOT NULL DEFAULT 'PENDING',
    "effective_date" DATE NOT NULL,
    "sk_number" TEXT,
    "old_subsidiary_id" UUID,
    "old_unit_id" UUID,
    "old_job_position_id" UUID,
    "old_grade_level_id" UUID,
    "new_subsidiary_id" UUID,
    "new_unit_id" UUID,
    "new_job_position_id" UUID,
    "new_grade_level_id" UUID,
    "approved_by_id" UUID,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_positions_code_key" ON "job_positions"("code");

-- CreateIndex
CREATE INDEX "job_positions_subsidiary_id_idx" ON "job_positions"("subsidiary_id");

-- CreateIndex
CREATE INDEX "job_positions_unit_id_idx" ON "job_positions"("unit_id");

-- CreateIndex
CREATE INDEX "grade_levels_subsidiary_id_tier_idx" ON "grade_levels"("subsidiary_id", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "grade_levels_subsidiary_id_code_key" ON "grade_levels"("subsidiary_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employment_contracts_contract_number_key" ON "employment_contracts"("contract_number");

-- CreateIndex
CREATE INDEX "employment_contracts_user_id_idx" ON "employment_contracts"("user_id");

-- CreateIndex
CREATE INDEX "employment_contracts_subsidiary_id_contract_status_idx" ON "employment_contracts"("subsidiary_id", "contract_status");

-- CreateIndex
CREATE INDEX "employment_contracts_user_id_contract_status_idx" ON "employment_contracts"("user_id", "contract_status");

-- CreateIndex
CREATE INDEX "employee_mutations_user_id_mutation_status_idx" ON "employee_mutations"("user_id", "mutation_status");

-- CreateIndex
CREATE INDEX "employee_mutations_effective_date_idx" ON "employee_mutations"("effective_date");

-- CreateIndex
CREATE INDEX "users_job_position_id_idx" ON "users"("job_position_id");

-- CreateIndex
CREATE INDEX "users_grade_level_id_idx" ON "users"("grade_level_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_job_position_id_fkey" FOREIGN KEY ("job_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_grade_level_id_fkey" FOREIGN KEY ("grade_level_id") REFERENCES "grade_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_levels" ADD CONSTRAINT "grade_levels_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_job_position_id_fkey" FOREIGN KEY ("job_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_grade_level_id_fkey" FOREIGN KEY ("grade_level_id") REFERENCES "grade_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_old_subsidiary_id_fkey" FOREIGN KEY ("old_subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_old_unit_id_fkey" FOREIGN KEY ("old_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_old_job_position_id_fkey" FOREIGN KEY ("old_job_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_old_grade_level_id_fkey" FOREIGN KEY ("old_grade_level_id") REFERENCES "grade_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_new_subsidiary_id_fkey" FOREIGN KEY ("new_subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_new_unit_id_fkey" FOREIGN KEY ("new_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_new_job_position_id_fkey" FOREIGN KEY ("new_job_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_new_grade_level_id_fkey" FOREIGN KEY ("new_grade_level_id") REFERENCES "grade_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mutations" ADD CONSTRAINT "employee_mutations_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Re-assert hand-authored GIN indexes
-- Prisma cannot emit GIN DDL and detects these as schema drift, generating
-- DROP INDEX statements in subsequent migrations. IF EXISTS / IF NOT EXISTS
-- makes every migration idempotent so shadow DB replay never fails.
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

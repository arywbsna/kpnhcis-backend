import {
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import {
  DarwinboxCoreDetailsDto,
  DarwinboxEmploymentDetailsDto,
  DarwinboxProfileDetailsDto,
  SyncProfileDto,
} from './dto/sync-profile.dto';

// =============================================================================
// Internal JSONB payload interface — versioned.
// NOT exported: the payload shape is an implementation detail of this service.
//
// This interface represents the full structure of User.payload for any
// employee synced from Darwinbox. Fields are optional because not every
// Darwinbox endpoint will have been called for a given sync operation.
// =============================================================================

interface DarwinboxSyncPayload {
  _v: 1;
  darwinbox: {
    synced_at: string;          // ISO 8601 — last successful sync timestamp
    source_employee_id?: string; // Darwinbox's internal employee_id (different from employee_no)
  };
  personal: {
    phone?: string;
    gender?: string;
    date_of_birth?: string;
    religion?: string;
    blood_group?: string;
    marital_status?: string;
    nationality?: string;
    place_of_birth?: string;
    nik?: string;
    npwp?: string;
  };
  employment: {
    designation?: string;
    designation_id?: string;
    department?: string;
    department_id?: string;
    employment_type?: string;
    date_of_joining?: string;
    probation_end_date?: string | null;
    contract_end_date?: string | null;
    location?: string;
    branch_id?: string;
    cost_center?: string;
    company_id?: string;
  };
  /**
   * Denormalised snapshot of the manager at sync time.
   * This is NOT a foreign key — it is informational only.
   * The live FK relationship is User.managerId.
   * Use this field for audit trails and UI display without a join.
   */
  manager_snapshot: {
    employee_no?: string;
    name?: string;
    designation?: string;
    email?: string;
  };
  addresses: Array<{
    type: string;
    street?: string;
    city?: string;
    province?: string;
    postal_code?: string;
    country?: string;
  }>;
  education_history: Array<{
    level?: string;
    institution?: string;
    major?: string;
    year_from?: number;
    year_to?: number;
    gpa?: string;
  }>;
  work_experience: Array<{
    company_name?: string;
    designation?: string;
    start_date?: string;
    end_date?: string | null;
    reason_for_leaving?: string;
  }>;
  emergency_contacts: Array<{
    name?: string;
    relationship?: string;
    phone?: string;
  }>;
  family_details: Array<Record<string, unknown>>;
  /**
   * PLT / dual-position UUIDs — populated separately by HR admins.
   * Preserved during sync: existing positionIds are NEVER overwritten
   * by Darwinbox data because Darwinbox has no concept of PLT roles.
   */
  positionIds?: string[];
}

// =============================================================================
// Status mapping — Darwinbox string → Prisma UserStatus enum
// =============================================================================

const DARWINBOX_STATUS_MAP: Readonly<Record<string, UserStatus>> = {
  active:    UserStatus.ACTIVE,
  inactive:  UserStatus.INACTIVE,
  suspended: UserStatus.SUSPENDED,
};

function mapDarwinboxStatus(status?: string): UserStatus {
  if (!status) return UserStatus.ACTIVE;
  return DARWINBOX_STATUS_MAP[status.toLowerCase()] ?? UserStatus.ACTIVE;
}

// =============================================================================
// Full name builder
// =============================================================================

function buildFullName(core: DarwinboxCoreDetailsDto): string {
  return [core.first_name, core.middle_name, core.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // syncDarwinboxProfile — upsert a single employee from Darwinbox upstream data.
  //
  // Upsert key: User.employeeId === dto.coreDetails.employee_no
  //   - If the record does not exist: CREATE with a randomly-generated unusable
  //     password hash. The user must set their password via the reset flow.
  //   - If the record exists: UPDATE all mapped fields; preserve existing
  //     passwordHash, refreshTokenHash, roles, and positionIds.
  //
  // Side effects (resolved before upsert):
  //   1. unitId    — looked up by Unit.code = department_id
  //   2. managerId — looked up by User.employeeId = reporting_manager_employee_id
  //
  // Transaction strategy: the unit/manager lookups are reads; the upsert is
  // a single write. No $transaction wrapper is needed because there is only
  // one write operation. If the surrounding context later requires a
  // batch upsert, wrap this method's caller in a transaction instead.
  // ---------------------------------------------------------------------------
  async syncDarwinboxProfile(dto: SyncProfileDto): Promise<User> {
    const { coreDetails, profileDetails, employmentDetails } = dto;

    // ── 1. Email conflict check ───────────────────────────────────────────────
    // Prisma's upsert does not automatically detect unique constraint conflicts
    // on non-key fields. If the incoming email already belongs to a *different*
    // employee, we must catch this before the upsert attempts an UPDATE that
    // would violate the unique email index.
    const emailConflict = await this.prisma.user.findUnique({
      where: { email: coreDetails.email },
      select: { id: true, employeeId: true },
    });

    if (emailConflict && emailConflict.employeeId !== coreDetails.employee_no) {
      throw new ConflictException(
        `Email "${coreDetails.email}" is already registered to a different ` +
        `employee (${emailConflict.employeeId}). ` +
        `Resolve the conflict in Darwinbox before retrying the sync.`,
      );
    }

    // ── 2. Resolve unitId — Unit.code lookup ──────────────────────────────────
    // Darwinbox sends department_id as a code string (e.g. "DEPT_IT_001").
    // Our Unit table uses `code` as its unique business key.
    // If the unit does not yet exist in our system, unitId remains null —
    // the sync does not block on missing units; the HR admin must create the
    // unit first and then re-trigger the sync.
    const departmentId =
      employmentDetails?.current_position?.department_id ??
      coreDetails.department_id;

    let unitId: string | null = null;

    if (departmentId) {
      const unit = await this.prisma.unit.findUnique({
        where:  { code: departmentId },
        select: { id: true },
      });

      if (unit) {
        unitId = unit.id;
      } else {
        this.logger.warn(
          `ProfilesService: Unit with code "${departmentId}" not found. ` +
          `unitId will be null for employee ${coreDetails.employee_no}. ` +
          `Create the unit and re-sync to resolve.`,
        );
      }
    }

    // ── 3. Resolve managerId — User.employeeId lookup ────────────────────────
    // The manager is identified by their Darwinbox employee number, not a UUID.
    // We look up the manager in our users table by employeeId.
    // If the manager has not yet been synced, managerId is set to null.
    // Re-syncing the employee after the manager's record is created will
    // correctly link them.
    const managerEmployeeNo =
      employmentDetails?.reporting_manager?.employee_no ??
      coreDetails.reporting_manager_employee_id;

    let managerId: string | null = null;

    if (managerEmployeeNo) {
      const manager = await this.prisma.user.findUnique({
        where:  { employeeId: managerEmployeeNo },
        select: { id: true },
      });

      if (manager) {
        managerId = manager.id;
      } else {
        this.logger.warn(
          `ProfilesService: Manager with employeeId "${managerEmployeeNo}" not found. ` +
          `managerId will be null for employee ${coreDetails.employee_no}. ` +
          `Sync the manager first, then re-sync this employee.`,
        );
      }
    }

    // ── 4. Fetch existing payload to preserve PLT positionIds ─────────────────
    // We never let Darwinbox data overwrite positionIds because Darwinbox has
    // no concept of PLT (Pelaksana Tugas) acting roles — those are managed
    // exclusively within KPNHCIS by HR admins.
    const existing = await this.prisma.user.findUnique({
      where:  { employeeId: coreDetails.employee_no },
      select: { payload: true },
    });

    const existingPayload = (existing?.payload ?? {}) as Partial<DarwinboxSyncPayload>;
    const preservedPositionIds = existingPayload.positionIds;

    // ── 5. Build the versioned JSONB payload ──────────────────────────────────
    const newPayload: DarwinboxSyncPayload = {
      _v: 1,

      darwinbox: {
        synced_at:           new Date().toISOString(),
        source_employee_id:  coreDetails.employee_id,
      },

      // Personal biographical data — merged from coreDetails + profileDetails
      personal: {
        phone:          coreDetails.mobile,
        gender:         coreDetails.gender,
        date_of_birth:  coreDetails.date_of_birth,
        religion:       profileDetails?.personal_details?.religion,
        blood_group:    profileDetails?.personal_details?.blood_group,
        marital_status: profileDetails?.personal_details?.marital_status,
        nationality:    profileDetails?.personal_details?.nationality,
        place_of_birth: profileDetails?.personal_details?.place_of_birth,
        nik:            profileDetails?.personal_details?.nik,
        npwp:           profileDetails?.personal_details?.npwp,
      },

      // Employment metadata — prefer employmentDetails over coreDetails for depth
      employment: {
        designation:       employmentDetails?.current_position?.designation   ?? coreDetails.designation,
        designation_id:    employmentDetails?.current_position?.designation_id,
        department:        employmentDetails?.current_position?.department    ?? coreDetails.department,
        department_id:     departmentId,
        employment_type:   employmentDetails?.current_position?.employment_type ?? coreDetails.employment_type,
        date_of_joining:   employmentDetails?.current_position?.date_of_joining ?? coreDetails.date_of_joining,
        probation_end_date: employmentDetails?.current_position?.probation_end_date ?? null,
        contract_end_date:  employmentDetails?.current_position?.contract_end_date  ?? null,
        location:          employmentDetails?.current_position?.location     ?? coreDetails.branch,
        branch_id:         coreDetails.branch_id,
        cost_center:       employmentDetails?.current_position?.cost_center,
        company_id:        coreDetails.company_id,
      },

      // Denormalised manager snapshot for UI display without a join
      manager_snapshot: {
        employee_no: managerEmployeeNo,
        name:        employmentDetails?.reporting_manager?.name ?? coreDetails.reporting_manager_name,
        designation: employmentDetails?.reporting_manager?.designation,
        email:       employmentDetails?.reporting_manager?.email,
      },

      addresses:         profileDetails?.addresses         ?? [],
      education_history: profileDetails?.education_history ?? [],
      work_experience:   employmentDetails?.work_experience ?? [],
      emergency_contacts: profileDetails?.emergency_contacts ?? [],
      family_details:    profileDetails?.family_details    ?? [],

      // Preserve PLT positionIds — never overwrite with Darwinbox data
      ...(preservedPositionIds !== undefined && { positionIds: preservedPositionIds }),
    };

    // ── 6. Generate a temporary unusable password for new employees ───────────
    // New employees synced from Darwinbox have no local password yet.
    // We hash a random UUID — the output is a valid bcrypt hash but the
    // employee cannot log in until they complete the password-reset flow.
    // Existing users keep their current passwordHash (upsert.update omits it).
    const tempPasswordHash = await bcrypt.hash(randomUUID(), 12);

    // ── 7. Upsert + manager_id patch ─────────────────────────────────────────
    // managerId is set via a separate $executeRaw because the Prisma-generated
    // types won't include the manager self-relation until the migration that adds
    // the manager_id column has been run and `prisma generate` has been re-executed.
    // Once that migration is applied, this $transaction can be collapsed back into
    // a plain upsert with managerId in the create/update blocks.
    const upserted = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { employeeId: coreDetails.employee_no },

        // CREATE: first-time sync — no password; user must use reset flow.
        create: {
          employeeId:   coreDetails.employee_no,
          email:        coreDetails.email,
          fullName:     buildFullName(coreDetails),
          passwordHash: tempPasswordHash,
          status:       mapDarwinboxStatus(coreDetails.status),
          unitId,
          payload:      newPayload as unknown as Prisma.InputJsonValue,
        },

        // UPDATE: subsequent syncs.
        // passwordHash and refreshTokenHash intentionally excluded.
        update: {
          email:    coreDetails.email,
          fullName: buildFullName(coreDetails),
          status:   mapDarwinboxStatus(coreDetails.status),
          unitId,
          payload:  newPayload as unknown as Prisma.InputJsonValue,
        },

        select: { id: true },
      });

      // Patch manager_id via raw SQL — bypasses missing Prisma type until migration runs.
      if (managerId !== null) {
        await tx.$executeRaw`
          UPDATE users SET manager_id = ${managerId}::uuid WHERE id = ${user.id}::uuid
        `;
      } else {
        await tx.$executeRaw`
          UPDATE users SET manager_id = NULL WHERE id = ${user.id}::uuid
        `;
      }

      return tx.user.findUniqueOrThrow({
        where:   { id: user.id },
        include: { unit: { select: { id: true, name: true, code: true } } },
      });
    });

    this.logger.log(
      `ProfilesService: Synced employee ${coreDetails.employee_no} ` +
      `("${buildFullName(coreDetails)}") — ` +
      `unitId=${unitId ?? 'null'} managerId=${managerId ?? 'null'} ` +
      `status=${mapDarwinboxStatus(coreDetails.status)}`,
    );

    return upserted;
  }

  // ---------------------------------------------------------------------------
  // findBySyncedDepartment — GIN query: find all users in a Darwinbox department.
  //
  // Uses payload.employment.department_id for lookups since that field is
  // indexed by the GIN index on payload. This is more reliable than querying
  // unit.code directly when the unit mapping may not always exist.
  //
  // Example: findBySyncedDepartment('DEPT_IT_001')
  // ---------------------------------------------------------------------------
  async findBySyncedDepartment(
    departmentId: string,
    options?: { skip?: number; take?: number },
  ): Promise<{ data: User[]; total: number }> {
    const { skip = 0, take = 20 } = options ?? {};

    // Build the @> containment filter. The GIN index decomposes this into
    // {employment: {department_id: "..."}} and looks it up efficiently.
    const jsonFilter = JSON.stringify({
      employment: { department_id: departmentId },
    });

    const [data, countResult] = await Promise.all([
      this.prisma.$queryRaw<User[]>`
        SELECT
          id,
          employee_id       AS "employeeId",
          email,
          full_name         AS "fullName",
          status,
          unit_id           AS "unitId",
          manager_id        AS "managerId",
          payload,
          created_at        AS "createdAt",
          updated_at        AS "updatedAt"
        FROM users
        WHERE payload @> ${jsonFilter}::jsonb
          AND deleted_at IS NULL
        ORDER BY full_name ASC
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM users
        WHERE payload @> ${jsonFilter}::jsonb
          AND deleted_at IS NULL
      `,
    ]);

    return { data, total: Number(countResult[0].count) };
  }
}

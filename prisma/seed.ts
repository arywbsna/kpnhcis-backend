/**
 * prisma/seed.ts — KPNHCIS Database Seeder
 *
 * Idempotent: safe to run multiple times (upsert-only, no destructive ops).
 *
 * Execution:
 *   npx prisma db seed
 *   — or directly —
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed.ts
 *
 * Phase overview:
 *   1.  Subsidiaries   — 4 KPN legal entities, upserted by code
 *   2.  Migration      — Pattern-based unit re-assignment from placeholder to
 *                        correct subsidiary, with per-rule row counts logged
 *   3.  Org Units      — Root + departmental + 5 branch (CAB_) units
 *   4.  Permissions    — CASL-compatible action:subject matrix
 *   5.  Roles          — 4 system roles with permission bindings
 *   6.  Users          — 3 seed users (admin, IT manager, staff engineer)
 *   7.  User Roles     — Role assignment join rows
 */

import { PrismaClient, UserStatus } from '@prisma/client';

const prisma = new PrismaClient();

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Pre-computed bcrypt hash of the literal string "password" (cost = 10).
 * Re-generate anytime via:
 *   node -e "require('bcrypt').hash('password', 10).then(console.log)"
 */
const HASHED_PASSWORD =
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';

/**
 * The sentinel UUID written by the P0 migration to every pre-existing unit
 * that had no subsidiary at the time of the NOT NULL backfill.
 * Phase 2 re-assigns all rows still holding this value to the correct entity.
 */
const PLACEHOLDER_SUBSIDIARY_ID = '00000000-0000-0000-0000-000000000001';

// =============================================================================
// TYPED INTERFACES
// =============================================================================

/** Typed shape for the User.payload JSONB column (schema version 1). */
interface UserPayload {
  readonly _v: 1;
  job_title: string;
  employment_status: 'permanent' | 'contract' | 'probation';
  join_date: string;       // ISO 8601 (YYYY-MM-DD)
  gender: 'male' | 'female';
  phone_number: string;
  manager_id?: string;     // User.id of the direct line manager
  financials: {
    basic_salary: number;
    currency: string;      // ISO 4217
  };
}

/** Static definition for each legal entity to be seeded. */
interface SubsidiaryDef {
  readonly code:      string;
  readonly name:      string;
  readonly companyId: string;
}

/**
 * Rule that maps a unit code prefix to a target subsidiary.
 * Rules are evaluated in declaration order — place most-specific prefixes first.
 */
interface UnitAssignmentRule {
  readonly prefix:         string;
  readonly subsidiaryCode: string;
  readonly label:          string;
}

// =============================================================================
// SEED DATA DEFINITIONS
// =============================================================================

/**
 * The four KPN conglomerate legal entities.
 * Each maps to exactly one row in the `subsidiaries` table.
 * companyId is the legacy external identifier used by Darwinbox / payroll systems.
 */
const SUBSIDIARY_DEFS: readonly SubsidiaryDef[] = [
  {
    code:      'KPN_HO',
    name:      'PT KPN Corporate HO',
    companyId: 'COMP_HO_01',
  },
  {
    code:      'KPN_PLNT',
    name:      'PT KPN Plantations',
    companyId: 'COMP_PLNT_02',
  },
  {
    code:      'KPN_LOG',
    name:      'PT KPN Logistics & Shipping',
    companyId: 'COMP_LOG_03',
  },
  {
    code:      'KPN_AGRI',
    name:      'PT KPN Agribusiness',
    companyId: 'COMP_AGRI_04',
  },
] as const;

/**
 * Pattern rules for automatic unit-to-subsidiary assignment.
 *
 * Evaluation contract:
 *   - Rules are tested in array order against each unit's `code` field.
 *   - The first matching prefix wins (short-circuit).
 *   - Units not matching any rule are assigned to KPN_HO (catch-all default).
 *
 * Ordering invariant: more-specific prefixes (CAB_PLNT_) MUST appear before
 * their less-specific superstrings (CAB_) to prevent the generic rule from
 * matching before the specific one has a chance to fire.
 */
const UNIT_ASSIGNMENT_RULES: readonly UnitAssignmentRule[] = [
  // ── PT KPN Plantations ────────────────────────────────────────────────────
  // Cabang units explicitly tagged for the plantation vertical.
  {
    prefix:         'CAB_PLNT_',
    subsidiaryCode: 'KPN_PLNT',
    label:          'PT KPN Plantations',
  },
  // ── PT KPN Logistics & Shipping ───────────────────────────────────────────
  // Regional logistics branches and port offices.
  {
    prefix:         'CAB_LOG_',
    subsidiaryCode: 'KPN_LOG',
    label:          'PT KPN Logistics & Shipping',
  },
  // ── PT KPN Agribusiness ───────────────────────────────────────────────────
  // Downstream agri-processing and trading branches.
  {
    prefix:         'CAB_AGRI_',
    subsidiaryCode: 'KPN_AGRI',
    label:          'PT KPN Agribusiness',
  },
  // ── Catch-all for any remaining CAB_ branches ─────────────────────────────
  // Un-classified branch units fall back to the HO legal entity.
  // This rule must come LAST in the CAB_ group to avoid masking specific matches.
  {
    prefix:         'CAB_',
    subsidiaryCode: 'KPN_HO',
    label:          'PT KPN Corporate HO (unclassified branch)',
  },
];

const DEFAULT_SUBSIDIARY_CODE = 'KPN_HO';

// =============================================================================
// PHASE 2 — UNIT RE-ASSIGNMENT (data migration utility)
// =============================================================================

/**
 * Executes the conditional unit → subsidiary re-assignment in three passes:
 *
 *   Pass A — Rule-based pattern match (CAB_PLNT_, CAB_LOG_, CAB_AGRI_, CAB_)
 *             Updates only rows that do NOT already have the target value to
 *             make every UPDATE idempotent.
 *
 *   Pass B — Placeholder cleanup: any unit still pointing to the sentinel UUID
 *             written by the P0 migration is reassigned to KPN_HO.
 *
 *   Pass C — Null cleanup: any unit with subsidiary_id IS NULL (defensive) is
 *             also assigned to KPN_HO.
 *
 * Each pass logs the exact row count affected, giving a full audit trail of
 * what moved where during the migration run.
 *
 * @param subsidiaryMap  Map of subsidiary code → DB UUID, built in Phase 1.
 */
async function runUnitReassignment(
  subsidiaryMap: Record<string, string>,
): Promise<void> {
  // ─── Validation guard ────────────────────────────────────────────────────
  // Verify every target subsidiary exists in the DB before issuing any FK write.
  // A missing subsidiary would cause a FK constraint violation on UPDATE.
  const targetCodes = [
    ...new Set(UNIT_ASSIGNMENT_RULES.map((r) => r.subsidiaryCode)),
    DEFAULT_SUBSIDIARY_CODE,
  ];

  for (const code of targetCodes) {
    const exists = await prisma.subsidiary.findUnique({ where: { code } });
    if (!exists) {
      throw new Error(
        `[Validation] Subsidiary "${code}" not found in the database. ` +
        `Ensure Phase 1 (subsidiary seeding) completed successfully before running the migration.`,
      );
    }
  }

  console.log('   ✓ Validation passed — all target subsidiary IDs confirmed in DB');

  // ─── Pass A: Rule-based prefix matching ──────────────────────────────────
  let totalMigrated = 0;

  for (const rule of UNIT_ASSIGNMENT_RULES) {
    const targetId    = subsidiaryMap[rule.subsidiaryCode];
    const likePattern = `${rule.prefix}%`;

    try {
      // $executeRaw is used here for three reasons:
      //   1. updateMany with startsWith translates to a LIKE clause, which is fine,
      //      but the NOT-equal guard (skip already-correct rows) is cleaner in SQL.
      //   2. The raw form returns the exact PostgreSQL rowcount (affected rows),
      //      while updateMany returns a Prisma BatchPayload with a `count` field.
      //   3. Pattern matching on text columns benefits from index scans on code
      //      when the prefix is a left-anchored LIKE (code LIKE 'CAB_PLNT_%').
      const affected: number = await prisma.$executeRaw`
        UPDATE units
           SET subsidiary_id = ${targetId}::uuid,
               updated_at    = NOW()
         WHERE code LIKE ${likePattern}
           AND subsidiary_id IS DISTINCT FROM ${targetId}::uuid
      `;

      if (affected > 0) {
        totalMigrated += affected;
        console.log(
          `   ✓ Rule [${rule.prefix}*] → migrated ${affected} unit(s) to ${rule.label}`,
        );
      } else {
        console.log(
          `   ─ Rule [${rule.prefix}*] → 0 units needed migration (already correct or no match)`,
        );
      }
    } catch (err) {
      throw new Error(
        `[Migration] Rule [${rule.prefix}] failed for subsidiary "${rule.subsidiaryCode}": ${String(err)}`,
      );
    }
  }

  // ─── Pass B: Placeholder UUID cleanup ────────────────────────────────────
  const defaultId = subsidiaryMap[DEFAULT_SUBSIDIARY_CODE];

  try {
    const placeholderAffected: number = await prisma.$executeRaw`
      UPDATE units
         SET subsidiary_id = ${defaultId}::uuid,
             updated_at    = NOW()
       WHERE subsidiary_id = ${PLACEHOLDER_SUBSIDIARY_ID}::uuid
    `;

    if (placeholderAffected > 0) {
      totalMigrated += placeholderAffected;
      console.log(
        `   ✓ Placeholder cleanup → migrated ${placeholderAffected} unit(s) ` +
        `(sentinel UUID → PT KPN Corporate HO)`,
      );
    } else {
      console.log(`   ─ Placeholder cleanup → 0 units found with sentinel UUID`);
    }
  } catch (err) {
    throw new Error(`[Migration] Placeholder cleanup failed: ${String(err)}`);
  }

  // ─── Pass C: NULL subsidiary_id defensive fix ────────────────────────────
  try {
    const nullAffected: number = await prisma.$executeRaw`
      UPDATE units
         SET subsidiary_id = ${defaultId}::uuid,
             updated_at    = NOW()
       WHERE subsidiary_id IS NULL
    `;

    if (nullAffected > 0) {
      totalMigrated += nullAffected;
      console.log(
        `   ✓ NULL cleanup → assigned ${nullAffected} unit(s) to PT KPN Corporate HO`,
      );
    }
  } catch (err) {
    throw new Error(`[Migration] NULL cleanup failed: ${String(err)}`);
  }

  console.log(
    `\n   ✅ Re-assignment complete — ${totalMigrated} total unit(s) migrated across all passes`,
  );

  // ─── Post-migration integrity check ──────────────────────────────────────
  // Verify no units remain without a valid subsidiary binding.
  // Uses $queryRaw because subsidiaryId is NOT NULL in the Prisma schema;
  // the client rejects { where: { subsidiaryId: null } } at the type level.
  // This raw query bypasses the type guard and queries the DB directly.
  const [orphanRow] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count FROM units WHERE subsidiary_id IS NULL
  `;
  const orphanCount = Number(orphanRow.count);

  if (orphanCount > 0) {
    throw new Error(
      `[Integrity Check] ${orphanCount} unit(s) still have NULL subsidiary_id after migration. ` +
      `Investigate before proceeding.`,
    );
  }

  console.log(`   ✓ Integrity check passed — no orphaned units`);
}

// =============================================================================
// MAIN SEEDER
// =============================================================================

async function main(): Promise<void> {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  KPNHCIS — Database Seeder                                  │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // ===========================================================================
  // PHASE 1 — SUBSIDIARIES
  // Upsert by `code` (unique). `name` is updated on re-runs so display name
  // changes are reflected without manual DB edits. `companyId` is only written
  // on INSERT — changing it in code will NOT update the existing row, preventing
  // accidental drift of the legacy system's immutable identifier.
  // ===========================================================================

  console.log('━━━  Phase 1: Subsidiaries  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // subsidiaryMap: code → DB UUID — shared across all phases
  const subsidiaryMap: Record<string, string> = {};

  for (const def of SUBSIDIARY_DEFS) {
    const sub = await prisma.subsidiary.upsert({
      where:  { code: def.code },
      update: { name: def.name },   // keeps display name in sync on re-runs
      create: {
        code:      def.code,
        name:      def.name,
        companyId: def.companyId,
      },
    });

    subsidiaryMap[def.code] = sub.id;

    console.log(
      `   ✓ ${def.name.padEnd(36)} code=${def.code.padEnd(10)} id=${sub.id}`,
    );
  }

  const hoId   = subsidiaryMap['KPN_HO'];
  const plntId = subsidiaryMap['KPN_PLNT'];
  const logId  = subsidiaryMap['KPN_LOG'];
  const agriId = subsidiaryMap['KPN_AGRI'];

  // ===========================================================================
  // PHASE 2 — UNIT RE-ASSIGNMENT MIGRATION
  // Processes existing rows that were written before Subsidiary was introduced.
  // Must run BEFORE Phase 3 unit upserts to avoid FK conflicts on the
  // placeholder UUID (which will still exist if Phase 3 has not yet run).
  // ===========================================================================

  console.log('\n━━━  Phase 2: Unit Re-Assignment Migration  ━━━━━━━━━━━━━━━━');

  await runUnitReassignment(subsidiaryMap);

  // ===========================================================================
  // PHASE 3 — ORG UNITS
  //
  // Hierarchy:
  //   KPN_HO   → HOLDING-KPN (root)
  //                ├── DEPT-IT
  //                ├── DEPT-HR
  //                └── DEPT-HSE
  //
  //   KPN_PLNT → CAB_PLNT_SUMUT  (Sumatera Utara plantation operations)
  //              CAB_PLNT_KALTIM (Kalimantan Timur plantation operations)
  //
  //   KPN_LOG  → CAB_LOG_JKT    (Jakarta logistics hub)
  //              CAB_LOG_SBY    (Surabaya logistics hub)
  //
  //   KPN_AGRI → CAB_AGRI_RIAU  (Riau agribusiness processing)
  //
  // The `update` block includes `subsidiaryId` so that re-running the seed
  // after subsidiary IDs change (e.g. after a reset + re-seed) corrects
  // the FK without requiring a manual UPDATE.
  // ===========================================================================

  console.log('\n━━━  Phase 3: Org Units  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── KPN_HO root & departments ─────────────────────────────────────────────

  const headOffice = await prisma.unit.upsert({
    where:  { code: 'HOLDING-KPN' },
    update: { subsidiaryId: hoId },
    create: {
      code:         'HOLDING-KPN',
      name:         'KPN Corp Head Office',
      description:  'Root holding unit — parent of all departmental nodes',
      parentId:     null,
      subsidiaryId: hoId,
      isActive:     true,
    },
  });

  const [itDept, hrDept, hseDept] = await Promise.all([
    prisma.unit.upsert({
      where:  { code: 'DEPT-IT' },
      update: { subsidiaryId: hoId },
      create: {
        code:         'DEPT-IT',
        name:         'IT Department',
        description:  'Information Technology Division',
        parentId:     headOffice.id,
        subsidiaryId: hoId,
        isActive:     true,
      },
    }),
    prisma.unit.upsert({
      where:  { code: 'DEPT-HR' },
      update: { subsidiaryId: hoId },
      create: {
        code:         'DEPT-HR',
        name:         'HR Department',
        description:  'Human Resources Division',
        parentId:     headOffice.id,
        subsidiaryId: hoId,
        isActive:     true,
      },
    }),
    prisma.unit.upsert({
      where:  { code: 'DEPT-HSE' },
      update: { subsidiaryId: hoId },
      create: {
        code:         'DEPT-HSE',
        name:         'HSE Department',
        description:  'Health, Safety & Environment Division',
        parentId:     headOffice.id,
        subsidiaryId: hoId,
        isActive:     true,
      },
    }),
  ]);

  console.log(`   ✓ KPN_HO   → ${headOffice.name}, ${itDept.name}, ${hrDept.name}, ${hseDept.name}`);

  // ── KPN_PLNT plantation branches ──────────────────────────────────────────

  const [cabPlntSumut, cabPlntKaltim] = await Promise.all([
    prisma.unit.upsert({
      where:  { code: 'CAB_PLNT_SUMUT' },
      update: { subsidiaryId: plntId },
      create: {
        code:         'CAB_PLNT_SUMUT',
        name:         'Cabang Sumatera Utara — Plantations',
        description:  'Plantation operations branch in North Sumatra corridor',
        parentId:     null,
        subsidiaryId: plntId,
        isActive:     true,
      },
    }),
    prisma.unit.upsert({
      where:  { code: 'CAB_PLNT_KALTIM' },
      update: { subsidiaryId: plntId },
      create: {
        code:         'CAB_PLNT_KALTIM',
        name:         'Cabang Kalimantan Timur — Plantations',
        description:  'Plantation operations branch in East Kalimantan corridor',
        parentId:     null,
        subsidiaryId: plntId,
        isActive:     true,
      },
    }),
  ]);

  console.log(`   ✓ KPN_PLNT → ${cabPlntSumut.name}`);
  console.log(`   ✓ KPN_PLNT → ${cabPlntKaltim.name}`);

  // ── KPN_LOG logistics branches ────────────────────────────────────────────

  const [cabLogJkt, cabLogSby] = await Promise.all([
    prisma.unit.upsert({
      where:  { code: 'CAB_LOG_JKT' },
      update: { subsidiaryId: logId },
      create: {
        code:         'CAB_LOG_JKT',
        name:         'Cabang Jakarta — Logistics Hub',
        description:  'Main Jakarta logistics and port operations hub',
        parentId:     null,
        subsidiaryId: logId,
        isActive:     true,
      },
    }),
    prisma.unit.upsert({
      where:  { code: 'CAB_LOG_SBY' },
      update: { subsidiaryId: logId },
      create: {
        code:         'CAB_LOG_SBY',
        name:         'Cabang Surabaya — Logistics Hub',
        description:  'East Java logistics distribution and port operations',
        parentId:     null,
        subsidiaryId: logId,
        isActive:     true,
      },
    }),
  ]);

  console.log(`   ✓ KPN_LOG  → ${cabLogJkt.name}`);
  console.log(`   ✓ KPN_LOG  → ${cabLogSby.name}`);

  // ── KPN_AGRI agribusiness branch ──────────────────────────────────────────

  const cabAgriRiau = await prisma.unit.upsert({
    where:  { code: 'CAB_AGRI_RIAU' },
    update: { subsidiaryId: agriId },
    create: {
      code:         'CAB_AGRI_RIAU',
      name:         'Cabang Riau — Agribusiness Processing',
      description:  'Palm oil and downstream agri-processing operations in Riau',
      parentId:     null,
      subsidiaryId: agriId,
      isActive:     true,
    },
  });

  console.log(`   ✓ KPN_AGRI → ${cabAgriRiau.name}`);

  // ===========================================================================
  // PHASE 4 — PERMISSIONS
  // CASL-compatible action:subject matrix. Each row becomes one ability rule
  // in the application layer's CASL ability factory.
  // ===========================================================================

  console.log('\n━━━  Phase 4: Permissions  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const permissionDefs = [
    // Global
    { action: 'manage', subject: 'all',              description: 'Unrestricted access to every resource' },
    // User
    { action: 'create', subject: 'User',             description: 'Create new employee accounts' },
    { action: 'read',   subject: 'User',             description: 'View employee profiles' },
    { action: 'update', subject: 'User',             description: 'Modify employee data' },
    { action: 'delete', subject: 'User',             description: 'Soft-delete / deactivate employees' },
    // LeaveRequest
    { action: 'create', subject: 'LeaveRequest',     description: 'Submit a new leave request' },
    { action: 'read',   subject: 'LeaveRequest',     description: 'View leave requests' },
    { action: 'update', subject: 'LeaveRequest',     description: 'Approve, reject, or edit leave requests' },
    { action: 'delete', subject: 'LeaveRequest',     description: 'Cancel or remove leave requests' },
    // Unit
    { action: 'read',   subject: 'Unit',             description: 'View org-chart structure' },
    { action: 'manage', subject: 'Unit',             description: 'Full control over org units' },
    // AttendanceRecord
    { action: 'create', subject: 'AttendanceRecord', description: 'Clock in / clock out events' },
    { action: 'read',   subject: 'AttendanceRecord', description: 'View attendance logs and daily summaries' },
    { action: 'update', subject: 'AttendanceRecord', description: 'Correct or adjust attendance records' },
    // LeaveBalance
    { action: 'read',   subject: 'LeaveBalance',     description: 'View leave balance entitlements' },
    { action: 'update', subject: 'LeaveBalance',     description: 'Adjust leave balance entries' },
  ] as const;

  const seededPermissions = await Promise.all(
    permissionDefs.map((p) =>
      prisma.permission.upsert({
        where:  { action_subject: { action: p.action, subject: p.subject } },
        update: { description: p.description },
        create: { action: p.action, subject: p.subject, description: p.description },
      }),
    ),
  );

  // Build a lookup map: "action:subject" → permissionId
  const permId = Object.fromEntries(
    seededPermissions.map((p) => [`${p.action}:${p.subject}`, p.id]),
  );

  console.log(`   ✓ ${seededPermissions.length} permissions upserted`);

  // ===========================================================================
  // PHASE 5 — ROLES
  // isSystem = true prevents accidental deletion through the admin UI.
  // ===========================================================================

  console.log('\n━━━  Phase 5: Roles  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const roleDefs = [
    {
      name:        'superadmin',
      description: 'Unrestricted system-wide access',
      permKeys:    ['manage:all'] as string[],
    },
    {
      name:        'hr_manager',
      description: 'Manages all employee data, leave administration, and org units',
      permKeys:    [
        'create:User', 'read:User', 'update:User', 'delete:User',
        'read:LeaveRequest', 'update:LeaveRequest', 'delete:LeaveRequest',
        'read:AttendanceRecord', 'update:AttendanceRecord',
        'read:LeaveBalance', 'update:LeaveBalance',
        'read:Unit',
      ],
    },
    {
      name:        'line_manager',
      description: 'Reviews and approves leave requests for direct reports',
      permKeys:    [
        'read:User',
        'read:LeaveRequest', 'update:LeaveRequest',
        'read:AttendanceRecord',
        'read:LeaveBalance',
        'read:Unit',
      ],
    },
    {
      name:        'employee',
      description: 'Standard employee — self-service leave and attendance only',
      permKeys:    [
        'read:User',
        'create:LeaveRequest', 'read:LeaveRequest',
        'create:AttendanceRecord', 'read:AttendanceRecord',
        'read:LeaveBalance',
        'read:Unit',
      ],
    },
  ];

  const roleIdByName: Record<string, string> = {};

  for (const def of roleDefs) {
    const role = await prisma.role.upsert({
      where:  { name: def.name },
      update: { description: def.description },
      create: { name: def.name, description: def.description, isSystem: true },
    });

    roleIdByName[def.name] = role.id;

    await Promise.all(
      def.permKeys.map((key) => {
        const permissionId = permId[key];
        if (!permissionId) {
          throw new Error(
            `[Phase 5] Unknown permission key "${key}" for role "${def.name}". ` +
            `Ensure the permission is defined in Phase 4.`,
          );
        }

        return prisma.rolePermission.upsert({
          where:  { roleId_permissionId: { roleId: role.id, permissionId } },
          update: {},
          create: { roleId: role.id, permissionId },
        });
      }),
    );

    console.log(`   ✓ ${def.name.padEnd(15)} — ${def.permKeys.length} permissions linked`);
  }

  // ===========================================================================
  // PHASE 6 — USERS
  // Extended HR fields live in the JSONB payload column (schema version _v: 1).
  // subsidiaryId is denormalised from the assigned unit — kept in sync here
  // at seed time so the tenant isolation FK is immediately consistent.
  // ===========================================================================

  console.log('\n━━━  Phase 6: Users  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── System Admin (Head Office) ────────────────────────────────────────────
  const adminUser = await prisma.user.upsert({
    where:  { email: 'admin@kpncorp.com' },
    update: { subsidiaryId: hoId },
    create: {
      employeeId:   'ADM-001',
      email:        'admin@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName:     'Ary Admin',
      status:       UserStatus.ACTIVE,
      unitId:       headOffice.id,
      subsidiaryId: hoId,
      payload: {
        _v:                1,
        job_title:         'System Administrator',
        employment_status: 'permanent',
        join_date:         '2020-01-15',
        gender:            'male',
        phone_number:      '+62811000001',
        financials:        { basic_salary: 25_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  // ── IT Manager — seeded before Staff so its ID is available for manager_id ─
  const itManager = await prisma.user.upsert({
    where:  { email: 'manager.it@kpncorp.com' },
    update: { subsidiaryId: hoId },
    create: {
      employeeId:   'MGR-IT-001',
      email:        'manager.it@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName:     'Budi IT Manager',
      status:       UserStatus.ACTIVE,
      unitId:       itDept.id,
      subsidiaryId: hoId,
      payload: {
        _v:                1,
        job_title:         'Head of IT',
        employment_status: 'permanent',
        join_date:         '2021-03-01',
        gender:            'male',
        phone_number:      '+62811000002',
        financials:        { basic_salary: 20_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  // ── Staff Software Engineer (reports to itManager) ─────────────────────────
  const staffUser = await prisma.user.upsert({
    where:  { email: 'staff.it@kpncorp.com' },
    update: { subsidiaryId: hoId },
    create: {
      employeeId:   'STF-IT-004',
      email:        'staff.it@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName:     'Made Software Engineer',
      status:       UserStatus.ACTIVE,
      unitId:       itDept.id,
      subsidiaryId: hoId,
      managerId:    itManager.id,
      payload: {
        _v:                1,
        job_title:         'Software Engineer',
        employment_status: 'permanent',
        join_date:         '2023-06-01',
        gender:            'male',
        phone_number:      '+62811000003',
        manager_id:        itManager.id, // JSONB mirror of the FK for Darwinbox sync
        financials:        { basic_salary: 12_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  console.log(`   ✓ ${adminUser.fullName.padEnd(25)} unit=${headOffice.code}  subsidiary=KPN_HO`);
  console.log(`   ✓ ${itManager.fullName.padEnd(25)} unit=${itDept.code}      subsidiary=KPN_HO`);
  console.log(`   ✓ ${staffUser.fullName.padEnd(25)} unit=${itDept.code}      subsidiary=KPN_HO`);

  // ===========================================================================
  // PHASE 7 — USER ROLES
  // ===========================================================================

  console.log('\n━━━  Phase 7: User Roles  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const userRoleMappings = [
    { userId: adminUser.id, roleId: roleIdByName['superadmin'],  label: `${adminUser.fullName} → superadmin`  },
    { userId: itManager.id, roleId: roleIdByName['line_manager'], label: `${itManager.fullName} → line_manager` },
    { userId: staffUser.id, roleId: roleIdByName['employee'],     label: `${staffUser.fullName} → employee`     },
  ];

  await Promise.all(
    userRoleMappings.map(({ userId, roleId }) =>
      prisma.userRole.upsert({
        where:  { userId_roleId: { userId, roleId } },
        update: {},
        create: { userId, roleId },
      }),
    ),
  );

  for (const m of userRoleMappings) {
    console.log(`   ✓ ${m.label}`);
  }

  // ===========================================================================
  // SUMMARY
  // ===========================================================================

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  ✅  Seed completed successfully                             │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log('│  Default credentials (all seed users)                       │');
  console.log('│    password : "password"                                    │');
  console.log(`│    hash     : ${HASHED_PASSWORD.substring(0, 29)}...  │`);
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log('│  Subsidiaries seeded                                        │');
  for (const def of SUBSIDIARY_DEFS) {
    console.log(`│    ${def.code.padEnd(12)} ${def.name.substring(0, 40).padEnd(40)}  │`);
  }
  console.log('└─────────────────────────────────────────────────────────────┘\n');
}

// =============================================================================
// ENTRY POINT
// =============================================================================

main()
  .catch((err: unknown) => {
    console.error('\n❌  Seed failed:\n', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

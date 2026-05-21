/**
 * prisma/seed.ts — KPNHCIS Database Seeder
 *
 * Idempotent: safe to run multiple times (upsert-only, no destructive ops).
 *
 * Execution:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed.ts
 *   — or via the "prisma.seed" script in package.json —
 *   npx prisma db seed
 */

import { PrismaClient, UserStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Pre-computed bcrypt hash for the literal string "password" (cost = 10).
// Re-generate any time via:
//   node -e "require('bcrypt').hash('password', 10).then(console.log)"
// ---------------------------------------------------------------------------
const HASHED_PASSWORD =
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';

// ---------------------------------------------------------------------------
// Typed shape for the User.payload JSONB column.
// _v tracks the schema version so future migrations can run targeted transforms.
// ---------------------------------------------------------------------------
interface UserPayload {
  readonly _v: 1;
  job_title: string;
  employment_status: 'permanent' | 'contract' | 'probation';
  join_date: string; // ISO 8601 (YYYY-MM-DD)
  gender: 'male' | 'female';
  phone_number: string;
  manager_id?: string; // User.id of the direct line manager
  financials: {
    basic_salary: number;
    currency: string; // ISO 4217
  };
}

// ---------------------------------------------------------------------------
// Main seeder
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('🌱  Starting database seed…');

  // -------------------------------------------------------------------------
  // 1. UNITS — Adjacency List hierarchy
  //    KPN Corp Head Office (root)
  //      ├── IT Department
  //      ├── HR Department
  //      └── HSE Department
  // -------------------------------------------------------------------------
  const headOffice = await prisma.unit.upsert({
    where: { code: 'HOLDING-KPN' },
    update: {},
    create: {
      code: 'HOLDING-KPN',
      name: 'KPN Corp Head Office',
      description: 'Root holding unit — parent of all departmental nodes',
      parentId: null,
      isActive: true,
    },
  });

  const [itDept, hrDept, hseDept] = await Promise.all([
    prisma.unit.upsert({
      where: { code: 'DEPT-IT' },
      update: {},
      create: {
        code: 'DEPT-IT',
        name: 'IT Department',
        description: 'Information Technology Division',
        parentId: headOffice.id,
        isActive: true,
      },
    }),
    prisma.unit.upsert({
      where: { code: 'DEPT-HR' },
      update: {},
      create: {
        code: 'DEPT-HR',
        name: 'HR Department',
        description: 'Human Resources Division',
        parentId: headOffice.id,
        isActive: true,
      },
    }),
    prisma.unit.upsert({
      where: { code: 'DEPT-HSE' },
      update: {},
      create: {
        code: 'DEPT-HSE',
        name: 'HSE Department',
        description: 'Health, Safety & Environment Division',
        parentId: headOffice.id,
        isActive: true,
      },
    }),
  ]);

  console.log(
    `   ✓ Units   → ${headOffice.name} | ${itDept.name} | ${hrDept.name} | ${hseDept.name}`,
  );

  // -------------------------------------------------------------------------
  // 2. PERMISSIONS — CASL-compatible action:subject matrix
  //    Each row becomes one CASL ability rule in the application layer.
  // -------------------------------------------------------------------------
  const permissionDefs = [
    // --- global ---
    { action: 'manage', subject: 'all',          description: 'Unrestricted access to every resource' },
    // --- User ---
    { action: 'create', subject: 'User',         description: 'Create new employee accounts' },
    { action: 'read',   subject: 'User',         description: 'View employee profiles' },
    { action: 'update', subject: 'User',         description: 'Modify employee data' },
    { action: 'delete', subject: 'User',         description: 'Soft-delete / deactivate employees' },
    // --- LeaveRequest ---
    { action: 'create', subject: 'LeaveRequest', description: 'Submit a leave request' },
    { action: 'read',   subject: 'LeaveRequest', description: 'View leave requests' },
    { action: 'update', subject: 'LeaveRequest', description: 'Approve, reject, or edit leave requests' },
    { action: 'delete', subject: 'LeaveRequest', description: 'Cancel or remove leave requests' },
    // --- Unit ---
    { action: 'read',   subject: 'Unit',         description: 'View org-chart structure' },
    { action: 'manage', subject: 'Unit',         description: 'Full control over org units' },
  ] as const;

  const seededPermissions = await Promise.all(
    permissionDefs.map((p) =>
      prisma.permission.upsert({
        where: { action_subject: { action: p.action, subject: p.subject } },
        update: { description: p.description },
        create: { action: p.action, subject: p.subject, description: p.description },
      }),
    ),
  );

  // Build a lookup map: "action:subject" → permissionId
  const permId = Object.fromEntries(
    seededPermissions.map((p) => [`${p.action}:${p.subject}`, p.id]),
  );

  console.log(`   ✓ Permissions → ${seededPermissions.length} entries`);

  // -------------------------------------------------------------------------
  // 3. ROLES — isSystem = true prevents deletion through the admin UI
  //    Permission keys are the "action:subject" strings defined above.
  // -------------------------------------------------------------------------
  const roleDefs = [
    {
      name: 'superadmin',
      description: 'Unrestricted system-wide access',
      permKeys: ['manage:all'],
    },
    {
      name: 'hr_manager',
      description: 'Manages all employee data, leave administration, and org units',
      permKeys: [
        'create:User', 'read:User', 'update:User', 'delete:User',
        'read:LeaveRequest', 'update:LeaveRequest', 'delete:LeaveRequest',
        'read:Unit',
      ],
    },
    {
      name: 'line_manager',
      description: 'Reviews and approves leave requests for direct reports',
      permKeys: [
        'read:User',
        'read:LeaveRequest', 'update:LeaveRequest',
        'read:Unit',
      ],
    },
    {
      name: 'employee',
      description: 'Standard employee — self-service leave management only',
      permKeys: [
        'read:User',
        'create:LeaveRequest', 'read:LeaveRequest',
        'read:Unit',
      ],
    },
  ];

  const roleIdByName: Record<string, string> = {};

  for (const def of roleDefs) {
    const role = await prisma.role.upsert({
      where: { name: def.name },
      update: { description: def.description },
      create: { name: def.name, description: def.description, isSystem: true },
    });

    roleIdByName[def.name] = role.id;

    await Promise.all(
      def.permKeys.map((key) => {
        const permissionId = permId[key];
        if (!permissionId) throw new Error(`Unknown permission key: "${key}"`);

        return prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          update: {},
          create: { roleId: role.id, permissionId },
        });
      }),
    );

    console.log(
      `   ✓ Role     → ${def.name} (${def.permKeys.length} permissions linked)`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. USERS
  //    Extended HR fields (job_title, salary, manager_id, etc.) live in the
  //    JSONB payload column. manager_id references User.id — resolved at
  //    runtime using the itManager record created below.
  // -------------------------------------------------------------------------

  // --- 4a. Admin (Head Office) ---
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@kpncorp.com' },
    update: {},
    create: {
      employeeId: 'ADM-001',
      email: 'admin@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName: 'Ary Admin',
      status: UserStatus.ACTIVE,
      unitId: headOffice.id,
      payload: {
        _v: 1,
        job_title: 'System Administrator',
        employment_status: 'permanent',
        join_date: '2020-01-15',
        gender: 'male',
        phone_number: '+62811000001',
        financials: { basic_salary: 25_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  // --- 4b. IT Manager (IT Department) — seeded before Staff so its ID is available ---
  const itManager = await prisma.user.upsert({
    where: { email: 'manager.it@kpncorp.com' },
    update: {},
    create: {
      employeeId: 'MGR-IT-001',
      email: 'manager.it@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName: 'Budi IT Manager',
      status: UserStatus.ACTIVE,
      unitId: itDept.id,
      payload: {
        _v: 1,
        job_title: 'Head of IT',
        employment_status: 'permanent',
        join_date: '2021-03-01',
        gender: 'male',
        phone_number: '+62811000002',
        financials: { basic_salary: 20_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  // --- 4c. Staff Engineer (IT Department) — manager_id points to itManager ---
  const staffUser = await prisma.user.upsert({
    where: { email: 'staff.it@kpncorp.com' },
    update: {},
    create: {
      employeeId: 'STF-IT-004',
      email: 'staff.it@kpncorp.com',
      passwordHash: HASHED_PASSWORD,
      fullName: 'Made Software Engineer',
      status: UserStatus.ACTIVE,
      unitId: itDept.id,
      payload: {
        _v: 1,
        job_title: 'Software Engineer',
        employment_status: 'permanent',
        join_date: '2023-06-01',
        gender: 'male',
        phone_number: '+62811000003',
        manager_id: itManager.id, // resolved after itManager is upserted above
        financials: { basic_salary: 12_000_000, currency: 'IDR' },
      } satisfies UserPayload,
    },
  });

  console.log(
    `   ✓ Users    → ${adminUser.fullName} | ${itManager.fullName} | ${staffUser.fullName}`,
  );

  // -------------------------------------------------------------------------
  // 5. USER ROLES — explicit join table (UserRole)
  // -------------------------------------------------------------------------
  const userRoleMappings = [
    { userId: adminUser.id, roleId: roleIdByName['superadmin'],   label: 'superadmin' },
    { userId: itManager.id, roleId: roleIdByName['line_manager'],  label: 'line_manager' },
    { userId: staffUser.id, roleId: roleIdByName['employee'],      label: 'employee' },
  ];

  await Promise.all(
    userRoleMappings.map(({ userId, roleId }) =>
      prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId } },
        update: {},
        create: { userId, roleId },
      }),
    ),
  );

  console.log(
    `   ✓ UserRole → ${userRoleMappings.map((m) => m.label).join(' | ')}`,
  );

  console.log('\n✅  Seed completed successfully.\n');
  console.log('  Default credentials (all users):');
  console.log('    password : "password"');
  console.log(`    hash     : ${HASHED_PASSWORD}\n`);
}

main()
  .catch((err: unknown) => {
    console.error('❌  Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

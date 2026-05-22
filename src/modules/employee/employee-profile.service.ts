import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeaveRequestStatus, LeaveType, Prisma, User, UserStatus } from '@prisma/client';

import { CaslAbilityFactory } from '../../casl/casl-ability.factory';
import { subject } from '../../casl/casl.types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GetEmployeeDetailsBodyDto,
  OrgChartQueryDto,
} from './dto/profile-query.dto';
import type {
  DWContractFields,
  DWCurrentBtnDetails,
  DWDesignationFields,
  DWEmployeeTypeFields,
  DWEmploymentSection,
  DWJobLevelFields,
  DWManagerFields,
  DWNeevLevelFields,
  DWOfficeLocationFields,
  DWSwitchBtnDetails,
  ViewEmploymentDetailsResponse,
} from './types/employment-details.types';
import type { ViewOrgChartDetailsResponse }    from './types/org-chart.types';
import type { ViewAttendanceStatusResponse }  from './types/attendance-status.types';
import { GetAttendanceStatusBodyDto }         from './types/attendance-status.types';

export type { ViewEmploymentDetailsResponse } from './types/employment-details.types';
export type { ViewOrgChartDetailsResponse }   from './types/org-chart.types';
export type { ViewAttendanceStatusResponse }  from './types/attendance-status.types';
export { GetAttendanceStatusBodyDto }         from './types/attendance-status.types';

// =============================================================================
// ProfileModuleFlags — per-employee feature-flag object stored at
// User.payload.modules.
//
// Mirrors the exact key names in the Darwinbox
// /Profileapi/enabledModulesListForProfileApi response envelope so the
// stored flags can be spread directly into the response without renaming.
//
// All keys are optional inside the payload so partial overrides are valid:
// e.g. only setting { time_management: true } leaves all other flags at
// their system defaults. The service merges: env defaults → static defaults
// → per-user payload flags (payload wins).
// =============================================================================

export interface ProfileModuleFlags {
  vibe?:                boolean;
  rnr?:                 boolean;
  skills?:              boolean;
  time_management?:     boolean;
  hover_data_enabled?:  boolean;
  enable_appreciations?: boolean;
}

// =============================================================================
// EnabledModuleFlagsResponse — the response envelope for
// POST /Profileapi/enabledModulesListForProfileApi.
//
// All keys are required in the response — absent payload flags resolve to
// system defaults before this object is constructed.
// =============================================================================

export interface EnabledModuleFlagsResponse {
  vibe:                boolean;
  rnr:                 boolean;
  skills:              boolean;
  time_management:     boolean;
  hover_data_enabled:  boolean;
  enable_appreciations: boolean;
}

// =============================================================================
// DarwinboxFileAttachment — S3-backed file reference in the Darwinbox wire
// format. Returned inside resume, document, and transcript fields by the
// ViewProfileDetails endpoint.
// =============================================================================

export interface DarwinboxFileAttachment {
  Key:               string;
  Bucket:            string;
  file_name:         string;
  show_download_btn: boolean;
  ObjectURL:         string;
  delete_btn_details: {
    show:  boolean;
    label: string;
  };
}

// =============================================================================
// EmployeePayload — canonical TypeScript interface for User.payload JSONB.
//
// This interface is the single source of truth for the payload shape across
// the entire employee module. It is intentionally EXPORTED so that:
//   - The controller can type-hint partial destructured slices.
//   - Future modules (e.g. RewardSanction) can import it without re-defining
//     the same structure.
//
// Versioned at _v: 1. When a field is added, bump _v and migrate existing rows.
// =============================================================================

export interface EmployeePayload {
  _v: 1;

  darwinbox?: {
    synced_at?: string;          // ISO 8601 — last successful sync timestamp
    source_employee_id?: string; // Darwinbox internal ID (≠ employee_no)
  };

  personal?: {
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
    full_name_ktp?: string;
    ethnic_group?: string;
    homebase?: string;
    anniversary_date?: string;
    citizenship_status?: string;
    mobile_access?: string;
    personal_email?: string;
    phone_country_code?: string;
    additional_email?: string;
  };

  employment?: {
    designation?: string;
    designation_id?: string;
    department?: string;
    department_id?: string;
    employment_type?: string;
    emp_sub_type?: string;
    date_of_joining?: string;
    probation_end_date?: string | null;
    contract_end_date?: string | null;
    location?: string;
    branch_id?: string;
    cost_center?: string;
    company_id?: string;
    // ViewEmploymentDetails extra fields
    group_company?: string;
    from_date?: string;
    job_level?: string;
    company_entity_name?: string;
    contract_duration?: string;
    location_area?: string;
    location_country?: string;
    location_state?: string;
    location_city?: string;
  };

  manager_snapshot?: {
    employee_no?: string;
    name?: string;
    designation?: string;
    email?: string;
  };

  addresses?: Array<{
    type: string;
    street?: string;
    city?: string;
    province?: string;
    postal_code?: string;
    country?: string;
  }>;

  education_history?: Array<{
    level?: string;
    institution?: string;
    major?: string;
    year_from?: number;
    year_to?: number;
    gpa?: string;
    max_gpa?: string;
    start_date_text?: string;
    end_date_text?: string;
    is_currently_student?: boolean;
    is_highest_qualification?: boolean;
    documents?: DarwinboxFileAttachment[];
    transcripts?: DarwinboxFileAttachment[];
  }>;

  work_experience?: Array<{
    company_name?: string;
    designation?: string;
    start_date?: string;
    end_date?: string | null;
    reason_for_leaving?: string;
    division_department?: string;
    final_designation?: string;
    is_currently_working?: boolean;
    job_summary?: string;
    company_address?: string;
    documents?: DarwinboxFileAttachment[];
  }>;

  emergency_contacts?: Array<{
    name?: string;
    relationship?: string;
    phone?: string;
  }>;

  family_details?: Array<Record<string, unknown>>;

  /**
   * PLT / dual-position UUIDs — managed exclusively by HR admins in KPNHCIS.
   * Never overwritten by Darwinbox sync (Darwinbox has no PLT concept).
   * Read by XState workflows to authorise approvers who hold acting positions.
   */
  positionIds?: string[];

  /**
   * Org-chart metadata.  Dotted-line count is stored here because it is not
   * derivable from the adjacency-list manager_id column alone — it requires
   * a separate relationship type that Darwinbox manages.  HR admins set it
   * manually; the service defaults to 0 when the key is absent.
   */
  org?: {
    dotted_line_reportees_count?: number;
  };

  /**
   * Per-employee feature-flag overrides for the profile module panel.
   * Each key maps directly to a boolean flag in the Darwinbox
   * /Profileapi/enabledModulesListForProfileApi response envelope.
   * Absent keys fall back to MODULE_FLAGS_DEFAULTS in the service layer.
   * Set/updated by the HR admin console — never overwritten by Darwinbox sync.
   */
  modules?: ProfileModuleFlags;

  profile?: {
    avatarUrl?: string;
    bio?: string;
    linkedin?: string;
    facebook?: string;
    resume?: DarwinboxFileAttachment | null;
  };
}

// =============================================================================
// Darwinbox-format response interfaces
//
// These mirror the real Darwinbox /Commondata/getemployeeDetails wire format
// exactly so the Vue 3 / Quasar frontend can switch between the real Darwinbox
// and this backend without changing its API integration code.
// =============================================================================

export interface DarwinboxDateTimeConfig {
  date_format: string;
  time_format: string;
  timezone: string;
  profile_timezone: string;
  abbreviation: string;
}

export interface DarwinboxReporteeItem {
  user_id: string;
  name: string;
  pic48: string | null;
  email: string;
  role: string;
  employee_no: string;
  is_active: boolean;
  department: string;
  department_id: string | null;
}

export interface DarwinboxUserDetails {
  user_id: string;
  name: string;
  pic48: string | null;
  email: string;
  phone: string;
  office_location: string;
  total_reportee_count: number;
  role: string;
  employee_no: string;
  is_active: boolean;
  has_access_to_automationhub_workflow: false;
  has_access_to_recipe_view: false;
  first_characters: string;
  tenant_id: string;
  subdomain: string;
  isManager: 0 | 1;
  language: string;
  reportees: DarwinboxReporteeItem[];
  pic320: string | null;
  pic25: string | null;
  employee_type: string;
  department: string;
  department_id: string | null;
  position_id: string | null;
  position_name: string;
  date_time_config: DarwinboxDateTimeConfig;
  is_only_onboarding_spoc: false;
  unique_tenant_code: string;
}

export interface DarwinboxEmployeeDetailsResponse {
  is_admin: 0 | 1;
  status: 1;
  message: 'Successfully loaded employee details';
  user_details: DarwinboxUserDetails;
  pendo_details: never[];
}

// =============================================================================
// ViewProfileDetails — Darwinbox wire format for
// GET /Profileapi/ViewProfileDetails
// =============================================================================

export interface DWTab {
  label: string;
  key:   string;
}

export interface DWUserImageSrc {
  Key:       string;
  Bucket:    string;
  ObjectURL: string;
}

export interface DWUserImage {
  type:              'image';
  src:               DWUserImageSrc | null;
  first_characters:  string;
  placeholder_color: string;
}

export interface DWManagerDetails {
  employee_id: string;
  name:        string;
  designation: string;
  user_image:  DWUserImage;
}

export interface DWSocial {
  linkedin: string;
  facebook: string;
  resume:   DarwinboxFileAttachment | null;
}

export interface DWProfileHeader {
  user_image:      DWUserImage;
  manager_details: DWManagerDetails | null;
  role_value:      string;
  social:          DWSocial;
}

export interface DWOverviewItem {
  key:   string;
  label: string;
  value: string | null;
  type:  'text' | 'date';
}

export interface DWOverviewData {
  items: DWOverviewItem[];
}

export interface DWField {
  key:         string;
  label:       string;
  value:       string | DarwinboxFileAttachment | null;
  type:        'text' | 'date' | 'select' | 'phone' | 'email' | 'file';
  is_editable: boolean;
}

export interface DWSection {
  fields: DWField[];
}

export interface DWAddButton {
  show:  boolean;
  label: string;
}

export interface DWGridRow {
  row_id:      string;
  fields:      DWField[];
  documents?:  DarwinboxFileAttachment[];
  transcripts?: DarwinboxFileAttachment[];
}

export interface DWGrid {
  rows:    DWGridRow[];
  total:   number;
  add_btn: DWAddButton;
}

export interface DWPersonalDetailsData {
  biography:         { data: DWSection };
  contact:           { data: DWSection };
  addresses: {
    current:   { data: DWSection };
    permanent: { data: DWSection };
  };
  resume_details:    { data: DWSection };
  work_experience:   { data: DWGrid };
  job_details:       { data: DWSection };
  education_details: { data: DWGrid };
}

export interface ViewProfileDetailsResponse {
  status:                1;
  tabs:                  DWTab[];
  profile_header:        DWProfileHeader;
  overview_data:         DWOverviewData;
  employee_id:           string;
  position_id:           string | null;
  department_id:         string | null;
  personal_details_data: DWPersonalDetailsData;
}

export interface EmploymentDetailsResponse {
  userId: string;
  employeeId: string;
  fullName: string;
  employment: NonNullable<EmployeePayload['employment']>;
  work_experience: NonNullable<EmployeePayload['work_experience']>;
  education_history: NonNullable<EmployeePayload['education_history']>;
  /**
   * PLT / dual-position UUIDs — the critical field for XState approval chain
   * resolution. The workflow engine checks this array to determine if an approver
   * holds a temporary acting position that grants approval authority.
   */
  positionIds: string[];
  unit: { id: string; name: string; code: string } | null;
}

interface OrgChartNode {
  id: string;
  employeeId: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  unit: { id: string; name: string; code: string } | null;
  avatarUrl: string | null;
}

export interface OrgChartResponse {
  user: OrgChartNode;
  manager: OrgChartNode | null;
  directReports: OrgChartNode[];
  totalDirectReports: number;
}

// =============================================================================
// Pure utility — no external dependencies, safe to unit-test in isolation.
// =============================================================================

/**
 * Builds the 2-character avatar initials Darwinbox calls "first_characters".
 * Logic: first letter of the first word + first letter of the last word.
 * "Budi Santoso" → "BS", "Nama Panjang Karyawan" → "NK", "Mono" → "MO".
 */
function buildFirstCharacters(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// =============================================================================
// MODULE_FLAGS_DEFAULTS — compile-time constants for the three-tier merge:
//
//   Tier 1 (lowest):  these compile-time values
//   Tier 2 (middle):  env vars MODULE_FLAG_<KEY> read at request time
//   Tier 3 (highest): per-employee payload.modules flags set by HR admins
//
// Changing a default here affects every employee that has no explicit per-user
// override AND no matching env var — i.e. a new deployment's "out of the box"
// state. Toggle feature flags in .env to roll out globally without touching
// the DB.
// =============================================================================

const MODULE_FLAGS_DEFAULTS: Readonly<Required<ProfileModuleFlags>> = {
  vibe:                 false,
  rnr:                  false,
  skills:               false,
  time_management:      false,
  hover_data_enabled:   false,
  enable_appreciations: false,
};

// =============================================================================
// Employment grid constants — shared defaults for every DWEmploymentSection.
// =============================================================================

const DW_SWITCH_DEFAULTS: DWSwitchBtnDetails = {
  view_modes:   ['list', 'grid'],
  default_view: 'grid',
} as const;

const DW_CURRENT_BTN: DWCurrentBtnDetails = {
  show_current_btn: true,
  label:            'Current',
} as const;

// =============================================================================
// Prisma select constants — explicit field allowlists.
// Sensitive columns (passwordHash, refreshTokenHash) are intentionally absent.
// =============================================================================

const UNIT_SELECT = { id: true, name: true, code: true } as const;

const ORG_NODE_SELECT = {
  id: true,
  employeeId: true,
  fullName: true,
  payload: true,
  unit: { select: UNIT_SELECT },
} satisfies Prisma.UserSelect;

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class EmployeeProfileService {
  private readonly logger = new Logger(EmployeeProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // getEmployeeDetails
  //
  // Backs POST /Commondata/getemployeeDetails.
  //
  // Returns a single employee's data in the exact Darwinbox wire format so the
  // Vue 3 / Quasar frontend can use the same integration code against both the
  // real Darwinbox and this backend.
  //
  // Lookup priority for dto.user_id:
  //   1. payload.darwinbox.source_employee_id — Darwinbox's internal numeric ID
  //      (stored during sync; queried via GIN @> containment index)
  //   2. User.employeeId — company employee_no fallback
  //
  // When dto.user_id is omitted, the requesting user's own record is returned.
  //
  // Authorization:
  //   - Own data: always permitted (guard already enforces read:User).
  //   - Cross-user lookup: assertProfileAccess enforces admin/HR check.
  // ---------------------------------------------------------------------------
  async getEmployeeDetails(
    requestingUser: User,
    dto: GetEmployeeDetailsBodyDto,
  ): Promise<DarwinboxEmployeeDetailsResponse> {
    // ── 1. Resolve the target user ────────────────────────────────────────────
    const targetId = await this.resolveTargetUserId(requestingUser.id, dto.user_id);
    await this.assertProfileAccess(requestingUser, targetId);

    // ── 2. Fetch full user record ─────────────────────────────────────────────
    const user = await this.prisma.user.findFirst({
      where:  { id: targetId, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        email: true,
        fullName: true,
        status: true,
        payload: true,
        unit: { select: UNIT_SELECT },
        roles: {
          select: {
            role: {
              select: {
                permissions: {
                  select: {
                    permission: { select: { action: true, subject: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException(`Employee not found.`);

    const p = user.payload as unknown as EmployeePayload | null;

    // ── 3. Resolve managerId + subordinate count via raw SQL ─────────────────
    type ManagerRef = { manager_id: string | null };
    const [managerRefs, countRows] = await Promise.all([
      this.prisma.$queryRaw<ManagerRef[]>`
        SELECT manager_id FROM users WHERE id = ${user.id}::uuid
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count FROM users
        WHERE  manager_id = ${user.id}::uuid AND deleted_at IS NULL
      `,
    ]);
    const totalReporteeCount = Number(countRows[0].count);

    // ── 4. Fetch direct reports (first 10 for the reportees array) ────────────
    type SubIdRow = { id: string };
    const subIdRows = await this.prisma.$queryRaw<SubIdRow[]>`
      SELECT id FROM users
      WHERE  manager_id = ${user.id}::uuid AND deleted_at IS NULL
      ORDER  BY full_name ASC
      LIMIT  10
    `;

    const reportees: DarwinboxReporteeItem[] = [];
    if (subIdRows.length > 0) {
      const subs = await this.prisma.user.findMany({
        where:  { id: { in: subIdRows.map((r) => r.id) }, deletedAt: null },
        select: { id: true, employeeId: true, email: true, fullName: true, status: true, payload: true },
        orderBy: { fullName: 'asc' },
      });
      for (const s of subs) {
        const sp = s.payload as unknown as EmployeePayload | null;
        reportees.push({
          user_id:      sp?.darwinbox?.source_employee_id ?? s.employeeId,
          name:         s.fullName,
          pic48:        sp?.profile?.avatarUrl ?? null,
          email:        s.email,
          role:         sp?.employment?.designation ?? '',
          employee_no:  s.employeeId,
          is_active:    s.status === UserStatus.ACTIVE,
          department:   sp?.employment?.department ?? '',
          department_id: sp?.employment?.department_id ?? null,
        });
      }
    }

    // ── 5. Determine is_admin ─────────────────────────────────────────────────
    // A user is admin if any of their roles grants manage:all.
    const isAdmin: 0 | 1 = user.roles.some((ur) =>
      ur.role.permissions.some(
        (rp) => rp.permission.action === 'manage' && rp.permission.subject === 'all',
      ),
    )
      ? 1
      : 0;

    // ── 6. Build Darwinbox-format response ────────────────────────────────────
    const avatarUrl = p?.profile?.avatarUrl ?? null;
    const tenantId        = this.config.get<string>('DARWINBOX_TENANT_ID',        '');
    const subdomain       = this.config.get<string>('DARWINBOX_SUBDOMAIN',        '');
    const uniqueTenantCode = this.config.get<string>('DARWINBOX_UNIQUE_TENANT_CODE', '');

    const userDetails: DarwinboxUserDetails = {
      user_id:       p?.darwinbox?.source_employee_id ?? user.employeeId,
      name:          user.fullName,
      pic48:         avatarUrl,
      pic320:        avatarUrl,
      pic25:         avatarUrl,
      email:         user.email,
      phone:         p?.personal?.phone ?? '',
      office_location: [
        p?.employment?.location,
        p?.employment?.department,
      ].filter(Boolean).join(', '),
      total_reportee_count:              totalReporteeCount,
      role:                              p?.employment?.designation ?? '',
      employee_no:                       user.employeeId,
      is_active:                         user.status === UserStatus.ACTIVE,
      has_access_to_automationhub_workflow: false,
      has_access_to_recipe_view:            false,
      first_characters:                  buildFirstCharacters(user.fullName),
      tenant_id:                         tenantId,
      subdomain:                         subdomain,
      isManager:                         totalReporteeCount > 0 ? 1 : 0,
      language:                          '',
      reportees,
      employee_type:                     p?.employment?.employment_type ?? '',
      department:                        p?.employment?.department      ?? '',
      department_id:                     p?.employment?.department_id   ?? null,
      position_id:                       p?.positionIds?.[0]            ?? null,
      position_name:                     '',
      date_time_config: {
        date_format:     this.config.get<string>('DATE_FORMAT', 'd-m-Y'),
        time_format:     this.config.get<string>('TIME_FORMAT', '24'),
        timezone:        this.config.get<string>('APP_TIMEZONE', 'Asia/Bangkok'),
        profile_timezone: this.config.get<string>('APP_TIMEZONE', 'Asia/Bangkok'),
        abbreviation:    this.config.get<string>(
          'TIMEZONE_ABBREVIATION',
          '(UTC+07:00) Bangkok, Hanoi, Jakarta',
        ),
      },
      is_only_onboarding_spoc: false,
      unique_tenant_code:      uniqueTenantCode,
    };

    this.logger.debug(
      `getEmployeeDetails: resolved user ${user.employeeId} ` +
      `(source_id=${p?.darwinbox?.source_employee_id}) ` +
      `reportees=${totalReporteeCount} is_admin=${isAdmin}`,
    );

    return {
      is_admin:     isAdmin,
      status:       1,
      message:      'Successfully loaded employee details',
      user_details: userDetails,
      pendo_details: [],
    };
  }

  // ---------------------------------------------------------------------------
  // getEnabledModules
  //
  // Backs POST /Profileapi/enabledModulesListForProfileApi
  //
  // Returns the exact boolean-flag envelope the Darwinbox wire format specifies:
  //   { vibe, rnr, skills, time_management, hover_data_enabled,
  //     enable_appreciations }
  //
  // Three-tier resolution for each flag (last write wins):
  //   1. MODULE_FLAGS_DEFAULTS compile-time constants (lowest priority)
  //   2. MODULE_FLAG_<KEY> environment variables (deployment-level overrides)
  //   3. payload.modules per-employee JSONB flags (highest priority)
  //
  // This means:
  //   - A fresh deployment returns all false (Tier 1).
  //   - Setting MODULE_FLAG_TIME_MANAGEMENT=true in .env enables it globally
  //     without any DB changes.
  //   - HR admin toggling a flag for one employee writes to payload.modules
  //     and overrides the env default only for that person.
  //
  // The userId parameter is always the authenticated user's own UUID (extracted
  // from the JWT in the controller). Cross-user flag access is not exposed on
  // this endpoint — the Darwinbox wire format calls it session-scoped.
  // ---------------------------------------------------------------------------
  async getEnabledModules(userId: string): Promise<EnabledModuleFlagsResponse> {
    const user = await this.prisma.user.findFirst({
      where:  { id: userId, deletedAt: null },
      select: { id: true, payload: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found.`);

    const p      = user.payload as unknown as EmployeePayload | null;
    const stored = p?.modules ?? {};

    // Tier 2: read env overrides once (ConfigService.get returns undefined
    // for unset vars, so the nullish coalescing preserves the Tier-1 default).
    const envFlags: Required<ProfileModuleFlags> = {
      vibe:                 this.config.get<boolean>('MODULE_FLAG_VIBE')                 ?? MODULE_FLAGS_DEFAULTS.vibe,
      rnr:                  this.config.get<boolean>('MODULE_FLAG_RNR')                  ?? MODULE_FLAGS_DEFAULTS.rnr,
      skills:               this.config.get<boolean>('MODULE_FLAG_SKILLS')               ?? MODULE_FLAGS_DEFAULTS.skills,
      time_management:      this.config.get<boolean>('MODULE_FLAG_TIME_MANAGEMENT')      ?? MODULE_FLAGS_DEFAULTS.time_management,
      hover_data_enabled:   this.config.get<boolean>('MODULE_FLAG_HOVER_DATA_ENABLED')   ?? MODULE_FLAGS_DEFAULTS.hover_data_enabled,
      enable_appreciations: this.config.get<boolean>('MODULE_FLAG_ENABLE_APPRECIATIONS') ?? MODULE_FLAGS_DEFAULTS.enable_appreciations,
    };

    // Tier 3: per-employee payload flags override env flags.
    // Each key uses `?? envFlags.<key>` so an explicit `false` in the payload
    // correctly overrides an env-level `true`.
    return {
      vibe:                 stored.vibe                 ?? envFlags.vibe,
      rnr:                  stored.rnr                  ?? envFlags.rnr,
      skills:               stored.skills               ?? envFlags.skills,
      time_management:      stored.time_management      ?? envFlags.time_management,
      hover_data_enabled:   stored.hover_data_enabled   ?? envFlags.hover_data_enabled,
      enable_appreciations: stored.enable_appreciations ?? envFlags.enable_appreciations,
    };
  }

  // ---------------------------------------------------------------------------
  // viewProfileDetails
  //
  // Backs GET /Profileapi/ViewProfileDetails?user_id=...
  //
  // Returns the full Darwinbox ViewProfileDetails wire format:
  //   profile_header — avatar, manager snapshot, designation, social links
  //   overview_data  — key employment facts grid
  //   personal_details_data — biography, contact, addresses, resume, work
  //     experience, job details, education (all as DW section / grid types)
  //
  // user_id resolution order (three-pass via resolveTargetUserId):
  //   1. payload.darwinbox.source_employee_id (GIN-indexed)
  //   2. User.employeeId (company employee_no)
  //   3. Internal UUID (for direct service consumers)
  // ---------------------------------------------------------------------------
  async viewProfileDetails(
    requestingUser: User,
    userIdParam?: string,
  ): Promise<ViewProfileDetailsResponse> {
    const targetUserId = await this.resolveTargetUserId(requestingUser.id, userIdParam);
    await this.assertProfileAccess(requestingUser, targetUserId);

    const user = await this.prisma.user.findFirst({
      where:  { id: targetUserId, deletedAt: null },
      select: {
        id:         true,
        employeeId: true,
        fullName:   true,
        email:      true,
        payload:    true,
        unit:       { select: UNIT_SELECT },
      },
    });
    if (!user) throw new NotFoundException(`User ${targetUserId} not found.`);

    const p = user.payload as unknown as EmployeePayload | null;

    // Resolve manager via raw SQL (manager_id column not yet in Prisma types)
    type ManagerRef = { manager_id: string | null };
    const managerRefs = await this.prisma.$queryRaw<ManagerRef[]>`
      SELECT manager_id FROM users WHERE id = ${targetUserId}::uuid
    `;
    const managerId = managerRefs[0]?.manager_id ?? null;

    const managerRecord = managerId
      ? await this.prisma.user.findFirst({
          where:  { id: managerId, deletedAt: null },
          select: { id: true, employeeId: true, fullName: true, payload: true },
        })
      : null;

    const mp = managerRecord?.payload as unknown as EmployeePayload | null;

    return {
      status: 1,
      tabs:   this.buildTabs(),
      profile_header: this.buildProfileHeader(user, managerRecord, mp, p),
      overview_data:  this.buildOverviewData(user.employeeId, p),
      employee_id:    p?.darwinbox?.source_employee_id ?? user.employeeId,
      position_id:    p?.positionIds?.[0] ?? null,
      department_id:  p?.employment?.department_id ?? null,
      personal_details_data: {
        biography:       { data: this.buildBiographicalSection(p) },
        contact:         { data: this.buildContactSection(p, user.email) },
        addresses: {
          current:   { data: this.buildAddressSection(p?.addresses?.find(a => a.type === 'current')) },
          permanent: { data: this.buildAddressSection(p?.addresses?.find(a => a.type === 'permanent')) },
        },
        resume_details:    { data: this.buildResumeSection(p?.profile) },
        work_experience:   { data: this.buildWorkExperienceGrid(p?.work_experience ?? []) },
        job_details:       { data: this.buildJobDetailsSection(p) },
        education_details: { data: this.buildEducationGrid(p?.education_history ?? []) },
      },
    };
  }

  // ── ViewProfileDetails builder helpers ──────────────────────────────────────

  private buildTabs(): DWTab[] {
    return [
      { label: 'Biography',       key: 'biography' },
      { label: 'Contact',         key: 'contact' },
      { label: 'Addresses',       key: 'addresses' },
      { label: 'Resume',          key: 'resume_details' },
      { label: 'Work Experience', key: 'work_experience' },
      { label: 'Job Details',     key: 'job_details' },
      { label: 'Education',       key: 'education_details' },
    ];
  }

  private buildDWUserImage(
    avatarUrl: string | null | undefined,
    fullName: string,
  ): DWUserImage {
    return {
      type: 'image',
      src:  avatarUrl
        ? { Key: '', Bucket: '', ObjectURL: avatarUrl }
        : null,
      first_characters:  buildFirstCharacters(fullName),
      placeholder_color: '#3498db',
    };
  }

  private buildProfileHeader(
    user:          { employeeId: string; fullName: string },
    managerRecord: { id: string; employeeId: string; fullName: string } | null,
    mp:            EmployeePayload | null,
    p:             EmployeePayload | null,
  ): DWProfileHeader {
    const managerDetails: DWManagerDetails | null = managerRecord
      ? {
          employee_id: mp?.darwinbox?.source_employee_id ?? managerRecord.employeeId,
          name:        managerRecord.fullName,
          designation: mp?.employment?.designation ?? '',
          user_image:  this.buildDWUserImage(mp?.profile?.avatarUrl, managerRecord.fullName),
        }
      : null;

    return {
      user_image:      this.buildDWUserImage(p?.profile?.avatarUrl, user.fullName),
      manager_details: managerDetails,
      role_value:      p?.employment?.designation ?? '',
      social: {
        linkedin: p?.profile?.linkedin ?? '',
        facebook: p?.profile?.facebook ?? '',
        resume:   p?.profile?.resume   ?? null,
      },
    };
  }

  private buildOverviewData(
    employeeId: string,
    p: EmployeePayload | null,
  ): DWOverviewData {
    return {
      items: [
        { key: 'employee_no',     label: 'Employee ID',     value: employeeId,                          type: 'text' },
        { key: 'department',      label: 'Department',      value: p?.employment?.department      ?? null, type: 'text' },
        { key: 'designation',     label: 'Designation',     value: p?.employment?.designation     ?? null, type: 'text' },
        { key: 'employment_type', label: 'Employment Type', value: p?.employment?.employment_type ?? null, type: 'text' },
        { key: 'date_of_joining', label: 'Date of Joining', value: p?.employment?.date_of_joining ?? null, type: 'date' },
        { key: 'location',        label: 'Location',        value: p?.employment?.location        ?? null, type: 'text' },
      ],
    };
  }

  private buildBiographicalSection(p: EmployeePayload | null): DWSection {
    const q = p?.personal;
    return {
      fields: [
        { key: 'a64f0088cf2748',     label: 'Full Name (KTP)',    value: q?.full_name_ktp       ?? null, type: 'text',   is_editable: true },
        { key: 'date_of_birth',      label: 'Date of Birth',      value: q?.date_of_birth       ?? null, type: 'date',   is_editable: true },
        { key: 'place_of_birth',     label: 'Place of Birth',     value: q?.place_of_birth      ?? null, type: 'text',   is_editable: true },
        { key: 'gender',             label: 'Gender',             value: q?.gender              ?? null, type: 'select', is_editable: true },
        { key: 'marital_status',     label: 'Marital Status',     value: q?.marital_status      ?? null, type: 'select', is_editable: true },
        { key: 'religion',           label: 'Religion',           value: q?.religion            ?? null, type: 'select', is_editable: true },
        { key: 'blood_group',        label: 'Blood Group',        value: q?.blood_group         ?? null, type: 'select', is_editable: true },
        { key: 'nationality',        label: 'Nationality',        value: q?.nationality         ?? null, type: 'text',   is_editable: true },
        { key: 'a64f00862f38c7',     label: 'Ethnic Group',       value: q?.ethnic_group        ?? null, type: 'text',   is_editable: true },
        { key: 'a655ef3538b768',     label: 'Homebase',           value: q?.homebase            ?? null, type: 'text',   is_editable: true },
        { key: 'anniversary_date',   label: 'Anniversary Date',   value: q?.anniversary_date    ?? null, type: 'date',   is_editable: true },
        { key: 'citizenship_status', label: 'Citizenship Status', value: q?.citizenship_status  ?? null, type: 'text',   is_editable: true },
        { key: 'nik',                label: 'NIK',                value: q?.nik                 ?? null, type: 'text',   is_editable: true },
        { key: 'npwp',               label: 'NPWP',               value: q?.npwp                ?? null, type: 'text',   is_editable: true },
      ],
    };
  }

  private buildContactSection(p: EmployeePayload | null, email: string): DWSection {
    const q = p?.personal;
    return {
      fields: [
        { key: 'email',              label: 'Work Email',          value: email,                           type: 'email', is_editable: false },
        { key: 'personal_email',     label: 'Personal Email',      value: q?.personal_email     ?? null,   type: 'email', is_editable: true  },
        { key: 'additional_email',   label: 'Additional Email',    value: q?.additional_email   ?? null,   type: 'email', is_editable: true  },
        { key: 'phone',              label: 'Phone',               value: q?.phone              ?? null,   type: 'phone', is_editable: true  },
        { key: 'phone_country_code', label: 'Phone Country Code',  value: q?.phone_country_code ?? null,   type: 'text',  is_editable: true  },
        { key: 'mobile_access',      label: 'Mobile Access',       value: q?.mobile_access      ?? null,   type: 'text',  is_editable: true  },
      ],
    };
  }

  private buildAddressSection(
    addr: NonNullable<EmployeePayload['addresses']>[number] | undefined,
  ): DWSection {
    return {
      fields: [
        { key: 'street',      label: 'Street',      value: addr?.street      ?? null, type: 'text', is_editable: true },
        { key: 'city',        label: 'City',         value: addr?.city        ?? null, type: 'text', is_editable: true },
        { key: 'province',    label: 'Province',     value: addr?.province    ?? null, type: 'text', is_editable: true },
        { key: 'postal_code', label: 'Postal Code',  value: addr?.postal_code ?? null, type: 'text', is_editable: true },
        { key: 'country',     label: 'Country',      value: addr?.country     ?? null, type: 'text', is_editable: true },
      ],
    };
  }

  private buildResumeSection(profile: EmployeePayload['profile']): DWSection {
    return {
      fields: [
        { key: 'linkedin', label: 'LinkedIn', value: profile?.linkedin ?? null, type: 'text', is_editable: true },
        { key: 'facebook', label: 'Facebook', value: profile?.facebook ?? null, type: 'text', is_editable: true },
        { key: 'resume',   label: 'Resume',   value: profile?.resume   ?? null, type: 'file', is_editable: true },
      ],
    };
  }

  private buildWorkExperienceGrid(
    experiences: NonNullable<EmployeePayload['work_experience']>,
  ): DWGrid {
    const rows: DWGridRow[] = experiences.map((exp, idx) => ({
      row_id: String(idx + 1),
      fields: [
        { key: 'company_name',        label: 'Company Name',          value: exp.company_name       ?? null, type: 'text', is_editable: true },
        { key: 'a64f00be1a5571',      label: 'Company Address',       value: exp.company_address    ?? null, type: 'text', is_editable: true },
        { key: 'designation',         label: 'Designation',           value: exp.designation        ?? null, type: 'text', is_editable: true },
        { key: 'a64f00c0e52d1e',      label: 'Final Designation',     value: exp.final_designation  ?? null, type: 'text', is_editable: true },
        { key: 'a6866366a5074a',      label: 'Division / Department', value: exp.division_department ?? null, type: 'text', is_editable: true },
        { key: 'start_date',          label: 'Start Date',            value: exp.start_date         ?? null, type: 'date', is_editable: true },
        { key: 'end_date',            label: 'End Date',              value: exp.end_date           ?? null, type: 'date', is_editable: true },
        { key: 'is_currently_working', label: 'Currently Working',   value: exp.is_currently_working != null ? String(exp.is_currently_working) : null, type: 'text', is_editable: true },
        { key: 'reason_for_leaving',  label: 'Reason for Leaving',    value: exp.reason_for_leaving ?? null, type: 'text', is_editable: true },
        { key: 'job_summary',         label: 'Job Summary',           value: exp.job_summary        ?? null, type: 'text', is_editable: true },
      ],
      documents: exp.documents ?? [],
    }));

    return {
      rows,
      total:   rows.length,
      add_btn: { show: true, label: 'Add Work Experience' },
    };
  }

  private buildJobDetailsSection(p: EmployeePayload | null): DWSection {
    const emp = p?.employment;
    return {
      fields: [
        { key: 'designation',        label: 'Designation',        value: emp?.designation        ?? null, type: 'text',   is_editable: false },
        { key: 'department',         label: 'Department',         value: emp?.department         ?? null, type: 'text',   is_editable: false },
        { key: 'employment_type',    label: 'Employment Type',    value: emp?.employment_type    ?? null, type: 'select', is_editable: false },
        { key: 'date_of_joining',    label: 'Date of Joining',    value: emp?.date_of_joining    ?? null, type: 'date',   is_editable: false },
        { key: 'probation_end_date', label: 'Probation End Date', value: emp?.probation_end_date ?? null, type: 'date',   is_editable: false },
        { key: 'contract_end_date',  label: 'Contract End Date',  value: emp?.contract_end_date  ?? null, type: 'date',   is_editable: false },
        { key: 'location',           label: 'Location',           value: emp?.location           ?? null, type: 'text',   is_editable: false },
        { key: 'cost_center',        label: 'Cost Centre',        value: emp?.cost_center        ?? null, type: 'text',   is_editable: false },
      ],
    };
  }

  private buildEducationGrid(
    education: NonNullable<EmployeePayload['education_history']>,
  ): DWGrid {
    const rows: DWGridRow[] = education.map((edu, idx) => ({
      row_id: String(idx + 1),
      fields: [
        { key: 'level',                    label: 'Level',                   value: edu.level              ?? null,                                                        type: 'select', is_editable: true },
        { key: 'institution',              label: 'Institution',             value: edu.institution        ?? null,                                                        type: 'text',   is_editable: true },
        { key: 'major',                    label: 'Major / Field of Study',  value: edu.major              ?? null,                                                        type: 'text',   is_editable: true },
        { key: 'year_from',                label: 'Start Year',              value: edu.year_from != null ? String(edu.year_from) : (edu.start_date_text ?? null),         type: 'text',   is_editable: true },
        { key: 'year_to',                  label: 'End Year',                value: edu.year_to   != null ? String(edu.year_to)   : (edu.end_date_text   ?? null),         type: 'text',   is_editable: true },
        { key: 'gpa',                      label: 'GPA',                     value: edu.gpa                ?? null,                                                        type: 'text',   is_editable: true },
        { key: 'max_gpa',                  label: 'Max GPA',                 value: edu.max_gpa            ?? null,                                                        type: 'text',   is_editable: true },
        { key: 'is_currently_student',     label: 'Currently Enrolled',      value: edu.is_currently_student     != null ? String(edu.is_currently_student)     : null,   type: 'text',   is_editable: true },
        { key: 'is_highest_qualification', label: 'Highest Qualification',   value: edu.is_highest_qualification != null ? String(edu.is_highest_qualification) : null,   type: 'text',   is_editable: true },
      ],
      documents:   edu.documents   ?? [],
      transcripts: edu.transcripts ?? [],
    }));

    return {
      rows,
      total:   rows.length,
      add_btn: { show: true, label: 'Add Education' },
    };
  }

  // ---------------------------------------------------------------------------
  // viewEmploymentDetails
  //
  // Backs GET /Profileapi/ViewEmploymentDetails?user_id=...
  //
  // Returns the full Darwinbox ViewEmploymentDetails wire format. Each
  // employment attribute is wrapped in a section envelope with a single
  // "current" grid snapshot.
  //
  // Sections produced:
  //   designation    — group_company, department, role title, effective date
  //   job_level      — grade code (e.g. "5B") and effective date
  //   neev_level     — legal company entity name and effective date
  //   officelocation — area, country, state, city and effective date
  //   manager        — supervisor card with Darwinbox hover-data HTML alias
  //   employee_type  — employment type, sub-type, effective date
  //   contract       — duration label + from_to with end-date annotation
  //
  // The manager section reads manager_id via raw SQL (FK not yet in Prisma
  // types until the migration runs) and hydrates the full manager record.
  // ---------------------------------------------------------------------------
  async viewEmploymentDetails(
    requestingUser: User,
    userIdParam?: string,
  ): Promise<ViewEmploymentDetailsResponse> {
    const targetUserId = await this.resolveTargetUserId(requestingUser.id, userIdParam);
    await this.assertProfileAccess(requestingUser, targetUserId);

    const user = await this.prisma.user.findFirst({
      where:  { id: targetUserId, deletedAt: null },
      select: {
        id:         true,
        employeeId: true,
        fullName:   true,
        payload:    true,
      },
    });
    if (!user) throw new NotFoundException(`User ${targetUserId} not found.`);

    const p   = user.payload as unknown as EmployeePayload | null;
    const emp = p?.employment;

    // ── Resolve manager via raw SQL ───────────────────────────────────────────
    type ManagerRef = { manager_id: string | null };
    const managerRefs = await this.prisma.$queryRaw<ManagerRef[]>`
      SELECT manager_id FROM users WHERE id = ${targetUserId}::uuid
    `;
    const managerId = managerRefs[0]?.manager_id ?? null;

    const managerRecord = managerId
      ? await this.prisma.user.findFirst({
          where:  { id: managerId, deletedAt: null },
          select: { id: true, employeeId: true, fullName: true, payload: true },
        })
      : null;
    const mp = managerRecord?.payload as unknown as EmployeePayload | null;

    // Effective date of the current assignment (from_date wins; falls back to
    // date_of_joining so a fresh record always renders a date rather than "Present").
    const fromDate = emp?.from_date ?? emp?.date_of_joining ?? null;

    this.logger.debug(
      `viewEmploymentDetails: user=${user.employeeId} ` +
      `manager=${managerRecord?.employeeId ?? 'none'} from=${fromDate}`,
    );

    return {
      status: 1,
      employment_details_data: {
        designation:    this.buildDesignationGrid(emp, user.employeeId, fromDate),
        job_level:      this.buildJobLevelGrid(emp, user.employeeId, fromDate),
        neev_level:     this.buildNeevLevelGrid(emp, user.employeeId, fromDate),
        officelocation: this.buildLocationGrid(emp, user.employeeId, fromDate),
        manager:        this.buildManagerGrid(managerRecord, mp, user.employeeId, fromDate),
        employee_type:  this.buildEmployeeTypeGrid(emp, user.employeeId, fromDate),
        contract:       this.buildContractGrid(emp, user.employeeId, fromDate),
      },
    };
  }

  // ── ViewEmploymentDetails builder helpers ──────────────────────────────────

  /**
   * Deterministic 14-character grid ID derived from section key + employeeId.
   * Uses a two-round FNV-1a hash so the ID is stable across restarts and
   * consistent with how Darwinbox formats its own grid IDs.
   */
  private sectionGridId(sectionKey: string, employeeId: string): string {
    const seed = `${employeeId}:${sectionKey}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x2166f619;
    for (let i = 0; i < seed.length; i++) {
      const c = seed.charCodeAt(i);
      h1 ^= c;
      h1  = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c;
      h2  = Math.imul(h2, 0x01000193) >>> 0;
    }
    // Mask to 24 bits before converting so each segment is always exactly 6 hex
    // chars — padStart pads to a minimum but does not truncate, so without the
    // mask a hash value ≥ 0x1000000 would produce a 7-8 char segment and break
    // the 14-char Darwinbox grid ID format ("a6" + 6 + 6).
    return 'a6' + (h1 & 0xFFFFFF).toString(16).padStart(6, '0') + (h2 & 0xFFFFFF).toString(16).padStart(6, '0');
  }

  /** Format an ISO date string (YYYY-MM-DD or ISO 8601) to dd-mm-yyyy. */
  private formatDateDMY(iso: string | undefined | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Date-only strings ("YYYY-MM-DD") parse as midnight UTC; UTC accessors
    // prevent an off-by-one-day error on servers in negative UTC offsets.
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  }

  /**
   * Build a "From - To" date-range string in Darwinbox format.
   *
   * Regular sections:  "dd-mm-yyyy - Present"
   * Contract section:  "dd-mm-yyyy - Present ( End Date dd-mm-yyyy )"
   *
   * When fromDateIso is absent the string falls back to "Present" so that
   * a local dev record with no history data still renders without errors.
   */
  private buildFromToStr(
    fromDateIso: string | undefined | null,
    endDateIso?: string | undefined | null,
  ): string {
    const from = this.formatDateDMY(fromDateIso);
    if (!from) return 'Present';
    if (endDateIso) {
      const end = this.formatDateDMY(endDateIso);
      return end ? `${from} - Present ( End Date ${end} )` : `${from} - Present`;
    }
    return `${from} - Present`;
  }

  private buildDesignationGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWDesignationFields> {
    return {
      label:              'Work Role',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('designation', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          group_company: {
            label:                     'Group Company',
            value:                     emp?.group_company ?? '',
            value_alias:               emp?.group_company ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
          },
          department: {
            label:                     'Unit',
            value:                     emp?.department ?? '',
            value_alias:               emp?.department ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
          },
          designation: {
            label:                     'Designation',
            value:                     emp?.designation ?? '',
            value_alias:               emp?.designation ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
            is_promotion_or_demotion:  '',
          },
          from_to: { label: 'From - To', value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildJobLevelGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWJobLevelFields> {
    return {
      label:              'Job Level',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('job_level', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          job_level: {
            label:                     'Job Level',
            value:                     emp?.job_level ?? '',
            value_alias:               emp?.job_level ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
            is_promotion_or_demotion:  '',
          },
          from_to: { label: 'From - To', value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildNeevLevelGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWNeevLevelFields> {
    return {
      label:              'Company Name',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('neev_level', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          neev_level: {
            label:                     'Company Name',
            value:                     emp?.company_entity_name ?? '',
            value_alias:               emp?.company_entity_name ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
            is_promotion_or_demotion:  '',
          },
          from_to: { label: 'From - To', value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildLocationGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWOfficeLocationFields> {
    return {
      label:              'Current Office Location',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('officelocation', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          area:    { label: 'Office Area', value: emp?.location_area    ?? '' },
          country: { label: 'Country',     value: emp?.location_country ?? '' },
          state:   { label: 'State',       value: emp?.location_state   ?? '' },
          city:    { label: 'City',        value: emp?.location_city    ?? '' },
          from_to: { label: 'From - To',   value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildManagerGrid(
    managerRecord: { id: string; employeeId: string; fullName: string } | null,
    mp:            EmployeePayload | null,
    employeeId:    string,
    fromDate:      string | null,
  ): DWEmploymentSection<DWManagerFields> {
    const managerId   = mp?.darwinbox?.source_employee_id ?? managerRecord?.employeeId ?? '';
    const managerName = managerRecord?.fullName ?? '';
    const profileUrl  = managerId ? `/ms/db/profile/view/${managerId}` : '';
    const imageUrl    = mp?.profile?.avatarUrl ?? null;

    // Preserve the exact Darwinbox hover-data HTML template so the frontend
    // employee-card component renders the inline profile popover correctly.
    const valueAlias = managerRecord
      ? `<dbx-ds-hover-data container="body" data-id="${managerId}" category="employee">` +
        `<span class='manager_name'>Full Name</span></dbx-ds-hover-data>`
      : '';

    return {
      label:              'Manager',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('manager', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          manager: {
            label:                     'Manager Name',
            value:                     managerName,
            type:                      'user',
            value_alias:               valueAlias,
            disable_overflow:          false,
            label_visibility_override: 'hide',
            profile_url:               profileUrl,
            image_url:                 imageUrl,
          },
          from_to: { label: 'From - To', value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildEmployeeTypeGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWEmployeeTypeFields> {
    return {
      label:              'Employee Type',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('employee_type', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          employee_type: {
            label:                     'Employee Type',
            value:                     emp?.employment_type ?? '',
            value_alias:               emp?.employment_type ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
          },
          emp_sub_type: {
            label:                     'Employee Sub Type',
            value:                     emp?.emp_sub_type ?? '',
            value_alias:               emp?.emp_sub_type ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
          },
          from_to: { label: 'From - To', value: this.buildFromToStr(fromDate) },
        },
      }],
    };
  }

  private buildContractGrid(
    emp:        EmployeePayload['employment'],
    employeeId: string,
    fromDate:   string | null,
  ): DWEmploymentSection<DWContractFields> {
    return {
      label:              'Contract',
      is_grid_section:    true,
      switch_btn_details: DW_SWITCH_DEFAULTS,
      grids: [{
        grid_id:             this.sectionGridId('contract', employeeId),
        current_btn_details: DW_CURRENT_BTN,
        fields: {
          contract: {
            label:                     'Contract',
            value:                     emp?.contract_duration ?? '',
            value_alias:               emp?.contract_duration ?? '',
            disable_overflow:          false,
            label_visibility_override: 'show',
          },
          // contract_end_date triggers the "End Date" annotation in the range string
          from_to: {
            label: 'From - To',
            value: this.buildFromToStr(fromDate, emp?.contract_end_date),
          },
        },
      }],
    };
  }

  // ---------------------------------------------------------------------------
  // getEmploymentDetails
  //
  // Backs GET /Profileapi/ViewEmploymentDetails?user_id=...
  //
  // Returns the employment-related payload slice:
  //   - employment (designation, grade, department, employment type, dates)
  //   - work_experience (prior employment history)
  //   - education_history
  //   - positionIds — the PLT/dual-position UUID array used by XState to
  //     authorise acting approvers in the leave approval chain
  //   - unit — the relational unit record (name + code)
  //
  // positionIds is the critical field the Vue frontend hydrates before
  // rendering the leave submission form's approver-chain picker. Without it,
  // the picker cannot determine which positions an employee currently holds.
  // ---------------------------------------------------------------------------
  async getEmploymentDetails(
    requestingUser: User,
    targetUserId: string,
  ): Promise<EmploymentDetailsResponse> {
    await this.assertProfileAccess(requestingUser, targetUserId);

    const user = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        payload: true,
        unit: { select: UNIT_SELECT },
      },
    });
    if (!user) throw new NotFoundException(`User ${targetUserId} not found.`);

    const p = user.payload as unknown as EmployeePayload | null;

    return {
      userId:           user.id,
      employeeId:       user.employeeId,
      fullName:         user.fullName,
      employment:       p?.employment      ?? {},
      work_experience:  p?.work_experience ?? [],
      education_history: p?.education_history ?? [],
      positionIds:      p?.positionIds     ?? [],
      unit:             user.unit,
    };
  }

  // ---------------------------------------------------------------------------
  // viewOrgChartDetails
  //
  // Backs GET /Profileapi/getOrganisationChartDetails?user_id=...
  //
  // Returns the Darwinbox ViewOrgChartDetails wire format — a "lens" focused
  // on one employee with three structural headcount metrics:
  //
  //   no_of_direct_reportees      — COUNT of rows WHERE manager_id = target
  //                                 (raw SQL; FK not yet in Prisma types)
  //
  //   no_of_dotted_line_reportees — stored in payload.org.dotted_line_reportees_count;
  //                                 defaults to 0 when absent (Darwinbox manages
  //                                 this relationship type, we surface what HR set)
  //
  //   total_team_size             — recursive CTE that walks the full sub-tree
  //                                 starting from target, counting every descendant
  //                                 at every depth level
  //
  // The recursive CTE terminates naturally when no new children are found.
  // Circular manager references (data integrity issue) would cause an infinite
  // loop — PostgreSQL does not detect cycles in UNION ALL CTEs.  KPNHCIS
  // prevents this at the data layer via a CHECK constraint on the sync endpoint.
  //
  // lens_id  — deterministic 18-char hex derived from the target user UUID,
  //            stable across restarts and consistent with Darwinbox ID format.
  // lens_label — "[FullName] ([employeeId]) - [Designation] - [Department]"
  // ---------------------------------------------------------------------------
  async viewOrgChartDetails(
    requestingUser: User,
    userIdParam?: string,
  ): Promise<ViewOrgChartDetailsResponse> {
    const targetUserId = await this.resolveTargetUserId(requestingUser.id, userIdParam);
    await this.assertProfileAccess(requestingUser, targetUserId);

    // ── 1. Fetch target user with unit for lens_label ─────────────────────────
    const user = await this.prisma.user.findFirst({
      where:  { id: targetUserId, deletedAt: null },
      select: {
        id:         true,
        employeeId: true,
        fullName:   true,
        payload:    true,
        unit:       { select: UNIT_SELECT },
      },
    });
    if (!user) throw new NotFoundException(`User ${targetUserId} not found.`);

    const p = user.payload as unknown as EmployeePayload | null;

    // ── 2. Direct reportee count ──────────────────────────────────────────────
    // manager_id is not in the Prisma-generated UserWhereInput until the
    // migration runs — raw SQL is the safe path.
    const directCountRows = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*)::bigint AS count
      FROM   users
      WHERE  manager_id  = ${targetUserId}::uuid
        AND  deleted_at IS NULL
    `;
    const directReportees = Number(directCountRows[0].count);

    // ── 3. Total sub-tree headcount via recursive CTE ─────────────────────────
    // The CTE seeds from the target user's direct reports, then repeatedly
    // joins each discovered employee's own direct reports until no new rows
    // are produced.  COUNT aggregates the entire result set.
    // CYCLE clause (PostgreSQL 14+) breaks any circular manager_id reference
    // before it can loop indefinitely.  The primary protection is the CHECK
    // constraint on the sync endpoint, but this acts as a second line of
    // defence for manual DB edits or migration edge cases.
    const totalTeamRows = await this.prisma.$queryRaw<[{ count: bigint }]>`
      WITH RECURSIVE org_tree AS (
        -- Anchor: immediate subordinates of the target
        SELECT id
        FROM   users
        WHERE  manager_id  = ${targetUserId}::uuid
          AND  deleted_at IS NULL

        UNION ALL

        -- Recursive step: each member's own direct reports
        SELECT u.id
        FROM   users        u
        INNER JOIN org_tree ot ON u.manager_id = ot.id
        WHERE  u.deleted_at IS NULL
      ) CYCLE id SET is_cycle USING cycle_path
      SELECT COUNT(*)::bigint AS count FROM org_tree WHERE NOT is_cycle
    `;
    const totalTeamSize = Number(totalTeamRows[0].count);

    // ── 4. Dotted-line count from JSONB payload ───────────────────────────────
    const dottedLineReportees = p?.org?.dotted_line_reportees_count ?? 0;

    // ── 5. Build lens metadata ────────────────────────────────────────────────
    const lensId    = this.buildLensId(user.id);
    const lensLabel = this.buildLensLabel(user, p);

    this.logger.debug(
      `viewOrgChartDetails: user=${user.employeeId} ` +
      `direct=${directReportees} total=${totalTeamSize} dotted=${dottedLineReportees}`,
    );

    return {
      status: 1,
      org_view_data: {
        label: 'Organization Chart',
        data: {
          org_structure_data: {
            show_org_structure:   true,
            label:                'Org View',
            lens_id:              lensId,
            lens_label:           lensLabel,
            org_chart_count_data: [
              {
                id:    'no_of_direct_reportees',
                label: 'No. of Direct Reportees',
                count: directReportees,
              },
              {
                id:    'no_of_dotted_line_reportees',
                label: 'No. of Dotted Line Reportees',
                count: dottedLineReportees,
              },
              {
                id:    'total_team_size',
                label: 'Total Team Size',
                count: totalTeamSize,
              },
            ],
          },
        },
        hide_org_view_redirect_icon: false,
      },
    };
  }

  // ── ViewOrgChartDetails helpers ────────────────────────────────────────────

  /**
   * Derives a stable 18-character Darwinbox-format lens ID from the user UUID.
   *
   * Strategy: strip UUID dashes, take the first 16 hex chars, prefix "a6".
   * This is deterministic, collision-free within a tenant, and structurally
   * identical to the IDs Darwinbox emits for its own lens records.
   */
  private buildLensId(userId: string): string {
    return 'a6' + userId.replace(/-/g, '').substring(0, 16);
  }

  /**
   * Builds the Darwinbox lens_label string.
   *
   * Format: "[FullName] ([EmployeeId]) - [Designation] - [Department]"
   *
   * Designation and department are read from payload.employment.  When either
   * is absent the segment is omitted rather than showing an empty dash so that
   * a freshly-synced record without all fields renders gracefully.
   *
   * Example: "Budi Santoso (E0042) - Project - Developer (Fullstack) - HC Information System"
   */
  private buildLensLabel(
    user: { employeeId: string; fullName: string; unit: { name: string } | null },
    p:    EmployeePayload | null,
  ): string {
    const designation = p?.employment?.designation?.trim() ?? '';
    const department  = (p?.employment?.department?.trim() || user.unit?.name?.trim()) ?? '';

    const parts: string[] = [`${user.fullName} (${user.employeeId})`];
    if (designation) parts.push(designation);
    if (department)  parts.push(department);
    return parts.join(' - ');
  }

  // ---------------------------------------------------------------------------
  // getOrganisationChart
  //
  // Backs GET /Profileapi/getOrganisationChartDetails?user_id=...
  //
  // Resolves:
  //   1. The target user's own designation/department (from payload.employment)
  //   2. Their immediate line manager (via User.managerId FK)
  //   3. Their direct reports (via User.subordinates relation)
  //
  // Subordinates are paginated (default take: 20, max: 50) because a manager
  // may have many direct reports. The totalDirectReports count covers all
  // non-deleted subordinates regardless of pagination.
  //
  // avatarUrl is extracted from payload.profile.avatarUrl at each level so
  // the frontend org-chart component can render profile photos without
  // additional requests.
  // ---------------------------------------------------------------------------
  async getOrganisationChart(
    requestingUser: User,
    query: OrgChartQueryDto,
  ): Promise<OrgChartResponse> {
    const targetUserId = query.user_id ?? requestingUser.id;
    await this.assertProfileAccess(requestingUser, targetUserId);

    const reportSkip = query.reportSkip ?? 0;
    const reportTake = query.reportTake ?? 20;

    // ── Step 1: Fetch the target user ─────────────────────────────────────────
    const user = await this.prisma.user.findFirst({
      where:  { id: targetUserId, deletedAt: null },
      select: ORG_NODE_SELECT,
    });
    if (!user) throw new NotFoundException(`User ${targetUserId} not found.`);

    // ── Step 2: Resolve managerId via raw SQL ─────────────────────────────────
    // The User.managerId FK exists in the Prisma schema and the DB column, but
    // it is absent from the generated Prisma types until the migration that adds
    // manager_id has been run and `prisma generate` has been re-executed.
    // $queryRaw bypasses the type gap without altering DB behaviour.
    type ManagerRef = { manager_id: string | null };
    const managerRefs = await this.prisma.$queryRaw<ManagerRef[]>`
      SELECT manager_id FROM users WHERE id = ${targetUserId}::uuid
    `;
    const managerId = managerRefs[0]?.manager_id ?? null;

    // ── Step 3: Resolve subordinate IDs + count via raw SQL ───────────────────
    // manager_id is not yet in UserWhereInput for the same reason as above.
    // We fetch IDs here, then hydrate full records via Prisma so the unit
    // relation join is handled by the ORM rather than by manual SQL.
    type SubIdRow = { id: string };
    const [subordinateIdRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<SubIdRow[]>`
        SELECT id FROM users
        WHERE  manager_id = ${targetUserId}::uuid
          AND  deleted_at IS NULL
        ORDER  BY full_name ASC
        LIMIT  ${reportTake} OFFSET ${reportSkip}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM   users
        WHERE  manager_id = ${targetUserId}::uuid
          AND  deleted_at IS NULL
      `,
    ]);
    const totalDirectReports = Number(countRows[0].count);

    // ── Step 4: Hydrate manager and subordinates via Prisma ───────────────────
    const subordinateIds = subordinateIdRows.map((r) => r.id);

    const [managerRecord, subordinateRecords] = await Promise.all([
      managerId
        ? this.prisma.user.findFirst({
            where:  { id: managerId, deletedAt: null },
            select: ORG_NODE_SELECT,
          })
        : Promise.resolve(null),
      subordinateIds.length > 0
        ? this.prisma.user.findMany({
            where:   { id: { in: subordinateIds }, deletedAt: null },
            select:  ORG_NODE_SELECT,
            orderBy: { fullName: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    return {
      user:               this.toOrgNode(user),
      manager:            managerRecord ? this.toOrgNode(managerRecord) : null,
      directReports:      subordinateRecords.map((s) => this.toOrgNode(s)),
      totalDirectReports,
    };
  }

  // ---------------------------------------------------------------------------
  // getAttendanceEmployeeStatus
  //
  // Backs POST /attendance/attendance/GetAttendanceEmployeeStatus
  //
  // Performs a live query against the leave_requests table to determine
  // whether the target user has an APPROVED leave that spans today's date.
  //
  // Leave detection query predicate:
  //   userId = targetUserId
  //   status = APPROVED
  //   startDate <= today (leave has started)
  //   endDate   >= today (leave has not yet ended)
  //
  // Date comparison uses UTC midnight to match Prisma's normalisation of
  // @db.Date columns, which are stored and returned as midnight-UTC values.
  // Using setUTCHours(0,0,0,0) ensures the check is date-only regardless
  // of the Node.js process timezone.
  //
  // When multiple overlapping approved leaves exist (should not occur with
  // correct business-rule enforcement at submission time), the most recently
  // started one is surfaced via orderBy startDate desc.
  // ---------------------------------------------------------------------------
  async getAttendanceEmployeeStatus(
    requestingUser: User,
    dto: GetAttendanceStatusBodyDto,
  ): Promise<ViewAttendanceStatusResponse> {
    const targetUserId = await this.resolveTargetUserId(requestingUser.id, dto.user_id);
    await this.assertProfileAccess(requestingUser, targetUserId);

    // ── Normalise "today" to midnight UTC ────────────────────────────────────
    // Prisma stores @db.Date columns as midnight-UTC Date objects.  Setting
    // the comparison timestamp to midnight-UTC guarantees a date-only match
    // that is independent of the host process timezone.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // ── Query for an active approved leave ───────────────────────────────────
    const activeLeave = await this.prisma.leaveRequest.findFirst({
      where: {
        userId:    targetUserId,
        status:    LeaveRequestStatus.APPROVED,
        startDate: { lte: today },
        endDate:   { gte: today },
      },
      select: {
        leaveType: true,
        endDate:   true,
      },
      orderBy: { startDate: 'desc' },
    });

    if (activeLeave) {
      // ── UTC-safe dd-mm-yyyy formatter for @db.Date values ─────────────────
      // Prisma returns Date objects at midnight-UTC for @db.Date columns.
      // getUTC* accessors are used here (instead of the local-time accessors
      // used by formatDateDMY) to avoid an off-by-one-day error in timezones
      // with negative UTC offsets.
      const d   = activeLeave.endDate;
      const pad = (n: number) => String(n).padStart(2, '0');
      const leaveTillDate = `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;

      this.logger.debug(
        `getAttendanceEmployeeStatus: user=${targetUserId} ` +
        `status=leave type=${activeLeave.leaveType} till=${leaveTillDate}`,
      );

      return {
        status: 1,
        data: {
          employee_status:      'On Leave',
          employee_status_code: 'leave',
          leave_type:           this.formatLeaveType(activeLeave.leaveType),
          leave_till_date:      leaveTillDate,
        },
      };
    }

    this.logger.debug(
      `getAttendanceEmployeeStatus: user=${targetUserId} status=working`,
    );

    return {
      status: 1,
      data: {
        employee_status:      'Working',
        employee_status_code: 'working',
        leave_type:           '',
        leave_till_date:      '',
      },
    };
  }

  /**
   * Maps a Prisma LeaveType enum value to the human-readable display label
   * used in the Darwinbox attendance-status wire format.
   *
   * The map is exhaustive — every enum member is listed explicitly so that
   * a future new enum value triggers a TypeScript error rather than silently
   * falling through to the raw enum string.
   */
  private formatLeaveType(type: LeaveType): string {
    const labels: Record<LeaveType, string> = {
      [LeaveType.ANNUAL]:    'Annual Leave',
      [LeaveType.SICK]:      'Sick Leave',
      [LeaveType.MATERNITY]: 'Maternity Leave',
      [LeaveType.PATERNITY]: 'Paternity Leave',
      [LeaveType.SPECIAL]:   'Special Leave',
      [LeaveType.UNPAID]:    'Unpaid Leave',
    };
    return labels[type] ?? String(type);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Enforce profile read access.
   *
   * Access is granted when ANY of the following is true:
   *   1. The requesting user is reading their own profile (short-circuit).
   *   2. CASL ability.can('read', subject('User', { id: targetUserId })):
   *      - Admin/HR roles with read:User (no conditions) → always true.
   *      - Regular employees with read:User + { id: "${user.id}" } condition
   *        → true only for own data (covered by case 1, but evaluated here
   *        as a safety net for direct service calls).
   *
   * Why in the service rather than a guard:
   *   The PermissionsGuard at the controller level performs a string-based
   *   check (ability.can('read', 'User')), which passes for any user who has
   *   read:User with or without conditions. The subject-based check here
   *   enforces the conditions for cross-user access at the data layer.
   */
  private async assertProfileAccess(
    requestingUser: User,
    targetUserId: string,
  ): Promise<void> {
    if (requestingUser.id === targetUserId) return;

    const ability = await this.caslAbilityFactory.createForUser(requestingUser);

    if (!ability.can('read', subject('User', { id: targetUserId }) as unknown as 'User')) {
      this.logger.warn(
        `EmployeeProfileService: user ${requestingUser.id} denied access ` +
        `to profile of ${targetUserId}.`,
      );
      throw new ForbiddenException(
        'Access denied: you do not have permission to view this employee\'s profile.',
      );
    }
  }

  /**
   * Three-pass Darwinbox ID → internal UUID resolution.
   *
   * Pass 1: GIN @> containment query on payload.darwinbox.source_employee_id
   *         (fastest — GIN-indexed).
   * Pass 2: User.employeeId (company employee_no / Darwinbox employee_no).
   * Pass 3: Direct UUID lookup for internal API callers.
   *
   * Returns requestingUserId when userIdParam is undefined (own-profile shortcut).
   */
  private async resolveTargetUserId(
    requestingUserId: string,
    userIdParam: string | undefined,
  ): Promise<string> {
    if (!userIdParam) return requestingUserId;

    const jsonFilter = JSON.stringify({ darwinbox: { source_employee_id: userIdParam } });
    const ginRows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM users
      WHERE  payload @> ${jsonFilter}::jsonb
        AND  deleted_at IS NULL
      LIMIT  1
    `;
    if (ginRows.length > 0) return ginRows[0].id;

    const byEmpId = await this.prisma.user.findFirst({
      where:  { employeeId: userIdParam, deletedAt: null },
      select: { id: true },
    });
    if (byEmpId) return byEmpId.id;

    // UUID format: direct internal lookup
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRe.test(userIdParam)) {
      const byId = await this.prisma.user.findFirst({
        where:  { id: userIdParam, deletedAt: null },
        select: { id: true },
      });
      if (byId) return byId.id;
    }

    throw new NotFoundException(`Employee "${userIdParam}" not found.`);
  }

  /**
   * Extracts designation, department, and avatarUrl from the payload JSONB
   * and returns a flat OrgChartNode. The `unit` relation is included in the
   * Prisma select upstream and passed through here unmodified.
   */
  private toOrgNode(
    user: {
      id: string;
      employeeId: string;
      fullName: string;
      payload: unknown;
      unit: { id: string; name: string; code: string } | null;
    },
  ): OrgChartNode {
    const p = user.payload as unknown as EmployeePayload | null;
    return {
      id:          user.id,
      employeeId:  user.employeeId,
      fullName:    user.fullName,
      designation: p?.employment?.designation ?? null,
      department:  p?.employment?.department  ?? null,
      unit:        user.unit,
      avatarUrl:   p?.profile?.avatarUrl      ?? null,
    };
  }
}

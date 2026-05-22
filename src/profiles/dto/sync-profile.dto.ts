import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// =============================================================================
// Darwinbox field names are kept in snake_case throughout these DTOs.
// This matches the Darwinbox API wire format exactly, so the integration
// layer (webhook receiver or scheduled job) can forward the payload without
// a field-rename transformation step.
//
// Field mapping reference (Darwinbox → KPNHCIS):
//   employee_no                     → User.employeeId        (upsert key)
//   email                           → User.email
//   first_name + middle_name + last_name → User.fullName
//   status                          → User.status (mapped via StatusMap)
//   department_id                   → Unit.code lookup → User.unitId
//   reporting_manager_employee_id   → User.employeeId lookup → User.managerId
//   (everything else)               → User.payload JSONB
// =============================================================================

// =============================================================================
// SECTION 1: getemployeeDetails — core identity & employment metadata
// Darwinbox endpoint: GET /getemployeeDetails?employee_id=...
// =============================================================================

export class DarwinboxCoreDetailsDto {
  /** Darwinbox employee number — becomes User.employeeId (upsert key) */
  @IsString()
  @IsNotEmpty()
  employee_no: string;

  /** Maps to User.email (unique column) */
  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  first_name: string;

  @IsString()
  @IsOptional()
  middle_name?: string;

  @IsString()
  @IsNotEmpty()
  last_name: string;

  /** Stored in payload.personal.phone */
  @IsString()
  @IsOptional()
  mobile?: string;

  /** Stored in payload.personal.gender */
  @IsString()
  @IsOptional()
  gender?: string;

  /** ISO date string e.g. "1990-05-15". Stored in payload.personal.date_of_birth */
  @IsString()
  @IsOptional()
  date_of_birth?: string;

  /** ISO date string e.g. "2021-03-01". Stored in payload.employment.date_of_joining */
  @IsString()
  @IsOptional()
  date_of_joining?: string;

  /** e.g. "Software Engineer". Stored in payload.employment.designation */
  @IsString()
  @IsOptional()
  designation?: string;

  /** Human-readable department name. Stored in payload.employment.department */
  @IsString()
  @IsOptional()
  department?: string;

  /**
   * Darwinbox department code.
   * Used to look up Unit.code → User.unitId.
   * Also stored in payload.employment.department_id for audit purposes.
   */
  @IsString()
  @IsOptional()
  department_id?: string;

  /** e.g. "PERMANENT", "CONTRACT", "PKWT". Stored in payload.employment */
  @IsString()
  @IsOptional()
  employment_type?: string;

  /**
   * Manager's Darwinbox employee number (not UUID).
   * Service resolves this to User.managerId by looking up User.employeeId.
   * Also stored in payload.manager_snapshot.employee_no.
   */
  @IsString()
  @IsOptional()
  reporting_manager_employee_id?: string;

  /** Stored in payload.manager_snapshot.name */
  @IsString()
  @IsOptional()
  reporting_manager_name?: string;

  /**
   * Darwinbox employee status.
   * Accepted values: "active" | "inactive".
   * Mapped to UserStatus enum by the service.
   */
  @IsIn(['active', 'inactive', 'suspended'])
  @IsOptional()
  status?: string;

  /** Stored in payload.employment.company_id */
  @IsString()
  @IsOptional()
  company_id?: string;

  /** Branch/office name. Stored in payload.employment.location */
  @IsString()
  @IsOptional()
  branch?: string;

  /** Stored in payload.employment.branch_id */
  @IsString()
  @IsOptional()
  branch_id?: string;

  /**
   * Darwinbox's internal employee_id (distinct from employee_no).
   * Stored in payload.darwinbox.source_employee_id for debugging.
   */
  @IsString()
  @IsOptional()
  employee_id?: string;
}

// =============================================================================
// SECTION 2: ViewProfileDetails — biographical & personal data
// Darwinbox endpoint: GET /ViewProfileDetails?employee_id=...
// =============================================================================

export class DarwinboxPersonalDetailsDto {
  @IsString()
  @IsOptional()
  religion?: string;

  @IsString()
  @IsOptional()
  blood_group?: string;

  @IsString()
  @IsOptional()
  marital_status?: string;

  @IsString()
  @IsOptional()
  nationality?: string;

  @IsString()
  @IsOptional()
  place_of_birth?: string;

  /** Indonesian National Identity Card number (NIK) */
  @IsString()
  @IsOptional()
  nik?: string;

  /** Indonesian Tax Registration Number (NPWP) */
  @IsString()
  @IsOptional()
  npwp?: string;
}

export class DarwinboxAddressDto {
  /** e.g. "PERMANENT", "CURRENT", "EMERGENCY" */
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsOptional()
  street?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  province?: string;

  @IsString()
  @IsOptional()
  postal_code?: string;

  @IsString()
  @IsOptional()
  country?: string;
}

export class DarwinboxEducationDto {
  /** e.g. "SMA", "D3", "S1", "S2", "S3" */
  @IsString()
  @IsOptional()
  level?: string;

  @IsString()
  @IsOptional()
  institution?: string;

  @IsString()
  @IsOptional()
  major?: string;

  @IsNumber()
  @IsOptional()
  year_from?: number;

  @IsNumber()
  @IsOptional()
  year_to?: number;

  /** GPA or final grade as string e.g. "3.75" */
  @IsString()
  @IsOptional()
  gpa?: string;
}

export class DarwinboxEmergencyContactDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  relationship?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}

export class DarwinboxProfileDetailsDto {
  @ValidateNested()
  @Type(() => DarwinboxPersonalDetailsDto)
  @IsOptional()
  personal_details?: DarwinboxPersonalDetailsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DarwinboxAddressDto)
  @IsOptional()
  addresses?: DarwinboxAddressDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DarwinboxEducationDto)
  @IsOptional()
  education_history?: DarwinboxEducationDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DarwinboxEmergencyContactDto)
  @IsOptional()
  emergency_contacts?: DarwinboxEmergencyContactDto[];

  /** Family member details — free-form structure varies by Darwinbox config */
  @IsArray()
  @IsOptional()
  family_details?: Record<string, unknown>[];
}

// =============================================================================
// SECTION 3: ViewEmploymentDetails — current position & work history
// Darwinbox endpoint: GET /ViewEmploymentDetails?employee_id=...
// =============================================================================

export class DarwinboxCurrentPositionDto {
  @IsString()
  @IsOptional()
  designation?: string;

  @IsString()
  @IsOptional()
  designation_id?: string;

  @IsString()
  @IsOptional()
  department?: string;

  @IsString()
  @IsOptional()
  department_id?: string;

  /** e.g. "PERMANENT", "CONTRACT", "PKWT", "INTERN" */
  @IsString()
  @IsOptional()
  employment_type?: string;

  @IsString()
  @IsOptional()
  date_of_joining?: string;

  @IsString()
  @IsOptional()
  probation_end_date?: string;

  @IsString()
  @IsOptional()
  contract_end_date?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  cost_center?: string;
}

export class DarwinboxReportingManagerDto {
  @IsString()
  @IsOptional()
  employee_no?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  designation?: string;

  @IsString()
  @IsOptional()
  email?: string;
}

export class DarwinboxWorkExperienceDto {
  @IsString()
  @IsOptional()
  company_name?: string;

  @IsString()
  @IsOptional()
  designation?: string;

  @IsString()
  @IsOptional()
  start_date?: string;

  @IsString()
  @IsOptional()
  end_date?: string;

  @IsString()
  @IsOptional()
  reason_for_leaving?: string;
}

export class DarwinboxEmploymentDetailsDto {
  @ValidateNested()
  @Type(() => DarwinboxCurrentPositionDto)
  @IsOptional()
  current_position?: DarwinboxCurrentPositionDto;

  @ValidateNested()
  @Type(() => DarwinboxReportingManagerDto)
  @IsOptional()
  reporting_manager?: DarwinboxReportingManagerDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DarwinboxWorkExperienceDto)
  @IsOptional()
  work_experience?: DarwinboxWorkExperienceDto[];
}

// =============================================================================
// ROOT DTO
// =============================================================================

/**
 * SyncProfileDto — the body of POST /profiles/sync.
 *
 * The integration layer (scheduled job or Darwinbox webhook consumer) calls
 * our three Darwinbox endpoints for a single employee, extracts the data
 * objects, and assembles this DTO before posting to our API.
 *
 * Only `coreDetails` is required. `profileDetails` and `employmentDetails`
 * can be omitted for a partial sync (e.g. status-only update from a webhook).
 */
export class SyncProfileDto {
  /** From Darwinbox getemployeeDetails — required; provides the upsert key */
  @ValidateNested()
  @Type(() => DarwinboxCoreDetailsDto)
  coreDetails: DarwinboxCoreDetailsDto;

  /** From Darwinbox ViewProfileDetails — biographical & address data */
  @ValidateNested()
  @Type(() => DarwinboxProfileDetailsDto)
  @IsOptional()
  profileDetails?: DarwinboxProfileDetailsDto;

  /** From Darwinbox ViewEmploymentDetails — position, manager, work history */
  @ValidateNested()
  @Type(() => DarwinboxEmploymentDetailsDto)
  @IsOptional()
  employmentDetails?: DarwinboxEmploymentDetailsDto;
}

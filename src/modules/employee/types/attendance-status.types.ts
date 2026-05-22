import { IsOptional, IsString } from 'class-validator';

// =============================================================================
// attendance-status.types.ts
//
// DTO and wire-format interfaces for the Darwinbox attendance-status endpoint:
//   POST /attendance/attendance/GetAttendanceEmployeeStatus
//
// The endpoint evaluates whether an employee is actively working today or
// currently on an APPROVED leave that spans the current calendar date.
// =============================================================================

// ─── Request DTO ──────────────────────────────────────────────────────────────

/**
 * Body for POST /attendance/attendance/GetAttendanceEmployeeStatus.
 *
 * user_id — Darwinbox source_employee_id, company employee_no, or internal
 *   UUID.  Resolved via the three-pass GIN → employeeId → UUID pipeline in
 *   the service.  Omit to evaluate the authenticated user's own status.
 */
export class GetAttendanceStatusBodyDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

// ─── Response interfaces ───────────────────────────────────────────────────────

/**
 * The data payload inside ViewAttendanceStatusResponse.
 *
 * Working state:
 *   employee_status      = "Working"
 *   employee_status_code = "working"
 *   leave_type           = ""
 *   leave_till_date      = ""
 *
 * On-leave state:
 *   employee_status      = "On Leave"
 *   employee_status_code = "leave"
 *   leave_type           = human-readable leave category (e.g. "Annual Leave")
 *   leave_till_date      = dd-mm-yyyy formatted end date of the active leave
 */
export interface DWAttendanceStatusData {
  employee_status:      string;
  employee_status_code: 'working' | 'leave';
  leave_type:           string;
  leave_till_date:      string;
}

/** Complete response envelope for GetAttendanceEmployeeStatus. */
export interface ViewAttendanceStatusResponse {
  status: 1;
  data:   DWAttendanceStatusData;
}

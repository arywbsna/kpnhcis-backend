// =============================================================================
// get-attendance-policies.dto.ts
//
// Validated request body for POST /attendance/attendanceAPI/GetAttendancePoliciesDetails.
//
// Both fields are optional:
//   user_id        — omit to operate on the authenticated user's own records.
//   effective_date — ISO-8601 "YYYY-MM-DD"; point-in-time anchor for shift
//                    assignment lookup. Defaults to today (UTC) when omitted.
// =============================================================================

import { IsDateString, IsOptional, IsString } from 'class-validator';

export class GetAttendancePoliciesBodyDto {
  /**
   * Darwinbox source_employee_id, company employee_no, or internal UUID.
   * Resolved via the three-pass GIN → employeeId → UUID pipeline.
   * Omit to use the authenticated user's own shift context.
   */
  @IsString()
  @IsOptional()
  user_id?: string;

  /**
   * Point-in-time anchor for shift assignment lookup, ISO-8601 "YYYY-MM-DD".
   * The service returns the active shift assignment covering this date.
   * Defaults to today (UTC midnight) when omitted.
   */
  @IsDateString()
  @IsOptional()
  effective_date?: string;
}

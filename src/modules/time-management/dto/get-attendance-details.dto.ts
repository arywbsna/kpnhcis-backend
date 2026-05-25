// =============================================================================
// get-attendance-details.dto.ts
//
// Validated request body for POST /attendance/attendanceAPI/GetAttendanceDetails.
//
// All three fields are optional:
//   user_id    — omit to operate on the authenticated user's own records.
//   start_date — omit to default to today (UTC midnight).
//   end_date   — used when the caller wants to know which shift was effective
//                for a specific past or future date.  The service uses start_date
//                as the effective date for shift resolution; end_date is stored
//                in context but does not change the shift lookup result (shift
//                assignments are typically stable within a period).
//
// Date format enforcement:
//   @IsDateString() validates ISO-8601 "YYYY-MM-DD" strings.  The service
//   normalises every date to UTC midnight via `new Date(value + 'T00:00:00Z')`
//   so timezone-ambiguous inputs are always resolved consistently.
// =============================================================================

import {
  IsDateString,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

export class GetAttendanceDetailsBodyDto {
  /**
   * Darwinbox source_employee_id, company employee_no, or internal UUID.
   * Resolved via the three-pass GIN → employeeId → UUID pipeline in the service.
   * Omit to use the authenticated user's own records.
   */
  @IsString()
  @IsOptional()
  user_id?: string;

  /**
   * Start of the period of interest, ISO-8601 "YYYY-MM-DD".
   * Used as the effective date for shift-assignment lookup.
   * Defaults to today (UTC) when omitted.
   */
  @IsDateString()
  @IsOptional()
  start_date?: string;

  /**
   * End of the period of interest, ISO-8601 "YYYY-MM-DD".
   * Must not precede start_date when both are provided.
   * Currently stored in context; future versions may use it to detect
   * mid-period shift changes and surface a composite response.
   */
  @IsDateString()
  @IsOptional()
  @ValidateIf(o => o.start_date !== undefined)
  end_date?: string;
}

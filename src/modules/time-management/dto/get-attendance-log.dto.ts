// =============================================================================
// get-attendance-log.dto.ts
//
// Request body DTO for POST /attendance/attendanceAPI/GetAttendanceLog.
//
// This endpoint returns a day-by-day attendance ledger dictionary for the
// requested date window, covering every calendar day between start_date and
// end_date inclusive.  Each day entry contains clock timings, duration
// metrics, status badges, shift card context, and window-level counters.
//
// Validation:
//   — start_date and end_date are required ISO-8601 "YYYY-MM-DD" strings.
//     The service normalises both to UTC midnight boundaries and guards the
//     window against exceeding 31 days to prevent memory exhaustion.
//
//   — user_id is optional.  When provided, it may be a Darwinbox
//     source_employee_id (resolved via JSONB GIN lookup), a company
//     employee_no, or an internal UUID (three-pass resolution in the service).
//     When omitted the JWT principal is the target of the query.
// =============================================================================

import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetAttendanceLogBodyDto {
  @IsDateString()
  @IsNotEmpty()
  start_date: string;

  @IsDateString()
  @IsNotEmpty()
  end_date: string;

  @IsString()
  @IsOptional()
  user_id?: string;
}

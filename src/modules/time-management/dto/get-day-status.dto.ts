// =============================================================================
// get-day-status.dto.ts
//
// Request body DTO for POST /attendance/attendanceAPI/getDayStatus.
//
// The endpoint accepts a single calendar date and an optional employee override.
// When user_id is omitted the JWT principal is the target of the query.
//
// Validation:
//   — date is required; must be a valid ISO-8601 "YYYY-MM-DD" string.
//     The service normalises it to UTC midnight before querying AttendanceDaily.
//   — user_id is optional.  When provided it may be a Darwinbox
//     source_employee_id (JSONB GIN lookup), a company employee_no, or an
//     internal UUID (resolved via the three-pass lookup in resolveTargetUser).
// =============================================================================

import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetDayStatusBodyDto {
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsOptional()
  user_id?: string;
}

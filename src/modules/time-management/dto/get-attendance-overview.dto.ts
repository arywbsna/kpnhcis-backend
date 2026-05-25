// =============================================================================
// get-attendance-overview.dto.ts
//
// Request body DTO for POST /attendance/attendanceAPI/GetAttendanceOverview.
//
// This endpoint accepts an explicit start_date / end_date window rather than
// a month+year pair so the analytics dashboard can display custom date ranges
// (e.g. a bi-weekly pay period or an arbitrary 30-day window) without needing
// the caller to split the request across month boundaries.
//
// Validation:
//   — Both date fields are required ISO-8601 "YYYY-MM-DD" strings.
//   — start_date must not be after end_date (enforced in the service layer
//     alongside the MAX_DATE_WINDOW_DAYS guard of 31 days).
//   — user_id is optional; when omitted the JWT principal is the target.
// =============================================================================

import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetAttendanceOverviewBodyDto {
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

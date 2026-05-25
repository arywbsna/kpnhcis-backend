// =============================================================================
// get-team-status.dto.ts
//
// Request body DTO for POST /leaves/leavesApi/getTeamStatus.
//
// This endpoint returns a rolling day-by-day visibility matrix of who is
// out-of-office (national holiday or approved leave) within the requesting
// user's organizational unit over the specified date window.
//
// Validation:
//   — start_date and end_date are optional ISO-8601 "YYYY-MM-DD" strings.
//     When omitted the service defaults to a rolling 5-day window starting
//     from today (UTC midnight).  The service additionally guards the window
//     against exceeding 31 days to prevent runaway accumulator loops.
//
//   — user_id is optional.  When provided, the service uses that employee's
//     organizational unit as the department boundary for the peer pool, rather
//     than the requesting user's unit.  Useful for HR / admin users who need
//     to inspect a specific department's team calendar.  Resolved via the
//     standard three-pass lookup (Darwinbox source_employee_id → employeeId
//     → internal UUID).
// =============================================================================

import { IsDateString, IsOptional, IsString } from 'class-validator';

export class GetTeamStatusBodyDto {
  @IsDateString()
  @IsOptional()
  start_date?: string;

  @IsDateString()
  @IsOptional()
  end_date?: string;

  @IsString()
  @IsOptional()
  user_id?: string;
}

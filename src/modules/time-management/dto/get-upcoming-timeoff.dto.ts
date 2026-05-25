// =============================================================================
// get-upcoming-timeoff.dto.ts
//
// Request body DTO for POST /leaves/leavesApi/getUpcomingTimeOff.
//
// This endpoint returns a merged, chronologically-sorted feed of all upcoming
// national public holidays and the target employee's own approved leave
// requests, starting from today (UTC midnight) with no upper date bound.
//
// The feed is a complete forward-looking timeline with no date-range filter
// or pagination parameters — the frontend consumes it in full to populate
// the timeline widget and the profile calendar for the remainder of the year.
//
// Validation:
//   — user_id is optional.  When provided it may be a Darwinbox
//     source_employee_id (resolved via JSONB GIN lookup), a company
//     employee_no, or an internal UUID (three-pass resolution in the service).
//     When omitted the JWT principal is the target of the query.
// =============================================================================

import { IsOptional, IsString } from 'class-validator';

export class GetUpcomingTimeOffBodyDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

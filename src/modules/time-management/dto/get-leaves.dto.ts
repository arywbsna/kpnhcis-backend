// =============================================================================
// get-leaves.dto.ts
//
// Request body DTO for POST /leaves/leavesApi/GetLeaves.
//
// This endpoint returns the live leave balance sheet and policy configuration
// dictionary for every active LeaveBalance row belonging to the resolved
// employee in the current calendar year.
//
// Validation:
//   — user_id is optional.  When provided it may be a Darwinbox
//     source_employee_id (resolved via JSONB GIN lookup), a company
//     employee_no, or an internal UUID.  When omitted the JWT principal
//     is the target of the query.
//
// Note: year selection is intentionally omitted.  The endpoint always returns
// the current calendar year's balances.  Historical year queries are served by
// the separate GetDataForLeavePattern (matrix) endpoint.
// =============================================================================

import { IsOptional, IsString } from 'class-validator';

export class GetLeavesBodyDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

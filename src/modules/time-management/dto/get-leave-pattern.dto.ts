// =============================================================================
// get-leave-pattern.dto.ts
//
// Request body DTO for POST /leaves/leavesApi/GetDataForLeavePattern.
//
// This endpoint returns a 12-month matrix of approved leave-day consumption
// per leave type for a given year.  Unlike the previous form-cascade
// implementation, no leave_type field is accepted — the matrix covers ALL
// active leave types simultaneously.
//
// Validation:
//   — year is optional.  When provided it must be a positive integer (YYYY).
//     The service defaults to the current UTC calendar year when omitted.
//
//   — user_id is optional.  When provided it may be a Darwinbox
//     source_employee_id (resolved via JSONB GIN lookup), a company
//     employee_no, or an internal UUID.  When omitted the JWT principal is
//     the target of the query.
// =============================================================================

import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GetLeavePatternBodyDto {
  @IsInt()
  @Min(2000)
  @IsOptional()
  @Type(() => Number)
  year?: number;

  @IsString()
  @IsOptional()
  user_id?: string;
}

// =============================================================================
// get-leave-common-details.dto.ts
//
// Request body DTO for POST /leaves/leavesApi/GetLeaveCommonDetails.
//
// This is intentionally a thin DTO — the only client-supplied parameter is the
// optional cross-employee target identifier.  Year and leave-type filters are
// not exposed at this endpoint because it always returns the full dashboard
// card set for the current leave year; filtered views are served by GetLeaves.
// =============================================================================

import { IsOptional, IsString } from 'class-validator';

/**
 * POST /leaves/leavesApi/GetLeaveCommonDetails
 *
 * user_id — optional Darwinbox source_employee_id, internal employeeId, or
 *            internal UUID.  When omitted the requesting JWT principal is the
 *            implicit target.  Three-pass resolution is performed in the
 *            service layer to support all three ID formats transparently.
 */
export class GetLeaveCommonDetailsBodyDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

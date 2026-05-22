import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// =============================================================================
// UserIdQueryDto
//
// Used by the four single-user profile endpoints:
//   GET /Profileapi/enabledModulesListForProfileApi?user_id=...
//   GET /Profileapi/ViewProfileDetails?user_id=...
//   GET /Profileapi/ViewEmploymentDetails?user_id=...
//   GET /Profileapi/getOrganisationChartDetails?user_id=...
//
// user_id is optional — when omitted the requesting user's own UUID is used.
// This lets the frontend call these endpoints without knowing their own UUID
// (the JWT sub claim fills the gap).
// =============================================================================

export class UserIdQueryDto {
  @IsUUID('4')
  @IsOptional()
  user_id?: string;
}

// =============================================================================
// GetEmployeeDetailsBodyDto
//
// Request body for POST /Commondata/getemployeeDetails.
// Mirrors the Darwinbox wire format exactly so the Vue 3 / Quasar frontend
// can call our backend with the same payload it sends to the real Darwinbox.
//
// user_id — Darwinbox's internal source employee ID, stored in our system as
//   payload.darwinbox.source_employee_id. Optional: when omitted the endpoint
//   returns the details of the authenticated user (JWT sub claim).
//
//   Lookup order:
//     1. payload.darwinbox.source_employee_id = user_id (GIN-indexed, fast)
//     2. User.employeeId = user_id (company employee_no fallback)
// =============================================================================

export class GetEmployeeDetailsBodyDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

// =============================================================================
// OrgChartQueryDto
//
// Extends UserIdQueryDto with pagination controls for the direct-reports list.
// A manager with 200+ direct reports would otherwise produce an unbounded
// payload — reportTake caps the subordinate slice at 50.
// =============================================================================

export class OrgChartQueryDto extends UserIdQueryDto {
  @IsInt()
  @Min(0)
  @Type(() => Number)
  @IsOptional()
  reportSkip?: number;

  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @IsOptional()
  reportTake?: number;
}

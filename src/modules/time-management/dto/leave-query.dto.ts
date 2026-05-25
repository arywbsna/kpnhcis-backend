// =============================================================================
// leave-query.dto.ts
//
// class-validator DTOs for all 5 Leaves API request bodies.
// All routes are POST; query params live in the request body per the legacy
// Darwinbox wire specification.
// =============================================================================

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { LeaveType } from '@prisma/client';
import { Type } from 'class-transformer';

// ─── Shared base ──────────────────────────────────────────────────────────────

class EmployeeTargetDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

// ─── 1. GetLeaveCommonDetails ─────────────────────────────────────────────────

/**
 * POST /leaves/leavesApi/GetLeaveCommonDetails
 *
 * No required fields — the endpoint returns configuration for ALL active
 * leave types when called without filters.
 *
 * leave_type — optional filter to return config for a single leave category.
 * year       — policy year to read config for; defaults to the current year.
 */
export class GetLeaveCommonDetailsDto extends EmployeeTargetDto {
  @IsEnum(LeaveType)
  @IsOptional()
  leave_type?: LeaveType;

  @IsInt()
  @Min(2000)
  @Max(2100)
  @Type(() => Number)
  @IsOptional()
  year?: number;
}

// ─── 2. getUpcomingTimeOff ────────────────────────────────────────────────────

/**
 * POST /leaves/leavesApi/getUpcomingTimeOff
 *
 * from_date / to_date — inclusive window for the timeline feed.
 *   Default: today → +90 days (one quarter look-ahead).
 *
 * include_pending — when true, PENDING_APPROVAL records appear alongside
 *   APPROVED ones.  Default: true (frontend shows tentative blocks).
 *
 * skip / take — pagination.  Default: take=20, skip=0.
 */
export class UpcomingTimeOffDto extends EmployeeTargetDto {
  @IsDateString()
  @IsOptional()
  from_date?: string;

  @IsDateString()
  @IsOptional()
  to_date?: string;

  @IsOptional()
  include_pending?: boolean;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  @IsOptional()
  skip?: number;

  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @IsOptional()
  take?: number;
}

// ─── 3. getTeamStatus ────────────────────────────────────────────────────────

/**
 * POST /leaves/leavesApi/getTeamStatus
 *
 * date — the calendar date to evaluate for OOO status.
 *   Default: today (UTC midnight).
 *
 * include_peers — when true, unit peers (same manager, same department)
 *   are included in addition to direct reports.  Default: true.
 */
export class TeamStatusDto extends EmployeeTargetDto {
  @IsDateString()
  @IsOptional()
  date?: string;

  @IsOptional()
  include_peers?: boolean;
}

// ─── 4. GetDataForLeavePattern ────────────────────────────────────────────────

/**
 * POST /leaves/leavesApi/GetDataForLeavePattern
 *
 * leave_type — REQUIRED.  The cascade options differ by leave category
 *   (e.g. MATERNITY disables half-day options; SICK may require a document).
 *
 * year — policy year context for date range bounds.  Default: current year.
 */
export class GetLeavePatternDataDto extends EmployeeTargetDto {
  @IsEnum(LeaveType)
  @IsNotEmpty()
  leave_type: LeaveType;

  @IsInt()
  @Min(2000)
  @Max(2100)
  @Type(() => Number)
  @IsOptional()
  year?: number;
}

// ─── 5. GetLeaves ─────────────────────────────────────────────────────────────

/**
 * POST /leaves/leavesApi/GetLeaves
 *
 * year — the leave year to read balances for.  Default: current year.
 *
 * include_expired — when true, leave types whose expiry_date has passed are
 *   still returned in the response with remaining = 0.  Default: false.
 */
export class GetLeavesDto extends EmployeeTargetDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  @Type(() => Number)
  @IsOptional()
  year?: number;

  @IsOptional()
  include_expired?: boolean;
}

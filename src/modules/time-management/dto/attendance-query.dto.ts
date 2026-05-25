// =============================================================================
// attendance-query.dto.ts
//
// class-validator DTOs for all 5 Attendance API request bodies.
// All routes are POST so query params live in the body per the legacy
// Darwinbox wire specification.
//
// Validation pipeline:
//   ValidationPipe (global, set in main.ts) — whitelist + forbidNonWhitelisted
//   @Transform(() => Number) for numeric fields that arrive as strings in JSON
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
import { Type } from 'class-transformer';

// ─── Shared base ──────────────────────────────────────────────────────────────

/**
 * Reusable employee override.
 * Darwinbox's convention: `user_id` in the body can be a
 * source_employee_id, company employee_no, or internal UUID.
 * When omitted the endpoint operates on the authenticated user.
 */
class EmployeeTargetDto {
  @IsString()
  @IsOptional()
  user_id?: string;
}

// ─── 1. GetAttendanceDetails ──────────────────────────────────────────────────

/**
 * POST /attendance/attendanceAPI/GetAttendanceDetails
 *
 * from_date / to_date — inclusive ISO-8601 date strings ("YYYY-MM-DD").
 * The service caps the window at 31 days to prevent runaway aggregations.
 *
 * skip / take — optional pagination over the daily record list.
 * Default: take=31, skip=0.
 */
export class AttendanceDetailsQueryDto extends EmployeeTargetDto {
  @IsDateString()
  @IsNotEmpty()
  from_date: string;

  @IsDateString()
  @IsNotEmpty()
  to_date: string;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  @IsOptional()
  skip?: number;

  @IsInt()
  @Min(1)
  @Max(31)
  @Type(() => Number)
  @IsOptional()
  take?: number;
}

// ─── 2. GetAttendancePoliciesDetails ─────────────────────────────────────────

/**
 * POST /attendance/attendanceAPI/GetAttendancePoliciesDetails
 *
 * effective_date — optional ISO-8601 date for point-in-time policy lookup.
 * When omitted the service returns policies effective today.
 */
export class AttendancePoliciesQueryDto extends EmployeeTargetDto {
  @IsDateString()
  @IsOptional()
  effective_date?: string;
}

// ─── 3. GetAttendanceOverview ─────────────────────────────────────────────────

/**
 * POST /attendance/attendanceAPI/GetAttendanceOverview
 *
 * month / year — the calendar period to aggregate.
 * Both are required; the service rejects cross-year ranges here by design
 * (overview is always a single calendar month widget).
 */
export class AttendanceOverviewQueryDto extends EmployeeTargetDto {
  @IsInt()
  @Min(1)
  @Max(12)
  @IsNotEmpty()
  @Type(() => Number)
  month: number;

  @IsInt()
  @Min(2000)
  @Max(2100)
  @IsNotEmpty()
  @Type(() => Number)
  year: number;
}

// ─── 4. getDayStatus ─────────────────────────────────────────────────────────

/**
 * POST /attendance/attendanceAPI/getDayStatus
 *
 * date — the single calendar date to classify.
 * Returns the day type (WORKING_DAY, WEEKOFF, PUBLIC_HOLIDAY, REST_DAY)
 * plus the attendance record for that date if it exists.
 */
export class DayStatusQueryDto extends EmployeeTargetDto {
  @IsDateString()
  @IsNotEmpty()
  date: string;
}

// ─── 5. GetAttendanceLog ─────────────────────────────────────────────────────

/**
 * POST /attendance/attendanceAPI/GetAttendanceLog
 *
 * date            — the specific calendar date to fetch raw log events for.
 * source_filter   — optional filter by input source.
 * skip / take     — pagination over the event stream (default: take=50, skip=0).
 *
 * `source_filter` is an enum matching the AttendanceSource Prisma enum so
 * the controller can pass it directly into the Prisma query without mapping.
 */

const VALID_SOURCES = ['BIOMETRIC', 'MOBILE_GPS', 'WEB'] as const;
type AttendanceSourceFilter = (typeof VALID_SOURCES)[number];

export class AttendanceLogQueryDto extends EmployeeTargetDto {
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @IsEnum(VALID_SOURCES)
  @IsOptional()
  source_filter?: AttendanceSourceFilter;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  @IsOptional()
  skip?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @IsOptional()
  take?: number;
}

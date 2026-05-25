import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { User } from '@prisma/client';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../../casl/guards/permissions.guard';
import { GetAttendanceLogBodyDto } from './dto/get-attendance-log.dto';
import { GetDayStatusBodyDto } from './dto/get-day-status.dto';
import { GetAttendanceDetailsBodyDto } from './dto/get-attendance-details.dto';
import { GetAttendanceOverviewBodyDto } from './dto/get-attendance-overview.dto';
import { GetAttendancePoliciesBodyDto } from './dto/get-attendance-policies.dto';
import { AttendanceManagementService } from './attendance-management.service';
import type { GetAttendanceDetailsResponse } from './types/attendance-details.types';
import type { GetAttendanceLogResponse } from './types/attendance-log.types';
import type { GetAttendanceOverviewResponse } from './types/attendance-overview.types';
import type { GetAttendancePoliciesResponse } from './types/attendance-policies.types';
import type { GetDayStatusResponse } from './types/day-status.types';

/**
 * AttendanceManagementController
 *
 * Serves the 5 Attendance API endpoints.  The URL structure mirrors Darwinbox's
 * own `/attendance/attendanceAPI/` sub-path so that existing Postman collections
 * and frontend axios clients need zero path changes.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates Bearer token; populates request.user.
 *   PermissionsGuard — evaluates @CheckPermissions() tuples against the CASL
 *                      ability built from the user's DB roles (cached in Redis).
 *
 * ─── Authorization overview ───────────────────────────────────────────────────
 *   All five endpoints require read:AttendanceRecord at the class level.
 *   Cross-employee reads (user_id !== JWT sub) are further gated inside the
 *   service via assertAttendanceAccess() which enforces "own data OR admin".
 *
 * ─── URL convention ───────────────────────────────────────────────────────────
 *   Global prefix "api/v1" (set in main.ts).  Full URLs:
 *     POST /api/v1/attendance/attendanceAPI/GetAttendanceDetails
 *     POST /api/v1/attendance/attendanceAPI/GetAttendancePoliciesDetails
 *     POST /api/v1/attendance/attendanceAPI/GetAttendanceOverview
 *     POST /api/v1/attendance/attendanceAPI/getDayStatus
 *     POST /api/v1/attendance/attendanceAPI/GetAttendanceLog
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'AttendanceRecord'])
export class AttendanceManagementController {
  constructor(
    private readonly attendanceService: AttendanceManagementService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /attendance/attendanceAPI/GetAttendanceDetails
  //
  // Context-bootstrap call for the attendance DataTable view.
  // Returns three payloads in a single round-trip:
  //
  //   shift   — the employee's currently active shift card: begin/end times,
  //             gross duration ("09:00 hours"), overnight flag, resolved office
  //             location name, and a null-shift sentinel when no assignment
  //             exists.
  //   columns — static QTable column header definitions (key + title pairs)
  //             that the frontend uses to render the timesheet DataTable.
  //   overtime_approval_reasons — selectable OT reason labels from the shift's
  //             JSONB payload; empty array when the org has no OT workflow.
  //
  // Body: { user_id?, start_date?, end_date? }
  //   start_date — ISO-8601 "YYYY-MM-DD"; effective date for shift lookup.
  //                Defaults to today (UTC midnight) when omitted.
  //   end_date   — ISO-8601 "YYYY-MM-DD"; stored in context for future
  //                mid-period shift-change detection.  Optional.
  //   user_id    — Darwinbox source_employee_id, company employee_no, or UUID.
  //                Omit to return the authenticated user's own shift context.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendanceAPI/GetAttendanceDetails')
  @HttpCode(HttpStatus.OK)
  getAttendanceDetails(
    @Body() dto: GetAttendanceDetailsBodyDto,
    @Req() req: Request,
  ): Promise<GetAttendanceDetailsResponse> {
    return this.attendanceService.getAttendanceDetails(
      req.user as User,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /attendance/attendanceAPI/GetAttendancePoliciesDetails
  //
  // Emulates shift assignments and the full set of policy rules bound to each
  // shift: grace periods, overtime caps, absent-cutoff thresholds, and
  // weekend day masks.  Used by the frontend to render the policy summary card
  // and by integration tests to assert shift configuration integrity.
  //
  // Body: { user_id?, effective_date? }
  //   effective_date — ISO-8601 date for point-in-time lookup; defaults to today.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendanceAPI/GetAttendancePoliciesDetails')
  @HttpCode(HttpStatus.OK)
  getAttendancePoliciesDetails(
    @Body() dto: GetAttendancePoliciesBodyDto,
    @Req() req: Request,
  ): Promise<GetAttendancePoliciesResponse> {
    return this.attendanceService.getAttendancePoliciesDetails(
      req.user as User,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /attendance/attendanceAPI/GetAttendanceOverview
  //
  // Time-series analytics dashboard for the requested date window.
  //
  // Returns two payloads:
  //   details         — a continuous day-by-day array between start_date and
  //                     end_date (inclusive).  Every calendar date is present,
  //                     including weekends and public holidays which carry
  //                     is_non_working_day = 1 and the expected shift duration
  //                     in non_working_duration.
  //   overall_summary — consolidated aggregates across the full window:
  //                     total/avg work duration (seconds-accurate), total/avg
  //                     late-by, total/avg overtime.  Averages are truncated to
  //                     the nearest minute (Darwinbox legacy rounding behaviour).
  //
  // Duration strings in per-day entries use "HH:mm:ss" (zero-padded).
  // overall_summary durations use "H:mm:ss" (no leading zero; hours may exceed
  // 24 for multi-day windows).
  //
  // Body: { start_date, end_date, user_id? }
  //   start_date — ISO-8601 "YYYY-MM-DD"; window start (midnight UTC).
  //   end_date   — ISO-8601 "YYYY-MM-DD"; window end (midnight UTC).
  //   user_id    — optional Darwinbox/employee/UUID target; defaults to the
  //                JWT principal.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendanceAPI/GetAttendanceOverview')
  @HttpCode(HttpStatus.OK)
  getAttendanceOverview(
    @Body() dto: GetAttendanceOverviewBodyDto,
    @Req() req: Request,
  ): Promise<GetAttendanceOverviewResponse> {
    return this.attendanceService.getAttendanceOverview(
      (req.user as User).id,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /attendance/attendanceAPI/getDayStatus
  //
  // Calendaring helper.  Resolves the exact cell state for a single date:
  //   WORKING_DAY   — shift is scheduled, no public holiday
  //   WEEKOFF       — falls on a weekend day per the employee's shift config
  //   PUBLIC_HOLIDAY — matched in the PublicHoliday table for the employee's
  //                   country/region code
  //   REST_DAY      — explicitly assigned rest day (e.g. compensatory off)
  //
  // Also returns the attendance record for that date (clock-in/out, status)
  // if an AttendanceDaily row exists, so the calendar cell can render both
  // the day classification and the actual clock data in one request.
  //
  // Body: { user_id?, date }
  //   date — ISO-8601 "YYYY-MM-DD" of the day to resolve.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendanceAPI/getDayStatus')
  @HttpCode(HttpStatus.OK)
  getDayStatus(
    @Body() dto: GetDayStatusBodyDto,
    @Req() req: Request,
  ): Promise<GetDayStatusResponse> {
    return this.attendanceService.getDayStatus((req.user as User).id, dto);
  }

  // ---------------------------------------------------------------------------
  // POST /attendance/attendanceAPI/GetAttendanceLog
  //
  // Day-by-day attendance ledger for the requested date window.
  //
  // Returns a `logs` dictionary keyed by "YYYY-MM-DD" date strings covering
  // every calendar day between start_date and end_date inclusive (no gaps).
  // Each entry contains:
  //   — Clock-in / clock-out full datetime and time-only duplicates.
  //   — Duration arithmetic: elapsed, break delta, final net work time.
  //   — A status badge array (Present / Absent / Holiday / Week Off / Leave).
  //   — An actions block with ot_journal_enable / att_register_enable flags.
  //   — A user_attendance_details shift card carrying the employee's shift
  //     name, start/end times, duration, grace periods, and policy label.
  //   — Window-level counters (present_count, absent_count, leave_count,
  //     unpaid_count) repeated on every entry for convenience.
  //
  // Inactive days (weekoffs, public holidays, absent, leave) receive an
  // empty-string fallcard with zero durations and the appropriate badge.
  // The shift card in user_attendance_details is still populated on inactive
  // days so the frontend can render the expected schedule context.
  //
  // Body: { start_date, end_date, user_id? }
  //   start_date — ISO-8601 "YYYY-MM-DD"; window start (midnight UTC).
  //   end_date   — ISO-8601 "YYYY-MM-DD"; window end (midnight UTC).
  //                Maximum window: 31 days.
  //   user_id    — Darwinbox source_employee_id, company employee_no, or
  //                internal UUID.  Omit to query the JWT principal's records.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendanceAPI/GetAttendanceLog')
  @HttpCode(HttpStatus.OK)
  getAttendanceLog(
    @Body() dto: GetAttendanceLogBodyDto,
    @Req() req: Request,
  ): Promise<GetAttendanceLogResponse> {
    return this.attendanceService.getAttendanceLog((req.user as User).id, dto);
  }
}

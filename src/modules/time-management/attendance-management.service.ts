import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AttendanceSource,
  DayType,
  LeaveRequestStatus,
  LeaveType,
  Prisma,
  User,
} from '@prisma/client';

import { CaslAbilityFactory } from '../../casl/casl-ability.factory';
import { subject } from '../../casl/casl.types';
import { PrismaService } from '../../prisma/prisma.service';
import type { GetAttendanceLogBodyDto } from './dto/get-attendance-log.dto';
import type { GetDayStatusBodyDto } from './dto/get-day-status.dto';
import type { GetAttendanceDetailsBodyDto } from './dto/get-attendance-details.dto';
import type { GetAttendanceOverviewBodyDto } from './dto/get-attendance-overview.dto';
import type { GetAttendancePoliciesBodyDto } from './dto/get-attendance-policies.dto';
import {
  ATTENDANCE_QUEUE,
  AttendanceJobName,
  type AntiFraudScanPayload,
  type DailySummaryAggregatePayload,
} from './queues/attendance.queue';
import type {
  DWShiftDetails,
  GetAttendanceDetailsResponse,
  OvertimeApprovalReason,
  ShiftAssignmentLocationPayload,
  ShiftDefinitionDetailPayload,
} from './types/attendance-details.types';
import type {
  DWDaySummary,
  DWDayOverviewEntry,
  DWOverallSummary,
  GetAttendanceOverviewResponse,
} from './types/attendance-overview.types';
import type { AttendanceLogEvent } from './types/attendance.types';
import type {
  DWDayLogLedgerEntry,
  DWLogActionsBlock,
  DWLogStatusBadge,
  DWUserAttendanceDetails,
  GetAttendanceLogResponse,
} from './types/attendance-log.types';
import type { GetDayStatusResponse } from './types/day-status.types';
import type {
  DWGeofenceConfig,
  DWOvertimePolicy,
  DWOvertimeTableRow,
  DWPayGroup,
  DWPolicyEnvelope,
  DWPolicyRow,
  DWTenantShift,
  GetAttendancePoliciesResponse,
  OvertimeCalculationTier,
  ShiftAssignmentPoliciesPayload,
  ShiftDefinitionPoliciesPayload,
} from './types/attendance-policies.types';
import type {
  AllowedLocation,
  AttendanceDailyPayload,
  AttendanceLogPayload,
  CurrentLocationContext,
  DeviceInfo,
  ResolvedShiftDate,
  ShiftWindowSnapshot,
} from './types/shared.types';

// ─── Internal DB row shapes ───────────────────────────────────────────────────

/** Prisma include shape for daily rows with shift and log count. */
type DailyWithShift = Prisma.AttendanceDailyGetPayload<{
  include: { shift: true };
}>;

/** Prisma include shape for log rows with no relations. */
type LogRow = Prisma.AttendanceLogGetPayload<Record<string, never>>;

/** Prisma include shape for shift assignments with the shift definition. */
type ShiftAssignmentWithDef = Prisma.ShiftAssignmentGetPayload<{
  include: { shift: true };
}>;

/** Scalar ShiftDefinition row shape; used by the ledger entry builder. */
type ShiftDefRow = NonNullable<DailyWithShift['shift']>;

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DATE_WINDOW_DAYS = 31;
const DEFAULT_TAKE_LOGS    = 50;

// Hard ceiling on the number of approved leave requests fetched per window.
// An employee cannot realistically have more than this many discrete approved
// leave requests overlapping a 31-day window.  The ceiling prevents O(N²)
// leave-date expansion loops from being exploited by malformed data.
const MAX_LEAVE_FETCH = 200;

/** Milliseconds in one minute — used for shift-window arithmetic. */
const MS_PER_MIN = 60_000;

/**
 * UTC offset in seconds for the operational timezone: WIB (Waktu Indonesia
 * Barat) = UTC+7.  WIB has no daylight-saving transitions, so this constant
 * is stable year-round.
 *
 * Used to:
 *   1. Anchor attendance dates to the LOCAL calendar day in resolveShiftDate
 *      (prevents pre-07:00 WIB punches from clipping into UTC "yesterday").
 *   2. Normalise punch timestamps to local-time seconds-from-midnight when
 *      computing earlyOut so shift boundaries (stored in local wall-clock time)
 *      are compared on a consistent timezone axis.
 */
const OPERATIONAL_TZ_OFFSET_SECS = 7 * 3600;

// =============================================================================
// Module-level constant — DataTable column definitions
//
// Externalised here so the array is allocated once per process rather than
// once per request.  The column order matches the legacy Darwinbox wire spec
// exactly; do not reorder without updating the frontend QTable config.
// =============================================================================

const ATTENDANCE_DETAILS_COLUMNS = [
  { key: 'date',                title: 'Date' },
  { key: 'attendance_status',   title: 'Attendance' },
  { key: 'request_status',      title: 'Request Status' },
  { key: 'clock_in',            title: 'Time In' },
  { key: 'clock_out',           title: 'Time Out' },
  { key: 'final_work_duration', title: 'Final Work Duration' },
  { key: 'total_work_duration', title: 'Total Work Duration' },
  { key: 'overtime',            title: 'Overtime' },
  { key: 'late_mark',           title: 'Late By' },
  { key: 'actions',             title: 'Actions' },
] as const satisfies import('./types/attendance-details.types').DWTableColumn[];

// Policy summary table column headers — static across all employees.
const POLICY_TABLE_HEADERS = [
  { key: 'attribute', title: 'Attribute' },
  { key: 'value',     title: 'Value' },
] as const satisfies import('./types/attendance-policies.types').DWPolicyTableHeader[];

// Overtime table column headers — static across all employees.
const OT_TABLE_HEADERS = [
  { key: 'day_type',         title: 'Day Type' },
  { key: 'calculation_rule', title: 'Calculation Rule' },
] as const satisfies import('./types/attendance-policies.types').DWPolicyTableHeader[];

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AttendanceManagementService {
  private readonly logger = new Logger(AttendanceManagementService.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly casl:     CaslAbilityFactory,
    @InjectQueue(ATTENDANCE_QUEUE)
    private readonly attendanceQueue: Queue,
  ) {}

  // ===========================================================================
  // 1. GetAttendanceDetails
  //
  // Context-bootstrap endpoint.  Returns the employee's active shift card,
  // the static DataTable column definitions, and the org's OT reason catalogue
  // in a single round-trip.  Does NOT return daily timesheet rows — those are
  // paginated separately by a distinct query once the table is initialised.
  //
  // Shift resolution uses start_date (or today when omitted) as the
  // point-in-time anchor.  The effective ShiftAssignment is the most recent
  // row whose effectiveDate ≤ anchor and whose expiryDate is null or ≥ anchor.
  // ===========================================================================

  async getAttendanceDetails(
    requestingUser: User,
    dto: GetAttendanceDetailsBodyDto,
  ): Promise<GetAttendanceDetailsResponse> {
    // ── Step 1: Resolve & authorise the target employee ──────────────────────
    const targetUserId = await this.resolveTargetUserId(requestingUser, dto.user_id);

    // Cross-employee reads require a CASL ability check.
    // Own-user reads are always permitted — skip the DB call for performance.
    if (targetUserId !== requestingUser.id) {
      const targetUser = await this.prisma.user.findUniqueOrThrow({
        where: { id: targetUserId },
      });
      await this.assertAttendanceAccess(requestingUser, targetUser);
    }

    // ── Step 2: Normalise the effective date to UTC midnight ─────────────────
    // Midnight-UTC normalisation: every date comparison in this service uses
    // UTC midnight as the canonical anchor to ensure consistent results
    // regardless of the server's local timezone or the client's timezone.
    const effectiveDate: Date = dto.start_date
      ? new Date(dto.start_date + 'T00:00:00Z')
      : this.utcMidnightToday();

    // ── Step 3: Validate end_date is not before start_date when both provided ─
    if (dto.start_date && dto.end_date) {
      const endDate = new Date(dto.end_date + 'T00:00:00Z');
      if (endDate < effectiveDate) {
        throw new BadRequestException(
          'end_date must not precede start_date.',
        );
      }
    }

    // ── Step 4: Fetch the effective ShiftAssignment + ShiftDefinition row ─────
    // The most recent assignment whose window covers effectiveDate.
    // Returns null when the employee has no shift scheduled — the service
    // returns a null-shift sentinel in that case rather than throwing.
    const assignment = await this.prisma.shiftAssignment.findFirst({
      where: {
        userId:        targetUserId,
        effectiveDate: { lte: effectiveDate },
        OR: [
          { expiryDate: null },
          { expiryDate: { gte: effectiveDate } },
        ],
      },
      include:  { shift: true },
      orderBy:  { effectiveDate: 'desc' },
    });

    // ── Step 5: Map to wire-format shift card ─────────────────────────────────
    const shift: DWShiftDetails = assignment
      ? this.mapAssignmentToShiftDetails(assignment)
      : this.buildNullShift();

    // ── Step 6: Extract overtime approval reasons from shift JSONB payload ────
    // Empty array is the correct response when no OT workflow is configured.
    const overtime_approval_reasons: OvertimeApprovalReason[] = assignment
      ? this.extractOvertimeApprovalReasons(assignment.shift)
      : [];

    return {
      status: 1,
      data: {
        shift,
        columns:                   [...ATTENDANCE_DETAILS_COLUMNS],
        overtime_approval_reasons,
      },
    };
  }

  // ===========================================================================
  // 2. GetAttendancePoliciesDetails
  //
  // Returns the complete policies card for the employee's active shift on the
  // requested date.  The response contains:
  //   geo_fencing        — dynamic hash of allowed location entries
  //   attendance_policy  — grace periods, backdated restriction, QTable display
  //   overtime_policy    — OT tier table, enabled flag
  //   tenant_shift       — condensed shift identity card
  //   weeklyoff_details  — human-readable weekend day description
  //   pay_group          — pay group binding (from assignment payload or default)
  //   month_to_select    — current month label e.g. "May 2026"
  //   cycle_start        — first day of the active pay cycle "YYYY-MM-DD"
  //   cycle_end          — last  day of the active pay cycle "YYYY-MM-DD"
  // ===========================================================================

  async getAttendancePoliciesDetails(
    requestingUser: User,
    dto: GetAttendancePoliciesBodyDto,
  ): Promise<GetAttendancePoliciesResponse> {
    // ── Step 1: Resolve & authorise the target employee ──────────────────────
    const targetUserId = await this.resolveTargetUserId(requestingUser, dto.user_id);

    if (targetUserId !== requestingUser.id) {
      const targetUser = await this.prisma.user.findUniqueOrThrow({
        where: { id: targetUserId },
      });
      await this.assertAttendanceAccess(requestingUser, targetUser);
    }

    // ── Step 2: Normalise effective date to UTC midnight ─────────────────────
    const effectiveDate: Date = dto.effective_date
      ? new Date(dto.effective_date + 'T00:00:00Z')
      : this.utcMidnightToday();

    // ── Step 3: Fetch the active ShiftAssignment + ShiftDefinition ───────────
    const assignment = await this.prisma.shiftAssignment.findFirst({
      where: {
        userId:        targetUserId,
        effectiveDate: { lte: effectiveDate },
        OR: [
          { expiryDate: null },
          { expiryDate: { gte: effectiveDate } },
        ],
      },
      include:  { shift: true },
      orderBy:  { effectiveDate: 'desc' },
    });

    // When no shift is configured return a minimal but valid response so the
    // frontend can still render an empty policy card without error handling.
    if (!assignment) {
      const emptyShift = this.buildNullShift();
      const emptyTenantShift: DWTenantShift = {
        shift_id:   emptyShift.id,
        shift_name: emptyShift.shift_name,
        begin_time: emptyShift.begin_time,
        end_time:   emptyShift.end_time,
      };
      const { cycle_start, cycle_end, month_to_select } =
        this.buildCycleDates(effectiveDate, undefined);

      return {
        status: 1,
        data: {
          geo_fencing:       {},
          attendance_policy: this.buildAttendancePolicyBody(assignment, undefined),
          overtime_policy:   this.buildOvertimePolicyBody(assignment, undefined),
          tenant_shift:      emptyTenantShift,
          weeklyoff_details: '',
          pay_group:         this.buildPayGroup(undefined),
          month_to_select,
          cycle_start,
          cycle_end,
        },
      };
    }

    const shiftPayload =
      assignment.shift.payload as unknown as ShiftDefinitionPoliciesPayload | null;
    const assignmentPayload =
      assignment.payload as unknown as ShiftAssignmentPoliciesPayload | null;

    return {
      status: 1,
      data: {
        geo_fencing:       this.buildGeofencingConfig(assignment),
        attendance_policy: this.buildAttendancePolicyBody(assignment, shiftPayload),
        overtime_policy:   this.buildOvertimePolicyBody(assignment, shiftPayload),
        tenant_shift:      this.buildTenantShift(assignment),
        weeklyoff_details: this.buildWeeklyOffDetails(assignment.shift.weekendDays),
        pay_group:         this.buildPayGroup(assignmentPayload),
        ...this.buildCycleDates(effectiveDate, assignmentPayload),
      },
    };
  }

  // ===========================================================================
  // 3. GetAttendanceOverview
  //
  // Time-series analytics dashboard endpoint.  Produces a continuous day-by-day
  // `details` array and a consolidated `overall_summary` for the requested
  // date window.
  //
  // Pipeline steps:
  //   1.  Resolve and authorise the target employee.
  //   2.  Parse and validate the start_date / end_date window boundaries.
  //   3.  Fetch all AttendanceDaily rows in range (one DB round-trip).
  //   4.  Resolve the active shift assignment to derive the expected shift
  //       duration (used for non_working_duration and total_absent_duration).
  //   5.  Fetch public holidays in range for the employee's country.
  //   6.  Fetch APPROVED leave requests that overlap the window.
  //   7.  Expand leave requests into a per-date lookup set.
  //   8.  Generate the continuous date-series loop, classify each day, and
  //       accumulate totals for the overall_summary.
  //   9.  Compute overall_summary averages (truncated to nearest minute).
  //  10.  Return the wire-format envelope.
  //
  // Duration arithmetic uses seconds internally; `secondsToTimeString` handles
  // all conversions at the serialization boundary.
  // ===========================================================================

  async getAttendanceOverview(
    requestingUserId: string,
    dto: GetAttendanceOverviewBodyDto,
  ): Promise<GetAttendanceOverviewResponse> {
    // ── Step 1: Resolve & authorise ──────────────────────────────────────────
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, dto.user_id);
    await this.assertAttendanceAccess(requestingUser, targetUser);

    // ── Step 2: Parse and validate date window ───────────────────────────────
    // Normalise both boundaries to UTC midnight so every later comparison is
    // unambiguous regardless of the server or client timezone.
    const startDate = new Date(dto.start_date + 'T00:00:00Z');
    const endDate   = new Date(dto.end_date   + 'T00:00:00Z');

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException(
        'start_date and end_date must be valid ISO-8601 dates.',
      );
    }
    if (startDate > endDate) {
      throw new BadRequestException('start_date must not be after end_date.');
    }
    const windowDays =
      Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    if (windowDays > MAX_DATE_WINDOW_DAYS) {
      throw new BadRequestException(
        `Date window exceeds the maximum of ${MAX_DATE_WINDOW_DAYS} days.`,
      );
    }

    // ── Steps 3–6: Concurrent batch queries ──────────────────────────────────
    // All four queries are independent reads given the resolved targetUser.id
    // and validated date window — issued in parallel via Promise.all() to
    // eliminate the serial latency that would accumulate from four sequential
    // round-trips.
    //
    //   Query A — AttendanceDaily: all daily aggregate rows in the window,
    //             joined with ShiftDefinition (for dayType / shift context).
    //
    //   Query B — ShiftAssignment: the most recent assignment whose window
    //             covers startDate, used for expected shift duration arithmetic.
    //             Mid-period shift changes are not modelled at this layer.
    //
    //   Query C — PublicHoliday: mandatory (isOptional = false) national
    //             holidays within the window for the employee's country code.
    //
    //   Query D — LeaveRequest: any APPROVED leave whose date range overlaps
    //             the window.  The AND predicate is intentionally broader than
    //             an exact start-date filter so multi-day leaves that begin
    //             before the window still cover days inside it.
    const countryCode = this.extractCountryCode(targetUser);

    const [dailyRows, shiftAssignment, publicHolidays, approvedLeaves] =
      await Promise.all([
        this.prisma.attendanceDaily.findMany({
          where: {
            userId:         targetUser.id,
            attendanceDate: { gte: startDate, lte: endDate },
          },
          include:  { shift: true },
          orderBy:  { attendanceDate: 'asc' },
        }),
        this.prisma.shiftAssignment.findFirst({
          where: {
            userId:        targetUser.id,
            effectiveDate: { lte: startDate },
            OR: [{ expiryDate: null }, { expiryDate: { gte: startDate } }],
          },
          include:  { shift: true },
          orderBy:  { effectiveDate: 'desc' },
        }),
        this.prisma.publicHoliday.findMany({
          where: {
            date:       { gte: startDate, lte: endDate },
            countryCode,
            isOptional: false,
          },
          select: { date: true },
        }),
        this.prisma.leaveRequest.findMany({
          where: {
            userId: targetUser.id,
            status: LeaveRequestStatus.APPROVED,
            AND: [
              { startDate: { lte: endDate   } },
              { endDate:   { gte: startDate } },
            ],
          },
          select: { startDate: true, endDate: true },
          take:   MAX_LEAVE_FETCH,
        }),
      ]);

    // Index daily rows by date string for O(1) lookup in the day loop.
    const dailyByDate = new Map<string, DailyWithShift>();
    for (const row of dailyRows) {
      dailyByDate.set(row.attendanceDate.toISOString().slice(0, 10), row);
    }

    // Weekend day mask from the shift definition — 0=Sun … 6=Sat.
    const weekendDaySet = new Set<number>(shiftAssignment?.shift.weekendDays ?? [0, 6]);

    // Expected shift duration in seconds.  Drives:
    //   — non_working_duration on weekoffs / public holidays ("H:mm:ss", no leading zero)
    //   — total_absent_duration on absent working days ("HH:mm:ss", zero-padded)
    const expectedShiftSecs: number = shiftAssignment
      ? this.computeShiftDurationMins(
          shiftAssignment.shift.startTime,
          shiftAssignment.shift.endTime,
          shiftAssignment.shift.isOvernight,
        ) * 60
      : 9 * 3600;   // 9-hour default when no shift assignment exists

    // Index public holidays by date string for O(1) lookup.
    const holidayDateSet = new Set(
      publicHolidays.map(h => h.date.toISOString().slice(0, 10)),
    );

    // ── Step 7: Expand leave request date ranges into a fast lookup set ───────
    // We clamp each leave to the query window so the inner loop never allocates
    // dates that will never be queried.
    const leaveDateSet = new Set<string>();
    for (const lr of approvedLeaves) {
      const rangeStart = lr.startDate > startDate ? lr.startDate : startDate;
      const rangeEnd   = lr.endDate   < endDate   ? lr.endDate   : endDate;
      const cursor     = new Date(rangeStart);
      while (cursor <= rangeEnd) {
        leaveDateSet.add(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    // ── Step 8: Generate the continuous date-series loop ─────────────────────
    const details: DWDayOverviewEntry[] = [];

    // Running accumulators for overall_summary.
    let totalPresentDays  = 0;
    let totalAbsentDays   = 0;
    let totalLeaveDays    = 0;
    let sumWorkSecs       = 0;   // from PRESENT days only
    let sumLateByTotalSecs   = 0;   // from all non-holiday working days
    let sumOvertimeTotalSecs = 0;   // from PRESENT days only

    const day = new Date(startDate);
    while (day <= endDate) {
      const dateStr   = day.toISOString().slice(0, 10);
      const dayOfWeek = day.getUTCDay();   // 0=Sun … 6=Sat
      const row       = dailyByDate.get(dateStr);

      const isHoliday = holidayDateSet.has(dateStr);
      const isWeekend = weekendDaySet.has(dayOfWeek);
      const isOnLeave = leaveDateSet.has(dateStr);

      // A stored AttendanceDaily row may carry an explicit non-working
      // classification (WEEKOFF, PUBLIC_HOLIDAY, REST_DAY) set by the
      // aggregation worker — this takes precedence over calendar inference.
      const rowDayType = row?.dayType;
      const isNonWorkingRow =
        rowDayType === DayType.WEEKOFF        ||
        rowDayType === DayType.PUBLIC_HOLIDAY ||
        rowDayType === DayType.REST_DAY;

      // A day is non-working when the stored row says so OR when no row exists
      // and the calendar (weekend/holiday table) classifies it as such.
      const isNonWorking = isNonWorkingRow || (!row && (isHoliday || isWeekend));

      let summary: DWDaySummary;

      if (isNonWorking) {
        // ── Non-working day (weekend, public holiday, rest day) ─────────────
        // non_working_duration carries the expected shift duration so the
        // frontend can display the "counterfactual" hours alongside the day.
        // Format: "H:mm:ss" without a leading zero (Darwinbox legacy quirk).
        summary = {
          present_days:          0,
          absent_days:           0,
          leave_days:            0,
          avg_work_duration:     '00:00:00',
          total_work_duration:   '00:00:00',
          avg_late_by:           '00:00:00',
          avg_overtime:          '00:00:00',
          is_non_working_day:    1,
          non_working_duration:  this.secondsToTimeString(expectedShiftSecs, false),
          total_absent_duration: '00:00:00',
        };

      } else if (isOnLeave) {
        // ── Leave day ────────────────────────────────────────────────────────
        // Extract actual clocked metrics — an employee on a half-day leave may
        // still have a clock-in record with valid late or overtime data.
        // Zero-fill when no daily row exists (full-day leave, never clocked in).
        const workSecs = row ? (row.totalWorkMins ?? 0) * 60 : 0;
        const lateSecs = row ? (row.lateByMins    ?? 0) * 60 : 0;
        const otSecs   = row ? (row.overtimeMins  ?? 0) * 60 : 0;

        totalLeaveDays++;

        // Any valid late mark or overtime registered by the aggregation job on
        // a leave day must still be captured in the window-level accumulators.
        // The workingDivisor already includes totalLeaveDays so the per-working-
        // day averages for late_by and overtime remain mathematically correct.
        sumLateByTotalSecs   += lateSecs;
        sumOvertimeTotalSecs += otSecs;

        summary = {
          present_days:          0,
          absent_days:           0,
          leave_days:            1,
          avg_work_duration:     this.secondsToTimeString(workSecs),
          total_work_duration:   this.secondsToTimeString(workSecs),
          avg_late_by:           this.secondsToTimeString(lateSecs),
          avg_overtime:          this.secondsToTimeString(otSecs),
          is_non_working_day:    0,
          non_working_duration:  '00:00:00',
          total_absent_duration: '00:00:00',
        };

      } else if (row !== undefined && row.firstClockIn !== null) {
        // ── Present day (working day with a recorded clock-in) ───────────────
        // displayWorkSecs: from the aggregation-job integer (totalWorkMins × 60).
        //   Used for the per-day DWDaySummary card — represents the confirmed
        //   net work time after break deductions and OT cap rules are applied.
        //   Minute-truncation is already baked in by the job writer.
        //
        // rawAccumSecs: from raw firstClockIn → lastClockOut timestamp delta,
        //   truncated to whole seconds.  Used ONLY for the overall_summary
        //   accumulator so sub-minute precision is not discarded before summing.
        //   Over a 31-day window, each day's up-to-59 lost seconds compound to
        //   ~30 minutes of drift vs. the raw log — this eliminates that drift.
        //   Falls back to displayWorkSecs when the daily row has no clock-out
        //   yet (employee still clocked in when the request is served).
        const displayWorkSecs = Math.floor((row.totalWorkMins ?? 0) * 60 / 60) * 60;
        const lateSecs        = (row.lateByMins   ?? 0) * 60;
        const otSecs          = (row.overtimeMins ?? 0) * 60;

        const rawAccumSecs =
          row.lastClockOut !== null
            ? Math.floor(
                (row.lastClockOut.getTime() - row.firstClockIn.getTime()) / 1000,
              )
            : displayWorkSecs;

        totalPresentDays++;
        sumWorkSecs          += rawAccumSecs;
        sumLateByTotalSecs   += lateSecs;
        sumOvertimeTotalSecs += otSecs;

        summary = {
          present_days:          1,
          absent_days:           0,
          leave_days:            0,
          avg_work_duration:     this.secondsToTimeString(displayWorkSecs),
          total_work_duration:   this.secondsToTimeString(displayWorkSecs),
          avg_late_by:           this.secondsToTimeString(lateSecs),
          avg_overtime:          this.secondsToTimeString(otSecs),
          is_non_working_day:    0,
          non_working_duration:  '00:00:00',
          total_absent_duration: '00:00:00',
        };

      } else {
        // ── Absent day (working day, no approved leave, no clock-in) ─────────
        // total_absent_duration carries the full expected shift duration —
        // the time the employee should have worked but did not.
        totalAbsentDays++;

        summary = {
          present_days:          0,
          absent_days:           1,
          leave_days:            0,
          avg_work_duration:     '00:00:00',
          total_work_duration:   '00:00:00',
          avg_late_by:           '00:00:00',
          avg_overtime:          '00:00:00',
          is_non_working_day:    0,
          non_working_duration:  '00:00:00',
          total_absent_duration: this.secondsToTimeString(expectedShiftSecs),
        };
      }

      details.push({ title: dateStr, summary });
      day.setUTCDate(day.getUTCDate() + 1);
    }

    // ── Step 9: Compute overall_summary ──────────────────────────────────────
    // Averages use the Darwinbox legacy rounding rule: truncate to the nearest
    // minute before serialisation (Math.floor(rawSecs / 60) * 60).
    //
    // Divisors are guarded against zero with a fallback of 1 so the output is
    // always "00:00:00" rather than NaN when there are no qualifying days.
    const presentDivisor  = totalPresentDays || 1;
    const workingDivisor  = (totalPresentDays + totalAbsentDays + totalLeaveDays) || 1;

    // Darwinbox truncation rule: floor the average to the nearest whole minute
    // before serialisation.  sumWorkSecs is accumulated from raw timestamps so
    // the pre-truncation average is more accurate than if we had summed the
    // already-integer-truncated totalWorkMins values.
    const avgWorkSecs = Math.floor(sumWorkSecs          / presentDivisor  / 60) * 60;
    const avgLateSecs = Math.floor(sumLateByTotalSecs   / workingDivisor  / 60) * 60;
    const avgOtSecs   = Math.floor(sumOvertimeTotalSecs / presentDivisor  / 60) * 60;

    // total_work_duration and avg_work_duration use "H:mm:ss" (no leading zero)
    // because hours may exceed 24 for multi-day windows and because Darwinbox
    // historically omits the leading zero in these two fields only.
    // All other overall_summary durations use the standard "HH:mm:ss" format.
    const overall_summary: DWOverallSummary = {
      present_days:        totalPresentDays,
      absent_days:         totalAbsentDays,
      leave_days:          totalLeaveDays,
      total_work_duration: this.secondsToTimeString(sumWorkSecs, false),
      avg_work_duration:   this.secondsToTimeString(avgWorkSecs, false),
      total_late_by:       this.secondsToTimeString(sumLateByTotalSecs),
      avg_late_by:         this.secondsToTimeString(avgLateSecs),
      avg_overtime:        this.secondsToTimeString(avgOtSecs),
      total_overtime:      this.secondsToTimeString(sumOvertimeTotalSecs),
    };

    return {
      status: 1,
      data:   { details, overall_summary },
    };
  }

  // ===========================================================================
  // 4. getDayStatus
  //
  // Resolves granular punch metadata, shift duration metrics, and raw timing
  // strings for a single targeted calendar date.  Used by the frontend when
  // the user clicks a day cell in the attendance calendar.
  //
  // Pipeline steps:
  //   1.  Resolve and authorise the target employee.
  //   2.  Normalise the input date to UTC midnight.
  //   3.  Resolve the active shift assignment to derive the expected shift
  //       duration (shift_duration field).
  //   4.  Fetch the AttendanceDaily row for the date (may be absent for
  //       future dates, weekoffs, or unrecorded working days).
  //   5.  Build deterministic hex identifiers (user_id, log_id).
  //   6.  Map raw punch timestamps to "HH:mm:ss" strings.
  //   7.  Compute duration strings with correct leading-zero rules.
  //   8.  Return the wire-format envelope.
  // ===========================================================================

  async getDayStatus(
    requestingUserId: string,
    dto: GetDayStatusBodyDto,
  ): Promise<GetDayStatusResponse> {
    // ── Step 1: Resolve & authorise ──────────────────────────────────────────
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, dto.user_id);
    await this.assertAttendanceAccess(requestingUser, targetUser);

    // ── Step 2: Normalise target date to UTC midnight ─────────────────────────
    const targetDate = new Date(dto.date + 'T00:00:00Z');
    if (isNaN(targetDate.getTime())) {
      throw new BadRequestException('date must be a valid ISO-8601 date.');
    }
    // Re-derive the canonical date string from the parsed Date so the response
    // is always "YYYY-MM-DD" regardless of what the caller sent (e.g. no
    // accidental timezone shift from an ambiguous input string).
    const dateStr = targetDate.toISOString().slice(0, 10);

    // ── Step 3: Resolve active shift for expected-duration arithmetic ──────────
    // A single assignment anchored to the target date is used throughout.
    // The shift is queried even for non-working days so shift_duration is
    // always populated — the frontend renders it in the day-detail card header
    // regardless of the day classification.
    const shiftAssignment = await this.prisma.shiftAssignment.findFirst({
      where: {
        userId:        targetUser.id,
        effectiveDate: { lte: targetDate },
        OR: [{ expiryDate: null }, { expiryDate: { gte: targetDate } }],
      },
      include:  { shift: true },
      orderBy:  { effectiveDate: 'desc' },
    });

    // Expected shift length in seconds.  Defaults to 9 hours when no
    // assignment exists so shift_duration is never an empty string.
    const expectedShiftSecs: number = shiftAssignment
      ? this.computeShiftDurationMins(
          shiftAssignment.shift.startTime,
          shiftAssignment.shift.endTime,
          shiftAssignment.shift.isOvernight,
        ) * 60
      : 9 * 3600;

    // ── Step 4: Fetch the AttendanceDaily row for the target date ─────────────
    // findUnique on the composite unique index (userId, attendanceDate) — O(1).
    // Returns null for future dates, weekoffs with no system record, or working
    // days where the employee did not clock in.
    const dailyRow = await this.prisma.attendanceDaily.findUnique({
      where: {
        userId_attendanceDate: {
          userId:         targetUser.id,
          attendanceDate: targetDate,
        },
      },
    });

    // ── Step 5: Build deterministic hex identifiers ───────────────────────────
    // user_id: first 23 hex chars from the target user UUID (hyphens stripped).
    //   A UUID without hyphens is 32 hex chars; slicing to 23 yields a stable,
    //   Darwinbox-compatible identifier that is always consistent for the same
    //   employee regardless of which date is queried.
    //
    // log_id: first 14 hex chars from the AttendanceDaily UUID (hyphens stripped).
    //   Matches the 14-char hex key convention used across this module (policy_id,
    //   shift_id, etc.).  Emits "" when no daily row exists — the Darwinbox
    //   client treats an empty log_id as "no record for this date".
    const userIdHex = targetUser.id.replace(/-/g, '').slice(0, 23);
    const logIdHex  = dailyRow ? dailyRow.id.replace(/-/g, '').slice(0, 14) : '';

    // ── Step 6: Map raw punch timestamps to "HH:mm:ss" strings ───────────────
    // firstClockIn / lastClockOut are stored as UTC DateTimes.
    // toLocalTimeString slices positions 11–19 of the ISO string, yielding the
    // "HH:MM:SS" UTC component — consistent with all other time fields in this
    // module.  Null is emitted verbatim (not as "") so the frontend can
    // distinguish "not yet clocked in" from "clocked in at 00:00:00".
    const clockInTime:  string | null = dailyRow?.firstClockIn
      ? this.toLocalTimeString(dailyRow.firstClockIn)
      : null;
    const clockOutTime: string | null = dailyRow?.lastClockOut
      ? this.toLocalTimeString(dailyRow.lastClockOut)
      : null;

    // ── Step 7: Compute duration strings ──────────────────────────────────────
    // total_duration — actual elapsed work time from the pre-aggregated minutes
    //   field set by the nightly DAILY_SUMMARY_AGGREGATE BullMQ job.
    //   Emits "00:00:00" for future dates, non-working days, or days where
    //   the aggregation job has not yet run.  Format: "HH:mm:ss" (zero-padded).
    //
    // shift_duration — expected shift length.  Format: "H:mm:ss" WITHOUT a
    //   leading zero on the hours component per the Darwinbox legacy wire quirk
    //   (e.g. "9:00:00", not "09:00:00").  includeLeadingZero=false achieves
    //   this via the shared secondsToTimeString helper.
    const totalWorkSecs = dailyRow?.totalWorkMins != null
      ? dailyRow.totalWorkMins * 60
      : 0;
    const totalDuration = this.secondsToTimeString(totalWorkSecs, true);
    const shiftDuration = this.secondsToTimeString(expectedShiftSecs, false);

    // ── Step 8: Return wire-format envelope ───────────────────────────────────
    return {
      status: 1,
      data: {
        total_duration:       totalDuration,
        shift_duration:       shiftDuration,
        day:                  dateStr,
        action_label:         0,
        clockin_time:         clockInTime,
        clockout_time:        clockOutTime,
        clockinout_label:     null,
        user_id:              userIdHex,
        tenant_id:            '5',
        shift_date:           dateStr,
        log_id:               logIdHex,
        clockin_time_string:  clockInTime,
        clockout_time_string: clockOutTime,
        enable_break:         null,
        show_break:           null,
        break_label:          '',
      },
    };
  }

  // ===========================================================================
  // 5. GetAttendanceLog
  //
  // Comprehensive day-by-day attendance ledger endpoint.  Returns a continuous
  // dictionary covering every calendar day in the requested window, including
  // weekends, public holidays, leave days, and absent days alongside present
  // days that have clock-in data.
  //
  // N+1-safe pipeline:
  //   1.  Resolve and authorise the target employee.
  //   2.  Parse and validate the start_date / end_date window (≤ 31 days).
  //   3.  Four concurrent Prisma queries:
  //         a. AttendanceDaily rows for the window (with shift relation joined).
  //         b. PublicHoliday rows for the window (isOptional = false only).
  //         c. APPROVED LeaveRequest rows that overlap the window date range.
  //         d. Active ShiftAssignment anchored to the window start date.
  //   4.  Pre-index all results into O(1)-lookup Maps.
  //   5.  First pass (date loop): compute four window-level counters.
  //       Priority: holiday/weekoff → leave → present → absent.
  //   6.  Second pass (date loop): build each DWDayLogLedgerEntry with:
  //         — Asymmetric date token inversion (outer key = "YYYY-MM-DD",
  //           entry.date = "DD-MM-YYYY").
  //         — Clock timing fields from AttendanceDaily timestamps (UTC).
  //         — Duration arithmetic: elapsed, break delta, net work.
  //         — Status badge, actions block, and user_attendance_details.
  //   7.  Return { status: 1, data: { logs } } envelope.
  // ===========================================================================

  async getAttendanceLog(
    requestingUserId: string,
    dto: GetAttendanceLogBodyDto,
  ): Promise<GetAttendanceLogResponse> {
    // ── Step 1: Resolve & authorise ──────────────────────────────────────────
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, dto.user_id);
    await this.assertAttendanceAccess(requestingUser, targetUser);

    // ── Step 2: Parse and validate date window ───────────────────────────────
    const startDate = new Date(dto.start_date + 'T00:00:00Z');
    const endDate   = new Date(dto.end_date   + 'T00:00:00Z');

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException(
        'start_date and end_date must be valid ISO-8601 dates.',
      );
    }
    if (startDate > endDate) {
      throw new BadRequestException('start_date must not be after end_date.');
    }
    const windowDays =
      Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    if (windowDays > MAX_DATE_WINDOW_DAYS) {
      throw new BadRequestException(
        `Date window exceeds the maximum of ${MAX_DATE_WINDOW_DAYS} days.`,
      );
    }

    // ── Step 3: Concurrent batch queries ─────────────────────────────────────
    // All four queries are independent reads — issued in parallel to minimise
    // total round-trip latency.
    //
    //   Query A — AttendanceDaily: daily aggregate rows for all present days in
    //             the window, joined with the ShiftDefinition that was active
    //             when each clock event was recorded.
    //
    //   Query B — PublicHoliday: mandatory (isOptional = false) national
    //             holidays within the window for the employee's country code.
    //
    //   Query C — LeaveRequest: any APPROVED leave that overlaps the window.
    //             Broader than an exact startDate filter: a multi-day leave
    //             that started before the window still covers days inside it.
    //
    //   Query D — ShiftAssignment: the most recent assignment effective on or
    //             before the window start date.  Used as the fallback shift
    //             context for inactive days that have no AttendanceDaily row.
    const countryCode = this.extractCountryCode(targetUser);

    const [dailyRows, publicHolidays, approvedLeaves, shiftAssignment] =
      await Promise.all([
        this.prisma.attendanceDaily.findMany({
          where: {
            userId:         targetUser.id,
            attendanceDate: { gte: startDate, lte: endDate },
          },
          include:  { shift: true },
          orderBy:  { attendanceDate: 'asc' },
        }),
        this.prisma.publicHoliday.findMany({
          where: {
            date:       { gte: startDate, lte: endDate },
            countryCode,
            isOptional: false,
          },
          select: { date: true, name: true },
        }),
        this.prisma.leaveRequest.findMany({
          where: {
            userId: targetUser.id,
            status: LeaveRequestStatus.APPROVED,
            AND: [
              { startDate: { lte: endDate   } },
              { endDate:   { gte: startDate } },
            ],
          },
          select: { startDate: true, endDate: true, leaveType: true },
          take:   MAX_LEAVE_FETCH,
        }),
        this.prisma.shiftAssignment.findFirst({
          where: {
            userId:        targetUser.id,
            effectiveDate: { lte: startDate },
            OR: [
              { expiryDate: null },
              { expiryDate: { gte: startDate } },
            ],
          },
          include:  { shift: true },
          orderBy:  { effectiveDate: 'desc' },
        }),
      ]);

    // ── Step 4: Pre-index results into O(1)-lookup Maps ───────────────────────

    // dailyByDate: "YYYY-MM-DD" → DailyWithShift row.
    const dailyByDate = new Map<string, DailyWithShift>();
    for (const row of dailyRows) {
      dailyByDate.set(row.attendanceDate.toISOString().slice(0, 10), row);
    }

    // holidayByDate: "YYYY-MM-DD" → holiday display name.
    const holidayByDate = new Map<string, string>();
    for (const h of publicHolidays) {
      holidayByDate.set(h.date.toISOString().slice(0, 10), h.name);
    }

    // leaveByDate: "YYYY-MM-DD" → LeaveType.
    // Expand every approved leave request day-by-day, clamping each range to
    // the query window so the inner loop never allocates out-of-window dates.
    // When two leaves of different types cover the same date (edge case),
    // the last write wins — sufficient for the flag/counter use-case here.
    const leaveByDate = new Map<string, LeaveType>();
    for (const lr of approvedLeaves) {
      const rangeStart = lr.startDate > startDate ? lr.startDate : startDate;
      const rangeEnd   = lr.endDate   < endDate   ? lr.endDate   : endDate;
      const lc = new Date(rangeStart);
      while (lc <= rangeEnd) {
        leaveByDate.set(lc.toISOString().slice(0, 10), lr.leaveType);
        lc.setUTCDate(lc.getUTCDate() + 1);
      }
    }

    // Weekend day mask from the fallback assignment (or the global default
    // [0, 6] when no assignment exists) so that weekoff classification works
    // even on days without an AttendanceDaily row.
    const weekendDaySet = new Set<number>(shiftAssignment?.shift.weekendDays ?? [0, 6]);

    // ── Step 5: First pass — compute window-level counters ───────────────────
    // These four counters are window-level totals written onto every entry.
    // A single forward pass over the date range computes them in O(windowDays).
    //
    // Classification priority (mutually exclusive):
    //   1. is_holiday OR is_weekoff → non-working; no counter incremented.
    //   2. is_leave (approved leave) → leaveCount++ or unpaidCount++.
    //   3. is_present (firstClockIn not null) → presentCount++.
    //   4. else (working day, no clock-in, no leave) → absentCount++.
    let presentCount = 0;
    let absentCount  = 0;
    let leaveCount   = 0;
    let unpaidCount  = 0;

    {
      const pc = new Date(startDate);
      while (pc <= endDate) {
        const ds  = pc.toISOString().slice(0, 10);
        const dow = pc.getUTCDay();

        const isHoliday = holidayByDate.has(ds);
        const isWeekoff = weekendDaySet.has(dow) && !isHoliday;

        if (!isHoliday && !isWeekoff) {
          const lt = leaveByDate.get(ds);
          if (lt !== undefined) {
            if (lt === LeaveType.UNPAID) {
              unpaidCount++;
            } else {
              leaveCount++;
            }
          } else if (dailyByDate.get(ds)?.firstClockIn != null) {
            presentCount++;
          } else {
            absentCount++;
          }
        }

        pc.setUTCDate(pc.getUTCDate() + 1);
      }
    }

    // ── Step 6: Second pass — build each ledger entry ────────────────────────
    const logs: Record<string, DWDayLogLedgerEntry> = {};

    const dc = new Date(startDate);
    while (dc <= endDate) {
      const dateStr = dc.toISOString().slice(0, 10);
      const dow     = dc.getUTCDay();

      const daily     = dailyByDate.get(dateStr);
      const isHoliday = holidayByDate.has(dateStr);
      const isWeekoff = weekendDaySet.has(dow) && !isHoliday;
      const leaveType = leaveByDate.get(dateStr);
      const isLeave   = leaveType !== undefined;
      const isPresent = daily?.firstClockIn != null;

      // Effective shift definition for this day.
      //   Present days: use the shift stored in the daily row — the shift that
      //     was recorded when the clock event was processed.
      //   Inactive days: fall back to the pre-queried assignment shift so the
      //     user_attendance_details card can still render the expected schedule.
      const effectiveShift: ShiftDefRow | null =
        daily?.shift ?? shiftAssignment?.shift ?? null;

      // ── Asymmetric date token inversion ──────────────────────────────────
      // Outer dict key : "YYYY-MM-DD" (ISO-8601 for JS Date construction).
      // Inner entry.date: "DD-MM-YYYY" (Darwinbox local display format).
      const [y, mo, d] = dateStr.split('-');
      const localDate  = `${d}-${mo}-${y}`;

      // ── Clock timing fields ───────────────────────────────────────────────
      // Full datetime: "YYYY-MM-DD HH:mm:ss" UTC (ISO "T" separator replaced).
      // Time-only:     "HH:mm:ss" UTC — the slice from the ISO string.
      // Empty string "" when the respective timestamp is absent.
      const clockInDateTime: string = daily?.firstClockIn
        ? daily.firstClockIn.toISOString().replace('T', ' ').slice(0, 19)
        : '';
      const clockOutDateTime: string = daily?.lastClockOut
        ? daily.lastClockOut.toISOString().replace('T', ' ').slice(0, 19)
        : '';
      const firstClockin: string  = daily?.firstClockIn
        ? this.toLocalTimeString(daily.firstClockIn)
        : '';
      const firstClockout: string = daily?.lastClockOut
        ? this.toLocalTimeString(daily.lastClockOut)
        : '';

      // ── Duration arithmetic ───────────────────────────────────────────────
      // rawElapsedSecs: integer seconds from first clock-in to last clock-out,
      //   truncated to whole seconds via Math.floor (eliminates sub-second
      //   jitter from JavaScript Date arithmetic).  Zero when no clock-out
      //   exists yet (employee currently working or day not yet ended).
      //
      // finalWorkSecs: net work time.  When the aggregation job has run
      //   (totalWorkMins set), use that value — it accounts for break
      //   deductions and OT cap rules applied by the worker.  When the job
      //   has not yet run for a same-day in-progress record, fall back to
      //   rawElapsedSecs with the Darwinbox truncation rule applied:
      //   Math.floor(rawSecs / 60) * 60 so sub-minute ticks are floored, not
      //   rounded, matching the Overview's overall_summary convention.
      //
      // breakSecs: derived delta (rawElapsed − finalWork), clamped ≥ 0.
      //   Paid and unpaid break splits are always "00:00:00" because no
      //   break-tap tracking is configured in this deployment.
      const hasClockOut = daily?.lastClockOut != null;
      const rawElapsedSecs: number =
        hasClockOut && daily?.firstClockIn
          ? Math.floor(
              (daily.lastClockOut!.getTime() - daily.firstClockIn.getTime()) / 1000,
            )
          : 0;
      const finalWorkSecs: number =
        daily?.totalWorkMins != null
          ? daily.totalWorkMins * 60
          : Math.floor(rawElapsedSecs / 60) * 60;
      const breakSecs = Math.max(0, rawElapsedSecs - finalWorkSecs);

      // Duration string rules:
      //   Inactive days              → empty string "" for all duration fields.
      //   Present, no clock-out yet  → "00:00:00" (in-progress sentinel).
      //   Present with clock-out     → computed "HH:mm:ss" string.
      //
      // totalWorkDuration uses rawElapsedSecs with the DW minute-truncation
      // rule applied (Math.floor / 60 * 60) so sub-minute ticks are floored
      // consistently with Overview's per-day and summary durations.
      const totalWorkDuration: string = isPresent
        ? (hasClockOut
            ? this.secondsToTimeString(Math.floor(rawElapsedSecs / 60) * 60)
            : '00:00:00')
        : '';
      const finalWorkDuration: string = isPresent
        ? (hasClockOut ? this.secondsToTimeString(finalWorkSecs) : '00:00:00')
        : '';
      const breakDuration: string = isPresent
        ? this.secondsToTimeString(breakSecs)
        : '';

      // ── Late mark ─────────────────────────────────────────────────────────
      // Sourced from AttendanceDaily.lateByMins (set by the aggregation worker
      // after the shift closes).  Empty string when on time or not yet computed.
      const lateMark: string =
        (daily?.lateByMins ?? 0) > 0
          ? this.secondsToTimeString(daily!.lateByMins! * 60)
          : '';

      // ── Early out ─────────────────────────────────────────────────────────
      // Computed only for standard (non-overnight) shifts that have a recorded
      // clock-out.
      //
      // Shift boundaries (effectiveShift.endTime) are stored in LOCAL wall-clock
      // time (WIB = UTC+7).  The lastClockOut timestamp is stored in UTC.
      // Comparing them without normalisation introduces a 7-hour phantom offset:
      // a 17:00 WIB departure (10:00 UTC) would appear as "7 hours early".
      //
      // Fix: convert the UTC punch to local seconds-from-midnight via
      // utcToLocalDaySeconds(), then compare against the local shift-end seconds.
      // Both values are now on the same WIB axis and the diff is correct.
      let earlyOut = '';
      if (isPresent && hasClockOut && effectiveShift && !effectiveShift.isOvernight) {
        const [endH, endM]    = effectiveShift.endTime.split(':').map(Number);
        const expectedEndSecs = endH * 3600 + endM * 60;
        const actualOutSecs   = this.utcToLocalDaySeconds(daily!.lastClockOut!);
        const earlyOutSecs    = expectedEndSecs - actualOutSecs;
        if (earlyOutSecs > 0) {
          earlyOut = this.secondsToTimeString(earlyOutSecs);
        }
      }

      // ── Overtime ──────────────────────────────────────────────────────────
      // Sourced from AttendanceDaily.overtimeMins (set by the aggregation
      // worker).  Empty string when zero or not yet computed.
      const overtime: string =
        (daily?.overtimeMins ?? 0) > 0
          ? this.secondsToTimeString(daily!.overtimeMins! * 60)
          : '';

      // ── Location ──────────────────────────────────────────────────────────
      // Resolved geofence location name from AttendanceDaily.payload.
      // currentLocationContext is set during processClockEvent when a GPS
      // coordinate matches an allowed-locations pool entry.
      const dailyPayload =
        daily?.payload as unknown as import('./types/shared.types').AttendanceDailyPayload | null;
      const location: string = dailyPayload?.currentLocationContext?.name ?? '';

      // ── Log ID ────────────────────────────────────────────────────────────
      // 14-char hex slice of AttendanceDaily.id (hyphens stripped).
      // Empty string "" when no daily row exists for this date.
      const logId: string = daily
        ? daily.id.replace(/-/g, '').slice(0, 14)
        : '';

      // ── Attendance status badge ───────────────────────────────────────────
      // One badge per day.  Priority order matches the classification used
      // in the counters pass: Present → Holiday → Week Off → Leave → Absent.
      // is_holiday and is_weekoff calendar flags are set independently so
      // the frontend can render compound states (e.g. present on a holiday).
      let attendance_status: DWLogStatusBadge[];
      if (isPresent) {
        attendance_status = [{ color: 'green',  status: 'Present',  type: 'present'  }];
      } else if (isHoliday) {
        attendance_status = [{ color: 'blue',   status: 'Holiday',  type: 'holiday'  }];
      } else if (isWeekoff) {
        attendance_status = [{ color: 'grey',   status: 'Week Off', type: 'weekoff'  }];
      } else if (isLeave) {
        attendance_status = [{ color: 'orange', status: 'Leave',    type: 'leave'    }];
      } else {
        attendance_status = [{ color: 'red',    status: 'Absent',   type: 'absent'   }];
      }

      // ── Actions block ─────────────────────────────────────────────────────
      // ot_journal_enable and att_register_enable are active (1) only on days
      // where the employee has a confirmed clock-in record.  All other toggles
      // are 0 — correction and shift-change workflows are request-based.
      const actions: DWLogActionsBlock = {
        is_edit:                 0,
        is_delete:               0,
        singleday_request:       0,
        ot_journal_enable:       isPresent ? 1 : 0,
        att_register_enable:     isPresent ? 1 : 0,
        attendance_shift_change: 0,
      };

      // ── User attendance details ───────────────────────────────────────────
      const user_attendance_details: DWUserAttendanceDetails =
        this.buildLogUserAttendanceDetails(dateStr, effectiveShift);

      logs[dateStr] = {
        date:                    localDate,
        clock_in:                clockInDateTime,
        clock_out:               clockOutDateTime,
        break_duration:          isPresent ? breakDuration  : '',
        paid_break:              isPresent ? '00:00:00'     : '',
        unpaid_break:            isPresent ? '00:00:00'     : '',
        final_work_duration:     finalWorkDuration,
        total_work_duration:     totalWorkDuration,
        short_leave_duration:    '',
        overtime,
        late_mark:               lateMark,
        early_out:               earlyOut,
        first_clockin:           firstClockin,
        first_clockout:          firstClockout,
        attendance_status,
        request_status:          [],
        location,
        timesheet_status:        isPresent ? 'Not Filled' : '',
        timesheet_duration:      '',
        actions,
        user_attendance_details,
        is_overnight:            effectiveShift?.isOvernight ? 1 : 0,
        purpose:                 '',
        present_count:           presentCount,
        absent_count:            absentCount,
        leave_count:             leaveCount,
        unpaid_count:            unpaidCount,
        request_id:              null,
        log_id:                  logId,
        is_policy_applicable:    effectiveShift ? 1 : 0,
        append_to_status:        '',
        manager_comment:         '',
        work_transfer_details:   [],
        is_holiday:              isHoliday ? 1 : 0,
        is_weekoff:              isWeekoff ? 1 : 0,
        is_leave:                isLeave   ? 1 : 0,
      };

      dc.setUTCDate(dc.getUTCDate() + 1);
    }

    // ── Step 7: Return the wire-format envelope ───────────────────────────────
    return { status: 1, data: { logs } };
  }

  // ===========================================================================
  // Private helpers — GetAttendanceLog
  // ===========================================================================

  /**
   * Builds the DWUserAttendanceDetails block for a single ledger day entry.
   *
   * When shiftDef is null (no ShiftAssignment exists for the employee),
   * returns the null-shift sentinel with is_null_shift = 1 and safe empty-
   * string defaults for all display fields so the frontend card renders
   * without throwing.
   *
   * shift_duration uses "H:mm:ss" without a leading zero on the hours
   * component — the Darwinbox wire convention for shift duration fields
   * (secondsToTimeString called with includeLeadingZero = false).
   *
   * weeklyoff_name orders weekend days with Saturday (6) before Sunday (0)
   * by treating Sunday as 7 for the sort key.  For weekendDays = [0, 6] this
   * produces "All Saturday, All Sunday" — matching the DW wire example.
   */
  private buildLogUserAttendanceDetails(
    dateStr:  string,
    shiftDef: ShiftDefRow | null,
  ): DWUserAttendanceDetails {
    if (!shiftDef) {
      return {
        weeklyoff_name:          '',
        shift_name:              'No Shift Assigned',
        current_shift_id:        '',
        shift_begin:             '',
        shift_end:               '',
        shift_duration:          '0:00:00',
        shift_break_name:        '',
        policy_name:             '',
        shiftblock_name:         '',
        overtime_policy:         '',
        employee_contract_hours: '',
        grace_time_clockin:      '0',
        grace_time_clockout:     '0',
        break_policy:            '',
        is_null_shift:           1,
      };
    }

    // Shift times are stored as "HH:MM" (5 chars); trim any trailing ":SS"
    // that may be present in legacy rows so shift_begin/end are always "HH:mm".
    const toHHMM = (t: string): string => t.slice(0, 5);

    // shift_duration in "H:mm:ss" (no leading zero) via the shared helper
    // with includeLeadingZero = false.  Example: "9:00:00" for a 9-hour shift.
    const shiftDurationMins = this.computeShiftDurationMins(
      shiftDef.startTime,
      shiftDef.endTime,
      shiftDef.isOvernight,
    );
    const shiftDurationStr = this.secondsToTimeString(shiftDurationMins * 60, false);

    // policy_name sourced from optional JSONB field; falls back to the shift
    // name so the card always carries a visible policy label.
    const shiftPayload = shiftDef.payload as { policyName?: string } | null;
    const policyName   = shiftPayload?.policyName ?? shiftDef.name;

    // Sort weekend days with Saturday (6) before Sunday (0) by mapping
    // Sunday to 7 for the comparator.  For the common [0, 6] mask this yields
    // [6, 7(=0)] → "All Saturday, All Sunday".
    const DAY_NAMES = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday',
      'Thursday', 'Friday', 'Saturday',
    ] as const;
    const sortedWeekend = [...shiftDef.weekendDays].sort(
      (a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b),
    );
    const weeklyoff_name = sortedWeekend
      .map(dw => `All ${DAY_NAMES[dw]}`)
      .join(', ');

    return {
      weeklyoff_name,
      shift_name:              shiftDef.name,
      current_shift_id:        shiftDef.id.replace(/-/g, '').slice(0, 14),
      shift_begin:             `${dateStr} ${toHHMM(shiftDef.startTime)}`,
      shift_end:               `${dateStr} ${toHHMM(shiftDef.endTime)}`,
      shift_duration:          shiftDurationStr,
      shift_break_name:        '',
      policy_name:             policyName,
      shiftblock_name:         '',
      overtime_policy:         '',
      employee_contract_hours: '',
      grace_time_clockin:      shiftDef.gracePeriodMins.toString(),
      grace_time_clockout:     '0',
      break_policy:            '',
      is_null_shift:           0,
    };
  }

  // ===========================================================================
  // Clock-Event Pipeline (internal — called by inbound clock-in/out handlers)
  //
  // This method is NOT exposed as an HTTP route.  It is the core transactional
  // unit that:
  //   1. Resolves the true operational attendance_date from the shift window
  //      (overnight shift safety net).
  //   2. Builds the mobility-safe geofence pool for the employee × date.
  //   3. Validates GPS coordinates against the pool (Haversine).
  //   4. Upserts the AttendanceDaily aggregate row with the new location context.
  //   5. Inserts the immutable AttendanceLog event row.
  //   6. Dispatches two BullMQ background jobs:
  //       a. ANTI_FRAUD_SCAN  — high-priority, near-realtime risk scoring.
  //       b. DAILY_SUMMARY_AGGREGATE — delayed to shift-close time to finalise
  //          the daily record once all taps are in.
  // ===========================================================================

  async processClockEvent(
    userId:     string,
    eventType:  'clock_in' | 'clock_out',
    source:     AttendanceSource,
    latitude:   number | null,
    longitude:  number | null,
    deviceInfo: DeviceInfo,
    ipAddress:  string | null,
  ): Promise<AttendanceLogEvent> {
    const now = new Date();

    // ── Step 1: Shift-Date Resolution ────────────────────────────────────────
    const { resolvedDate, shift } = await this.resolveShiftDate(userId, now);

    // ── Step 2: Mobility-Safe Geofence Matrix ────────────────────────────────
    const allowedPool = await this.buildAllowedLocationsPool(userId, resolvedDate);

    let matchedLocation: AllowedLocation | null = null;
    if (latitude !== null && longitude !== null) {
      matchedLocation = this.intersectGeofencePool(latitude, longitude, allowedPool);
      if (!matchedLocation) {
        throw new UnprocessableEntityException(
          'Clock event rejected: GPS coordinates are outside all geofences in ' +
          'your allowed locations pool (standard schedule + active branch ' +
          'assignments + active business trips).  Please move to an approved ' +
          'location or contact your HR administrator.',
        );
      }
    }

    // ── Step 3: Upsert daily aggregate row ────────────────────────────────────
    const daily = await this.upsertAttendanceDaily(
      userId,
      resolvedDate,
      shift,
      matchedLocation,
      allowedPool,
      eventType,
      now,
    );

    // ── Step 4: Insert immutable raw log event ────────────────────────────────
    const logPayload: AttendanceLogPayload = {
      _v:             1,
      deviceInfo,
      ipAddress,
      antiFraudFlags: [],
    };

    const logRow = await this.prisma.attendanceLog.create({
      data: {
        dailyId:         daily.id,
        userId,
        eventType,
        source,
        loggedAt:        now,
        latitude:        latitude  !== null ? new Prisma.Decimal(latitude)  : null,
        longitude:       longitude !== null ? new Prisma.Decimal(longitude) : null,
        resolvedLocation: matchedLocation?.name ?? null,
        geofenceMatched:  latitude !== null ? matchedLocation !== null : null,
        payload:          logPayload as unknown as Prisma.InputJsonValue,
      },
    });

    // ── Step 5a: Dispatch ANTI_FRAUD_SCAN job (high priority, near-realtime) ──
    const fraudPayload: AntiFraudScanPayload = {
      logId:          logRow.id,
      dailyId:        daily.id,
      userId,
      attendanceDate: resolvedDate.toISOString().slice(0, 10),
      eventType,
      latitude,
      longitude,
      deviceId:       deviceInfo.device_id,
      ipAddress,
      loggedAtIso:    now.toISOString(),
    };

    await this.attendanceQueue.add(
      AttendanceJobName.ANTI_FRAUD_SCAN,
      fraudPayload,
      {
        priority:     1,  // BullMQ: lower number = higher priority
        attempts:     3,
        backoff:      { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 500 },
        removeOnFail:     { count: 500 },
      },
    );

    // ── Step 5b: Dispatch DAILY_SUMMARY_AGGREGATE job (delayed to shift close) ─
    if (daily.shiftId) {
      const shiftCloseMs = this.computeShiftCloseMs(resolvedDate, shift);
      const delayMs      = Math.max(0, shiftCloseMs - Date.now());

      const aggregatePayload: DailySummaryAggregatePayload = {
        userId,
        attendanceDate: resolvedDate.toISOString().slice(0, 10),
        dailyId:        daily.id,
        shiftId:        daily.shiftId,
      };

      const job = await this.attendanceQueue.add(
        AttendanceJobName.DAILY_SUMMARY_AGGREGATE,
        aggregatePayload,
        {
          delay:            delayMs,
          jobId:            `daily-agg:${userId}:${resolvedDate.toISOString().slice(0, 10)}`,
          attempts:         5,
          backoff:          { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 100 },
          removeOnFail:     { count: 200 },
        },
      );

      if (job.id) {
        const currentPayload =
          (daily.payload as unknown as AttendanceDailyPayload | null) ?? this.emptyDailyPayload();
        await this.prisma.attendanceDaily.update({
          where: { id: daily.id },
          data:  {
            payload: {
              ...currentPayload,
              dailySummaryJobId: job.id,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }

    return this.mapLogRowToEvent(logRow);
  }

  // ===========================================================================
  // Private helpers — GetAttendanceDetails mapping
  // ===========================================================================

  /**
   * Resolves the internal UUID for the target employee using the 3-pass
   * GIN → employeeId → UUID pipeline and returns the string ID.
   */
  private async resolveTargetUserId(
    requestingUser: User,
    rawUserId:      string | undefined,
  ): Promise<string> {
    if (!rawUserId) return requestingUser.id;
    const resolved = await this.resolveTargetUser(requestingUser, rawUserId);
    return resolved.id;
  }

  /**
   * Maps a ShiftAssignment + ShiftDefinition row into the DWShiftDetails
   * wire-format object.
   */
  private mapAssignmentToShiftDetails(
    assignment: ShiftAssignmentWithDef,
  ): DWShiftDetails {
    const shift = assignment.shift;

    const shortId = shift.id.replace(/-/g, '').slice(0, 11);

    const toWireTime = (t: string): string =>
      t.length === 5 ? `${t}:00` : t;

    const beginTime = toWireTime(shift.startTime);
    const endTime   = toWireTime(shift.endTime);

    const totalMins  = this.computeShiftDurationMins(
      shift.startTime,
      shift.endTime,
      shift.isOvernight,
    );
    const totalHours = `${this.minsToHHMM(totalMins)} hours`;

    const assignmentPayload =
      assignment.payload as unknown as ShiftAssignmentLocationPayload | null;
    const shiftPayload =
      shift.payload as unknown as ShiftDefinitionDetailPayload | null;

    const location =
      assignmentPayload?.standardLocation?.name ??
      shiftPayload?.location                    ??
      '';

    return {
      id:                shortId,
      shift_name:        shift.name,
      begin_time:        beginTime,
      end_time:          endTime,
      begin_time_string: beginTime,
      end_time_string:   endTime,
      total_hours:       totalHours,
      is_overnight:      shift.isOvernight ? 1 : 0,
      location,
      is_null_shift:     0,
    };
  }

  /**
   * Returns the null-shift sentinel object used when no ShiftAssignment exists.
   */
  private buildNullShift(): DWShiftDetails {
    return {
      id:                '',
      shift_name:        'No Shift Assigned',
      begin_time:        '00:00:00',
      end_time:          '00:00:00',
      begin_time_string: '00:00:00',
      end_time_string:   '00:00:00',
      total_hours:       '00:00 hours',
      is_overnight:      0,
      location:          '',
      is_null_shift:     1,
    };
  }

  /**
   * Extracts the overtime approval reasons array from the ShiftDefinition's
   * JSONB payload.
   */
  private extractOvertimeApprovalReasons(
    shift: ShiftAssignmentWithDef['shift'],
  ): OvertimeApprovalReason[] {
    const payload = shift.payload as unknown as ShiftDefinitionDetailPayload | null;
    return payload?.overtimeApprovalReasons ?? [];
  }

  /**
   * Computes gross shift duration in minutes.
   *
   * Standard:  endMins - startMins
   * Overnight: (1440 - startMins) + endMins
   */
  private computeShiftDurationMins(
    startTime:   string,
    endTime:     string,
    isOvernight: boolean,
  ): number {
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH,   endM]   = endTime.split(':').map(Number);

    const startMins = startH * 60 + startM;
    const endMins   = endH   * 60 + endM;

    if (!isOvernight) {
      return endMins > startMins ? endMins - startMins : 0;
    }

    return (24 * 60 - startMins) + endMins;
  }

  // ===========================================================================
  // Private helpers — GetAttendancePoliciesDetails
  // ===========================================================================

  /**
   * Build the geo_fencing hash map from the assignment's allowed locations pool.
   * Keys are 14-char hex strings derived from the location_id UUID.
   */
  private buildGeofencingConfig(
    assignment: ShiftAssignmentWithDef,
  ): DWGeofenceConfig {
    const result: DWGeofenceConfig = {};

    const assignmentPayload =
      assignment.payload as ShiftAssignmentLocationPayload | null;

    const standardLocation = assignmentPayload?.standardLocation;

    if (standardLocation) {
      const key = standardLocation.location_id.replace(/-/g, '').toLowerCase().slice(0, 14);
      result[key] = {
        label:    standardLocation.name,
        long:     standardLocation.longitude,
        latt:     standardLocation.latitude,
        distance: standardLocation.radius_meters,
      };
    }

    return result;
  }

  /**
   * Build the attendance_policy envelope.
   */
  private buildAttendancePolicyBody(
    assignment: ShiftAssignmentWithDef | null,
    payload:    ShiftDefinitionPoliciesPayload | null | undefined,
  ): DWPolicyEnvelope {
    const shiftId = assignment?.shift.id ?? 'no-shift';
    const policyName = assignment
      ? `${assignment.shift.name} Attendance Policy`
      : 'No Policy';

    const lateGrace       = payload?.lateGraceMinutes       ?? assignment?.shift.gracePeriodMins ?? 0;
    const earlyGrace      = payload?.earlyGraceMinutes       ?? 0;
    const backdated       = payload?.backdatedRestrictionDays ?? 7;
    const allowedRequests = this.formatAllowedRequests(payload?.allowedRequestTypes);

    const policy_data: import('./types/attendance-policies.types').DWPolicyData = {
      policy_id:             shiftId.replace(/-/g, '').slice(0, 14),
      policy_name:           policyName,
      late_grace_time:       lateGrace,
      early_grace_time:      earlyGrace,
      backdated_restriction: backdated,
      allowed_request:       allowedRequests,
    };

    const table_body: DWPolicyRow[] = [
      {
        key:            'late_grace_time',
        attribute:      'Late Grace Time',
        value:          `${lateGrace} Minutes`,
        highlight_code: '',
      },
      {
        key:            'early_grace_time',
        attribute:      'Early Grace Time',
        value:          `${earlyGrace} Minutes`,
        highlight_code: '',
      },
      {
        key:            'backdated_restriction',
        attribute:      'Backdated Entry Restriction',
        value:          `${backdated} Days`,
        highlight_code: '',
      },
      {
        key:            'allowed_request',
        attribute:      'Allowed Request Types',
        value:          allowedRequests.join(', ') || 'None',
        highlight_code: '',
      },
    ];

    return {
      policy_data,
      table_headers: [...POLICY_TABLE_HEADERS],
      table_body,
    };
  }

  /**
   * Build the overtime_policy envelope.
   */
  private buildOvertimePolicyBody(
    assignment: ShiftAssignmentWithDef | null,
    payload:    ShiftDefinitionPoliciesPayload | null | undefined,
  ): DWOvertimePolicy {
    const enabled = assignment?.shift.overtimeEligible ?? false;
    const shiftId = assignment?.shift.id ?? 'no-shift';

    const tiers: OvertimeCalculationTier[] =
      payload?.overtimeCalculationTiers ?? [
        { day_type: 'Weekday',    calculation_rule: '1x multiplier after scheduled hours' },
        { day_type: 'Weekly Off', calculation_rule: '2x multiplier for all hours worked' },
        { day_type: 'Holiday',    calculation_rule: '3x multiplier for all hours worked' },
      ];

    const table_body: DWOvertimeTableRow[] = this.formatOvertimeTiers(tiers);

    return {
      policy_id:     payload?.overtimePolicyId   ?? shiftId.replace(/-/g, '').slice(0, 14),
      policy_name:   payload?.overtimePolicyName ?? (assignment
        ? `${assignment.shift.name} OT Policy`
        : 'No OT Policy'),
      is_enabled:    enabled ? 1 : 0,
      table_headers: [...OT_TABLE_HEADERS],
      table_body,
    };
  }

  /** Build the condensed DWTenantShift card from the active assignment. */
  private buildTenantShift(assignment: ShiftAssignmentWithDef): DWTenantShift {
    const s = assignment.shift;
    return {
      shift_id:   s.id.replace(/-/g, '').slice(0, 14),
      shift_name: s.name,
      begin_time: s.startTime.length === 5 ? `${s.startTime}:00` : s.startTime,
      end_time:   s.endTime.length   === 5 ? `${s.endTime}:00`   : s.endTime,
    };
  }

  /**
   * Build a human-readable weekend day summary string.
   */
  private buildWeeklyOffDetails(weekendDays: number[]): string {
    if (weekendDays.length === 0) return '';

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const sorted = [...weekendDays].sort((a, b) => a - b);

    const labels = sorted.map(d => `All ${DAY_NAMES[d]}`);
    return `(${labels.join(', ')})`;
  }

  /**
   * Build the pay group object from the assignment payload.
   */
  private buildPayGroup(
    payload: ShiftAssignmentPoliciesPayload | null | undefined,
  ): DWPayGroup {
    if (payload?.payGroup) {
      return {
        group_id:   payload.payGroup.group_id,
        group_name: payload.payGroup.group_name,
      };
    }
    return {
      group_id:   'default',
      group_name: 'Default Pay Group',
    };
  }

  /**
   * Compute the pay cycle start/end dates and the month_to_select label.
   *
   * The previous implementation used `Date.setUTCMonth()` and `setUTCDate()`
   * on a mutable Date object.  JavaScript's Date.prototype.setUTCMonth() does
   * NOT clamp to the target month's actual day count — it overflows silently:
   *   new Date('2026-01-31').setUTCMonth(1)  →  "2026-03-03"  (not Feb 28)
   *
   * This rewrite uses only `Date.UTC(y, m, d)` constructor calls with explicit
   * month-end clamping via the "day-0 trick":
   *   new Date(Date.UTC(y, m + 1, 0)).getUTCDate()  →  last day of month m
   *
   * Verified edge cases:
   *   cycleStartDay=31, month=Jan  → cycleStart=Jan-31, cycleEnd=Feb-27/28
   *   cycleStartDay=31, month=Feb  → cycleStart=Feb-28/29, cycleEnd=Mar-27/28/29
   *   cycleStartDay=29, year=2025  → Feb cycleStart=Feb-28 (non-leap year)
   *   cycleStartDay=1,  any month  → standard 1st-of-month cycle, never overflows
   */
  private buildCycleDates(
    effectiveDate: Date,
    payload:       ShiftAssignmentPoliciesPayload | null | undefined,
  ): { month_to_select: string; cycle_start: string; cycle_end: string } {
    const cycleStartDay = payload?.cycleStartDay ?? 1;

    // Helper: returns the number of days in the given month (0-based) of year y.
    // Uses the "day-0 of the next month" trick which is safe for all months
    // including February in both leap and non-leap years.
    const lastDayOf = (y: number, m: number): number =>
      new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

    const ey = effectiveDate.getUTCFullYear();
    const em = effectiveDate.getUTCMonth();   // 0-based

    // Build the candidate cycle start in the current month, clamping
    // cycleStartDay to the month's actual day count.
    const safeCurrentDay    = Math.min(cycleStartDay, lastDayOf(ey, em));
    const candidateStart    = new Date(Date.UTC(ey, em, safeCurrentDay));

    // If effectiveDate precedes the candidate start, roll the cycle back
    // one month.  We do this entirely with integer year/month arithmetic to
    // avoid any setUTCMonth() overflow.
    let csYear  = ey;
    let csMonth = em;

    if (effectiveDate < candidateStart) {
      csMonth--;
      if (csMonth < 0) { csMonth = 11; csYear--; }
    }

    const safeCsDay  = Math.min(cycleStartDay, lastDayOf(csYear, csMonth));
    const cycleStart = new Date(Date.UTC(csYear, csMonth, safeCsDay));

    // Next cycle start: same day-of-month in the following month.
    // Incrementing month with integer arithmetic avoids setUTCMonth() overflow.
    let nsYear  = csYear;
    let nsMonth = csMonth + 1;
    if (nsMonth > 11) { nsMonth = 0; nsYear++; }

    const safeNsDay      = Math.min(cycleStartDay, lastDayOf(nsYear, nsMonth));
    const nextCycleStart = new Date(Date.UTC(nsYear, nsMonth, safeNsDay));

    // Cycle end is the day immediately before the next cycle starts.
    // Subtracting 86 400 000 ms (one full UTC day) is exact and overflow-free
    // for any valid calendar date.
    const cycleEnd = new Date(nextCycleStart.getTime() - 86_400_000);

    const MONTH_NAMES = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    return {
      month_to_select: `${MONTH_NAMES[cycleStart.getUTCMonth()]} ${cycleStart.getUTCFullYear()}`,
      cycle_start:     cycleStart.toISOString().slice(0, 10),
      cycle_end:       cycleEnd.toISOString().slice(0, 10),
    };
  }

  /**
   * Normalise the allowedRequestTypes array from shift payload.
   */
  private formatAllowedRequests(types: string[] | undefined): string[] {
    if (types && types.length > 0) return types;
    return ['Clock In Request', 'Clock Out Request'];
  }

  /**
   * Map OvertimeCalculationTier[] to DWOvertimeTableRow[].
   */
  private formatOvertimeTiers(tiers: OvertimeCalculationTier[]): DWOvertimeTableRow[] {
    return tiers.map(t => ({
      day_type:         t.day_type,
      calculation_rule: t.calculation_rule,
      highlight_code:   '',
    }));
  }

  // ===========================================================================
  // Private helpers — target user resolution & access control
  // ===========================================================================

  // ===========================================================================
  // Private helpers — target user resolution, tenant isolation, access control
  //
  // resolveTargetUser is the single choke-point that all cross-employee reads
  // must pass through.  It enforces two independent security layers in order:
  //
  //   1. Tenant isolation (Finding 3.1 / assertSameTenant):
  //      The KPN Corporation umbrella hosts multiple subsidiary companies
  //      (e.g. PT KPN Tiga, PT KPN Lima).  A manager at one subsidiary that
  //      holds a valid CASL read:AttendanceRecord permission must NOT be able
  //      to read data belonging to an employee of a sibling subsidiary.  CASL
  //      subject conditions operate on in-memory User objects and do not inspect
  //      the employment.company_id JSONB field, so this guard closes the gap.
  //
  //   2. CASL permission check (assertAttendanceAccess):
  //      Only executed after the tenant gate passes.  Evaluates the requesting
  //      user's ability set against the target's User object so role-based
  //      restrictions (read-own only, manager-scope only) are still applied.
  // ===========================================================================

  private async resolveTargetUser(
    requestingUser: User,
    userId:         string | undefined,
  ): Promise<User> {
    // Self-access short-circuit: no resolution or tenant check needed.
    if (!userId) return requestingUser;

    // ── Pass 1: Darwinbox source_employee_id via JSONB GIN index ─────────────
    // Using the canonical Prisma.sql tagged template so parameterization is
    // explicit and auditable.  The ${ginFilter} interpolation becomes a bound
    // $1 parameter — the ::jsonb cast stays in the SQL template string where
    // it cannot be influenced by the caller's input value.
    const ginFilter = JSON.stringify({ darwinbox: { source_employee_id: userId } });
    const byPayload = await this.prisma.$queryRaw<User[]>(
      Prisma.sql`
        SELECT * FROM users
        WHERE  payload @> ${ginFilter}::jsonb
          AND  deleted_at IS NULL
        LIMIT  1
      `,
    );
    if (byPayload.length > 0) {
      this.assertSameTenant(requestingUser, byPayload[0]);
      return byPayload[0];
    }

    // ── Pass 2: internal employeeId ───────────────────────────────────────────
    const byEmployeeId = await this.prisma.user.findFirst({
      where: { employeeId: userId, deletedAt: null },
    });
    if (byEmployeeId) {
      this.assertSameTenant(requestingUser, byEmployeeId);
      return byEmployeeId;
    }

    // ── Pass 3: internal UUID ─────────────────────────────────────────────────
    const byUuid = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (byUuid) {
      this.assertSameTenant(requestingUser, byUuid);
      return byUuid;
    }

    throw new NotFoundException(`Employee not found: ${userId}`);
  }

  /**
   * Enforces subsidiary-level tenant isolation within the KPN Corporation
   * umbrella.
   *
   * The User model carries no dedicated tenantId column.  Company membership
   * is stored in `User.payload.employment.company_id`, written by the
   * Darwinbox profile-sync job at onboarding and updated on transfer.
   *
   * Guard logic:
   *   — When BOTH users carry a resolved company_id, they MUST match.
   *   — When either is absent (super-admin accounts pre-dating the sync job
   *     carry no employment record), the check is skipped and responsibility
   *     passes to the CASL permission layer below.
   *
   * Called synchronously — extractCompanyId is a pure JSONB accessor with no
   * async I/O, so it incurs zero latency on the hot path.
   */
  private assertSameTenant(requestingUser: User, targetUser: User): void {
    const requestingCompany = this.extractCompanyId(requestingUser);
    const targetCompany     = this.extractCompanyId(targetUser);

    if (requestingCompany && targetCompany && requestingCompany !== targetCompany) {
      throw new ForbiddenException(
        'Cross-tenant data access is strictly forbidden.',
      );
    }
  }

  /**
   * Extracts the Darwinbox company_id from the user's JSONB employment payload.
   * Returns null when the field is absent (super-admin accounts, newly-created
   * users whose sync job has not yet completed, or manual test fixtures).
   */
  private extractCompanyId(user: User): string | null {
    const p = user.payload as { employment?: { company_id?: string } } | null;
    return p?.employment?.company_id ?? null;
  }

  private async assertAttendanceAccess(
    requestingUser: User,
    targetUser: User,
  ): Promise<void> {
    if (requestingUser.id === targetUser.id) return;

    const ability = await this.casl.createForUser(requestingUser);

    if (!ability.can('read', subject('AttendanceRecord', targetUser) as unknown as 'AttendanceRecord')) {
      throw new ForbiddenException(
        'You do not have permission to view this employee\'s attendance records.',
      );
    }
  }

  // ===========================================================================
  // Private helpers — shift-date resolution
  // ===========================================================================

  /**
   * Resolves the operational attendance_date for a given clock timestamp.
   *
   * All shift times (startTime / endTime) are stored in local wall-clock time
   * (WIB = UTC+7).  Clock timestamps are stored and received in UTC.  To keep
   * both on the same axis we first convert the clock time to local time and
   * derive the LOCAL calendar date from that.
   *
   * Without this conversion a 06:45 WIB clock-in lands at 23:45 UTC of the
   * previous calendar day, which would record attendance on "yesterday" and
   * trigger a false Absent flag for today.
   *
   * Standard shifts:
   *   resolvedDate = LOCAL calendar date of clockTime.
   *
   * Overnight shifts:
   *   If local clockTime ∈ [00:00, shiftEnd] → tail of previous day (day N − 1).
   *   If local clockTime ∈ (shiftEnd, 23:59] → start of this day (day N).
   *
   * Both comparisons use LOCAL-time minutes so shift boundaries and punch times
   * are on the same WIB axis throughout.
   */
  private async resolveShiftDate(
    userId:    string,
    clockTime: Date,
  ): Promise<ResolvedShiftDate> {
    // Convert the UTC clock timestamp to LOCAL time (WIB = UTC+7) by shifting
    // the epoch forward by the zone offset.  We then read the date components
    // from the shifted Date object using the UTC getters — those getters now
    // see WIB local components rather than UTC components.
    const localEpochMs = clockTime.getTime() + OPERATIONAL_TZ_OFFSET_SECS * 1_000;
    const localDt      = new Date(localEpochMs);

    // localDate: UTC midnight on the LOCAL calendar date — used as the
    // effectiveDate anchor for ShiftAssignment queries and as the default
    // resolvedDate for standard (non-overnight) shifts.
    const localDate = new Date(
      Date.UTC(
        localDt.getUTCFullYear(),
        localDt.getUTCMonth(),
        localDt.getUTCDate(),
      ),
    );

    const assignment = await this.prisma.shiftAssignment.findFirst({
      where: {
        userId,
        effectiveDate: { lte: localDate },
        OR: [{ expiryDate: null }, { expiryDate: { gte: localDate } }],
      },
      include:  { shift: true },
      orderBy:  { effectiveDate: 'desc' },
    });

    if (!assignment) {
      throw new NotFoundException(
        `No active shift assignment found for employee on ${localDate.toISOString().slice(0, 10)}.  ` +
        'Please ask your HR administrator to assign a shift before clocking in.',
      );
    }

    const shift = this.mapShiftToSnapshot(assignment.shift);

    if (!shift.is_overnight) {
      // For standard shifts the attendance date is simply the LOCAL calendar
      // day — no overnight tail window to consider.
      return { resolvedDate: localDate, shift, isOvernightTail: false };
    }

    // Overnight shifts: determine whether the punch falls in the "tail" window
    // (after midnight LOCAL, before the shift's local end time).  Both values
    // are now in LOCAL minutes-from-midnight so the comparison is timezone-clean.
    const [endHour, endMin]  = shift.shift_end.split(':').map(Number);
    const shiftEndLocalMs    = (endHour * 60 + endMin) * MS_PER_MIN;
    const clockLocalOfDayMs  =
      (localDt.getUTCHours() * 60 + localDt.getUTCMinutes()) * MS_PER_MIN;

    const isOvernightTail = clockLocalOfDayMs <= shiftEndLocalMs;

    // Tail punches belong to the PREVIOUS local calendar day (the shift
    // that started yesterday evening is still "open" until its end time).
    const resolvedDate = isOvernightTail
      ? new Date(localDate.getTime() - 86_400_000)
      : localDate;

    return { resolvedDate, shift, isOvernightTail };
  }

  // ===========================================================================
  // Private helpers — geofencing
  // ===========================================================================

  /**
   * Builds the allowed locations pool for a given employee on a given date.
   *
   * Pool composition (ordered by priority):
   *   1. standard_schedule — branch/office from active shift assignment payload.
   *   2. branch_assignment  — temporary branch overrides active on `date`.
   *   3. business_trip      — approved dinas-luar locations active on `date`.
   *
   * The user profile fetch and the shift assignment fetch are independent reads
   * and are issued concurrently via Promise.all() to halve the number of
   * sequential connection-pool leases held on the hot clock-in/out path.
   */
  private async buildAllowedLocationsPool(
    userId: string,
    date:   Date,
  ): Promise<AllowedLocation[]> {
    const [user, assignment] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      }),
      this.prisma.shiftAssignment.findFirst({
        where: {
          userId,
          effectiveDate: { lte: date },
          OR: [{ expiryDate: null }, { expiryDate: { gte: date } }],
        },
        orderBy: { effectiveDate: 'desc' },
      }),
    ]);

    const pool: AllowedLocation[] = [];

    if (assignment?.payload) {
      const ap = assignment.payload as {
        standardLocation?: AllowedLocation;
        branchOverrides?:  Array<AllowedLocation & { fromDate: string; toDate: string }>;
      };

      if (ap.standardLocation) {
        pool.push({ ...ap.standardLocation, source: 'standard_schedule' });
      }

      const dateStr = date.toISOString().slice(0, 10);
      for (const override of ap.branchOverrides ?? []) {
        if (override.fromDate <= dateStr && dateStr <= override.toDate) {
          pool.push({ ...override, source: 'branch_assignment' });
        }
      }
    }

    if (user.payload) {
      const up = user.payload as {
        businessTrips?: Array<AllowedLocation & { fromDate: string; toDate: string }>;
      };
      const dateStr = date.toISOString().slice(0, 10);
      for (const trip of up.businessTrips ?? []) {
        if (trip.fromDate <= dateStr && dateStr <= trip.toDate) {
          pool.push({ ...trip, source: 'business_trip' });
        }
      }
    }

    return pool;
  }

  /**
   * Returns the first AllowedLocation whose geofence circle contains (lat, lon).
   * Uses the Haversine formula for great-circle distance.
   */
  private intersectGeofencePool(
    lat:  number,
    lon:  number,
    pool: AllowedLocation[],
  ): AllowedLocation | null {
    for (const loc of pool) {
      const dist = this.haversineDistanceMeters(lat, lon, loc.latitude, loc.longitude);
      if (dist <= loc.radius_meters) return loc;
    }
    return null;
  }

  /**
   * Haversine great-circle distance in metres between two WGS-84 coordinates.
   */
  private haversineDistanceMeters(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
  ): number {
    const R  = 6_371_000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a  =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ===========================================================================
  // Private helpers — daily aggregate upsert
  // ===========================================================================

  private async upsertAttendanceDaily(
    userId:          string,
    resolvedDate:    Date,
    shift:           ShiftWindowSnapshot,
    matchedLocation: AllowedLocation | null,
    allowedPool:     AllowedLocation[],
    eventType:       'clock_in' | 'clock_out',
    now:             Date,
  ): Promise<Prisma.AttendanceDailyGetPayload<Record<string, never>>> {
    const locationContext: CurrentLocationContext | null = matchedLocation
      ? {
          location_id: matchedLocation.location_id,
          name:        matchedLocation.name,
          latitude:    matchedLocation.latitude,
          longitude:   matchedLocation.longitude,
          source:      matchedLocation.source,
          accepted_at: now.toISOString(),
        }
      : null;

    const newPayload: AttendanceDailyPayload = {
      _v:                     1,
      currentLocationContext: locationContext,
      allowedLocationsPool:   allowedPool,
      dailySummaryJobId:      null,
    };

    const shiftDef = await this.prisma.shiftDefinition.findUnique({
      where: { code: shift.shift_code },
    });

    const existing = await this.prisma.attendanceDaily.findUnique({
      where: { userId_attendanceDate: { userId, attendanceDate: resolvedDate } },
    });

    if (!existing) {
      return this.prisma.attendanceDaily.create({
        data: {
          userId,
          attendanceDate:  resolvedDate,
          shiftId:         shiftDef?.id ?? null,
          firstClockIn:    eventType === 'clock_in'  ? now : null,
          lastClockOut:    eventType === 'clock_out' ? now : null,
          dayType:         DayType.WORKING_DAY,
          payload:         newPayload as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const previousPayload =
      (existing.payload as unknown as AttendanceDailyPayload | null) ?? this.emptyDailyPayload();

    return this.prisma.attendanceDaily.update({
      where: { id: existing.id },
      data: {
        ...(eventType === 'clock_in' && !existing.firstClockIn
          ? { firstClockIn: now }
          : {}),
        ...(eventType === 'clock_out' ? { lastClockOut: now } : {}),
        payload: {
          ...previousPayload,
          currentLocationContext: locationContext ?? previousPayload.currentLocationContext,
          allowedLocationsPool:   allowedPool,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ===========================================================================
  // Private helpers — mapping
  // ===========================================================================

  private mapShiftToSnapshot(
    shift: {
      id: string; name: string; code: string;
      startTime: string; endTime: string;
      isOvernight: boolean; gracePeriodMins: number; overtimeEligible: boolean;
    },
  ): ShiftWindowSnapshot {
    return {
      shift_id:          shift.id,
      shift_name:        shift.name,
      shift_code:        shift.code,
      shift_start:       shift.startTime,
      shift_end:         shift.endTime,
      is_overnight:      shift.isOvernight,
      grace_period_mins: shift.gracePeriodMins,
      overtime_eligible: shift.overtimeEligible,
    };
  }

  private mapLogRowToEvent(row: LogRow): AttendanceLogEvent {
    const p = (row.payload ?? {}) as Partial<AttendanceLogPayload>;
    return {
      log_id:            row.id,
      event_type:        row.eventType as 'clock_in' | 'clock_out',
      source:            row.source as 'BIOMETRIC' | 'MOBILE_GPS' | 'WEB',
      logged_at:         row.loggedAt.toISOString(),
      latitude:          row.latitude  ? Number(row.latitude)  : null,
      longitude:         row.longitude ? Number(row.longitude) : null,
      resolved_location: row.resolvedLocation,
      geofence_matched:  row.geofenceMatched,
      device_info:       p.deviceInfo ?? {
        device_id:   null,
        device_type: null,
        os_version:  null,
        app_version: null,
      },
    };
  }

  // ===========================================================================
  // Private helpers — computation
  // ===========================================================================

  /**
   * Computes the Unix epoch millisecond at which the shift closes on
   * resolvedDate, used to schedule the daily aggregation job.
   */
  private computeShiftCloseMs(
    resolvedDate: Date,
    shift:        ShiftWindowSnapshot,
  ): number {
    const [endHour, endMin] = shift.shift_end.split(':').map(Number);
    const utcMidnight       = resolvedDate.getTime();

    if (!shift.is_overnight) {
      return utcMidnight + (endHour * 60 + endMin) * MS_PER_MIN;
    }
    return utcMidnight + 86_400_000 + (endHour * 60 + endMin) * MS_PER_MIN;
  }

  // ===========================================================================
  // Private helpers — time arithmetic
  //
  // These utilities form the internal time-parsing and formatting engine used
  // exclusively by getAttendanceOverview.  All duration arithmetic is performed
  // in integer seconds to avoid floating-point accumulation errors, then
  // re-formatted at the serialisation boundary.
  // ===========================================================================

  /**
   * Formats a duration in total seconds into a time string.
   *
   * @param seconds          — raw total seconds (fractional part is rounded).
   * @param includeLeadingZero — when true (default) the hours component is
   *   zero-padded to two digits ("09:03:13").  When false the hours component
   *   is emitted without padding ("9:03:13" or "36:45:44") — the Darwinbox
   *   legacy wire format uses no leading zero for the non_working_duration per-
   *   day field and for both avg/total work duration in overall_summary.
   */
  private secondsToTimeString(seconds: number, includeLeadingZero = true): string {
    const totalSecs = Math.max(0, Math.round(seconds));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    const hStr = includeLeadingZero
      ? h.toString().padStart(2, '0')
      : h.toString();
    const mStr = m.toString().padStart(2, '0');
    const sStr = s.toString().padStart(2, '0');
    return `${hStr}:${mStr}:${sStr}`;
  }

  /**
   * Converts a UTC timestamp to the number of whole seconds elapsed since
   * local midnight (WIB = UTC+7).
   *
   * Shift boundaries are stored in the database in local wall-clock time
   * (e.g. "17:00" means 17:00 WIB).  Punch timestamps are stored in UTC.
   * Comparing them directly would introduce a 7-hour offset that falsely
   * classifies on-time departures as "early out".  This helper normalises
   * the punch side to the same local-time axis before any comparison.
   *
   * Result is always in [0, 86399] — midnight wrapping is handled by modulo.
   */
  private utcToLocalDaySeconds(utcTs: Date): number {
    const rawSecs =
      utcTs.getUTCHours()   * 3600 +
      utcTs.getUTCMinutes() * 60   +
      utcTs.getUTCSeconds();
    return (rawSecs + OPERATIONAL_TZ_OFFSET_SECS) % 86_400;
  }

  // ===========================================================================
  // Private helpers — utilities
  // ===========================================================================

  private parseDateRange(fromDate: string, toDate: string) {
    const startDate = new Date(fromDate + 'T00:00:00Z');
    const endDate   = new Date(toDate   + 'T00:00:00Z');

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('from_date and to_date must be valid ISO-8601 dates.');
    }
    if (startDate > endDate) {
      throw new BadRequestException('from_date must not be after to_date.');
    }
    const windowDays = (endDate.getTime() - startDate.getTime()) / 86_400_000 + 1;
    if (windowDays > MAX_DATE_WINDOW_DAYS) {
      throw new BadRequestException(
        `Date window exceeds the maximum of ${MAX_DATE_WINDOW_DAYS} days.`,
      );
    }
    return { startDate, endDate };
  }

  private utcMidnightToday(): Date {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }

  private toLocalTimeString(dt: Date): string {
    return dt.toISOString().slice(11, 19); // "HH:MM:SS" UTC
  }

  private minsToHHMM(totalMins: number): string {
    const h = Math.floor(Math.abs(totalMins) / 60)
      .toString()
      .padStart(2, '0');
    const m = (Math.abs(totalMins) % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private emptyDailyPayload(): AttendanceDailyPayload {
    return {
      _v:                     1,
      currentLocationContext: null,
      allowedLocationsPool:   [],
      dailySummaryJobId:      null,
    };
  }

  private extractCountryCode(user: User): string {
    const p = user.payload as { address?: { country_code?: string } } | null;
    return p?.address?.country_code ?? 'ID';
  }
}

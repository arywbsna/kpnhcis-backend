import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  LeaveRequestStatus,
  LeaveType,
  Prisma,
  User,
} from '@prisma/client';

import { CaslAbilityFactory } from '../../casl/casl-ability.factory';
import { subject } from '../../casl/casl.types';
import { PrismaService } from '../../prisma/prisma.service';
import type { GetLeavesBodyDto } from './dto/get-leaves.dto';
import type { GetLeavePatternBodyDto } from './dto/get-leave-pattern.dto';
import type { GetTeamStatusBodyDto } from './dto/get-team-status.dto';
import type {
  DWLeaveCardDetail,
  DWLeaveRecipient,
  GetLeaveCommonDetailsResponse,
} from './types/leave-common.types';
import type {
  DWPolicyDetailRow,
  DWStandardLeaveEntry,
  DWUnpaidLeaveEntry,
  GetLeavesResponse,
} from './types/get-leaves.types';
import type { GetLeavePatternResponse } from './types/leave-pattern.types';
import type {
  DWDayTeamStatusEntry,
  DWTeamStatusUserSnapshot,
  DWTeamTimeOffBlock,
  GetTeamStatusResponse,
} from './types/team-status.types';
import type {
  DWUpcomingTimeOffEntry,
  GetUpcomingTimeOffResponse,
} from './types/upcoming-timeoff.types';
import type { LeaveBalancePayload } from './types/shared.types';

// ─── Internal DB row shapes ───────────────────────────────────────────────────

type LeaveBalanceRow = Prisma.LeaveBalanceGetPayload<Record<string, never>>;

// Eagerly loads the unit (for department name) and manager (for the
// leave_recipients chain) used exclusively in getLeaveCommonDetails.
type UserWithUnitAndManager = Prisma.UserGetPayload<{
  include: { unit: true; manager: true };
}>;

// Extended JSONB payload cast that includes optional DW-level custom fields
// written by the Darwinbox sync job but not modelled in the canonical schema.
type ExtendedLeavePayload = Partial<LeaveBalancePayload> & {
  leaveName?:  string;   // custom bilingual name override from Darwinbox
  cycleStart?: string;   // "YYYY-MM-DD" — leave-year start for anniversary cycles
  cycleEnd?:   string;   // "YYYY-MM-DD" — leave-year end for anniversary cycles
};

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAVE_TYPE_DISPLAY: Record<LeaveType, string> = {
  ANNUAL:    'Annual Leave',
  SICK:      'Sick Leave',
  MATERNITY: 'Maternity Leave',
  PATERNITY: 'Paternity Leave',
  SPECIAL:   'Special Leave',
  UNPAID:    'Unpaid Leave',
};

const LEAVE_TYPE_COLOR: Record<LeaveType, string> = {
  ANNUAL:    '#4CAF50',
  SICK:      '#F44336',
  MATERNITY: '#E91E63',
  PATERNITY: '#2196F3',
  SPECIAL:   '#FF9800',
  UNPAID:    '#9E9E9E',
};

// Bilingual (ID / EN) display names used by GetLeaves when the LeaveBalance
// payload does not carry a custom leaveName override from the Darwinbox sync.
const LEAVE_BILINGUAL_DISPLAY: Record<LeaveType, string> = {
  ANNUAL:    'Cuti Tahunan / Annual Leave',
  SICK:      'Cuti Sakit / Sick Leave',
  MATERNITY: 'Cuti Melahirkan / Maternity Leave',
  PATERNITY: 'Cuti Ayah / Paternity Leave',
  SPECIAL:   'Cuti Khusus / Special Leave',
  UNPAID:    'Unpaid Leave / Cuti Potong Gaji',
};

// Canonical DW disclaimer banner embedded in every standard leave card when
// admin-level configuration has disabled one or more data points.
const SETTINGS_WARNING =
  "*There could be a mismatch in the totals on this page, as a few data points have been disabled due to admin configurations.";

// Ordinal cycle base year.  Cycle number = currentYear - CYCLE_BASE_YEAR.
// With CYCLE_BASE_YEAR = 2021: 2022 → cycle 1, 2023 → 2, …, 2026 → 5.
const CYCLE_BASE_YEAR = 2021;

const STATUS_LABEL: Partial<Record<LeaveRequestStatus, string>> = {
  DRAFT:                  'Draft',
  PENDING_APPROVAL:       'Pending Approval',
  APPROVED_BY_SUPERVISOR: 'Pending HR Approval',
  APPROVED:               'Approved',
  REJECTED:               'Rejected',
  CANCELLED:              'Cancelled',
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class LeaveManagementService {
  private readonly logger = new Logger(LeaveManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly casl:   CaslAbilityFactory,
  ) {}

  // ===========================================================================
  // 1. GetLeaveCommonDetails
  //
  // Dashboard hydration endpoint.  Builds the full `leaves_taken` card
  // dictionary, `leave_recipients` chain snapshot, and `system_leaves_list`
  // for the resolved target employee, covering ALL six leave categories even
  // when no LeaveBalance row has been provisioned yet for a given type.
  //
  // Wire contract: mirrors Darwinbox's DW envelope under the `data` root.
  // ===========================================================================

  async getLeaveCommonDetails(
    requestingUserId: string,
    targetUserId?: string,
  ): Promise<GetLeaveCommonDetailsResponse> {
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });

    const targetUser = await this.resolveTargetUser(requestingUser, targetUserId);
    await this.assertLeaveBalanceAccess(requestingUser, targetUser);

    const year = new Date().getUTCFullYear();

    // Load unit (department name) and manager (approval chain hop) in one join.
    const targetWithRelations = await this.prisma.user.findUniqueOrThrow({
      where:   { id: targetUser.id },
      include: { unit: true, manager: true },
    }) as UserWithUnitAndManager;

    // All balance rows for the resolved employee in the current leave year.
    const balanceRows = await this.prisma.leaveBalance.findMany({
      where:   { userId: targetUser.id, year },
      orderBy: { leaveType: 'asc' },
    });

    // Authoritative live pending totals.  The stored `pending` column may lag
    // if a request was submitted since the last balance-sync run, so we
    // re-derive pending days from the live LeaveRequest table.
    const pendingRequests = await this.prisma.leaveRequest.findMany({
      where: {
        userId: targetUser.id,
        status: {
          in: [
            LeaveRequestStatus.PENDING_APPROVAL,
            LeaveRequestStatus.APPROVED_BY_SUPERVISOR,
          ],
        },
        startDate: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lte: new Date(Date.UTC(year, 11, 31)),
        },
      },
      select: { leaveType: true, totalDays: true },
    });

    const pendingByType = new Map<LeaveType, number>();
    for (const req of pendingRequests) {
      const existing = pendingByType.get(req.leaveType) ?? 0;
      pendingByType.set(req.leaveType, existing + Number(req.totalDays));
    }

    const todayStr   = this.utcMidnightToday().toISOString().slice(0, 10);
    const userGender = this.extractUserGender(targetUser);

    const leaves_taken:       Record<string, DWLeaveCardDetail> = {};
    const system_leaves_list: Record<string, string>            = {};

    // Iterate every known LeaveType so the frontend always receives a complete
    // card set — types not yet provisioned receive zero/default values.
    for (const lt of Object.values(LeaveType)) {
      const row = balanceRows.find(b => b.leaveType === lt);

      // The payload may carry optional Darwinbox admin-level visibility flags
      // (dontShowInFrontEnd, dontShowInApplication) that override the computed
      // values below.  probationRestriction blocks application during the
      // employee's probation window, emitting the canonical DW message.
      const payload = (row?.payload ?? {}) as Partial<LeaveBalancePayload> & {
        dontShowInFrontEnd?:    boolean;
        dontShowInApplication?: boolean;
        probationRestriction?:  boolean;
      };

      // Balance arithmetic — fall back to per-type org defaults when no row exists.
      const entitled    = Number(row?.entitled   ?? this.defaultEntitledDays(lt));
      const used        = Number(row?.used        ?? 0);
      const carried     = Number(row?.carried     ?? 0);
      const livePending = pendingByType.get(lt) ?? Number(row?.pending ?? 0);
      const remaining   = Math.max(0, entitled + carried - used - livePending);

      // ── Constraint evaluation ─────────────────────────────────────────────

      const genderConstraint  = payload.genderConstraint ?? this.defaultGenderConstraint(lt);
      const genderBlocked     = genderConstraint !== null && genderConstraint !== userGender;
      const isExpired         = payload.expiryDate != null && payload.expiryDate < todayStr;
      const probationBlocked  = payload.probationRestriction ?? false;

      const dont_show_in_front_end   = payload.dontShowInFrontEnd   ?? false;
      const dont_show_in_application =
        payload.dontShowInApplication ??
        (genderBlocked || isExpired || probationBlocked);

      // Restriction messages are evaluated in priority order so the most
      // actionable reason surfaces first.  Probation > gender > expiry > no balance.
      let reason_for_application_restriction: string | null = null;
      if (probationBlocked) {
        reason_for_application_restriction =
          'You cannot apply for this Leave in probation period.';
      } else if (genderBlocked) {
        reason_for_application_restriction =
          `This leave is only available for ${genderConstraint} employees.`;
      } else if (isExpired) {
        reason_for_application_restriction = 'This leave type has expired.';
      } else if (remaining <= 0 && lt !== LeaveType.UNPAID) {
        reason_for_application_restriction =
          'You have no remaining balance for this leave type.';
      }

      // ── Darwinbox legacy wire quirk ───────────────────────────────────────
      // UNPAID always serialises `currently_available` as the string "0"
      // regardless of actual balance; every other type emits a plain number.
      // The union type on DWLeaveCardDetail preserves this contract verbatim.
      const currently_available: string | number =
        lt === LeaveType.UNPAID ? '0' : remaining;

      const key = this.buildLeaveCardKey(targetUser.id, lt, row);
      if (key === null) continue;

      leaves_taken[key] = {
        dont_show_in_front_end,
        dont_show_in_application,
        pay_rate:                           lt === LeaveType.UNPAID ? 0 : 1,
        color_code:                         payload.color ?? LEAVE_TYPE_COLOR[lt],
        currently_available,
        reason_for_application_restriction,
      } satisfies DWLeaveCardDetail;

      system_leaves_list[key] = LEAVE_TYPE_DISPLAY[lt];
    }

    // ── Leave recipients ──────────────────────────────────────────────────────
    // Always includes the target employee.  The immediate manager is appended
    // when present to represent the first hop of the approval chain.
    const leave_recipients: DWLeaveRecipient[] = [
      this.buildRecipient(targetWithRelations, targetWithRelations.unit?.name),
    ];
    if (targetWithRelations.manager) {
      leave_recipients.push(this.buildRecipient(targetWithRelations.manager));
    }

    return {
      status: 1,
      data: {
        leaves_taken,
        leave_recipients,
        system_leaves_list,
        max_optional_holiday:            0,
        optional_holiday_approval_status: 0,
      },
    };
  }

  // ===========================================================================
  // 2. getUpcomingTimeOff
  //
  // Timeline consolidation endpoint.  Merges two independent data sources:
  //   — PublicHoliday rows (date >= today, matching the employee's country code)
  //   — APPROVED LeaveRequest rows for the target employee (startDate >= today)
  //
  // Both queries execute concurrently via Promise.all().  The results are
  // mapped to the DW wire format, unioned into a single flat array, and sorted
  // chronologically ascending.  When two entries share the same date, public
  // holidays sort before personal leave entries for deterministic output.
  //
  // Day names are derived from UTC dates via getUTCDay() to guarantee a
  // timezone-agnostic weekday label regardless of the server's local zone.
  // ===========================================================================

  async getUpcomingTimeOff(
    requestingUserId: string,
    targetUserId?: string,
  ): Promise<GetUpcomingTimeOffResponse> {
    // ── Step 1: Resolve & authorise ──────────────────────────────────────────
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, targetUserId);
    await this.assertLeaveRequestAccess(requestingUser, targetUser);

    // ── Step 2: Set today baseline (UTC midnight) ─────────────────────────────
    // Normalising to midnight-UTC prevents timezone slippage: an event that
    // starts later today is still captured because its date >= midnight-UTC.
    const today       = this.utcMidnightToday();
    const countryCode = this.extractCountryCode(targetUser);

    // ── Step 3: Concurrent Prisma queries ─────────────────────────────────────
    // Both queries are independent and can be issued in parallel.
    //   Query A — PublicHoliday: only mandatory (isOptional = false) national
    //             holidays for the employee's country, on or after today.
    //   Query B — LeaveRequest:  only APPROVED personal leaves starting on or
    //             after today.  Pending leaves are excluded — the timeline widget
    //             shows only confirmed time-off to prevent tentative noise.
    const [publicHolidays, approvedLeaves] = await Promise.all([
      this.prisma.publicHoliday.findMany({
        where: {
          date:       { gte: today },
          countryCode,
          isOptional: false,
        },
        orderBy: { date: 'asc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          userId:    targetUser.id,
          status:    LeaveRequestStatus.APPROVED,
          startDate: { gte: today },
        },
        orderBy: { startDate: 'asc' },
      }),
    ]);

    // ── Step 4: Map both datasets to the DW wire format ───────────────────────
    // Full English day-name lookup indexed by getUTCDay() (0 = Sunday).
    const DAY_NAMES = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday',
      'Thursday', 'Friday', 'Saturday',
    ] as const;

    const holidayEntries: DWUpcomingTimeOffEntry[] = publicHolidays.map(h => {
      const dateStr   = h.date.toISOString().slice(0, 10);
      const dayOfWeek = new Date(dateStr + 'T00:00:00Z').getUTCDay();
      return {
        // 14-char deterministic hex slice of the PublicHoliday UUID.
        id:    h.id.replace(/-/g, '').slice(0, 14),
        title: h.name,
        date:  dateStr,
        day:   DAY_NAMES[dayOfWeek],
        type:  'National Holiday',
      };
    });

    const leaveEntries: DWUpcomingTimeOffEntry[] = approvedLeaves.map(lr => {
      const dateStr   = lr.startDate.toISOString().slice(0, 10);
      const dayOfWeek = new Date(dateStr + 'T00:00:00Z').getUTCDay();
      const typeName  = LEAVE_TYPE_DISPLAY[lr.leaveType];
      return {
        // 14-char deterministic hex slice of the LeaveRequest UUID.
        id:    lr.id.replace(/-/g, '').slice(0, 14),
        title: typeName,
        date:  dateStr,
        day:   DAY_NAMES[dayOfWeek],
        type:  typeName,
      };
    });

    // ── Step 5: Merge and sort chronologically ────────────────────────────────
    // Primary sort:   date ascending (ISO string lexicographic comparison is
    //                 equivalent to chronological order for "YYYY-MM-DD").
    // Secondary sort: "National Holiday" before personal leave on the same date,
    //                 yielding deterministic, stable output across requests.
    const data: DWUpcomingTimeOffEntry[] = [
      ...holidayEntries,
      ...leaveEntries,
    ].sort((a, b) => {
      const dateDiff = a.date.localeCompare(b.date);
      if (dateDiff !== 0) return dateDiff;
      if (a.type === 'National Holiday' && b.type !== 'National Holiday') return -1;
      if (a.type !== 'National Holiday' && b.type === 'National Holiday') return 1;
      return 0;
    });

    return { data, status: 1 };
  }

  // ===========================================================================
  // 3. getTeamStatus
  //
  // Department-scoped rolling visibility matrix.  Returns a day-by-day feed
  // showing which unit members are absent (national holiday or approved leave)
  // over the requested window.
  //
  // N+1 prevention pipeline:
  //   1.  Resolve the pivot user and derive their unitId (department boundary).
  //   2.  One query: all active User rows sharing that unitId → peer pool.
  //   3.  Pre-compute DWTeamStatusUserSnapshot for every peer (O(N) once).
  //   4.  Concurrent queries: all APPROVED LeaveRequests that overlap the
  //       window for any peer; all PublicHolidays in the window.
  //   5.  Pre-index leaves into Map<dateStr, Map<leaveTypeName, Set<userId>>>
  //       and holidays into Map<dateStr, holidayName> — both O(L+H).
  //   6.  Day-by-day loop: O(window * uniqueLeaveTypes) — no inner DB calls.
  //   7.  Return the Record<dateStr, DWTeamTimeOffBlock[]> envelope.
  // ===========================================================================

  async getTeamStatus(
    requestingUserId: string,
    dto: GetTeamStatusBodyDto,
  ): Promise<GetTeamStatusResponse> {
    // ── Step 1: Resolve pivot user and department boundary ────────────────────
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });

    // When dto.user_id is provided the requesting user wants to inspect a
    // specific employee's department calendar (HR / manager use case).
    const pivotUser = dto.user_id
      ? await this.resolveTargetUser(requestingUser, dto.user_id)
      : requestingUser;

    // ── Step 2: Parse and validate the date window ────────────────────────────
    // Default: rolling 5-day window from today (today + 4 days, inclusive).
    const today       = this.utcMidnightToday();
    const windowStart = dto.start_date
      ? new Date(dto.start_date + 'T00:00:00Z')
      : today;
    const windowEnd = dto.end_date
      ? new Date(dto.end_date + 'T00:00:00Z')
      : new Date(today.getTime() + 4 * 86_400_000);

    if (windowStart > windowEnd) {
      throw new BadRequestException('start_date must not be after end_date.');
    }
    const windowDays =
      Math.round((windowEnd.getTime() - windowStart.getTime()) / 86_400_000) + 1;
    if (windowDays > 31) {
      throw new BadRequestException(
        'Date window exceeds the maximum of 31 days.',
      );
    }

    // ── Step 3: Fetch all active peers in the pivot user's unit ───────────────
    // The department boundary is the pivot user's unitId.  All non-deleted
    // users in that unit form the peer pool — including the pivot user.
    // When the pivot user has no unit, every day emits the empty sentinel.
    const departmentPeers = pivotUser.unitId
      ? await this.prisma.user.findMany({
          where: {
            unitId:    pivotUser.unitId,
            deletedAt: null,
            status:    'ACTIVE',
          },
        })
      : [];

    // ── Step 4: Pre-compute user snapshots once (O(N)) ────────────────────────
    // Building the snapshot is O(1) per user.  Storing in a Map by userId
    // allows O(1) lookup in the inner index-construction loop.
    const peerSnapshotMap = new Map<string, DWTeamStatusUserSnapshot>();
    for (const peer of departmentPeers) {
      peerSnapshotMap.set(peer.id, this.buildTeamStatusSnapshot(peer));
    }

    // Pre-materialise all snapshots as an array for holiday blocks (which
    // affect every department member simultaneously).
    const allPeerSnapshots = [...peerSnapshotMap.values()];

    // ── Step 5: Concurrent batch retrieval ────────────────────────────────────
    // Both queries are independent reads — no ordering dependency.
    //
    // Leave query: any APPROVED leave request for any peer whose date range
    //   overlaps [windowStart, windowEnd].  The AND predicate is intentionally
    //   broader than a strict start-date filter so mid-window multi-day leaves
    //   are captured even when their startDate is before the window start.
    //
    // Holiday query: mandatory (isOptional = false) public holidays within the
    //   window for the pivot user's country code.
    const peerIds     = departmentPeers.map(p => p.id);
    const countryCode = this.extractCountryCode(pivotUser);

    const [allLeaves, publicHolidays] = peerIds.length > 0
      ? await Promise.all([
          this.prisma.leaveRequest.findMany({
            where: {
              userId: { in: peerIds },
              status: LeaveRequestStatus.APPROVED,
              AND: [
                { startDate: { lte: windowEnd   } },
                { endDate:   { gte: windowStart } },
              ],
            },
            select: {
              userId:    true,
              leaveType: true,
              startDate: true,
              endDate:   true,
            },
          }),
          this.prisma.publicHoliday.findMany({
            where: {
              date:       { gte: windowStart, lte: windowEnd },
              countryCode,
              isOptional: false,
            },
            select: { date: true, name: true },
          }),
        ])
      : [[], []];

    // ── Step 6: Pre-index holidays into Map<dateStr, holidayName> (O(H)) ──────
    // ISO string slice [0, 10] yields "YYYY-MM-DD" without TZ offset risk since
    // PublicHoliday.date is stored as a @db.Date (UTC midnight) field.
    const holidayIndex = new Map<string, string>();
    for (const h of publicHolidays) {
      holidayIndex.set(h.date.toISOString().slice(0, 10), h.name);
    }

    // ── Step 7: Pre-index leaves into Map<dateStr, Map<typeName, Set<userId>>>
    //            O(L × avgLeaveDays) — one pass over all approved leave rows.
    //
    // Each leave request is expanded day-by-day, clamped to the query window,
    // and inserted into the nested Map so the day loop can do O(1) lookups.
    // A Set<userId> deduplicates the (edge-case) scenario where an employee
    // has two overlapping approved leaves of the same type.
    const leaveIndex = new Map<string, Map<string, Set<string>>>();

    for (const lr of allLeaves) {
      const typeName = LEAVE_TYPE_DISPLAY[lr.leaveType];

      // Clamp the leave range to the query window to avoid allocating dates
      // that will never be queried in the day loop below.
      const rangeStart = lr.startDate > windowStart ? lr.startDate : windowStart;
      const rangeEnd   = lr.endDate   < windowEnd   ? lr.endDate   : windowEnd;

      const cursor = new Date(rangeStart);
      while (cursor <= rangeEnd) {
        const dateStr = cursor.toISOString().slice(0, 10);

        if (!leaveIndex.has(dateStr)) {
          leaveIndex.set(dateStr, new Map());
        }
        const typeMap = leaveIndex.get(dateStr)!;
        if (!typeMap.has(typeName)) {
          typeMap.set(typeName, new Set());
        }
        typeMap.get(typeName)!.add(lr.userId);

        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    // ── Step 8: Day-by-day accumulator loop ───────────────────────────────────
    // For each calendar day in the window:
    //   a. Check holidayIndex for a matching public holiday.
    //   b. Check leaveIndex for any approved leave blocks on this date.
    //   c. If neither, push the empty sentinel block.
    //
    // The DWDayTeamStatusEntry accumulator carries the date alongside blocks
    // to avoid index-tracking errors; it is then indexed into the output Record.
    const dayEntries: DWDayTeamStatusEntry[] = [];

    const cursor = new Date(windowStart);
    while (cursor <= windowEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const blocks:  DWTeamTimeOffBlock[] = [];

      // ── Holiday path ────────────────────────────────────────────────────
      // A national holiday affects the whole department — every peer appears
      // in the users array regardless of whether they have a leave request.
      const holidayName = holidayIndex.get(dateStr);
      if (holidayName !== undefined) {
        blocks.push({
          type:  'holiday',
          title: holidayName,
          users: allPeerSnapshots,
        });
      }

      // ── Leave path ──────────────────────────────────────────────────────
      // Group by leave type name.  Each type produces a separate block so the
      // frontend can apply distinct visual treatment (icon, colour) per type.
      const dayLeaveMap = leaveIndex.get(dateStr);
      if (dayLeaveMap !== undefined) {
        for (const [typeName, userIdSet] of dayLeaveMap) {
          const users: DWTeamStatusUserSnapshot[] = [];
          for (const uid of userIdSet) {
            const snapshot = peerSnapshotMap.get(uid);
            if (snapshot) users.push(snapshot);
          }
          if (users.length > 0) {
            blocks.push({ type: 'leave', title: typeName, users });
          }
        }
      }

      // ── Empty sentinel ──────────────────────────────────────────────────
      // When a working day has neither a holiday nor any approved leaves,
      // emit the sentinel so the frontend receives a complete, gap-free array.
      if (blocks.length === 0) {
        blocks.push({ type: '', title: '', users: [] });
      }

      dayEntries.push({ date: dateStr, blocks });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // ── Step 9: Index into Record and return ──────────────────────────────────
    const data: Record<string, DWTeamTimeOffBlock[]> = {};
    for (const entry of dayEntries) {
      data[entry.date] = entry.blocks;
    }

    return { status: 1, data };
  }

  // ===========================================================================
  // 4. GetDataForLeavePattern
  // ===========================================================================

  async getDataForLeavePattern(
    requestingUserId: string,
    dto: GetLeavePatternBodyDto,
  ): Promise<GetLeavePatternResponse> {
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, dto.user_id);
    await this.assertLeaveBalanceAccess(requestingUser, targetUser);

    const year = dto.year ?? new Date().getUTCFullYear();

    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd   = new Date(Date.UTC(year, 11, 31));

    // Concurrent fetch: all balance rows for the year + all approved leave
    // requests that overlap the year at all.
    const [balanceRows, approvedLeaves] = await Promise.all([
      this.prisma.leaveBalance.findMany({
        where:   { userId: targetUser.id, year },
        orderBy: { leaveType: 'asc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          userId:    targetUser.id,
          status:    LeaveRequestStatus.APPROVED,
          startDate: { lte: yearEnd },
          endDate:   { gte: yearStart },
        },
        select: { startDate: true, endDate: true, leaveType: true },
      }),
    ]);

    // Build leave-type key map keyed by LeaveType enum value.
    // UNPAID balances get the "unpaid_" prefix per the Darwinbox wire convention.
    const keyByType = new Map<LeaveType, string>();
    for (const row of balanceRows) {
      const hex14 = row.id.replace(/-/g, '').slice(0, 14);
      keyByType.set(
        row.leaveType,
        row.leaveType === LeaveType.UNPAID ? `unpaid_${hex14}` : hex14,
      );
    }

    // Build 12-month skeleton: every month contains every active key at 0.
    const data: Record<string, Record<string, number>> = {};
    for (let m = 0; m < 12; m++) {
      const monthStr = `${year}-${String(m + 1).padStart(2, '0')}`;
      const entry: Record<string, number> = {};
      for (const key of keyByType.values()) {
        entry[key] = 0;
      }
      data[monthStr] = entry;
    }

    // Distribute each approved leave request across the months it overlaps.
    // Per-month overlap: max(start, monthStart) to min(end, monthEnd), inclusive.
    for (const leave of approvedLeaves) {
      const leaveKey = keyByType.get(leave.leaveType);
      if (!leaveKey) continue; // no balance row for this type in the year

      for (let m = 0; m < 12; m++) {
        const monthStart = new Date(Date.UTC(year, m, 1));
        // Last day of month: day 0 of next month
        const monthEnd   = new Date(Date.UTC(year, m + 1, 0));

        const overlapStart = leave.startDate > monthStart ? leave.startDate : monthStart;
        const overlapEnd   = leave.endDate   < monthEnd   ? leave.endDate   : monthEnd;

        if (overlapEnd >= overlapStart) {
          const days =
            Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000) + 1;
          const monthStr = `${year}-${String(m + 1).padStart(2, '0')}`;
          data[monthStr][leaveKey] += days;
        }
      }
    }

    return { data, history_details: [], status: 1 };
  }

  // ===========================================================================
  // 5. GetLeaves
  //
  // Live leave balance sheet and policy configuration dictionary.
  //
  // Returns a `data` envelope keyed by Darwinbox-format leave-type IDs.
  // Each value is a discriminated-union card:
  //   DWStandardLeaveEntry — for all paid leave types (ANNUAL, SICK, etc.)
  //   DWUnpaidLeaveEntry   — for UNPAID leave type only
  //
  // All three Prisma queries are issued concurrently via Promise.all() to
  // prevent N+1 latency from sequential round-trips.
  //
  // XState integration:
  //   is_xstate_guard_passing on each card is the canonical boolean gate.
  //   The leave-submission machine guard reads this field on every form mount
  //   to enable or disable the "Submit Leave Request" transition without
  //   requiring a second fetch.
  // ===========================================================================

  async getLeaves(
    requestingUserId: string,
    dto: GetLeavesBodyDto,
  ): Promise<GetLeavesResponse> {
    const requestingUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: requestingUserId },
    });
    const targetUser = await this.resolveTargetUser(requestingUser, dto.user_id);
    await this.assertLeaveBalanceAccess(requestingUser, targetUser);

    const year      = new Date().getUTCFullYear();
    const today     = this.utcMidnightToday();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd   = new Date(Date.UTC(year, 11, 31));

    // Three concurrent queries: balance ledger, pending requests, active-today
    // leave check.  The active check drives is_xstate_guard_passing for the
    // "employee is currently mid-leave" branch of the XState guard condition.
    const [balanceRows, pendingRequests, activeLeaves] = await Promise.all([
      this.prisma.leaveBalance.findMany({
        where:   { userId: targetUser.id, year },
        orderBy: { leaveType: 'asc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          userId: targetUser.id,
          status: {
            in: [
              LeaveRequestStatus.PENDING_APPROVAL,
              LeaveRequestStatus.APPROVED_BY_SUPERVISOR,
            ],
          },
          startDate: { gte: yearStart, lte: yearEnd },
        },
        select: { leaveType: true, totalDays: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          userId:    targetUser.id,
          status:    LeaveRequestStatus.APPROVED,
          startDate: { lte: today },
          endDate:   { gte: today },
        },
        select: { leaveType: true },
      }),
    ]);

    // Index pending totals by leave type for O(1) lookup per card.
    const pendingByType = new Map<LeaveType, number>();
    for (const req of pendingRequests) {
      pendingByType.set(
        req.leaveType,
        (pendingByType.get(req.leaveType) ?? 0) + Number(req.totalDays),
      );
    }

    // Set of leave types for which the employee is actively mid-leave today.
    // When a type appears in this set, is_xstate_guard_passing = false regardless
    // of balance, preventing a second overlapping leave submission.
    const activeLeaveTypes = new Set(activeLeaves.map(l => l.leaveType));
    const userGender       = this.extractUserGender(targetUser);
    const cycle            = Math.max(1, year - CYCLE_BASE_YEAR + 1);

    const data: Record<string, DWStandardLeaveEntry | DWUnpaidLeaveEntry> = {};

    for (const row of balanceRows) {
      const payload          = (row.payload ?? {}) as ExtendedLeavePayload;
      const entitled         = Number(row.entitled);
      const used             = Number(row.used);
      const carried          = Number(row.carried);
      const livePending      = pendingByType.get(row.leaveType) ?? Number(row.pending);
      const remaining        = Math.max(0, entitled + carried - used - livePending);

      const allowHalfDay       = payload.allowHalfDay       ?? true;
      const requiresDocument   = payload.requiresDocument   ?? this.defaultRequiresDocument(row.leaveType);
      const maxConsecutiveDays = payload.maxConsecutiveDays ?? null;
      const minAdvanceDays     = payload.minAdvanceDays     ?? 1;
      const carryoverDays      = payload.carryoverDays      ?? 0;
      const encashable         = payload.encashable         ?? false;
      const leaveName          = payload.leaveName          ?? LEAVE_BILINGUAL_DISPLAY[row.leaveType];
      const notOnLeaveToday    = !activeLeaveTypes.has(row.leaveType);

      const policyCtx = {
        leaveName,
        entitledDays:       entitled,
        allowHalfDay,
        maxConsecutiveDays,
        requiresDocument,
        carryoverDays,
        minAdvanceDays,
      };

      if (row.leaveType === LeaveType.UNPAID) {
        // UNPAID leave key: "unpaid_" + first 14 hex chars of the balance UUID.
        const leaveId = `unpaid_${row.id.replace(/-/g, '').slice(0, 14)}`;

        const entry: DWUnpaidLeaveEntry = {
          show_application_info: false,
          is_unpaid:             1,
          leave_id:              leaveId,
          is_hourly:             '0',
          leave_name:            leaveName,
          // already_taken and system_deducted both come from the authoritative
          // `used` column; system_deducted has no separate payroll-deduction
          // log in this deployment so it mirrors already_taken.
          already_taken:         String(used),
          applied:               String(livePending),
          system_deducted:       String(used),
          policy_details:        this.buildPolicyDetailsArray(row.leaveType, policyCtx),
          custom_qa:             [],
          is_xstate_guard_passing: notOnLeaveToday,
        };
        data[leaveId] = entry;
      } else {
        // Standard leave key: first 14 hex chars of the balance UUID (no prefix).
        const leaveId = row.id.replace(/-/g, '').slice(0, 14);

        // Cycle boundary defaults to calendar year unless the sync job has
        // written anniversary-based dates into the JSONB payload.
        const cycleStart = payload.cycleStart ?? `${year}-01-01`;
        const cycleEnd   = payload.cycleEnd   ?? `${year}-12-31`;

        const genderConstraint = payload.genderConstraint ?? this.defaultGenderConstraint(row.leaveType);
        const genderPasses     = genderConstraint === null || genderConstraint === userGender;

        const entry: DWStandardLeaveEntry = {
          show_application_info:   false,
          show_applicability_info: false,
          settings_warning_info:   SETTINGS_WARNING,
          cycle,
          pay_rate_info:           0,
          leave_id:                leaveId,
          leave_name:              leaveName,
          is_hybrid_cycle:         0,
          is_encashment:           encashable ? 1 : 0,
          policy_details:          this.buildPolicyDetailsArray(row.leaveType, policyCtx),
          custom_qa:               [],
          table_data:              [],
          current_cycle_start:     cycleStart,
          current_cycle_end:       cycleEnd,
          is_hourly:               '0',
          currently_available:     Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1),
          show_accrual_balance:    1,
          accrual_balance:         Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1),
          annual_allotment:        entitled,
          is_compoff:              0,
          is_xstate_guard_passing: remaining > 0 && genderPasses && notOnLeaveToday,
        };
        data[leaveId] = entry;
      }
    }

    return { status: 1, data };
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
  //   1. Tenant isolation (assertSameTenant):
  //      A manager at one KPN subsidiary must NOT read leave ledgers belonging
  //      to employees of a sibling subsidiary even if their CASL ability passes.
  //      CASL conditions do not inspect the employment.company_id JSONB field,
  //      so this guard closes the gap before the CASL check below.
  //
  //   2. CASL permission check (assertLeaveBalanceAccess):
  //      Only executed after the tenant gate passes.  Enforces role-based
  //      restrictions (read-own only, manager-scope only) via the ability set.
  // ===========================================================================

  private async resolveTargetUser(
    requestingUser: User,
    userId:         string | undefined,
  ): Promise<User> {
    // Self-access short-circuit: no resolution or tenant check needed.
    if (!userId) return requestingUser;

    // ── Pass 1: Darwinbox source_employee_id via JSONB GIN index ─────────────
    // Explicit Prisma.sql tagged template keeps parameterization canonical and
    // auditable.  ${ginFilter} becomes bound parameter $1; the ::jsonb cast
    // lives in the immutable SQL template string and cannot be influenced by
    // the caller's input.
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
   * Darwinbox profile-sync job at onboarding and updated on lateral transfers.
   *
   * Guard logic:
   *   — When BOTH users carry a resolved company_id, they MUST match.
   *   — When either is absent (super-admin accounts pre-dating the sync job
   *     or manual test fixtures with no employment record), the check is skipped
   *     and responsibility passes to the CASL permission layer.
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

  private async assertLeaveBalanceAccess(
    requestingUser: User,
    targetUser:     User,
  ): Promise<void> {
    if (requestingUser.id === targetUser.id) return;

    const ability = await this.casl.createForUser(requestingUser);

    if (!ability.can('read', subject('LeaveBalance', targetUser) as unknown as 'LeaveBalance')) {
      throw new ForbiddenException(
        'You do not have permission to view this employee\'s leave balances.',
      );
    }
  }

  private async assertLeaveRequestAccess(
    requestingUser: User,
    targetUser:     User,
  ): Promise<void> {
    if (requestingUser.id === targetUser.id) return;

    const ability = await this.casl.createForUser(requestingUser);

    if (!ability.can('read', subject('LeaveRequest', targetUser) as unknown as 'LeaveRequest')) {
      throw new ForbiddenException(
        'You do not have permission to view this employee\'s leave requests.',
      );
    }
  }

  // ===========================================================================
  // Private helpers — mapping
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // buildPolicyDetailsArray
  //
  // Static factory that assembles the rich `policy_details` text array for a
  // single leave card entry.  Externalised from the main getLeaves loop to
  // keep the per-row logic readable and to make the text rules independently
  // testable.
  //
  // UNPAID leave receives a single description row only.
  // All other types receive a header row followed by entitlement, half-day,
  // carry-forward, document, and advance-notice rule rows driven by the
  // active policy knobs in the LeaveBalance payload.
  // ---------------------------------------------------------------------------
  private buildPolicyDetailsArray(
    leaveType: LeaveType,
    ctx: {
      leaveName:          string;
      entitledDays:       number;
      allowHalfDay:       boolean;
      maxConsecutiveDays: number | null;
      requiresDocument:   boolean;
      carryoverDays:      number;
      minAdvanceDays:     number;
    },
  ): DWPolicyDetailRow[] {
    if (leaveType === LeaveType.UNPAID) {
      return [
        {
          key:   'Description',
          value: `${ctx.leaveName} is a Leave which is approved but not paid for.`,
        },
      ];
    }

    const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

    const rows: DWPolicyDetailRow[] = [
      { key: 'Policy Information' },
      {
        key:   'Number of Leave allocated Per Year',
        value: `You are entitled to take ${days(ctx.entitledDays)} of Leave Annually`,
      },
      {
        key: "Is 'Half Day' allowed for this Leave?",
        value: ctx.allowHalfDay
          ? 'You are allowed to use your Leave to avail Half-Day Leave. One half-day Leave will reduce 0.5 of your Leave.'
          : 'Half-Day Leave is not allowed for this leave type.',
      },
    ];

    if (ctx.maxConsecutiveDays !== null) {
      rows.push({
        key:   'Maximum Consecutive Days',
        value: `You can take a maximum of ${days(ctx.maxConsecutiveDays)} consecutively for this Leave.`,
      });
    }

    if (ctx.requiresDocument) {
      rows.push({
        key:   'Supporting Document',
        value: 'A supporting document is required when applying for this leave type.',
      });
    }

    rows.push({
      key: 'Leave Carry Forward',
      value: ctx.carryoverDays > 0
        ? `Up to ${days(ctx.carryoverDays)} of this leave can be carried forward to the next leave cycle.`
        : 'Unused leave days for this type will not be carried forward to the next cycle.',
    });

    if (ctx.minAdvanceDays > 0) {
      rows.push({
        key:   'Advance Notice',
        value: `This leave must be applied at least ${days(ctx.minAdvanceDays)} in advance.`,
      });
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // buildLeaveCardKey
  //
  // Derives the Darwinbox-format dictionary key for a single leave card.
  //
  // Convention (mirrors DW key structure):
  //   UNPAID with a provisioned row → "unpaid_{first 14 hex chars of balance UUID}"
  //   All others with a provisioned row → first 14 hex chars of the balance UUID
  //   No row yet → logs a warning and returns null; caller must skip the card.
  //
  // In production every employee has a balance row provisioned by the Darwinbox
  // sync job before this endpoint is called, so the null path should never fire.
  // ---------------------------------------------------------------------------
  private buildLeaveCardKey(
    userId: string,
    lt:     LeaveType,
    row:    LeaveBalanceRow | undefined,
  ): string | null {
    if (row) {
      const hex14 = row.id.replace(/-/g, '').slice(0, 14);
      return lt === LeaveType.UNPAID ? `unpaid_${hex14}` : hex14;
    }
    this.logger.warn(
      `No LeaveBalance row for userId=${userId} leaveType=${lt} — skipping card.`,
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // buildRecipient
  //
  // Maps a User row to the DW leave-recipient profile snapshot.
  //
  // unitName is provided for the primary target employee where the unit
  // relation is eagerly loaded in the join; it is intentionally omitted for
  // the manager since that relation is not joined (payload.department used
  // as fallback for the manager's organisation label).
  // ---------------------------------------------------------------------------
  private buildRecipient(user: User, unitName?: string | null): DWLeaveRecipient {
    const p = user.payload as {
      avatar_url?:  string;
      designation?: string;
      department?:  string;
      darwinbox?:   { mongo_id?: string };
    } | null;

    return {
      mongo_id:         p?.darwinbox?.mongo_id ?? user.id,
      employee_no:      user.employeeId,
      name_employee_no: `${user.fullName} (${user.employeeId})`,
      designation:      p?.designation ?? '',
      department:       unitName ?? p?.department ?? '',
      image:            p?.avatar_url  ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // buildTeamStatusSnapshot
  //
  // Maps a User row to the DW team-status employee profile snapshot.
  //
  // mongo_id resolution order:
  //   1. payload.darwinbox.mongo_id — original MongoDB ObjectId from Darwinbox sync.
  //   2. Internal UUID fallback when the JSONB field is absent or null.
  //
  // display_time_zone is hardcoded to "+420|Bangkok" (UTC+7 / WIB) matching
  // the primary timezone for this deployment's user base.
  // ---------------------------------------------------------------------------
  private buildTeamStatusSnapshot(user: User): DWTeamStatusUserSnapshot {
    const p = user.payload as {
      avatar_url?: string;
      darwinbox?:  { mongo_id?: string };
    } | null;

    return {
      mongo_id:          p?.darwinbox?.mongo_id ?? user.id,
      name_employee_no:  `${user.fullName} (${user.employeeId})`,
      url:               `/employeeprofile/view/id/${user.id}`,
      date_format:       'd-m-Y',
      time_format:       '24',
      is_on_notice:      'No',
      display_time_zone: '+420|Bangkok',
      image:             p?.avatar_url ?? null,
    };
  }

  // ===========================================================================
  // Private helpers — per-type policy defaults
  // ===========================================================================

  private defaultGenderConstraint(lt: LeaveType): 'male' | 'female' | null {
    if (lt === LeaveType.MATERNITY) return 'female';
    if (lt === LeaveType.PATERNITY) return 'male';
    return null;
  }

  private defaultEntitledDays(lt: LeaveType): number {
    const defaults: Record<LeaveType, number> = {
      ANNUAL:    12,
      SICK:      14,
      MATERNITY: 90,
      PATERNITY: 3,
      SPECIAL:   3,
      UNPAID:    0,
    };
    return defaults[lt];
  }

  private defaultRequiresDocument(lt: LeaveType): boolean {
    return lt === LeaveType.SICK || lt === LeaveType.MATERNITY;
  }

  // ===========================================================================
  // Private helpers — utilities
  // ===========================================================================

  private utcMidnightToday(): Date {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }

  private extractAvatarUrl(user: User): string | null {
    const p = user.payload as { avatar_url?: string } | null;
    return p?.avatar_url ?? null;
  }

  private extractCountryCode(user: User): string {
    const p = user.payload as { address?: { country_code?: string } } | null;
    return p?.address?.country_code ?? 'ID';
  }

  private extractUserGender(user: User): 'male' | 'female' | null {
    const p = user.payload as { gender?: 'male' | 'female' } | null;
    return p?.gender ?? null;
  }
}

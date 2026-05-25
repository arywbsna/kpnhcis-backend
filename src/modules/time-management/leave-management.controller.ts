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
import { GetLeaveCommonDetailsBodyDto } from './dto/get-leave-common-details.dto';
import { GetLeavesBodyDto } from './dto/get-leaves.dto';
import { GetLeavePatternBodyDto } from './dto/get-leave-pattern.dto';
import { GetTeamStatusBodyDto } from './dto/get-team-status.dto';
import { GetUpcomingTimeOffBodyDto } from './dto/get-upcoming-timeoff.dto';
import { LeaveManagementService } from './leave-management.service';
import type { GetLeaveCommonDetailsResponse } from './types/leave-common.types';
import type { GetLeavesResponse } from './types/get-leaves.types';
import type { GetLeavePatternResponse } from './types/leave-pattern.types';
import type { GetTeamStatusResponse } from './types/team-status.types';
import type { GetUpcomingTimeOffResponse } from './types/upcoming-timeoff.types';

/**
 * LeaveManagementController
 *
 * Serves the 5 Leaves API endpoints.  URL structure mirrors Darwinbox's own
 * `/leaves/leavesApi/` sub-path.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates Bearer token; populates request.user.
 *   PermissionsGuard — evaluates @CheckPermissions() tuples against the CASL
 *                      ability built from the user's DB roles (cached in Redis).
 *
 * ─── Authorization overview ───────────────────────────────────────────────────
 *   GetLeaveCommonDetails — read:LeaveBalance (structural config, all roles).
 *   getUpcomingTimeOff    — read:LeaveRequest (own OR admin).
 *   getTeamStatus         — read:LeaveRequest + read:User (manager / HR only for
 *                           cross-employee visibility; peers filtered by unit).
 *   GetDataForLeavePattern — read:LeaveBalance (type config drives form cascade).
 *   GetLeaves             — read:LeaveBalance (own OR admin).
 *
 * ─── URL convention ───────────────────────────────────────────────────────────
 *   Global prefix "api/v1".  Full URLs:
 *     POST /api/v1/leaves/leavesApi/GetLeaveCommonDetails
 *     POST /api/v1/leaves/leavesApi/getUpcomingTimeOff
 *     POST /api/v1/leaves/leavesApi/getTeamStatus
 *     POST /api/v1/leaves/leavesApi/GetDataForLeavePattern
 *     POST /api/v1/leaves/leavesApi/GetLeaves
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'LeaveBalance'])
export class LeaveManagementController {
  constructor(
    private readonly leaveService: LeaveManagementService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /leaves/leavesApi/GetLeaveCommonDetails
  //
  // Hydrates the main Leave Application dashboard.  Returns the full set of
  // leave cards for the target employee including:
  //   — Per-card visibility flags (dont_show_in_front_end / dont_show_in_application)
  //   — Live remaining balance as `currently_available` (string | number — see
  //     DWLeaveCardDetail for the Darwinbox legacy type quirk)
  //   — Hex color codes for UI rendering
  //   — Human-readable restriction messages when application is blocked
  //     (e.g. "You cannot apply for this Leave in probation period.")
  //   — Corporate profile snapshots for the approval chain (leave_recipients)
  //   — Flat key→name mapping in system_leaves_list for label rendering
  //
  // Body: { user_id? }
  //   user_id — optional; accepts Darwinbox source_employee_id, internal
  //             employeeId, or internal UUID.  Defaults to the JWT principal.
  // ---------------------------------------------------------------------------
  @Post('leaves/leavesApi/GetLeaveCommonDetails')
  @HttpCode(HttpStatus.OK)
  getLeaveCommonDetails(
    @Body() dto: GetLeaveCommonDetailsBodyDto,
    @Req() req: Request,
  ): Promise<GetLeaveCommonDetailsResponse> {
    return this.leaveService.getLeaveCommonDetails(
      (req.user as User).id,
      dto.user_id,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /leaves/leavesApi/getUpcomingTimeOff
  //
  // Timeline feed of approved and pending future scheduled time-off records.
  // Consumed by the profile calendar widget and the leave summary panel.
  //
  // The `include_pending` flag controls whether PENDING_APPROVAL records are
  // returned alongside APPROVED ones — the frontend uses this to render
  // tentative (striped) calendar blocks.
  //
  // Body: { user_id?, from_date?, to_date?, include_pending?, skip?, take? }
  //   Default window: today → +90 days.
  //   Default pagination: skip=0, take=20.
  // ---------------------------------------------------------------------------
  @Post('leaves/leavesApi/getUpcomingTimeOff')
  @HttpCode(HttpStatus.OK)
  @CheckPermissions(['read', 'LeaveRequest'])
  getUpcomingTimeOff(
    @Body() dto: GetUpcomingTimeOffBodyDto,
    @Req() req: Request,
  ): Promise<GetUpcomingTimeOffResponse> {
    return this.leaveService.getUpcomingTimeOff(
      (req.user as User).id,
      dto.user_id,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /leaves/leavesApi/getTeamStatus
  //
  // Peer visibility matrix for the manager / team lead dashboard.
  // Shows which direct reports (User.subordinates) and unit peers are
  // currently out-of-office on the requested date.
  //
  // Cross-employee access is gated inside the service: non-manager employees
  // can only see peers in the same unit, not arbitrary subordinates.
  //
  // Body: { user_id?, date?, include_peers? }
  //   date          — defaults to today (UTC midnight).
  //   include_peers — when true, unit peers are included; default: true.
  // ---------------------------------------------------------------------------
  @Post('leaves/leavesApi/getTeamStatus')
  @HttpCode(HttpStatus.OK)
  @CheckPermissions(['read', 'LeaveRequest'])
  getTeamStatus(
    @Body() dto: GetTeamStatusBodyDto,
    @Req() req: Request,
  ): Promise<GetTeamStatusResponse> {
    return this.leaveService.getTeamStatus((req.user as User).id, dto);
  }

  // ---------------------------------------------------------------------------
  // POST /leaves/leavesApi/GetDataForLeavePattern
  //
  // 12-month leave consumption matrix for the requested year.  Returns a
  // `data` dictionary keyed by "YYYY-MM" month strings covering all 12
  // calendar months.  Each entry maps leave-type keys to the total number
  // of approved leave days consumed in that month.
  //
  // Leave-type keys follow Darwinbox wire convention:
  //   Non-UNPAID types → 14-char hex slice of the LeaveBalance UUID.
  //   UNPAID types     → "unpaid_" + 14-char hex slice.
  //
  // All active LeaveBalance rows for the year appear in every month's
  // sub-dictionary, pre-initialised to 0 so the frontend can render the
  // chart skeleton without a second fetch.
  //
  // Body: { user_id?, year? }
  //   year    — optional YYYY integer; defaults to the current calendar year.
  //   user_id — optional; accepts Darwinbox source_employee_id, internal
  //             employeeId, or internal UUID.  Defaults to the JWT principal.
  // ---------------------------------------------------------------------------
  @Post('leaves/leavesApi/GetDataForLeavePattern')
  @HttpCode(HttpStatus.OK)
  getDataForLeavePattern(
    @Body() dto: GetLeavePatternBodyDto,
    @Req() req: Request,
  ): Promise<GetLeavePatternResponse> {
    return this.leaveService.getDataForLeavePattern(
      (req.user as User).id,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /leaves/leavesApi/GetLeaves
  //
  // Definitive leave balance sheet and policy configuration dictionary for the
  // resolved employee.  Returns a `data` envelope keyed by Darwinbox-format
  // leave-type identifiers:
  //   Non-UNPAID → 14-char hex slice of the LeaveBalance UUID.
  //   UNPAID     → "unpaid_" + 14-char hex slice.
  //
  // Each entry is a discriminated-union card (DWStandardLeaveEntry for paid
  // types, DWUnpaidLeaveEntry for UNPAID) containing:
  //   — Live balance metrics (currently_available, accrual_balance, annual_allotment).
  //   — Cycle boundary tokens (current_cycle_start / current_cycle_end).
  //   — Rich policy_details text array for the detail panel.
  //   — is_xstate_guard_passing: the server-side boolean gate consumed by the
  //     XState v5 leave-submission machine guard.  The "Submit Leave Request"
  //     transition fires only when this flag is true.
  //     Guard rules:
  //       Standard → (remaining > 0) AND gender constraint passes AND not mid-leave today.
  //       Unpaid   → not mid-leave today (no balance cap for UNPAID types).
  //
  // Body: { user_id? }
  //   user_id — optional; accepts Darwinbox source_employee_id, internal
  //             employeeId, or internal UUID.  Defaults to the JWT principal.
  // ---------------------------------------------------------------------------
  @Post('leaves/leavesApi/GetLeaves')
  @HttpCode(HttpStatus.OK)
  getLeaves(
    @Body() dto: GetLeavesBodyDto,
    @Req() req: Request,
  ): Promise<GetLeavesResponse> {
    return this.leaveService.getLeaves((req.user as User).id, dto);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LeaveRequest, LeaveRequestStatus, Prisma, User } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../casl/guards/permissions.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ApproveLeaveRequestDto } from './dto/approve-leave-request.dto';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { LeaveRequestQueryDto } from './dto/leave-request-query.dto';
import { RejectLeaveRequestDto } from './dto/reject-leave-request.dto';
import { SubmitLeaveRequestDto } from './dto/submit-leave-request.dto';
import { LeaveRequestService } from './leave-request.service';

/**
 * LeaveRequestController
 *
 * Exposes the full leave-request lifecycle over REST.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates the Bearer token; populates request.user
 *   PermissionsGuard — evaluates @CheckPermissions() against the user's CASL
 *                      ability (built from DB roles, cached in Redis)
 *
 * Class-level @CheckPermissions(['read', 'LeaveRequest']) is the default for
 * every route. Method-level decorators override it where a stronger permission
 * is needed (create / update / approve / reject / cancel).
 *
 * ─── Lifecycle endpoints ──────────────────────────────────────────────────────
 *   POST /              create a new DRAFT request
 *   POST /:id/submit    DRAFT → PENDING_APPROVAL (+ optional approverIds)
 *   POST /:id/approve   smart routing: supervisor or HRD step auto-detected
 *   POST /:id/reject    any active state → REJECTED (remarks required)
 *   POST /:id/cancel    any non-terminal state → CANCELLED
 *
 * ─── Read endpoints ───────────────────────────────────────────────────────────
 *   GET /               paginated list (users see own; approvers see unit-scoped)
 *   GET /:id            single request with approvals included
 *   GET /:id/transitions allowed event types for the current state (UI feed)
 *
 * ─── Approve routing detail ───────────────────────────────────────────────────
 *   POST /:id/approve delegates to LeaveRequestService.approveStep(), which
 *   reads the current status and dispatches to the correct XState event:
 *     PENDING_APPROVAL       → APPROVE_BY_SUPERVISOR
 *     APPROVED_BY_SUPERVISOR → APPROVE
 *   Anything else → 409 ConflictException from the service layer.
 *   The caller only needs to know "I approve this request" — routing is opaque.
 */
@Controller('leave-requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'LeaveRequest'])
export class LeaveRequestController {
  constructor(
    private readonly leaveRequestService: LeaveRequestService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * POST /leave-requests
   * Initialises a new leave request in DRAFT state for the authenticated user.
   * The XState context snapshot is seeded in the payload JSONB column.
   * Returns 201 Created with the full persisted record.
   */
  @Post()
  @CheckPermissions(['create', 'LeaveRequest'])
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateLeaveRequestDto,
  ): Promise<LeaveRequest> {
    return this.leaveRequestService.create({
      userId:    user.id,
      leaveType: dto.leaveType,
      startDate: new Date(dto.startDate),
      endDate:   new Date(dto.endDate),
      totalDays: dto.totalDays,
      reason:    dto.reason,
      payload:   dto.payload,
    });
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * GET /leave-requests
   * Paginated list with optional filters.
   *
   * Scoping rules (enforced here + by CASL conditions on DB roles):
   *   - Regular employees: always filtered to their own userId.
   *   - Supervisors / HRD: may pass ?userId= to query another employee's
   *     requests, but CASL conditions (e.g. { unitId: "${user.unitId}" })
   *     still restrict which records the ability grants.
   */
  @Get()
  async findAll(
    @Query() query: LeaveRequestQueryDto,
    @CurrentUser() user: User,
  ): Promise<{ data: LeaveRequest[]; total: number }> {
    const where: Prisma.LeaveRequestWhereInput = {
      ...(query.userId ? { userId: query.userId } : { userId: user.id }),
      ...(query.status    && { status:    query.status }),
      ...(query.leaveType && { leaveType: query.leaveType }),
      ...(query.startDateFrom || query.startDateTo
        ? {
            startDate: {
              ...(query.startDateFrom && { gte: new Date(query.startDateFrom) }),
              ...(query.startDateTo   && { lte: new Date(query.startDateTo)   }),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        skip:    query.skip,
        take:    query.take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, employeeId: true } },
          approvals: {
            orderBy: { decidedAt: 'asc' },
            include: { approver: { select: { id: true, fullName: true } } },
          },
        },
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * GET /leave-requests/:id
   * Returns a single request with all approval steps included.
   * Throws 404 if the record does not exist.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<LeaveRequest> {
    return this.leaveRequestService.findOne(id);
  }

  /**
   * GET /leave-requests/:id/transitions
   * Returns the current status and the list of XState event types that are
   * valid from it. The Vue 3 / Quasar frontend uses this response to
   * conditionally render action buttons — only reachable transitions are shown.
   *
   * Example response:
   *   { status: "PENDING_APPROVAL", allowedEvents: ["APPROVE_BY_SUPERVISOR", "REJECT", "CANCEL"] }
   */
  @Get(':id/transitions')
  getAvailableTransitions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ status: LeaveRequestStatus; allowedEvents: readonly string[] }> {
    return this.leaveRequestService.getAvailableTransitions(id);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle transitions
  // ---------------------------------------------------------------------------

  /**
   * POST /leave-requests/:id/submit
   * Transitions DRAFT → PENDING_APPROVAL.
   *
   * Body (optional): { approverIds?: string[] }
   *   If approverIds are provided they are stored in the payload JSONB column
   *   alongside the XState transition record. Downstream approval guards can
   *   use this list to validate that the acting approver was pre-authorised by
   *   the requester.
   *
   * Permission: 'update' on LeaveRequest (the requester updates their own draft).
   * Returns 200 OK — the resource already existed; this mutates its state.
   */
  @Post(':id/submit')
  @CheckPermissions(['update', 'LeaveRequest'])
  @HttpCode(HttpStatus.OK)
  submitRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitLeaveRequestDto,
    @CurrentUser() user: User,
  ): Promise<LeaveRequest> {
    return this.leaveRequestService.submitRequest(id, user.id, dto.approvalChain);
  }

  /**
   * POST /leave-requests/:id/approve
   * Smart approval endpoint — routes to the correct XState event based on
   * the current state of the leave request.
   *
   *   PENDING_APPROVAL       → APPROVE_BY_SUPERVISOR (supervisor step)
   *   APPROVED_BY_SUPERVISOR → APPROVE               (HRD final step)
   *   any other status       → 409 ConflictException (from service layer)
   *
   * The logged-in user's ID is implicitly used as the approverId — approvers
   * never pass their own ID in the request body, preventing impersonation.
   * An optional `remarks` string is forwarded to the audit trail.
   *
   * Returns 200 OK with the updated leave request including the new approval row.
   */
  @Post(':id/approve')
  @CheckPermissions(['approve', 'LeaveRequest'])
  @HttpCode(HttpStatus.OK)
  approveStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveLeaveRequestDto,
    @CurrentUser() user: User,
  ): Promise<LeaveRequest> {
    return this.leaveRequestService.approveStep(id, user.id, dto.remarks);
  }

  /**
   * POST /leave-requests/:id/reject
   * Transitions any active state (PENDING_APPROVAL | APPROVED_BY_SUPERVISOR)
   * → REJECTED. `remarks` is required: approvers must state a rejection reason
   * which is persisted in the LeaveApproval audit row and in payload.transitions.
   *
   * Returns 200 OK with the rejected leave request.
   */
  @Post(':id/reject')
  @CheckPermissions(['reject', 'LeaveRequest'])
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLeaveRequestDto,
    @CurrentUser() user: User,
  ): Promise<LeaveRequest> {
    return this.leaveRequestService.reject(id, user.id, dto.remarks);
  }

  /**
   * POST /leave-requests/:id/cancel
   * Transitions DRAFT | PENDING_APPROVAL | APPROVED_BY_SUPERVISOR → CANCELLED.
   * Terminal states (APPROVED, REJECTED, CANCELLED) throw 409 from the service.
   *
   * Returns 200 OK with the cancelled leave request.
   */
  @Post(':id/cancel')
  @CheckPermissions(['cancel', 'LeaveRequest'])
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<LeaveRequest> {
    return this.leaveRequestService.cancel(id, user.id);
  }
}

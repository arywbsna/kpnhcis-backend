import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LeaveRequest, LeaveRequestStatus, Prisma } from '@prisma/client';
import { createActor } from 'xstate';

import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOWED_EVENTS_BY_STATUS,
  LeaveRequestContext,
  LeaveRequestEvent,
  leaveRequestMachine,
  STATE_TO_STATUS,
  STATUS_TO_STATE,
  TERMINAL_STATUSES,
  TransitionRecord,
} from './leave-request.machine';

// ---------------------------------------------------------------------------
// RawLeaveRequestRow — shape returned by $queryRaw JSONB queries.
//
// $queryRaw returns PostgreSQL's native column names (snake_case) unless the
// SQL aliases them.  Every raw query in this service aliases columns to
// camelCase so this interface maps directly to the JS objects Prisma returns,
// with no secondary transformation step.
// ---------------------------------------------------------------------------
export interface RawLeaveRequestRow {
  id: string;
  userId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: string;   // PostgreSQL DECIMAL comes back as string from $queryRaw
  reason: string;
  status: LeaveRequestStatus;
  payload: Record<string, unknown> | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Shape of the JSONB payload column
// Versioned so future migrations can detect and upgrade old records.
// ---------------------------------------------------------------------------
interface LeaveRequestPayload {
  _v: number;
  _stateValue: string;
  /** Ordered list of user/position UUIDs that must approve in sequence. */
  approvalChain: string[];
  /** Index of the next required approver. Advances on each APPROVE. */
  currentStepIndex: number;
  lastApproverId?: string;
  lastRemarks?: string;
  transitions: TransitionRecord[];
  [key: string]: unknown; // user-defined dynamic fields
}

@Injectable()
export class LeaveRequestService {
  private readonly logger = new Logger(LeaveRequestService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Create — initialises a new request in DRAFT with an empty transition log
  // ---------------------------------------------------------------------------
  async create(data: {
    userId: string;
    leaveType: LeaveRequest['leaveType'];
    startDate: Date;
    endDate: Date;
    totalDays: number;
    reason: string;
    payload?: Record<string, unknown>;
  }): Promise<LeaveRequest> {
    const { payload: extraPayload, ...coreData } = data;

    const initialPayload: LeaveRequestPayload = {
      _v:               1,
      _stateValue:      'draft',
      approvalChain:    [],   // populated when SUBMIT fires
      currentStepIndex: 0,
      transitions: [
        {
          actorId:   data.userId,
          event:     'CREATE',
          fromState: 'none',
          toState:   'draft',
          timestamp: new Date().toISOString(),
        },
      ],
      ...(extraPayload ?? {}),
    };

    return this.prisma.leaveRequest.create({
      data: {
        ...coreData,
        status:  LeaveRequestStatus.DRAFT,
        payload: initialPayload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Find one — used by the controller and internally
  // ---------------------------------------------------------------------------
  async findOne(id: string): Promise<LeaveRequest> {
    const record = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        user:      { select: { id: true, fullName: true, employeeId: true } },
        approvals: {
          orderBy: { decidedAt: 'asc' },
          include: { approver: { select: { id: true, fullName: true } } },
        },
      },
    });

    if (!record) {
      throw new NotFoundException(`LeaveRequest ${id} not found`);
    }

    return record;
  }

  // ---------------------------------------------------------------------------
  // Available transitions — pure lookup, no DB hit on the machine
  // Derived from ALLOWED_EVENTS_BY_STATUS in the machine file so the
  // topology is defined exactly once.
  // ---------------------------------------------------------------------------
  async getAvailableTransitions(
    id: string,
  ): Promise<{ status: LeaveRequestStatus; allowedEvents: readonly string[] }> {
    const record = await this.prisma.leaveRequest.findUnique({
      where:  { id },
      select: { status: true },
    });

    if (!record) {
      throw new NotFoundException(`LeaveRequest ${id} not found`);
    }

    return {
      status:        record.status,
      allowedEvents: ALLOWED_EVENTS_BY_STATUS[record.status],
    };
  }

  // ---------------------------------------------------------------------------
  // Core transition — drives the XState machine and persists atomically
  // ---------------------------------------------------------------------------
  async transition(
    leaveRequestId: string,
    event: LeaveRequestEvent,
    actorUserId: string,
  ): Promise<LeaveRequest> {
    const leaveRequest = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
    });

    if (!leaveRequest) {
      throw new NotFoundException(`LeaveRequest ${leaveRequestId} not found`);
    }

    // ── Early exit for terminal states ─────────────────────────────────────
    // Never rehydrate an actor in a final state — XState v5 immediately fires
    // the .done event, which makes snapshot.can() return false for everything,
    // producing a misleading "event not allowed" error.
    if (TERMINAL_STATUSES.has(leaveRequest.status)) {
      throw new ConflictException(
        `LeaveRequest ${leaveRequestId} is already in a terminal state: "${leaveRequest.status}". No further transitions are possible.`,
      );
    }

    // ── Rehydrate actor from persisted state ──────────────────────────────
    const currentStateValue = STATUS_TO_STATE[leaveRequest.status];
    const existingPayload = (leaveRequest.payload as Partial<LeaveRequestPayload>) ?? {};

    // Restore the full chain state from the payload so `isAuthorisedApprover`
    // and the step guards have accurate context on rehydration.
    const rehydratedContext: LeaveRequestContext = {
      leaveRequestId:   leaveRequest.id,
      userId:           leaveRequest.userId,
      approvalChain:    Array.isArray(existingPayload.approvalChain)
                          ? existingPayload.approvalChain as string[]
                          : [],
      currentStepIndex: typeof existingPayload.currentStepIndex === 'number'
                          ? existingPayload.currentStepIndex
                          : 0,
      lastApproverId:   existingPayload.lastApproverId,
      lastRemarks:      existingPayload.lastRemarks,
    };

    const actor = createActor(leaveRequestMachine, {
      input: {
        leaveRequestId:   rehydratedContext.leaveRequestId,
        userId:           rehydratedContext.userId,
        approvalChain:    rehydratedContext.approvalChain,
        currentStepIndex: rehydratedContext.currentStepIndex,
        lastApproverId:   rehydratedContext.lastApproverId,
        lastRemarks:      rehydratedContext.lastRemarks,
      },
      snapshot: leaveRequestMachine.resolveState({
        value:   currentStateValue,
        context: rehydratedContext,
      }),
    });

    // ── Validate event before sending ─────────────────────────────────────
    // Use try/finally so actor.stop() is always called even on early throw.
    try {
      actor.start();
      const beforeSnapshot = actor.getSnapshot();

      if (!beforeSnapshot.can(event)) {
        const state = String(beforeSnapshot.value);
        const allowed = ALLOWED_EVENTS_BY_STATUS[leaveRequest.status];
        throw new BadRequestException(
          `Event "${event.type}" is not valid from state "${state}". ` +
          `Allowed events: [${allowed.join(', ')}]`,
        );
      }

      actor.send(event);

      const afterSnapshot  = actor.getSnapshot();
      const nextStateValue = String(afterSnapshot.value);
      const nextStatus     = STATE_TO_STATUS[nextStateValue];

      if (!nextStatus) {
        throw new BadRequestException(
          `Machine transitioned to unrecognised state: "${nextStateValue}"`,
        );
      }

      // ── Build immutable transition record ─────────────────────────────
      const transitionRecord: TransitionRecord = {
        actorId:    'approverId' in event ? event.approverId : actorUserId,
        event:      event.type,
        fromState:  currentStateValue,
        toState:    nextStateValue,
        // Capture the chain index that was satisfied before advanceStepIndex fires.
        stepIndex:  'approverId' in event ? rehydratedContext.currentStepIndex : undefined,
        approverId: 'approverId' in event ? event.approverId : undefined,
        remarks:    'remarks'    in event ? event.remarks    : undefined,
        timestamp:  new Date().toISOString(),
      };

      this.logger.log(
        `LeaveRequest ${leaveRequestId}: ` +
        `${leaveRequest.status} → ${nextStatus} ` +
        `via ${event.type} by ${transitionRecord.actorId}`,
      );

      // ── Atomic persist: status + payload + audit row ───────────────────
      const existingTransitions: TransitionRecord[] =
        Array.isArray(existingPayload.transitions) ? existingPayload.transitions : [];

      const newPayload: LeaveRequestPayload = {
        ...existingPayload,
        _v:               1,
        _stateValue:      nextStateValue,
        // Persist the updated chain state so the next rehydration is accurate.
        approvalChain:    afterSnapshot.context.approvalChain,
        currentStepIndex: afterSnapshot.context.currentStepIndex,
        lastApproverId:   afterSnapshot.context.lastApproverId,
        lastRemarks:      afterSnapshot.context.lastRemarks,
        transitions:      [...existingTransitions, transitionRecord],
      };

      const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updatedRecord = await tx.leaveRequest.update({
          where: { id: leaveRequestId },
          data: {
            status:      nextStatus,
            submittedAt: event.type === 'SUBMIT' ? new Date() : leaveRequest.submittedAt,
            payload:     newPayload as unknown as Prisma.InputJsonValue,
          },
        });

        // Write audit row for every action that carries an approverId.
        // SUBMIT and CANCEL are actor-only and recorded in payload.transitions.
        if ('approverId' in event && event.approverId) {
          await tx.leaveApproval.create({
            data: {
              leaveRequestId,
              approverId:    event.approverId,
              action:        event.type,
              remarks:       'remarks' in event ? event.remarks : undefined,
              eventSnapshot: event as unknown as Prisma.InputJsonValue,
              decidedAt:     new Date(transitionRecord.timestamp),
            },
          });
        }

        return updatedRecord;
      });

      return updated;
    } finally {
      // Always stop the actor — releases internal subscriptions
      actor.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Typed convenience wrappers — thin delegates over transition()
  // ---------------------------------------------------------------------------

  /**
   * submitRequest — passes the ordered approvalChain inside the SUBMIT event.
   *
   * The chain is now part of the XState event, not a post-submit JSONB patch.
   * The machine's `initApprovalChain` action writes it into context on the
   * DRAFT → approving transition, and the service persists it in the payload.
   *
   * Chain resolution (org hierarchy lookup) must happen before calling this.
   * The controller or a dedicated ApprovalChainService is responsible for
   * resolving the ordered list of approver IDs from the employee's unit.
   */
  submitRequest(
    leaveRequestId: string,
    userId: string,
    approvalChain: string[],
  ): Promise<LeaveRequest> {
    return this.transition(
      leaveRequestId,
      { type: 'SUBMIT', approvalChain },
      userId,
    );
  }

  /**
   * approve — fires the single APPROVE event that drives the token-passing loop.
   *
   * positionIds: the actor's currently held position/role UUIDs, resolved by
   * resolvePositionIds() from user.payload.positionIds. Passed to the machine
   * guard to support PLT / dual-position scenarios where the chain slot holds
   * a position UUID rather than a personal user UUID.
   *
   * Replaces the old approveBySupervisor + approve split. The machine guard
   * (`isAuthorisedApprover` + `isLastStep` / `notLastStep`) handles routing.
   */
  async approve(
    leaveRequestId: string,
    approverId: string,
    remarks?: string,
  ): Promise<LeaveRequest> {
    const positionIds = await this.resolvePositionIds(approverId);
    return this.transition(
      leaveRequestId,
      { type: 'APPROVE', approverId, positionIds, remarks },
      approverId,
    );
  }

  reject(
    leaveRequestId: string,
    approverId: string,
    remarks: string,
  ): Promise<LeaveRequest> {
    return this.transition(
      leaveRequestId,
      { type: 'REJECT', approverId, remarks },
      approverId,
    );
  }

  cancel(leaveRequestId: string, userId: string): Promise<LeaveRequest> {
    return this.transition(leaveRequestId, { type: 'CANCEL' }, userId);
  }

  /**
   * approveStep — public facade used by the controller.
   * Delegates to approve() which handles positionIds resolution internally.
   * The old status-based routing (PENDING_APPROVAL → approveBySupervisor,
   * APPROVED_BY_SUPERVISOR → approve) is no longer needed; the machine loop
   * and `currentStepIndex` replace it.
   */
  approveStep(
    leaveRequestId: string,
    approverId: string,
    remarks?: string,
  ): Promise<LeaveRequest> {
    return this.approve(leaveRequestId, approverId, remarks);
  }

  // ---------------------------------------------------------------------------
  // resolvePositionIds — loads the actor's held position/role UUIDs.
  //
  // PLT (Pelaksana Tugas) and dual-position users store their additional
  // position UUIDs in user.payload.positionIds (a string[]).
  // The machine guard combines these with the actor's personal user UUID
  // so either form of identity is accepted when matching an approval chain slot.
  // ---------------------------------------------------------------------------
  private async resolvePositionIds(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { payload: true },
    });
    const positionIds = (user?.payload as Record<string, unknown>)?.positionIds;
    return Array.isArray(positionIds) ? (positionIds as string[]) : [];
  }

  // ---------------------------------------------------------------------------
  // findByPayloadContainment — GIN-accelerated containment search on payload
  //
  // Uses the @> operator so the query planner chooses the GIN index created in
  // migration add_gin_indexes_payload.  Any expression that extracts a value
  // with ->> or #>> and then compares it will perform a sequential scan.
  //
  // Usage examples — all hit the GIN index:
  //   findByPayloadContainment({ _stateValue: 'pendingApproval' })
  //   findByPayloadContainment({ approverIds: ['<uuid>'] })
  //   findByPayloadContainment({ currentApproverIndex: 0 })
  //
  // Contrast with what does NOT use the GIN index:
  //   WHERE payload->>'_stateValue' = 'pendingApproval'   -- sequential scan
  //   WHERE payload #>> '{_stateValue}' = 'pendingApproval'-- sequential scan
  // ---------------------------------------------------------------------------
  async findByPayloadContainment(
    filter: Record<string, unknown>,
    options?: { skip?: number; take?: number },
  ): Promise<{ data: RawLeaveRequestRow[]; total: number }> {
    const { skip = 0, take = 20 } = options ?? {};
    const jsonFilter = JSON.stringify(filter);

    const [data, countRows] = await Promise.all([
      this.prisma.$queryRaw<RawLeaveRequestRow[]>`
        SELECT
          id,
          user_id       AS "userId",
          leave_type    AS "leaveType",
          start_date    AS "startDate",
          end_date      AS "endDate",
          total_days    AS "totalDays",
          reason,
          status,
          payload,
          submitted_at  AS "submittedAt",
          created_at    AS "createdAt",
          updated_at    AS "updatedAt"
        FROM leave_requests
        WHERE payload @> ${jsonFilter}::jsonb    -- hits the GIN index
        ORDER BY created_at DESC
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM leave_requests
        WHERE payload @> ${jsonFilter}::jsonb
      `,
    ]);

    return {
      data,
      total: Number(countRows[0].count),
    };
  }

  // ---------------------------------------------------------------------------
  // findPendingForApprover — path-specific GIN query
  //
  // Finds every leave request where a specific UUID appears inside the
  // `approverIds` array stored in the payload JSONB column.
  //
  // GIN index strategy:
  //   The query wraps the target UUID in a single-element JSON array and uses
  //   @> (containment).  "Does this document's approverIds array contain this
  //   element?"  PostgreSQL answers by looking the element up in the GIN
  //   structure — no sequential scan.
  //
  //   payload @> '{"approverIds": ["<uuid>"]}'::jsonb
  //
  // This is the deep nested path query the user requested:
  //   - The "path" is payload → approverIds → element
  //   - The GIN index is hit because we use @> on the full path, not ->> extraction
  //
  // Alternative that would NOT use GIN:
  //   WHERE payload->'approverIds' ? '<uuid>'   -- key-existence, needs jsonb_ops
  //   (jsonb_path_ops does not support ?, only @>)
  // ---------------------------------------------------------------------------
  async findPendingForApprover(
    approverId: string,
    status?: LeaveRequestStatus,
    options?: { skip?: number; take?: number },
  ): Promise<{ data: RawLeaveRequestRow[]; total: number }> {
    const { skip = 0, take = 20 } = options ?? {};

    // Wrap the approver ID inside the nested structure that @> expects.
    // {"approvalChain": ["<uuid>"]} matches any document where approvalChain
    // is an array that contains at least this one element.
    const jsonFilter = JSON.stringify({ approvalChain: [approverId] });

    const statusClause = status
      ? Prisma.sql`AND status = ${status}::"LeaveRequestStatus"`
      : Prisma.sql``;

    const [data, countRows] = await Promise.all([
      this.prisma.$queryRaw<RawLeaveRequestRow[]>`
        SELECT
          id,
          user_id       AS "userId",
          leave_type    AS "leaveType",
          start_date    AS "startDate",
          end_date      AS "endDate",
          total_days    AS "totalDays",
          reason,
          status,
          payload,
          submitted_at  AS "submittedAt",
          created_at    AS "createdAt",
          updated_at    AS "updatedAt"
        FROM leave_requests
        WHERE payload @> ${jsonFilter}::jsonb    -- GIN index hit: checks nested path
          ${statusClause}
        ORDER BY created_at DESC
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM leave_requests
        WHERE payload @> ${jsonFilter}::jsonb
          ${statusClause}
      `,
    ]);

    return {
      data,
      total: Number(countRows[0].count),
    };
  }

  // ---------------------------------------------------------------------------
  // findByXStateState — containment query on the _stateValue XState snapshot
  //
  // The XState context snapshot is stored in payload._stateValue (a plain
  // string matching the machine's state node name, e.g. 'pendingApproval').
  //
  // This differs from the Prisma `status` enum column: status is the persisted
  // business status (PENDING_APPROVAL), while _stateValue is the XState-internal
  // name ('pendingApproval').  They are always in sync but are separate fields.
  //
  // GIN hit: payload @> '{"_stateValue": "pendingApproval"}'::jsonb ✓
  // No GIN:  WHERE payload->>'_stateValue' = 'pendingApproval'       ✗
  // ---------------------------------------------------------------------------
  async findByXStateState(
    stateValue: string,
    options?: { skip?: number; take?: number },
  ): Promise<{ data: RawLeaveRequestRow[]; total: number }> {
    return this.findByPayloadContainment({ _stateValue: stateValue }, options);
  }

}

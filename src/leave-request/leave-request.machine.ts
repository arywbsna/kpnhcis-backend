import { LeaveRequestStatus } from '@prisma/client';
import { and, assign, setup } from 'xstate';

// =============================================================================
// Types
// =============================================================================

/**
 * One record per state transition — stored in payload.transitions[].
 * Immutable once written; new transitions are appended, never mutated.
 */
export interface TransitionRecord {
  /** UUID of the user who triggered this transition */
  actorId: string;
  /** XState event type string */
  event: string;
  fromState: string;
  toState: string;
  /** Position in the approvalChain that was satisfied (undefined for SUBMIT/CANCEL) */
  stepIndex?: number;
  approverId?: string;
  remarks?: string;
  timestamp: string; // ISO 8601
}

export interface LeaveRequestContext {
  leaveRequestId: string;
  userId: string;

  /**
   * Ordered list of user UUIDs (or position/role UUIDs for dual-position support)
   * that must approve in sequence. Set once at SUBMIT; never mutated afterwards.
   *
   * Examples:
   *   Route A: [rmId, hcDivId, groupHcId, jsId]    — 4 steps
   *   Route B: [hcHeadId, ceoId, jsId]             — 3 steps
   */
  approvalChain: string[];

  /** Index of the next required approver in approvalChain. Starts at 0. */
  currentStepIndex: number;

  lastApproverId?: string;
  lastRemarks?: string;
  error?: string;
}

/** Passed as `input` when creating or rehydrating an actor */
export interface LeaveRequestInput {
  leaveRequestId: string;
  userId: string;
  approvalChain?: string[];
  currentStepIndex?: number;
  lastApproverId?: string;
  lastRemarks?: string;
}

export type LeaveRequestEvent =
  /**
   * SUBMIT: transitions DRAFT → approving.
   * The caller is responsible for providing the ordered approval chain.
   * Chain resolution (unit hierarchy lookup) must happen in the service before
   * this event is sent — the machine is pure and performs no I/O.
   */
  | { type: 'SUBMIT'; approvalChain: string[] }
  /**
   * APPROVE: advance one step in the chain.
   * - Intermediate step: stays in `approving`, increments currentStepIndex.
   * - Final step: transitions to `approved`.
   *
   * positionIds: the acting user's currently held position/role UUIDs.
   * The guard checks whether any of these IDs matches approvalChain[currentStepIndex],
   * enabling PLT / dual-position scenarios without duplicating user records.
   */
  | { type: 'APPROVE'; approverId: string; positionIds?: string[]; remarks?: string }
  | { type: 'REJECT';  approverId: string; positionIds?: string[]; remarks: string }
  | { type: 'CANCEL' };

// =============================================================================
// Bidirectional status ↔ state-value maps — single source of truth.
// The new machine uses a single `approving` state for all in-progress steps.
// APPROVED_BY_SUPERVISOR is kept for backward-compatibility with existing DB rows.
// =============================================================================

export const STATE_TO_STATUS: Readonly<Record<string, LeaveRequestStatus>> = {
  draft:     LeaveRequestStatus.DRAFT,
  approving: LeaveRequestStatus.PENDING_APPROVAL,
  approved:  LeaveRequestStatus.APPROVED,
  rejected:  LeaveRequestStatus.REJECTED,
  cancelled: LeaveRequestStatus.CANCELLED,
} as const;

export const STATUS_TO_STATE: Readonly<Record<LeaveRequestStatus, string>> = {
  [LeaveRequestStatus.DRAFT]:                  'draft',
  [LeaveRequestStatus.PENDING_APPROVAL]:       'approving',
  // Legacy rows that reached the old `approvedBySupervisor` state are rehydrated
  // into `approving`; their currentStepIndex in the payload indicates their position.
  [LeaveRequestStatus.APPROVED_BY_SUPERVISOR]: 'approving',
  [LeaveRequestStatus.APPROVED]:               'approved',
  [LeaveRequestStatus.REJECTED]:               'rejected',
  [LeaveRequestStatus.CANCELLED]:              'cancelled',
} as const;

export const TERMINAL_STATUSES = new Set<LeaveRequestStatus>([
  LeaveRequestStatus.APPROVED,
  LeaveRequestStatus.REJECTED,
  LeaveRequestStatus.CANCELLED,
]);

export const ALLOWED_EVENTS_BY_STATUS: Readonly<
  Record<LeaveRequestStatus, ReadonlyArray<LeaveRequestEvent['type']>>
> = {
  [LeaveRequestStatus.DRAFT]:                  ['SUBMIT', 'CANCEL'],
  [LeaveRequestStatus.PENDING_APPROVAL]:       ['APPROVE', 'REJECT', 'CANCEL'],
  [LeaveRequestStatus.APPROVED_BY_SUPERVISOR]: ['APPROVE', 'REJECT', 'CANCEL'], // legacy
  [LeaveRequestStatus.APPROVED]:               [],
  [LeaveRequestStatus.REJECTED]:               [],
  [LeaveRequestStatus.CANCELLED]:              [],
} as const;

// =============================================================================
// Machine
// Pure: no framework imports, no I/O, no timestamps.
// All side effects live in LeaveRequestService.
//
// State topology (token-passing loop):
//
//   draft ──SUBMIT──► approving ──APPROVE (intermediate)──► approving (loop)
//                          │
//                          ├──APPROVE (final step)──► approved [final]
//                          ├──REJECT ───────────────► rejected  [final]
//                          └──CANCEL ───────────────► cancelled [final]
//   draft ──CANCEL──► cancelled
//
// The single `approving` state replaces the old rigid
// pendingApproval → approvedBySupervisor two-step graph.
// Chain length is data, not topology.
// =============================================================================

export const leaveRequestMachine = setup({
  types: {
    context: {} as LeaveRequestContext,
    events:  {} as LeaveRequestEvent,
    input:   {} as LeaveRequestInput,
  },

  guards: {
    /** SUBMIT must carry a non-empty ordered chain */
    hasApprovalChain: (
      { event }: { context: LeaveRequestContext; event: LeaveRequestEvent },
    ) =>
      event.type === 'SUBMIT' &&
      Array.isArray(event.approvalChain) &&
      event.approvalChain.length > 0,

    /**
     * Core authorization guard.
     *
     * Passes when:
     *   approvalChain[currentStepIndex] ∈ { event.approverId, ...event.positionIds }
     *
     * This covers both cases:
     *   - Normal user: their UUID matches the chain slot directly.
     *   - PLT / dual-position: one of their held position UUIDs matches the slot.
     *     Example: chain slot = "rm-position-uuid", actor holds both their user UUID
     *     and "rm-position-uuid" in positionIds → guard passes.
     */
    isAuthorisedApprover: (
      { context, event }: { context: LeaveRequestContext; event: LeaveRequestEvent },
    ) => {
      if (!('approverId' in event) || typeof event.approverId !== 'string') return false;

      const requiredId = context.approvalChain[context.currentStepIndex];
      if (!requiredId) return false;

      const actorIdentities = new Set([
        event.approverId,
        ...(event.positionIds ?? []),
      ]);

      return actorIdentities.has(requiredId);
    },

    /** True when currentStepIndex is at the last slot of the chain */
    isLastStep: (
      { context }: { context: LeaveRequestContext; event: LeaveRequestEvent },
    ) => context.currentStepIndex >= context.approvalChain.length - 1,

    /** True when there is at least one more slot after the current one */
    notLastStep: (
      { context }: { context: LeaveRequestContext; event: LeaveRequestEvent },
    ) => context.currentStepIndex < context.approvalChain.length - 1,

    /** Rejection must carry a non-empty written reason */
    hasRemarks: (
      { event }: { context: LeaveRequestContext; event: LeaveRequestEvent },
    ) =>
      'remarks' in event &&
      typeof event.remarks === 'string' &&
      event.remarks.trim().length > 0,
  },

  actions: {
    /**
     * Called on SUBMIT. Seeds approvalChain + currentStepIndex from the event.
     * Clears any stale approver fields from a previous lifecycle.
     */
    initApprovalChain: assign(
      ({ event }: { context: LeaveRequestContext; event: LeaveRequestEvent }) => {
        if (event.type !== 'SUBMIT') return {};
        return {
          approvalChain:    event.approvalChain,
          currentStepIndex: 0,
          lastApproverId:   undefined as string | undefined,
          lastRemarks:      undefined as string | undefined,
        };
      },
    ),

    /**
     * Advances the chain pointer by one.
     * Called only on intermediate APPROVE transitions (notLastStep).
     */
    advanceStepIndex: assign(
      ({ context }: { context: LeaveRequestContext; event: LeaveRequestEvent }) => ({
        currentStepIndex: context.currentStepIndex + 1,
      }),
    ),

    /**
     * Writes the acting approver's ID and optional remarks into context.
     * Called on every successful APPROVE and REJECT.
     */
    setApproverCtx: assign(
      ({ event }: { context: LeaveRequestContext; event: LeaveRequestEvent }) => ({
        lastApproverId: 'approverId' in event ? event.approverId : undefined,
        lastRemarks:    'remarks'    in event ? event.remarks    : undefined,
      }),
    ),
  },

}).createMachine({
  id:      'leaveRequest',
  initial: 'draft',

  context: ({ input }: { input: LeaveRequestInput }) => ({
    leaveRequestId:   input.leaveRequestId,
    userId:           input.userId,
    approvalChain:    input.approvalChain    ?? [],
    currentStepIndex: input.currentStepIndex ?? 0,
    lastApproverId:   input.lastApproverId,
    lastRemarks:      input.lastRemarks,
  }),

  states: {
    // -------------------------------------------------------------------------
    // DRAFT — initial state after creation
    // -------------------------------------------------------------------------
    draft: {
      on: {
        SUBMIT: {
          target:  'approving',
          guard:   'hasApprovalChain',
          actions: 'initApprovalChain',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },

    // -------------------------------------------------------------------------
    // APPROVING — dynamic token-passing loop.
    //
    // XState evaluates the APPROVE array entries in order.
    // Both branches require `isAuthorisedApprover`, so an unauthorized actor
    // fails both — snapshot.can(event) returns false, and the service throws 400.
    //
    // The two branches are mutually exclusive (notLastStep XOR isLastStep),
    // so evaluation order does not affect correctness.
    // -------------------------------------------------------------------------
    approving: {
      on: {
        APPROVE: [
          {
            // Intermediate step: advance pointer and stay in `approving`.
            guard:   and(['isAuthorisedApprover', 'notLastStep']),
            target:  'approving',
            actions: ['setApproverCtx', 'advanceStepIndex'],
          },
          {
            // Final step: chain is exhausted — transition to terminal state.
            guard:   and(['isAuthorisedApprover', 'isLastStep']),
            target:  'approved',
            actions: 'setApproverCtx',
          },
        ],
        REJECT: {
          target:  'rejected',
          guard:   and(['isAuthorisedApprover', 'hasRemarks']),
          actions: 'setApproverCtx',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },

    // -------------------------------------------------------------------------
    // Terminal states — no outbound transitions
    // -------------------------------------------------------------------------
    approved: {
      type: 'final',
    },
    rejected: {
      type: 'final',
    },
    cancelled: {
      type: 'final',
    },
  },
});

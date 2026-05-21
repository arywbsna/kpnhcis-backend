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
  /** XState event type string, e.g. "APPROVE_BY_SUPERVISOR" */
  event: string;
  fromState: string;
  toState: string;
  /** Present only on APPROVE_BY_SUPERVISOR, APPROVE, REJECT */
  approverId?: string;
  remarks?: string;
  timestamp: string; // ISO 8601
}

export interface LeaveRequestContext {
  leaveRequestId: string;
  userId: string;
  /** ID of the last actor who touched the request via an approver event */
  lastApproverId?: string;
  lastRemarks?: string;
  error?: string;
}

/** Passed as `input` when creating or rehydrating an actor */
export interface LeaveRequestInput {
  leaveRequestId: string;
  userId: string;
  lastApproverId?: string;
  lastRemarks?: string;
}

export type LeaveRequestEvent =
  | { type: 'SUBMIT' }
  | { type: 'APPROVE_BY_SUPERVISOR'; approverId: string; remarks?: string }
  | { type: 'APPROVE'; approverId: string; remarks?: string }
  | { type: 'REJECT'; approverId: string; remarks: string }
  | { type: 'CANCEL' };

// =============================================================================
// Bidirectional status ↔ state-value maps — single source of truth
// Exported so the service never has to re-derive this knowledge.
// =============================================================================

export const STATE_TO_STATUS: Readonly<Record<string, LeaveRequestStatus>> = {
  draft:                LeaveRequestStatus.DRAFT,
  pendingApproval:      LeaveRequestStatus.PENDING_APPROVAL,
  approvedBySupervisor: LeaveRequestStatus.APPROVED_BY_SUPERVISOR,
  approved:             LeaveRequestStatus.APPROVED,
  rejected:             LeaveRequestStatus.REJECTED,
  cancelled:            LeaveRequestStatus.CANCELLED,
} as const;

export const STATUS_TO_STATE: Readonly<Record<LeaveRequestStatus, string>> = {
  [LeaveRequestStatus.DRAFT]:                   'draft',
  [LeaveRequestStatus.PENDING_APPROVAL]:        'pendingApproval',
  [LeaveRequestStatus.APPROVED_BY_SUPERVISOR]:  'approvedBySupervisor',
  [LeaveRequestStatus.APPROVED]:                'approved',
  [LeaveRequestStatus.REJECTED]:                'rejected',
  [LeaveRequestStatus.CANCELLED]:               'cancelled',
} as const;

/**
 * States from which no further transitions are possible.
 * The service uses this to exit early rather than rehydrating a dead actor.
 */
export const TERMINAL_STATUSES = new Set<LeaveRequestStatus>([
  LeaveRequestStatus.APPROVED,
  LeaveRequestStatus.REJECTED,
  LeaveRequestStatus.CANCELLED,
]);

/**
 * The event types that are valid from each status.
 * Used by getAvailableTransitions() — derived from the machine topology,
 * kept here so the machine and its consumers share a single definition.
 */
export const ALLOWED_EVENTS_BY_STATUS: Readonly<
  Record<LeaveRequestStatus, ReadonlyArray<LeaveRequestEvent['type']>>
> = {
  [LeaveRequestStatus.DRAFT]:                   ['SUBMIT', 'CANCEL'],
  [LeaveRequestStatus.PENDING_APPROVAL]:        ['APPROVE_BY_SUPERVISOR', 'REJECT', 'CANCEL'],
  [LeaveRequestStatus.APPROVED_BY_SUPERVISOR]:  ['APPROVE', 'REJECT', 'CANCEL'],
  [LeaveRequestStatus.APPROVED]:                [],
  [LeaveRequestStatus.REJECTED]:                [],
  [LeaveRequestStatus.CANCELLED]:               [],
} as const;

// =============================================================================
// Machine
// Pure: no framework imports, no I/O, no timestamps.
// All side effects live in LeaveRequestService.
// =============================================================================

export const leaveRequestMachine = setup({
  types: {
    context:  {} as LeaveRequestContext,
    events:   {} as LeaveRequestEvent,
    input:    {} as LeaveRequestInput,
  },

  guards: {
    /** Approver events must carry a non-empty approverId */
    hasApproverId: ({ event }: { context: LeaveRequestContext; event: LeaveRequestEvent }) =>
      'approverId' in event && typeof event.approverId === 'string' && event.approverId.length > 0,

    /** Rejections must carry a non-empty reason */
    hasRemarks: ({ event }: { context: LeaveRequestContext; event: LeaveRequestEvent }) =>
      'remarks' in event && typeof event.remarks === 'string' && event.remarks.trim().length > 0,
  },

  actions: {
    /**
     * Writes the acting approver's ID and optional remarks into context.
     * Using the function form of assign so the parameter type is explicit —
     * the object form relies on XState inference that breaks when the module
     * is not yet resolved (pre-install).
     */
    setApproverCtx: assign(
      ({ event }: { context: LeaveRequestContext; event: LeaveRequestEvent }) => ({
        lastApproverId: 'approverId' in event ? event.approverId : undefined,
        lastRemarks:    'remarks'    in event ? event.remarks    : undefined,
      }),
    ),

    /** Resets approver fields — used when entering non-approver states */
    clearApproverCtx: assign(
      (_: { context: LeaveRequestContext; event: LeaveRequestEvent }) => ({
        lastApproverId: undefined as string | undefined,
        lastRemarks:    undefined as string | undefined,
      }),
    ),
  },

}).createMachine({
  id:      'leaveRequest',
  initial: 'draft',

  context: ({ input }: { input: LeaveRequestInput }) => ({
    leaveRequestId: input.leaveRequestId,
    userId:         input.userId,
    lastApproverId: input.lastApproverId,
    lastRemarks:    input.lastRemarks,
  }),

  states: {
    // -------------------------------------------------------------------------
    // DRAFT — initial state after creation
    // -------------------------------------------------------------------------
    draft: {
      on: {
        SUBMIT: {
          target:  'pendingApproval',
          actions: 'clearApproverCtx',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },

    // -------------------------------------------------------------------------
    // PENDING_APPROVAL — submitted, awaiting supervisor review
    // -------------------------------------------------------------------------
    pendingApproval: {
      on: {
        APPROVE_BY_SUPERVISOR: {
          target:  'approvedBySupervisor',
          guard:   'hasApproverId',
          actions: 'setApproverCtx',
        },
        REJECT: {
          target:  'rejected',
          // Both guards must pass — approver identity AND a written reason
          guard:   and(['hasApproverId', 'hasRemarks']),
          actions: 'setApproverCtx',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },

    // -------------------------------------------------------------------------
    // APPROVED_BY_SUPERVISOR — supervisor approved; awaiting final authority
    // -------------------------------------------------------------------------
    approvedBySupervisor: {
      on: {
        APPROVE: {
          target:  'approved',
          guard:   'hasApproverId',
          actions: 'setApproverCtx',
        },
        REJECT: {
          target:  'rejected',
          guard:   and(['hasApproverId', 'hasRemarks']),
          actions: 'setApproverCtx',
        },
        // Intentionally allowed: final-authority can still cancel before approval
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

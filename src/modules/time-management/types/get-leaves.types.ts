// =============================================================================
// get-leaves.types.ts
//
// Wire-format interfaces for POST /leaves/leavesApi/GetLeaves.
//
// This endpoint returns a `data` dictionary keyed by Darwinbox leave-type
// identifiers.  The dictionary values form a discriminated union: standard
// (paid) leave entries carry cycle boundary tokens and accrual fields, while
// UNPAID leave entries carry live tracking metrics.  The discriminant is the
// presence or absence of the `is_unpaid: 1` literal.
//
// Key naming convention (Darwinbox wire compatibility):
//   Non-UNPAID types → 14-char hex slice of LeaveBalance.id (hyphens stripped)
//   UNPAID types     → "unpaid_" + 14-char hex slice of LeaveBalance.id
//
// Strict wire invariants enforced by the type system:
//   is_hourly                → always the string "0" (not numeric 0)
//   is_compoff               → always the numeric literal 0
//   is_hybrid_cycle          → always the numeric literal 0
//   pay_rate_info            → always the numeric literal 0
//   show_accrual_balance     → always the numeric literal 1
//   show_application_info    → always the boolean false
//   show_applicability_info  → always the boolean false (standard entries only)
//   currently_available      → serialised as a numeric string, e.g. "12"
//   accrual_balance          → serialised as a numeric string
//   already_taken / applied / system_deducted → numeric strings (UNPAID only)
//   custom_qa / table_data   → always empty; typed as never[] to enforce invariant
//
// is_xstate_guard_passing is a server-side extension beyond the Darwinbox base
// wire format.  It is the canonical boolean consumed by the XState v5 leave-
// submission machine guard: the "Submit Leave Request" transition fires only
// when this flag is true.  Evaluation rules:
//   Standard → (remaining > 0) AND gender constraint passes AND not mid-leave today.
//   Unpaid   → not mid-leave today (no balance constraint on unpaid types).
// =============================================================================

/**
 * A single text row inside the `policy_details` array.
 *
 * Entries without a `value` key are section headers — the frontend renders
 * them in bold/title style.  Entries with both `key` and `value` are
 * descriptive rule lines rendered as key → paragraph pairs.
 */
export interface DWPolicyDetailRow {
  /** Section label or rule caption, e.g. "Policy Information". */
  key: string;
  /**
   * Human-readable rule description, e.g.
   * "You are entitled to take 12 days of Leave Annually".
   * Omitted on header rows (no `value` key in the JSON object at all).
   */
  value?: string;
}

/**
 * A standard (paid) leave entry in the GetLeaves data dictionary.
 *
 * Applies to every LeaveType except UNPAID.  Carries cycle boundary tokens
 * (`current_cycle_start`, `current_cycle_end`) that the frontend uses to
 * render the leave-year progress bar, and `annual_allotment` for the
 * "total entitlement" badge.
 *
 * `currently_available` is the live remaining balance after deducting used,
 * pending, and carried-over days.  Serialised as a numeric string to match
 * the Darwinbox legacy wire format consumed by existing frontend parsers.
 *
 * `is_encashment` reflects whether this leave type's LeaveBalance payload
 * has `encashable: true`; 0 in this deployment for all default types.
 */
export interface DWStandardLeaveEntry {
  /** Always false — application info banner is disabled in this deployment. */
  show_application_info:   false;
  /** Always false — applicability banner is disabled in this deployment. */
  show_applicability_info: false;
  /**
   * Disclaimer banner surfaced when admin-level config disables some data
   * points.  Always the canonical DW disclaimer string.
   */
  settings_warning_info: string;

  /**
   * Ordinal cycle number for this leave year.
   * Computed as `currentYear - CYCLE_BASE_YEAR`.  The frontend uses this
   * value to label the leave-year chip ("Year 5", "Year 6", etc.).
   */
  cycle: number;

  /** Always 0 — pay-rate modifiers are not configured in this deployment. */
  pay_rate_info: 0;

  /**
   * Dictionary key repeated as a property for self-contained card rendering.
   * Format: 14-char hex UUID slice, e.g. "a64f80538abbc2".
   */
  leave_id: string;

  /**
   * Bilingual display name for this leave category.
   * Sourced from LeaveBalance.payload.leaveName when present; falls back to
   * the canonical bilingual name constant for this deployment's locale pair.
   * Example: "Cuti Tahunan / Annual Leave".
   */
  leave_name: string;

  /** Always 0 — hybrid leave cycles are not configured in this deployment. */
  is_hybrid_cycle: 0;

  /**
   * 1 when the LeaveBalance payload marks this type as encashable; 0 otherwise.
   * In this deployment all default leave types have is_encashment = 0.
   */
  is_encashment: 0 | 1;

  /**
   * Rich policy text array rendered in the leave-detail panel.
   * Built by the `buildPolicyDetailsArray` service helper from the active
   * policy knobs (entitlement, half-day flag, carry-over, advance notice, etc.).
   */
  policy_details: DWPolicyDetailRow[];

  /**
   * Custom question/answer blocks for this leave type.
   * Always empty — no custom Q&A workflow in this deployment.
   */
  custom_qa: never[];

  /**
   * Supplementary table data rows.
   * Always empty — tabular breakdown is not used in this deployment.
   */
  table_data: never[];

  /**
   * ISO-8601 start date of the active leave cycle, e.g. "2026-01-01".
   * Sourced from LeaveBalance.payload.cycleStart; defaults to the calendar
   * year boundary `${year}-01-01` when the field is absent.
   */
  current_cycle_start: string;

  /**
   * ISO-8601 end date of the active leave cycle, e.g. "2026-12-31".
   * Sourced from LeaveBalance.payload.cycleEnd; defaults to `${year}-12-31`.
   */
  current_cycle_end: string;

  /**
   * Always the string "0" — hourly leave booking is not enabled.
   * MUST be a string literal, not a numeric 0, to match the Darwinbox wire
   * format evaluated by existing client-side parsers.
   */
  is_hourly: '0';

  /**
   * Live remaining balance: `max(0, entitled + carried - used - pending)`.
   * Serialised as a numeric string, e.g. "12" or "0".
   */
  currently_available: string;

  /**
   * Always 1 — accrual balance display is always enabled for standard types.
   */
  show_accrual_balance: 1;

  /**
   * Accrual balance string.  In this deployment (non-accrual system) this
   * mirrors `currently_available`.
   */
  accrual_balance: string;

  /**
   * Annual entitlement in full days, e.g. 12.
   * Sourced from LeaveBalance.entitled cast to number.
   */
  annual_allotment: number;

  /** Always 0 — comp-off is not tracked as a distinct balance type here. */
  is_compoff: 0;

  /**
   * Server-side XState v5 guard signal.
   * true  → the "Submit Leave Request" machine transition is ENABLED.
   * false → DISABLED (zero remaining balance, gender constraint not met,
   *         or the employee is currently mid-leave for this type today).
   *
   * Evaluation: (remaining > 0) AND genderPasses AND notOnLeaveToday.
   */
  is_xstate_guard_passing: boolean;
}

/**
 * An UNPAID leave entry in the GetLeaves data dictionary.
 *
 * Applies exclusively to LeaveBalance rows where leaveType = UNPAID.
 * Does not carry cycle boundary or allotment fields — UNPAID leave has no
 * pre-set cap.  Instead it surfaces live tracking metrics:
 *   already_taken   — approved days consumed this year (LeaveBalance.used).
 *   applied         — pending days not yet approved (live count from requests).
 *   system_deducted — days that have been payroll-deducted (mirrors already_taken
 *                     in this deployment as no separate deduction workflow exists).
 *
 * Key format: "unpaid_" + 14-char hex UUID slice,
 *   e.g. "unpaid_a1236af4f12e0a".
 */
export interface DWUnpaidLeaveEntry {
  /** Always false — application info banner is disabled. */
  show_application_info: false;

  /** Discriminant — always 1, identifies this as an UNPAID leave card. */
  is_unpaid: 1;

  /**
   * Dictionary key repeated as a property for self-contained card rendering.
   * Format: "unpaid_" + 14-char hex UUID slice.
   */
  leave_id: string;

  /**
   * Always the string "0" — hourly leave booking is not enabled.
   * Must remain a string literal matching the Darwinbox wire convention.
   */
  is_hourly: '0';

  /**
   * Bilingual display name, e.g. "Unpaid Leave / Cuti Potong Gaji".
   * Sourced from LeaveBalance.payload.leaveName or the canonical constant.
   */
  leave_name: string;

  /**
   * Total approved UNPAID leave days taken this year.
   * Sourced from LeaveBalance.used; serialised as a numeric string.
   */
  already_taken: string;

  /**
   * Total UNPAID leave days currently pending approval.
   * Live count from LeaveRequest table; serialised as a numeric string.
   */
  applied: string;

  /**
   * Total UNPAID leave days that have been payroll-deducted.
   * In this deployment mirrors `already_taken` (no separate deduction log).
   */
  system_deducted: string;

  /**
   * Rich policy text array — for UNPAID types contains a single description
   * row explaining the leave's non-payment nature.
   */
  policy_details: DWPolicyDetailRow[];

  /** Custom Q&A blocks — always empty in this deployment. */
  custom_qa: never[];

  /**
   * Server-side XState v5 guard signal.
   * true  → transition ENABLED (employee is not currently mid-UNPAID-leave today).
   * false → DISABLED (employee is actively on an approved UNPAID leave today).
   *
   * Balance check is omitted for UNPAID: no cap is enforced.
   */
  is_xstate_guard_passing: boolean;
}

/**
 * Discriminated union for a single entry in the `data` envelope.
 *
 * Discriminant: presence of `is_unpaid: 1` on the UNPAID variant.
 * TypeScript narrows correctly using `'is_unpaid' in entry` or a type guard.
 */
export type GetLeavesDataEnvelope = DWStandardLeaveEntry | DWUnpaidLeaveEntry;

/**
 * Root response envelope for GET /leaves/leavesApi/GetLeaves.
 *
 * `data` is a Record whose keys are Darwinbox-format leave-type identifiers:
 *   — 14-char hex UUID slices for standard (paid) leave types.
 *   — "unpaid_" + 14-char hex UUID slice for UNPAID leave types.
 *
 * Every active LeaveBalance row for the resolved employee in the current year
 * produces exactly one entry.  Types for which no LeaveBalance row has been
 * provisioned are omitted (the sync job guarantees coverage in production).
 */
export interface GetLeavesResponse {
  status: 1;
  data:   Record<string, GetLeavesDataEnvelope>;
}

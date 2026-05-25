// =============================================================================
// leave-common.types.ts
//
// Wire-format interfaces for POST /leaves/leavesApi/GetLeaveCommonDetails.
//
// Mirrors the Darwinbox DW-wire envelope so the Vue 3/Quasar frontend can
// consume the response without an adapter layer.  No `any` types.
//
// Key design decisions:
//   — `leaves_taken` is a dynamic dictionary keyed by 14-char hex strings
//     derived from the LeaveBalance UUID (Darwinbox convention), with the
//     single exception of the UNPAID category which uses an `unpaid_*` prefix.
//   — `currently_available` carries a Darwinbox legacy type quirk: it is
//     emitted as the string "0" for zero-balance UNPAID entries and as a
//     plain number for all other leave categories.  The union type preserves
//     this wire contract exactly so downstream consumers can handle either
//     form without defensive casts.
// =============================================================================

/**
 * A single leave card entry in the `leaves_taken` dictionary.
 *
 * Visibility flags control rendering at two levels:
 *   dont_show_in_front_end   — hide the card entirely (e.g. type disabled for
 *                              this contract class).
 *   dont_show_in_application — card is visible but the "Apply" button is
 *                              suppressed (gender mismatch, probation lock,
 *                              expired policy, zero balance).
 *
 * `reason_for_application_restriction` supplies the human-readable tooltip
 * shown by the frontend when dont_show_in_application is true.
 */
export interface DWLeaveCardDetail {
  dont_show_in_front_end:             boolean;
  dont_show_in_application:           boolean;
  pay_rate:                           number;          // 1 = full pay, 0 = unpaid
  color_code:                         string;          // hex e.g. "#4CAF50"
  currently_available:                string | number; // see module-level note
  reason_for_application_restriction: string | null;
}

/**
 * Corporate profile snapshot of a leave chain participant.
 * The array in the response typically contains two entries:
 *   [0] — the target employee (the one whose leave is being viewed).
 *   [1] — the immediate reporting manager (approval chain first hop).
 *
 * `mongo_id` mirrors Darwinbox's legacy MongoDB primary key field.  In our
 * PostgreSQL system this is populated from payload.darwinbox.mongo_id when
 * the record was synced from Darwinbox; otherwise the internal UUID is used.
 *
 * `name_employee_no` is the composite display label expected by the frontend:
 *   "{fullName} ({employeeNo})"   e.g. "John Doe (EMP-00042)"
 */
export interface DWLeaveRecipient {
  mongo_id:         string;
  employee_no:      string;
  name_employee_no: string;
  designation:      string;
  department:       string;
  image:            string | null;   // S3 avatar path, or null when unset
}

/**
 * Root data payload nested under the `data` key in the envelope.
 *
 * `system_leaves_list` is a flat key-value dictionary that maps the same
 * 14-char hex keys used in `leaves_taken` directly to their display names,
 * allowing the frontend to render the card labels without a secondary lookup.
 *
 * `max_optional_holiday` and `optional_holiday_approval_status` default to 0.
 * They are retained in the contract for forward-compatibility with the
 * Darwinbox optional-holiday scheme, which this organisation has not enabled.
 */
export interface GetLeaveCommonDetailsData {
  leaves_taken:                     Record<string, DWLeaveCardDetail>;
  leave_recipients:                 DWLeaveRecipient[];
  system_leaves_list:               Record<string, string>;
  max_optional_holiday:             number;
  optional_holiday_approval_status: number;
}

export interface GetLeaveCommonDetailsResponse {
  status: 1;
  data:   GetLeaveCommonDetailsData;
}

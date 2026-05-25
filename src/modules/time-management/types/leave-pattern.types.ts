// =============================================================================
// leave-pattern.types.ts
//
// Wire-format interfaces for POST /leaves/leavesApi/GetDataForLeavePattern.
//
// This endpoint returns a 12-month matrix mapping consumed approved leave days
// per leave type for a given year.  The response is keyed by "YYYY-MM" month
// strings, with each value being a flat Record mapping leave-type keys to the
// number of approved days consumed in that month.
//
// Key naming convention (Darwinbox wire compatibility):
//   UNPAID leave types  → key prefixed with "unpaid_" + 14-char hex UUID slice
//   All other types     → 14-char hex UUID slice (no prefix)
//
// Keys that appear in the skeleton always correspond to LeaveBalance rows that
// exist for the target user in the requested year.  Every month in the 12-month
// window contains every active key pre-initialised to 0, then incremented by
// per-month overlap days from APPROVED LeaveRequest rows.
//
// history_details is always an empty array — the historical audit trail is
// served by a separate workflow endpoint not implemented in this deployment.
// =============================================================================

/**
 * A single month's leave consumption snapshot.
 *
 * Keys are leave-type identifiers derived from the LeaveBalance.id UUID:
 *   — Non-UNPAID: `id.replace(/-/g, '').slice(0, 14)` — 14-char hex
 *   — UNPAID:     `"unpaid_" + id.replace(/-/g, '').slice(0, 14)`
 *
 * Values are integer day counts representing the total approved leave days
 * consumed in this calendar month for that leave type.  0 when no approved
 * leaves overlap this month.
 */
export type DWMonthlyLeavePattern = Record<string, number>;

/**
 * Root response envelope for GetDataForLeavePattern.
 *
 * `data` is a Record keyed by "YYYY-MM" month strings covering all 12 months
 * of the requested year (January through December), each containing one
 * DWMonthlyLeavePattern entry per active LeaveBalance row.
 *
 * `history_details` is always an empty array.
 * `status` is always 1.
 */
export interface GetLeavePatternResponse {
  data:            Record<string, DWMonthlyLeavePattern>;
  history_details: never[];
  status:          1;
}

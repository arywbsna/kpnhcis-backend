// =============================================================================
// day-status.types.ts
//
// Wire-format interfaces for POST /attendance/attendanceAPI/getDayStatus.
//
// This endpoint resolves granular punch metadata, shift duration metrics, and
// raw timing strings for a single targeted calendar date.  The frontend hits
// this endpoint when a user clicks a day cell in the attendance calendar to
// inspect their timeline for that day.
//
// Wire contract (must match exactly):
// {
//   "status": 1,
//   "data": {
//     "total_duration":       "00:00:00",
//     "shift_duration":       "9:00:00",
//     "day":                  "2026-05-21",
//     "action_label":         0,
//     "clockin_time":         "07:45:45",
//     "clockout_time":        null,
//     "clockinout_label":     null,
//     "user_id":              "a69123b48123c0123712302",
//     "tenant_id":            "5",
//     "shift_date":           "2026-05-21",
//     "log_id":               "a6a0e5123e5123",
//     "clockin_time_string":  "07:45:45",
//     "clockout_time_string": null,
//     "enable_break":         null,
//     "show_break":           null,
//     "break_label":          ""
//   }
// }
//
// Design notes:
//   — clockin_time / clockin_time_string carry the same value (likewise for
//     the clockout pair).  Both fields are emitted because the Darwinbox
//     legacy frontend binds to each field independently in different views.
//   — shift_duration uses "H:mm:ss" (no leading zero on the hours component)
//     to match the Darwinbox legacy wire quirk.  All other duration fields
//     use the standard "HH:mm:ss" zero-padded form.
//   — enable_break and show_break are permanently null — the break management
//     module is inactive in this deployment.  The fields are present so the
//     client's deep validation does not reject the payload.
//   — break_label is always "" (empty string), never null.  The Darwinbox
//     client distinguishes a disabled-break sentinel ("") from a genuinely
//     absent break-label (null) and renders different UI for each state.
// =============================================================================

/**
 * Single-day attendance data payload returned by getDayStatus.
 *
 * All duration strings use "HH:mm:ss" (zero-padded) except shift_duration
 * which uses "H:mm:ss" (no leading zero) per the Darwinbox legacy quirk.
 *
 * Null fields indicate that data is absent or a feature is disabled; they are
 * typed precisely (`null` literal) rather than `null | undefined` to ensure
 * the JSON serialiser always emits `null` rather than omitting the key.
 */
export interface DWDayStatusData {
  /**
   * Actual elapsed work time for the day.
   * Read from AttendanceDaily.totalWorkMins × 60, formatted as "HH:mm:ss".
   * Emits "00:00:00" when no daily row exists or the nightly aggregation
   * job has not yet run for the day.
   */
  total_duration: string;

  /**
   * Expected shift length derived from the active ShiftDefinition.
   * Formatted as "H:mm:ss" WITHOUT a leading zero on the hours component
   * (Darwinbox legacy wire quirk — e.g. "9:00:00", not "09:00:00").
   * Defaults to "9:00:00" when no shift assignment is found.
   */
  shift_duration: string;

  /** Calendar date in "YYYY-MM-DD" format. */
  day: string;

  /**
   * UI state flag for the clock-in/out action button.
   * 0 = default / no pending special action label.
   * The frontend determines clock-in vs. clock-out button visibility by
   * inspecting the presence of clockin_time and clockout_time directly.
   */
  action_label: number;

  /** First clock-in time for this date in "HH:mm:ss" UTC; null when absent. */
  clockin_time: string | null;

  /** Last clock-out time for this date in "HH:mm:ss" UTC; null when absent. */
  clockout_time: string | null;

  /**
   * Optional UI override label for the clock-in/out button.
   * null in the standard workflow — populated only in custom action states
   * (e.g. correction request in progress).
   */
  clockinout_label: string | null;

  /**
   * Deterministic 23-character hex identifier for the target employee.
   * Derived by stripping hyphens from the user's internal UUID and slicing
   * the first 23 characters, yielding a stable Darwinbox-compatible ID.
   */
  user_id: string;

  /**
   * Darwinbox tenant identifier.
   * Hardcoded to "5" per the legacy wire specification for this deployment.
   */
  tenant_id: string;

  /** Mirrors `day` — the shift date for which data is returned ("YYYY-MM-DD"). */
  shift_date: string;

  /**
   * Deterministic 14-character hex identifier for the AttendanceDaily row.
   * Derived by stripping hyphens from the row UUID and slicing the first 14
   * characters.  Emits "" (empty string) when no daily row exists for the date.
   */
  log_id: string;

  /** Duplicate of clockin_time — required by the legacy wire contract. */
  clockin_time_string: string | null;

  /** Duplicate of clockout_time — required by the legacy wire contract. */
  clockout_time_string: string | null;

  /**
   * Break feature activation flag.
   * Permanently null — break management is not active in this deployment.
   * Present in the response to satisfy client-side deep validation.
   */
  enable_break: null;

  /**
   * Break UI visibility flag.
   * Permanently null — break UI is suppressed in this deployment.
   */
  show_break: null;

  /**
   * Disabled-break sentinel.
   * Always "" (empty string) — never null.  The Darwinbox client distinguishes
   * this sentinel from null and renders a different no-break indicator for each.
   */
  break_label: string;
}

export interface GetDayStatusResponse {
  status: 1;
  data:   DWDayStatusData;
}

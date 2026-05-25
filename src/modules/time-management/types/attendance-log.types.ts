// =============================================================================
// attendance-log.types.ts
//
// Wire-format interfaces for POST /attendance/attendanceAPI/GetAttendanceLog.
//
// This endpoint produces a day-by-day dictionary ledger keyed by ISO-8601 date
// strings ("YYYY-MM-DD").  Each value is a DWDayLogLedgerEntry containing:
//   — Clock timing fields (full datetime and time-only duplicates).
//   — Duration arithmetic sub-fields (elapsed, break split, aggregated work).
//   — A DWLogStatusBadge[] attendance_status badge array.
//   — A DWLogActionsBlock actions sub-object with 0|1 permission toggles.
//   — A DWUserAttendanceDetails block carrying the employee's active shift card
//     and policy configuration for that calendar day.
//   — Window-level counters (present_count, absent_count, leave_count,
//     unpaid_count) that are the same on every day entry in the response.
//
// Wire contract (Darwinbox asymmetric date token inversion):
//   Outer dict key : "YYYY-MM-DD" — ISO format for JS Date parsing.
//   Inner .date    : "DD-MM-YYYY" — legacy local display format.
//
// Design notes:
//   — request_status and work_transfer_details are always empty in this
//     deployment (no attendance-correction or work-transfer workflow).
//     Typed as `never[]` to enforce the empty-array invariant at compile time.
//   — All 0|1 integer fields use the literal union `0 | 1` rather than
//     `number` to prevent legacy client evaluation errors.
//   — Duration strings follow two conventions:
//       "HH:mm:ss" (zero-padded) for per-day elapsed/work/break fields.
//       "H:mm:ss"  (no leading zero) for shift_duration inside
//                  DWUserAttendanceDetails — Darwinbox legacy wire quirk.
// =============================================================================

/**
 * A single coloured status badge inside the attendance_status array.
 *
 * Each day carries exactly one badge.  The badge's `type` field is the
 * machine-readable discriminator; `status` is the human-readable label;
 * `color` is the hex or named colour the frontend applies to the chip.
 *
 * Known badge variants for this deployment:
 *   type "present"  → color "green",  status "Present"
 *   type "absent"   → color "red",    status "Absent"
 *   type "holiday"  → color "blue",   status "Holiday"
 *   type "weekoff"  → color "grey",   status "Week Off"
 *   type "leave"    → color "orange", status "Leave"
 */
export interface DWLogStatusBadge {
  color:  string;
  status: string;
  type:   string;
}

/**
 * Operational permission toggles for the day row.
 *
 * All fields use the 0|1 integer literal to match the Darwinbox legacy
 * wire format where JavaScript's truthiness evaluation is the expected
 * consumer — `false` (boolean) would break existing client evaluations.
 *
 *   is_edit / is_delete         — row-level mutation permissions; always 0
 *                                 in this deployment (edits go through the
 *                                 correction-request workflow, not inline).
 *   singleday_request           — 0; no single-day correction workflow.
 *   ot_journal_enable           — 1 on present days; allows OT journaling.
 *   att_register_enable         — 1 on present days; activates the register.
 *   attendance_shift_change     — 0; shift change is not user-facing here.
 */
export interface DWLogActionsBlock {
  is_edit:                 0 | 1;
  is_delete:               0 | 1;
  singleday_request:       0 | 1;
  ot_journal_enable:       0 | 1;
  att_register_enable:     0 | 1;
  attendance_shift_change: 0 | 1;
}

/**
 * Shift and policy card embedded inside each ledger day entry.
 *
 * For active (present) days, the shift is sourced from the AttendanceDaily
 * row's linked ShiftDefinition — the shift that was actually active when the
 * clock event was recorded.
 *
 * For inactive days (weekoff, holiday, absent, leave), the shift comes from
 * the most recent ShiftAssignment effective on the window start date, so the
 * frontend can render the employee's "expected schedule" in the empty cell.
 *
 * When no shift assignment exists at all, is_null_shift is set to 1 and all
 * string fields carry safe empty-string defaults.
 *
 * shift_duration uses "H:mm:ss" (no leading zero) per the Darwinbox wire
 * convention for shift duration fields across this module.
 * All other time strings in this block use "HH:mm" (no seconds).
 */
export interface DWUserAttendanceDetails {
  /**
   * Human-readable weekend day summary, e.g. "All Saturday, All Sunday".
   * Days are ordered by natural work-week position (Saturday before Sunday).
   * Empty string when no shift is assigned.
   */
  weeklyoff_name: string;

  /** ShiftDefinition.name, e.g. "09:00 - 18:00 flexi". */
  shift_name: string;

  /**
   * 14-char hex slice of the ShiftDefinition UUID (hyphens stripped).
   * Matches the key convention used across this module for entity identifiers.
   * Empty string when is_null_shift = 1.
   */
  current_shift_id: string;

  /**
   * Full shift start datetime for this calendar day.
   * Format: "YYYY-MM-DD HH:mm" (no seconds), e.g. "2026-05-11 09:00".
   * The date component mirrors the outer dictionary key.
   */
  shift_begin: string;

  /**
   * Full shift end datetime for this calendar day.
   * Format: "YYYY-MM-DD HH:mm" (no seconds), e.g. "2026-05-11 18:00".
   */
  shift_end: string;

  /**
   * Gross shift duration without break deduction.
   * Format: "H:mm:ss" — no leading zero on hours (Darwinbox legacy quirk).
   * Example: "9:00:00" for a 09:00–18:00 shift.
   */
  shift_duration: string;

  /** Break schedule name; always "" — no named break policy in this deployment. */
  shift_break_name: string;

  /**
   * Attendance policy label, sourced from ShiftDefinition.payload.policyName
   * when present, falling back to the shift name.
   */
  policy_name: string;

  /** Shift block name; always "" in this deployment. */
  shiftblock_name: string;

  /** Overtime policy name; always "" — OT policy is embedded in the shift card. */
  overtime_policy: string;

  /** Contract hours label; always "" — not configured in this deployment. */
  employee_contract_hours: string;

  /**
   * Clock-in grace period in minutes, serialised as a numeric string.
   * Sourced from ShiftDefinition.gracePeriodMins, e.g. "0" or "15".
   */
  grace_time_clockin: string;

  /**
   * Clock-out grace period in minutes, serialised as a numeric string.
   * Always "0" — no separate clock-out grace in this deployment.
   */
  grace_time_clockout: string;

  /** Break policy name; always "" in this deployment. */
  break_policy: string;

  /** 1 when no ShiftAssignment exists for this employee; 0 otherwise. */
  is_null_shift: 0 | 1;
}

/**
 * A single day entry in the GetAttendanceLog ledger dictionary.
 *
 * The outer `logs` Record key is "YYYY-MM-DD" (ISO-8601 for JS Date parsing).
 * This entry's `.date` property is the Darwinbox-format inversion "DD-MM-YYYY"
 * (local display format) — see the asymmetric date token inversion note at
 * the top of this file.
 *
 * Duration fields:
 *   total_work_duration  — raw elapsed from first_clockin to first_clockout.
 *   break_duration       — elapsed minus final_work_duration (derived delta).
 *   paid_break           — always "00:00:00"; no paid-break policy here.
 *   unpaid_break         — always "00:00:00"; tracked separately from break_duration.
 *   final_work_duration  — net work from AttendanceDaily.totalWorkMins * 60.
 *
 * All duration fields on inactive days (no clock-in) are empty string "".
 * All duration fields on present days with no clock-out are "00:00:00".
 *
 * Window-level counters (present_count, absent_count, leave_count,
 * unpaid_count) reflect the totals across the ENTIRE requested date window,
 * not just this individual day.  The same four values appear on every entry.
 */
export interface DWDayLogLedgerEntry {
  /**
   * Local-format date for this entry: "DD-MM-YYYY".
   * Inverted from the outer dict key which uses "YYYY-MM-DD".
   */
  date: string;

  /**
   * Full clock-in datetime in UTC: "YYYY-MM-DD HH:mm:ss".
   * Sourced from AttendanceDaily.firstClockIn.
   * Empty string "" when the employee did not clock in on this date.
   */
  clock_in: string;

  /**
   * Full clock-out datetime in UTC: "YYYY-MM-DD HH:mm:ss".
   * Sourced from AttendanceDaily.lastClockOut.
   * Empty string "" when no clock-out has been recorded.
   */
  clock_out: string;

  /**
   * Break duration derived as (total_work_duration − final_work_duration).
   * Format: "HH:mm:ss".  "00:00:00" when no break is recorded or when the
   * aggregation job has not yet run (totalWorkMins still null).
   */
  break_duration: string;

  /** Always "00:00:00" — no paid-break policy is configured. */
  paid_break: string;

  /** Always "00:00:00" — paid/unpaid break split is not tracked. */
  unpaid_break: string;

  /**
   * Net work duration after subtracting break: AttendanceDaily.totalWorkMins × 60 secs.
   * Format: "HH:mm:ss".
   * Empty string "" on inactive days; "00:00:00" on present days without clock-out.
   */
  final_work_duration: string;

  /**
   * Raw elapsed time from first_clockin to first_clockout.
   * Format: "HH:mm:ss".
   * Empty string "" on inactive days; "00:00:00" on present days without clock-out.
   */
  total_work_duration: string;

  /** Always "" — no short-leave duration tracking in this deployment. */
  short_leave_duration: string;

  /**
   * Overtime worked on this day, from AttendanceDaily.overtimeMins.
   * Format: "HH:mm:ss" when overtimeMins > 0; "" otherwise.
   */
  overtime: string;

  /**
   * Lateness duration (clock-in time minus expected start plus grace period).
   * Format: "HH:mm:ss" when lateByMins > 0; "" otherwise.
   * Sourced from AttendanceDaily.lateByMins (set by the aggregation worker).
   */
  late_mark: string;

  /**
   * Early departure duration (expected shift end minus actual clock-out).
   * Format: "HH:mm:ss" when the employee clocked out before the shift end; "" otherwise.
   * Not applicable for overnight shifts.
   */
  early_out: string;

  /**
   * Time-only component of the first clock-in: "HH:mm:ss" UTC.
   * Mirrors the time portion of clock_in.
   * Empty string "" when no clock-in was recorded.
   */
  first_clockin: string;

  /**
   * Time-only component of the last clock-out: "HH:mm:ss" UTC.
   * Mirrors the time portion of clock_out.
   * Empty string "" when no clock-out was recorded.
   */
  first_clockout: string;

  /**
   * Exactly one status badge classifying this day.
   * Array always has exactly one element (never empty, never multi-badge
   * in this deployment).  Typed as array for Darwinbox wire compatibility.
   */
  attendance_status: DWLogStatusBadge[];

  /**
   * Pending attendance-correction request entries for this day.
   * Always empty in this deployment — no inline correction workflow.
   */
  request_status: never[];

  /**
   * Resolved geofence location name from AttendanceDaily.payload.currentLocationContext.name.
   * Empty string "" when no location was resolved (GPS disabled or no match).
   */
  location: string;

  /**
   * Timesheet fill status: "Not Filled" on present days; "" on inactive days.
   * Hardcoded — no timesheet module is integrated in this deployment.
   */
  timesheet_status: string;

  /** Always "" — timesheet duration is not tracked in this deployment. */
  timesheet_duration: string;

  /**
   * Row-level permission and feature-flag toggles.
   * ot_journal_enable and att_register_enable are 1 on present days only.
   */
  actions: DWLogActionsBlock;

  /**
   * Active shift card and policy snapshot for this calendar day.
   * Sourced from daily.shift (present days) or from the pre-queried
   * ShiftAssignment (inactive days) so inactive cells still render
   * the employee's expected schedule context.
   */
  user_attendance_details: DWUserAttendanceDetails;

  /** 1 when the linked shift definition has isOvernight = true; 0 otherwise. */
  is_overnight: 0 | 1;

  /** Always "" — work purpose is not tracked in this deployment. */
  purpose: string;

  /**
   * Total present-day count across the entire requested window.
   * A working day is present if AttendanceDaily.firstClockIn is not null
   * and the day is not classified as leave.
   */
  present_count: number;

  /**
   * Total absent-day count across the entire requested window.
   * A working day is absent if it has no clock-in, no approved leave,
   * and is not a public holiday or weekend day.
   */
  absent_count: number;

  /**
   * Total approved leave-day count (non-unpaid) across the window.
   * Days with an UNPAID-type leave request are counted in unpaid_count instead.
   */
  leave_count: number;

  /**
   * Total approved UNPAID leave-day count across the window.
   * Separated from leave_count to match Darwinbox's unpaid-leave accounting.
   */
  unpaid_count: number;

  /** Always null — correction request linkage not used in this deployment. */
  request_id: null;

  /**
   * 14-char hex slice of AttendanceDaily.id (hyphens stripped).
   * Empty string "" when no AttendanceDaily row exists for this date.
   */
  log_id: string;

  /**
   * 1 when a ShiftAssignment exists for this employee (even on non-working
   * days — the attendance policy still applies); 0 when no assignment exists.
   */
  is_policy_applicable: 0 | 1;

  /** Always "" — status append logic is not used in this deployment. */
  append_to_status: string;

  /** Always "" — manager comments are tracked in the correction workflow, not here. */
  manager_comment: string;

  /**
   * Work-transfer entries for this day.
   * Always empty — work-transfer module is not integrated.
   */
  work_transfer_details: never[];

  /**
   * 1 when this calendar date falls on a mandatory public holiday for the
   * employee's country code.  Independent of whether the employee clocked in
   * (an employee may clock in on a holiday — is_holiday still = 1).
   */
  is_holiday: 0 | 1;

  /**
   * 1 when this calendar date is a weekend day per the employee's shift
   * definition and is NOT a public holiday (holidays take precedence).
   */
  is_weekoff: 0 | 1;

  /**
   * 1 when an approved LeaveRequest covers this date.
   * Set regardless of leave type — check leave_count / unpaid_count for
   * the breakdown between paid and unpaid leave.
   */
  is_leave: 0 | 1;
}

/**
 * Root response envelope for GetAttendanceLog.
 *
 * `logs` is a Record keyed by ISO-8601 date strings ("YYYY-MM-DD"), containing
 * one DWDayLogLedgerEntry per calendar day in the requested window.
 * Every date in the window is present — no dates are skipped.
 */
export interface GetAttendanceLogResponse {
  status: 1;
  data: {
    logs: Record<string, DWDayLogLedgerEntry>;
  };
}

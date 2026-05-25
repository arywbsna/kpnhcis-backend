// =============================================================================
// attendance-overview.types.ts
//
// Wire-format interfaces for POST /attendance/attendanceAPI/GetAttendanceOverview.
//
// This endpoint implements the Darwinbox DW-wire "time-series analytics"
// variant of the attendance overview, producing a day-by-day breakdown
// (`details`) and a consolidated `overall_summary` across the requested
// window.  It replaces the simpler monthly widget that returned aggregate
// counters only.
//
// Design notes:
//   — `present_days`, `absent_days`, `leave_days`, `is_non_working_day` are
//     typed as `0 | 1` per day (the legacy Darwinbox integer-boolean encoding).
//     At the overall_summary level they accumulate to plain `number`.
//   — Duration strings use "HH:mm:ss" within per-day summaries (always
//     zero-padded) and "H:mm:ss" in overall_summary fields that may exceed
//     24 hours (total_work_duration) or where the legacy wire omits the
//     leading zero on the hours component (avg_work_duration).
//   — `non_working_duration` in DWDaySummary intentionally uses "H:mm:ss"
//     (no leading zero) to match the observed Darwinbox wire output.
// =============================================================================

/**
 * Per-day attendance summary populated for every calendar date in the
 * requested window, including weekends and public holidays.
 *
 * Duration fields represent totals for that single day.  Because N=1,
 * `avg_work_duration` equals `total_work_duration` and `avg_late_by` equals
 * the measured late-by value for that day.
 *
 * Integer-boolean fields (`is_non_working_day`, `present_days`, `absent_days`,
 * `leave_days`) carry exactly `0` or `1` — never a JS boolean — to preserve
 * the Darwinbox legacy numeric wire contract.
 */
export interface DWDaySummary {
  present_days:          0 | 1;
  absent_days:           0 | 1;
  leave_days:            0 | 1;
  avg_work_duration:     string;   // "HH:mm:ss" — equals total_work_duration for single day
  total_work_duration:   string;   // "HH:mm:ss"
  avg_late_by:           string;   // "HH:mm:ss"
  avg_overtime:          string;   // "HH:mm:ss"
  is_non_working_day:    0 | 1;
  non_working_duration:  string;   // "H:mm:ss" no leading zero (Darwinbox legacy quirk)
  total_absent_duration: string;   // "HH:mm:ss" — scheduled shift duration when absent
}

/**
 * A single entry in the `details` array.
 * `title` carries the calendar date as "YYYY-MM-DD".
 */
export interface DWDayOverviewEntry {
  title:   string;
  summary: DWDaySummary;
}

/**
 * Consolidated aggregate across all days in the requested window.
 *
 * Averages are computed over PRESENT days only (work duration, overtime)
 * or over all non-holiday working days (late_by).  Both avg fields are
 * truncated to the nearest minute before serialisation so the wire format
 * matches the Darwinbox legacy rounding behaviour.
 *
 * `total_work_duration` may exceed 24 hours for multi-day windows and is
 * serialised without a leading zero on the hours component ("36:45:44").
 * All other duration fields are zero-padded ("00:00:00").
 */
export interface DWOverallSummary {
  present_days:        number;
  absent_days:         number;
  leave_days:          number;
  total_work_duration: string;   // "H:mm:ss" — may exceed 24 hours, no leading zero
  avg_work_duration:   string;   // "H:mm:ss" — truncated to nearest minute
  total_late_by:       string;   // "HH:mm:ss"
  avg_late_by:         string;   // "HH:mm:ss" — truncated to nearest minute
  avg_overtime:        string;   // "HH:mm:ss"
  total_overtime:      string;   // "HH:mm:ss"
}

export interface GetAttendanceOverviewData {
  details:         DWDayOverviewEntry[];
  overall_summary: DWOverallSummary;
}

export interface GetAttendanceOverviewResponse {
  status: 1;
  data:   GetAttendanceOverviewData;
}

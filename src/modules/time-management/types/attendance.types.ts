// =============================================================================
// attendance.types.ts
//
// Strict TypeScript interfaces for the 5 Attendance API wire-format responses.
// Each interface mirrors the exact JSON shape the Vue 3 / Quasar frontend
// expects, following the Darwinbox envelope convention used in the rest of
// this backend (status: 1, data nested under a domain key).
//
// No `any` types are used.  Fields that may legitimately be absent (e.g. a day
// with no clock-in) are typed as `string | null` or `number | null`.
// =============================================================================

import type {
  AttendanceDayStatus,
  CalendarDayType,
  DeviceInfo,
  ShiftWindowSnapshot,
} from './shared.types';

// ─── 1. GetAttendanceDetails ──────────────────────────────────────────────────

/**
 * A single day's timesheet record inside the GetAttendanceDetails response.
 * One entry per calendar day in the requested period.
 */
export interface AttendanceTimeRecord {
  attendance_id:    string;
  attendance_date:  string;            // "YYYY-MM-DD"
  day_type:         CalendarDayType;
  shift:            ShiftWindowSnapshot | null;
  clock_in:         string | null;     // "HH:MM:SS" local time, null if no record
  clock_out:        string | null;
  total_work_hours: string;            // "HH:MM"
  is_late:          boolean;
  late_by:          string;            // "00:00" when not late
  overtime:         string;            // "00:00" when no overtime
  status:           AttendanceDayStatus;
  location:         string;            // resolved branch/office name or ""
}

export interface AttendancePeriodSummary {
  total_working_days:   number;
  total_present:        number;
  total_absent:         number;
  total_late:           number;
  total_leave:          number;
  total_overtime_hours: string;   // "HH:MM"
}

export interface AttendanceDetailsEnvelope {
  status:          1;
  attendance_data: AttendanceTimeRecord[];
  summary:         AttendancePeriodSummary;
}

// ─── 2. GetAttendancePoliciesDetails ─────────────────────────────────────────

export type PolicyRuleType =
  | 'GRACE'
  | 'OVERTIME'
  | 'EARLYOUT'
  | 'ABSENT_CUTOFF';

/**
 * A single rule inside an attendance policy shift binding.
 * Rules are stored in ShiftDefinition.payload and surfaced verbatim.
 */
export interface ShiftPolicyRule {
  rule_type:      PolicyRuleType;
  threshold_mins: number;
  action:         string;       // e.g. "MARK_LATE", "MARK_ABSENT", "CAP_OVERTIME"
  description:    string;
}

export interface AttendancePolicySnapshot {
  policy_id:         string;
  policy_name:       string;
  shift:             ShiftWindowSnapshot;
  rules:             ShiftPolicyRule[];
  effective_from:    string;          // "YYYY-MM-DD"
  effective_to:      string | null;
  overtime_eligible: boolean;
  weekend_days:      number[];        // 0=Sun … 6=Sat
}

export interface AttendancePoliciesDetailsResponse {
  status:       1;
  policies_data: AttendancePolicySnapshot[];
}

// ─── 3. GetAttendanceOverview ─────────────────────────────────────────────────

export interface AttendanceMonthlyMetric {
  label:      string;
  value:      number;
  percentage: number;   // 0–100, rounded to 1dp
  color:      string;   // hex
}

export interface AttendanceTrendPoint {
  date:       string;             // "YYYY-MM-DD"
  status:     AttendanceDayStatus;
  work_hours: string;             // "HH:MM"
}

export interface AttendanceOverviewMetrics {
  present:  AttendanceMonthlyMetric;
  absent:   AttendanceMonthlyMetric;
  late:     AttendanceMonthlyMetric;
  leave:    AttendanceMonthlyMetric;
  weekoff:  AttendanceMonthlyMetric;
  holiday:  AttendanceMonthlyMetric;
}

export interface AttendanceOverviewData {
  month:              string;   // "January"
  year:               number;
  total_working_days: number;
  metrics:            AttendanceOverviewMetrics;
  trend_data:         AttendanceTrendPoint[];
}

export interface AttendanceOverviewResponse {
  status:        1;
  overview_data: AttendanceOverviewData;
}

// ─── 4. getDayStatus ─────────────────────────────────────────────────────────

/**
 * The attendance sub-record embedded in DayStatusCell.
 * Present only when an AttendanceDaily row exists for the date; null otherwise.
 */
export interface DayAttendanceRecord {
  exists:    true;
  status:    AttendanceDayStatus;
  clock_in:  string | null;
  clock_out: string | null;
}

export interface DayNoAttendanceRecord {
  exists: false;
}

export interface DayStatusCell {
  date:               string;                              // "YYYY-MM-DD"
  day_type:           CalendarDayType;
  label:              string;                              // "Working Day", "National Holiday", etc.
  holiday_name:       string | null;
  shift_applicable:   boolean;
  attendance_record:  DayAttendanceRecord | DayNoAttendanceRecord;
}

export interface DayStatusResponse {
  status:   1;
  day_data: DayStatusCell;
}

// ─── 5. GetAttendanceLog ─────────────────────────────────────────────────────

export type AttendanceLogSource    = 'BIOMETRIC' | 'MOBILE_GPS' | 'WEB';
export type AttendanceLogEventType = 'clock_in'  | 'clock_out';

/**
 * A single raw biometric / GPS / web tap event in the log stream.
 */
export interface AttendanceLogEvent {
  log_id:            string;
  event_type:        AttendanceLogEventType;
  source:            AttendanceLogSource;
  logged_at:         string;           // ISO 8601 UTC
  latitude:          number | null;
  longitude:         number | null;
  resolved_location: string | null;
  geofence_matched:  boolean | null;
  device_info:       DeviceInfo;
}

export interface AttendanceLogData {
  attendance_date: string;
  shift:           ShiftWindowSnapshot | null;
  events:          AttendanceLogEvent[];
  total_events:    number;
}

export interface AttendanceLogEnvelope {
  status:   1;
  log_data: AttendanceLogData;
}

// ─── ShiftDefinition JSONB payload shape (read by the service) ───────────────

/**
 * Typed shape of ShiftDefinition.payload JSONB.
 * Stored in the DB; surfaced as ShiftPolicyRule[] in policies responses.
 */
export interface ShiftDefinitionPayload {
  _v:              number;
  rules:           ShiftPolicyRule[];
  overtimeCapMins: number | null;
  absentCutoffMins: number;
}

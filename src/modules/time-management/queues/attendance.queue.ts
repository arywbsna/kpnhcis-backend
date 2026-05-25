// =============================================================================
// attendance.queue.ts
//
// BullMQ queue name, job-name constants, and typed job payload interfaces for
// the two background workers spawned by the clock-event pipeline:
//
//   ANTI_FRAUD_SCAN          — near-realtime risk scoring per tap event.
//   DAILY_SUMMARY_AGGREGATE  — end-of-shift aggregation that closes the daily
//                              record, computes work hours, and updates payroll
//                              integration flags.
//
// Both consumers are implemented in a separate processor (not generated here)
// and registered in TimeManagementModule as a BullMQ Processor decorated with
// @Processor(ATTENDANCE_QUEUE).
// =============================================================================

export const ATTENDANCE_QUEUE = 'attendance' as const;

// ─── Job name registry ────────────────────────────────────────────────────────

export const AttendanceJobName = {
  ANTI_FRAUD_SCAN:         'anti-fraud-scan',
  DAILY_SUMMARY_AGGREGATE: 'daily-summary-aggregate',
} as const;

export type AttendanceJobName =
  (typeof AttendanceJobName)[keyof typeof AttendanceJobName];

// ─── Job payload interfaces ───────────────────────────────────────────────────

/**
 * Payload dispatched immediately after each accepted clock-in/out event.
 *
 * The fraud worker scores:
 *   — GPS speed anomaly (distance / time since last tap)
 *   — Device spoofing signals (mock location flags in deviceInfo)
 *   — IP address cross-region mismatch
 *   — Duplicate tap within a configurable debounce window
 *
 * If the score exceeds the configured threshold the worker sets
 * AttendanceLog.payload.antiFraudFlags and optionally suspends the
 * AttendanceDaily row pending manual HR review.
 */
export interface AntiFraudScanPayload {
  logId:           string;   // AttendanceLog.id
  dailyId:         string;   // AttendanceDaily.id
  userId:          string;
  attendanceDate:  string;   // "YYYY-MM-DD"
  eventType:       'clock_in' | 'clock_out';
  latitude:        number | null;
  longitude:       number | null;
  deviceId:        string | null;
  ipAddress:       string | null;
  loggedAtIso:     string;   // ISO 8601 UTC — used for speed-anomaly delta
}

/**
 * Payload dispatched when a shift window closes (at midnight UTC for standard
 * shifts; at the end of the overnight tail window for cross-midnight shifts).
 *
 * The aggregation worker:
 *   1. Reads all AttendanceLog events for (userId, attendanceDate).
 *   2. Computes firstClockIn, lastClockOut, totalWorkMins.
 *   3. Evaluates late / overtime against the shift's policy rules.
 *   4. Updates AttendanceDaily with the computed values.
 *   5. Writes a payroll-integration flag into AttendanceDaily.payload.
 *   6. Removes the dailySummaryJobId from the payload so re-scheduling is safe.
 */
export interface DailySummaryAggregatePayload {
  userId:         string;
  attendanceDate: string;   // "YYYY-MM-DD"
  dailyId:        string;   // AttendanceDaily.id
  shiftId:        string;   // ShiftDefinition.id — needed to read policy rules
}

// ─── Union type for InjectQueue type-safety at dispatch sites ─────────────────

export type AttendanceJobData =
  | { name: typeof AttendanceJobName.ANTI_FRAUD_SCAN;         data: AntiFraudScanPayload }
  | { name: typeof AttendanceJobName.DAILY_SUMMARY_AGGREGATE; data: DailySummaryAggregatePayload };

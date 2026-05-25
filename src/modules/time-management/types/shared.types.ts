// =============================================================================
// shared.types.ts
//
// Primitive domain types shared across both the Attendance and Leaves
// sub-modules.  Kept in a single file so the geofence and shift-window logic
// stays in one canonical location and cannot drift between consumers.
// =============================================================================

// ─── Shift window ─────────────────────────────────────────────────────────────

/**
 * Compact snapshot of a ShiftDefinition row embedded in attendance responses.
 * Contains only the fields the frontend needs for display + overnight logic.
 */
export interface ShiftWindowSnapshot {
  shift_id:          string;
  shift_name:        string;
  shift_code:        string;
  shift_start:       string;   // "HH:MM" 24h
  shift_end:         string;   // "HH:MM" 24h
  is_overnight:      boolean;
  grace_period_mins: number;
  overtime_eligible: boolean;
}

// ─── Geofence pool ────────────────────────────────────────────────────────────

/**
 * Source tag explaining why a location is in the employee's allowed pool.
 *   standard_schedule — the employee's regular branch/office from their shift assignment
 *   branch_assignment — a temporary branch override active for this date
 *   business_trip     — an approved dinas-luar / travel record active for this date
 */
export type AllowedLocationSource =
  | 'standard_schedule'
  | 'branch_assignment'
  | 'business_trip';

/**
 * A single entry in the mobility-safe geofence pool.
 * The pipeline calls intersectGeofencePool() against every entry using the
 * Haversine formula; the first intersection wins (pool is ordered by priority:
 * standard_schedule < branch_assignment < business_trip so override sources
 * take precedence).
 */
export interface AllowedLocation {
  location_id:   string;
  name:          string;
  latitude:      number;
  longitude:     number;
  radius_meters: number;
  source:        AllowedLocationSource;
}

/**
 * The current-location context persisted inside AttendanceDaily.payload.
 * Updated in-place every time a clock event is accepted inside a geofence.
 */
export interface CurrentLocationContext {
  location_id:   string;
  name:          string;
  latitude:      number;
  longitude:     number;
  source:        AllowedLocationSource;
  accepted_at:   string;   // ISO 8601
}

// ─── AttendanceDaily JSONB payload shape ──────────────────────────────────────

/**
 * Typed interface for the `payload` JSONB column on the `attendance_daily`
 * table.  Versioned with `_v` so upgrade migrations can detect and backfill
 * old rows.
 */
export interface AttendanceDailyPayload {
  _v:                     number;
  currentLocationContext: CurrentLocationContext | null;
  allowedLocationsPool:   AllowedLocation[];
  dailySummaryJobId:      string | null;
}

// ─── AttendanceLog JSONB payload shape ────────────────────────────────────────

export interface DeviceInfo {
  device_id:   string | null;
  device_type: string | null;
  os_version:  string | null;
  app_version: string | null;
}

export interface AttendanceLogPayload {
  _v:             number;
  deviceInfo:     DeviceInfo;
  ipAddress:      string | null;
  antiFraudFlags: string[];
}

// ─── Day classification ────────────────────────────────────────────────────────

export type CalendarDayType =
  | 'WORKING_DAY'
  | 'WEEKOFF'
  | 'PUBLIC_HOLIDAY'
  | 'REST_DAY';

export type AttendanceDayStatus =
  | 'Present'
  | 'Absent'
  | 'Late'
  | 'Leave'
  | 'Weekoff'
  | 'Holiday'
  | 'Rest Day';

// ─── Resolved shift-date result ───────────────────────────────────────────────

/**
 * Return type from resolveShiftDate().
 * The `resolvedDate` is always the operational calendar date — for overnight
 * shifts a 23:00 clock-in on day N resolves to N, not N+1.
 */
export interface ResolvedShiftDate {
  resolvedDate:   Date;
  shift:          ShiftWindowSnapshot;
  isOvernightTail: boolean;   // true when the clock time falls in the next-day tail window
}

// ─── LeaveBalance JSONB payload shape ─────────────────────────────────────────

export interface LeaveBalancePayload {
  _v:                  number;
  expiryDate:          string | null;       // "YYYY-MM-DD"
  color:               string;              // hex, e.g. "#4CAF50"
  allowHalfDay:        boolean;
  requiresDocument:    boolean;
  documentTypes:       string[];
  genderConstraint:    'male' | 'female' | null;
  maxConsecutiveDays:  number | null;
  minAdvanceDays:      number;
  encashable:          boolean;
  carryoverDays:       number;
}

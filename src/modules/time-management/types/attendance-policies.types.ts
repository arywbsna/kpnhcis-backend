// =============================================================================
// attendance-policies.types.ts
//
// Strict TypeScript interfaces for the exact wire-format envelope returned by
// POST /attendance/attendanceAPI/GetAttendancePoliciesDetails.
//
// Wire contract summary:
// {
//   "status": 1,
//   "data": {
//     "geo_fencing":        Record<string, DWGeofenceEntry>,   // keyed by 14-char hex
//     "attendance_policy":  DWPolicyEnvelope,
//     "overtime_policy":    DWOvertimePolicy,
//     "tenant_shift":       DWTenantShift,
//     "weeklyoff_details":  string,                            // "(All Saturday, All Sunday)"
//     "pay_group":          DWPayGroup,
//     "month_to_select":    string,                            // "May 2026"
//     "cycle_start":        string,                            // "YYYY-MM-DD"
//     "cycle_end":          string                             // "YYYY-MM-DD"
//   }
// }
//
// Zero `any` types.  Numeric booleans (is_enabled) use `0 | 1` to match the
// legacy Darwinbox wire format — the Vue 3 frontend does strict equality checks.
// =============================================================================

// ─── Geo-fencing ──────────────────────────────────────────────────────────────

/**
 * A single geofence location entry in the dynamic hash map.
 * `latt` and `long` match Darwinbox's legacy misspelling — the frontend binds
 * these exact keys so they cannot be renamed.
 */
export interface DWGeofenceEntry {
  label:    string;
  long:     number;
  latt:     number;
  distance: number;   // radius in metres
}

/**
 * Dynamic hash map of geofence locations keyed by 14-char hex strings
 * derived from the AllowedLocation location_id UUIDs.
 *
 * The key format mirrors the shift-id short-hex convention used elsewhere in
 * the module (UUID stripped of dashes, first 14 characters lowercased).
 */
export type DWGeofenceConfig = Record<string, DWGeofenceEntry>;

// ─── Attendance policy ────────────────────────────────────────────────────────

/**
 * Scalar policy configuration values stored in ShiftDefinition.payload.
 * Rendered as both a typed data object (for frontend logic) and a display
 * table (for the policy summary card).
 */
export interface DWPolicyData {
  policy_id:              string;
  policy_name:            string;
  late_grace_time:        number;    // minutes
  early_grace_time:       number;    // minutes
  backdated_restriction:  number;    // calendar days
  allowed_request:        string[];  // e.g. ["Clock In Request", "Clock Out Request"]
}

/** Column header for both the policy table and OT table. */
export interface DWPolicyTableHeader {
  key:   string;
  title: string;
}

/**
 * A single display row in the policy summary table.
 * `highlight_code` is an optional CSS class / colour token from the legacy
 * Darwinbox UI; empty string when no highlight is needed.
 */
export interface DWPolicyRow {
  key:            string;
  attribute:      string;
  value:          string;
  highlight_code: string;
}

/** Full attendance policy card: data object + QTable headers + QTable rows. */
export interface DWPolicyEnvelope {
  policy_data:   DWPolicyData;
  table_headers: DWPolicyTableHeader[];
  table_body:    DWPolicyRow[];
}

// ─── Overtime policy ──────────────────────────────────────────────────────────

/**
 * A single overtime calculation tier row (Weekday / Weekly Off / Holiday).
 * `highlight_code` follows the same convention as DWPolicyRow.
 */
export interface DWOvertimeTableRow {
  day_type:         string;   // "Weekday" | "Weekly Off" | "Holiday"
  calculation_rule: string;   // human-readable tier description
  highlight_code:   string;
}

/**
 * Overtime policy card returned alongside the attendance policy card.
 * `is_enabled` uses `0 | 1` (not boolean) per the Darwinbox wire spec.
 */
export interface DWOvertimePolicy {
  policy_id:     string;
  policy_name:   string;
  is_enabled:    0 | 1;
  table_headers: DWPolicyTableHeader[];
  table_body:    DWOvertimeTableRow[];
}

// ─── Tenant shift card ────────────────────────────────────────────────────────

/**
 * Condensed shift summary embedded in the policies response.
 * Subset of DWShiftDetails — only the identity and time fields are needed here.
 */
export interface DWTenantShift {
  shift_id:   string;   // short 14-char hex from ShiftDefinition UUID
  shift_name: string;
  begin_time: string;   // "HH:MM:SS"
  end_time:   string;   // "HH:MM:SS"
}

// ─── Pay group ────────────────────────────────────────────────────────────────

/**
 * Pay group the employee belongs to.  Derived from ShiftAssignment.payload or
 * falls back to a synthetic "Default Pay Group" when not configured.
 */
export interface DWPayGroup {
  group_id:   string;
  group_name: string;
}

// ─── Root response ────────────────────────────────────────────────────────────

export interface GetAttendancePoliciesData {
  geo_fencing:       DWGeofenceConfig;
  attendance_policy: DWPolicyEnvelope;
  overtime_policy:   DWOvertimePolicy;
  tenant_shift:      DWTenantShift;
  weeklyoff_details: string;    // "(All Saturday, All Sunday)"
  pay_group:         DWPayGroup;
  month_to_select:   string;    // "May 2026"
  cycle_start:       string;    // "YYYY-MM-DD"
  cycle_end:         string;    // "YYYY-MM-DD"
}

export interface GetAttendancePoliciesResponse {
  status: 1;
  data:   GetAttendancePoliciesData;
}

// ─── ShiftDefinition JSONB payload — extended view for this endpoint ──────────

/**
 * Extended view of ShiftDefinition.payload specific to the policies endpoint.
 * Extends the base payload shape with policy-level fields stored by HR config.
 *
 * `overtimeCalculationTiers` encodes the OT tier table rows so the service
 * can surface them without maintaining a separate DB table.
 */
export interface OvertimeCalculationTier {
  day_type:         'Weekday' | 'Weekly Off' | 'Holiday';
  calculation_rule: string;
}

export interface ShiftDefinitionPoliciesPayload {
  _v:                          number;
  lateGraceMinutes?:           number;
  earlyGraceMinutes?:          number;
  backdatedRestrictionDays?:   number;
  allowedRequestTypes?:        string[];
  overtimeCalculationTiers?:   OvertimeCalculationTier[];
  overtimePolicyId?:           string;
  overtimePolicyName?:         string;
  overtimeEnabled?:            boolean;
}

/**
 * Typed view of ShiftAssignment.payload fields relevant to the policies
 * response: pay group binding and cycle dates.
 */
export interface ShiftAssignmentPoliciesPayload {
  payGroup?: {
    group_id:   string;
    group_name: string;
  };
  cycleStartDay?: number;   // day-of-month (1–28) the pay cycle starts
}

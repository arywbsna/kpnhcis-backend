// =============================================================================
// attendance-details.types.ts
//
// Strict TypeScript interfaces for the exact wire-format envelope returned by
// POST /attendance/attendanceAPI/GetAttendanceDetails.
//
// This endpoint acts as a context-bootstrap call — the frontend fetches it on
// page mount to hydrate:
//   1. The employee's currently active shift card (begin/end times, overnight
//      flag, total hours, resolved office location).
//   2. The DataTable column definition headers that drive the Quasar QTable.
//   3. The overtime approval reason catalogue used to annotate OT requests.
//
// Wire contract (must match exactly):
// {
//   "status": 1,
//   "data": {
//     "shift": { ... },
//     "columns": [ { "key": "...", "title": "..." }, ... ],
//     "overtime_approval_reasons": []
//   }
// }
//
// Zero `any` types.  Fields that Darwinbox encodes as numeric booleans
// (is_overnight, is_null_shift) are typed as `0 | 1` — not `boolean` — to
// match the legacy wire format precisely.
// =============================================================================

// ─── Overtime approval reasons ────────────────────────────────────────────────

/**
 * A single selectable reason for an overtime approval request.
 * Stored in ShiftDefinition.payload.overtimeApprovalReasons[] and returned
 * verbatim so the frontend can populate the OT reason dropdown.
 *
 * The array is empty when the organisation has not configured any OT reasons
 * (the most common case during initial roll-out).
 */
export interface OvertimeApprovalReason {
  id:    string;
  label: string;
}

// ─── Shift details card ───────────────────────────────────────────────────────

/**
 * Active shift context for the target employee on the requested date.
 *
 * Numeric boolean fields (is_overnight, is_null_shift) use `0 | 1` instead
 * of `boolean` because the Darwinbox legacy wire format uses integers, and
 * the Vue 3 frontend performs strict equality checks against 0 / 1.
 *
 * When no shift assignment exists the service returns a null-shift sentinel
 * with is_null_shift = 1 and zeroed time fields, so the frontend can render
 * a "No Shift Assigned" card without special-casing undefined.
 */
export interface DWShiftDetails {
  /** Short hex identifier derived from the ShiftDefinition UUID (first 11 chars, no dashes). */
  id:                string;

  /** Human-readable shift name as stored in ShiftDefinition.name, e.g. "08:00 - 17:00 flexi". */
  shift_name:        string;

  /** Shift start time in "HH:MM:SS" format (seconds always "00" for schema-stored "HH:MM"). */
  begin_time:        string;

  /** Shift end time in "HH:MM:SS" format. */
  end_time:          string;

  /** Alias for begin_time — both fields are required by the legacy wire spec. */
  begin_time_string: string;

  /** Alias for end_time — both fields are required by the legacy wire spec. */
  end_time_string:   string;

  /**
   * Gross shift duration as a human-readable string, e.g. "09:00 hours".
   * Computed as (end - start) with midnight wraparound for overnight shifts.
   * Does not deduct break time — that is handled by the daily aggregation worker.
   */
  total_hours:       string;

  /** 1 when the shift crosses midnight (e.g. 22:00 → 06:00), 0 otherwise. */
  is_overnight:      0 | 1;

  /**
   * Resolved office / branch name for this shift.
   * Resolution order:
   *   1. ShiftAssignment.payload.standardLocation.name
   *   2. ShiftDefinition.payload.location
   *   3. Empty string when neither source is configured.
   */
  location:          string;

  /** 1 when no shift assignment exists for the target employee on the effective date. */
  is_null_shift:     0 | 1;
}

// ─── DataTable column header ──────────────────────────────────────────────────

/**
 * A single column definition in the QTable column config array.
 *
 * `key`   — the field name the frontend binds to when rendering each row cell.
 * `title` — the human-readable column header label rendered in the table head.
 *
 * The columns array is static across all employees and organisations.
 * It is externalised as ATTENDANCE_DETAILS_COLUMNS at module level in the
 * service so it is only allocated once per process, not per request.
 */
export interface DWTableColumn {
  key:   string;
  title: string;
}

// ─── Response envelope ────────────────────────────────────────────────────────

export interface GetAttendanceDetailsData {
  shift:                     DWShiftDetails;
  columns:                   DWTableColumn[];
  overtime_approval_reasons: OvertimeApprovalReason[];
}

export interface GetAttendanceDetailsResponse {
  status: 1;
  data:   GetAttendanceDetailsData;
}

// ─── ShiftDefinition JSONB payload — extended view for this endpoint ──────────

/**
 * Extended view of the ShiftDefinition.payload JSONB column for fields that
 * are specific to the GetAttendanceDetails response:
 *   overtimeApprovalReasons — populated by HR configuration flows
 *   flexiGraceMinutes       — per-shift flexi window overriding global grace
 *   location                — fallback office name when assignment has no standard location
 *
 * This interface is intentionally local to this endpoint's type file so the
 * base ShiftDefinitionPayload in attendance.types.ts stays minimal.
 */
export interface ShiftDefinitionDetailPayload {
  _v:                       number;
  overtimeApprovalReasons?: OvertimeApprovalReason[];
  flexiGraceMinutes?:        number;
  location?:                 string;
}

// ─── ShiftAssignment JSONB payload — location extraction view ─────────────────

/**
 * Typed view of the relevant slice of ShiftAssignment.payload used during
 * location resolution.  The full payload may contain additional branch override
 * and dinas-luar entries managed by the geofencing pipeline.
 */
export interface ShiftAssignmentLocationPayload {
  standardLocation?: {
    location_id:   string;
    name:          string;
    latitude:      number;
    longitude:     number;
    radius_meters: number;
  };
}

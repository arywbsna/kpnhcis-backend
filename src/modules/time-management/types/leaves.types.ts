// =============================================================================
// leaves.types.ts
//
// Strict TypeScript interfaces for the 5 Leaves API wire-format responses.
// Mirrors the Darwinbox envelope convention: status: 1 at root, domain data
// nested under a descriptive key.  No `any` types.
// =============================================================================

import type { LeaveRequestStatus, LeaveType } from '@prisma/client';

// ─── 1. GetLeaveCommonDetails ─────────────────────────────────────────────────

/**
 * Per-leave-type structural configuration.
 * Consumed by the frontend to build the leave-request form dynamically.
 */
export interface LeaveTypeConfig {
  leave_type_id:        LeaveType;
  leave_type_name:      string;
  gender_constraint:    'male' | 'female' | null;
  max_days_per_year:    number;
  max_consecutive_days: number | null;
  min_advance_days:     number;
  requires_document:    boolean;
  document_types:       string[];
  allow_half_day:       boolean;
  carryover_days:       number;
  encashable:           boolean;
  is_active:            boolean;
  color:                string;   // hex
}

/**
 * Organisation-level leave policy constants.
 * These apply to all employees and all leave types uniformly.
 */
export interface GlobalLeavePolicy {
  leave_year_start:          string;   // "MM-DD" e.g. "01-01"
  leave_year_end:            string;   // "MM-DD" e.g. "12-31"
  allow_negative_balance:    boolean;
  max_backdate_days:         number;
  announcement_period_days:  number;
}

export interface LeaveCommonDetailsData {
  leave_types:   LeaveTypeConfig[];
  global_policy: GlobalLeavePolicy;
}

export interface LeaveCommonDetailsResponse {
  status:         1;
  common_details: LeaveCommonDetailsData;
}

// ─── 2. getUpcomingTimeOff ────────────────────────────────────────────────────

/**
 * A single upcoming time-off entry in the employee's personal timeline.
 * Includes both PENDING_APPROVAL and APPROVED records so the calendar
 * can render tentative blocks alongside confirmed ones.
 */
export interface UpcomingTimeOffEntry {
  request_id:    string;
  leave_type:    string;           // human-readable, e.g. "Annual Leave"
  leave_type_id: LeaveType;
  start_date:    string;           // "YYYY-MM-DD"
  end_date:      string;
  total_days:    number;
  status:        LeaveRequestStatus;
  status_label:  string;           // "Approved", "Pending Approval", etc.
  reason:        string;
  submitted_at:  string | null;    // ISO 8601
}

export interface UpcomingTimeOffResponse {
  status:           1;
  upcoming_time_off: UpcomingTimeOffEntry[];
  total:            number;
}

// ─── 3. getTeamStatus ────────────────────────────────────────────────────────

/**
 * Relationship of a team member to the requesting employee.
 *   direct_report — immediate subordinate (User.subordinates)
 *   peer          — same unit, same reporting manager
 */
export type TeamMemberRelationship = 'direct_report' | 'peer';

/**
 * A single team member who is currently out-of-office.
 */
export interface TeamOutOfOfficeEntry {
  employee_id:    string;
  employee_name:  string;
  avatar_url:     string | null;
  leave_type:     string;          // human-readable
  leave_till_date: string;         // "YYYY-MM-DD"
  relationship:   TeamMemberRelationship;
}

export interface TeamStatusData {
  date:             string;                 // "YYYY-MM-DD" — the evaluated date
  out_of_office:    TeamOutOfOfficeEntry[];
  total_out:        number;
  total_team_members: number;
}

export interface TeamStatusResponse {
  status:      1;
  team_status: TeamStatusData;
}

// ─── 4. GetDataForLeavePattern ────────────────────────────────────────────────

/**
 * A duration option surfaced in the leave-request form when the employee
 * selects a leave type that supports fractional days.
 */
export interface LeaveDurationOption {
  value: 'full_day' | 'half_day_am' | 'half_day_pm';
  label: string;
}

export interface LeaveDateRangeOptions {
  min_date:            string;    // "YYYY-MM-DD" — today or advance_notice cutoff
  max_date:            string;    // "YYYY-MM-DD" — end of leave year
  blackout_dates:      string[];  // public holidays within the window
  max_selection_days:  number | null;
}

export interface LeaveHandoverItem {
  item_id:  string;
  label:    string;
  required: boolean;
}

export interface LeavePatternData {
  leave_type_id:        LeaveType;
  duration_options:     LeaveDurationOption[];
  date_range_options:   LeaveDateRangeOptions;
  attachments_required: boolean;
  attachment_types:     string[];
  require_reason:       boolean;
  delegate_required:    boolean;
  handover_checklist:   LeaveHandoverItem[];
}

export interface LeavePatternDataResponse {
  status:       1;
  pattern_data: LeavePatternData;
}

// ─── 5. GetLeaves ─────────────────────────────────────────────────────────────

/**
 * Live remaining balance for one leave category.
 *
 * is_xstate_guard_passing — true when (remaining > 0) AND the leave type
 *   has no unsatisfied constraints (gender, document, active concurrent leave).
 *   This boolean is the canonical guard signal consumed by the XState machine
 *   to enable or disable the "Submit Leave Request" transition.
 */
export interface ViewLeaveBalanceEntry {
  leave_balance_id:        string;
  leave_type_id:           LeaveType;
  leave_type_name:         string;
  leave_type_color:        string;    // hex
  entitled:                number;
  used:                    number;
  pending:                 number;
  carried:                 number;
  remaining:               number;   // entitled + carried - used - pending
  expiry_date:             string | null;
  is_xstate_guard_passing: boolean;
  allow_half_day:          boolean;
}

export interface ViewLeavesBalanceResponse {
  status:         1;
  leave_data:     ViewLeaveBalanceEntry[];
  balance_as_of:  string;   // "YYYY-MM-DD" — snapshot date (today)
}

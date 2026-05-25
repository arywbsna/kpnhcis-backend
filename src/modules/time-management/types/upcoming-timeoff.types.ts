// =============================================================================
// upcoming-timeoff.types.ts
//
// Wire-format interfaces for POST /leaves/leavesApi/getUpcomingTimeOff.
//
// This endpoint hydrates the "Upcoming Time Off / Holidays" timeline widget in
// the Quasar frontend.  It produces a unified, chronologically-sorted feed
// by merging two independent data sources:
//
//   1. PublicHoliday rows where date >= today — classified as "National Holiday".
//   2. APPROVED LeaveRequest rows for the target employee where startDate >= today
//      — classified by leave type display name (e.g. "Annual Leave").
//
// Wire contract (field order matches Darwinbox DW envelope):
// {
//   "data": [
//     {
//       "id":    "a6951ffb12345f",
//       "title": "Idul Adha 1447 Hijriah",
//       "date":  "2026-05-27",
//       "day":   "Wednesday",
//       "type":  "National Holiday"
//     },
//     {
//       "id":    "a695123f0a1234",
//       "title": "Hari Raya Waisak 2570 BE",
//       "date":  "2026-05-31",
//       "day":   "Sunday",
//       "type":  "National Holiday"
//     }
//   ],
//   "status": 1
// }
//
// Design notes:
//   — `id` is a 14-character deterministic hex slice of the source UUID
//     (hyphens stripped, first 14 characters retained), consistent with the
//     key-length convention used throughout this module (leave balance keys,
//     shift ID keys, log_id, policy_id).
//   — `day` is derived from the UTC date via getUTCDay() to guarantee a
//     timezone-agnostic weekday label regardless of the server's local zone.
//   — Entries are ordered by `date` ascending.  When two entries share the
//     same calendar date, "National Holiday" entries sort before personal leave
//     entries for deterministic, stable output.
// =============================================================================

/**
 * A single merged entry in the upcoming time-off / holiday timeline.
 *
 * Represents either a national public holiday or an employee's approved
 * personal leave request starting on or after today.  The `type` field is
 * the primary discriminator the frontend uses to apply different visual
 * treatments (icon, badge colour, striped vs. solid block).
 */
export interface DWUpcomingTimeOffEntry {
  /**
   * 14-character deterministic hex identifier.
   *
   * Derived by stripping hyphens from the source row's UUID and slicing the
   * first 14 characters.  The value is stable across requests for the same
   * underlying PublicHoliday or LeaveRequest row and matches the hex-key
   * convention used for leave balance keys, shift IDs, and attendance log IDs
   * throughout this module.
   */
  id: string;

  /**
   * Human-readable label for the timeline entry.
   *
   * For public holidays: the holiday's stored name as-is
   *   (e.g. "Idul Adha 1447 Hijriah", "Hari Raya Waisak 2570 BE").
   * For personal leaves: the leave type display name
   *   (e.g. "Annual Leave", "Sick Leave").
   */
  title: string;

  /**
   * Calendar date of the event in "YYYY-MM-DD" format (UTC).
   *
   * For public holidays: the holiday's stored date.
   * For personal leaves: the leave request's startDate — the first day of the
   * approved leave block.  Multi-day leaves appear as a single entry anchored
   * to their start date; the timeline widget expands the block client-side.
   */
  date: string;

  /**
   * Full English weekday name corresponding to the event date.
   *
   * Derived from the UTC date using getUTCDay() so the value is immune to
   * server or client timezone shifts (e.g. "Wednesday", "Sunday").
   * Possible values: "Sunday" | "Monday" | "Tuesday" | "Wednesday" |
   *                  "Thursday" | "Friday" | "Saturday".
   */
  day: string;

  /**
   * Category label used by the frontend to select the visual style.
   *
   * "National Holiday" — for PublicHoliday source rows.
   * Leave type display name — for LeaveRequest source rows
   *   (e.g. "Annual Leave", "Sick Leave", "Maternity Leave").
   */
  type: string;
}

export interface GetUpcomingTimeOffResponse {
  data:   DWUpcomingTimeOffEntry[];
  status: 1;
}

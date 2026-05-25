// =============================================================================
// team-status.types.ts
//
// Wire-format interfaces for POST /leaves/leavesApi/getTeamStatus.
//
// This endpoint produces a rolling day-by-day visibility matrix showing which
// members of the requesting user's organizational unit are out-of-office on
// each date in the requested window — either due to a national public holiday
// or an individually approved leave request.
//
// Wire contract:
// {
//   "status": 1,
//   "data": {
//     "2026-05-26": [
//       {
//         "type":  "holiday",
//         "title": "Hari Raya Waisak 2570 BE",
//         "users": [ { "mongo_id": "...", "name_employee_no": "...", ... } ]
//       }
//     ],
//     "2026-05-27": [
//       {
//         "type":  "leave",
//         "title": "Annual Leave",
//         "users": [ { ... } ]
//       }
//     ],
//     "2026-05-28": [
//       { "type": "", "title": "", "users": [] }
//     ]
//   }
// }
//
// Design notes:
//   — `data` is a Record keyed by "YYYY-MM-DD" date strings.  Every day in
//     the requested window is present; no dates are skipped.
//   — Each day maps to an array of DWTeamTimeOffBlock items.  A day with no
//     holiday and no approved leaves emits exactly one sentinel block with
//     `type: ""`, `title: ""`, and `users: []`.
//   — Holiday blocks push every active department member into `users` since
//     everyone is affected by a public holiday.
//   — Leave blocks are grouped by leave type: one block per unique leave type
//     active on that day, with only the affected employees in `users`.
//   — `DWDayTeamStatusEntry` is the typed unit of the day-accumulator used
//     during service-layer processing before the output is indexed into the
//     Record by date string.
// =============================================================================

/**
 * Employee profile snapshot embedded inside each time-off block's `users` array.
 *
 * Contains the full set of legacy tracking fields the Darwinbox frontend
 * expects for every department member appearing in the team visibility matrix.
 * All string fields with fixed enum-like values are typed as `string` (not
 * union literals) because the server-side defaults match a single value per
 * this deployment and the wire spec does not define other valid variants.
 */
export interface DWTeamStatusUserSnapshot {
  /**
   * Hexadecimal identifier for the employee.
   *
   * Resolution order:
   *   1. `user.payload.darwinbox.mongo_id` — the original MongoDB ObjectId
   *      assigned during the Darwinbox profile sync.
   *   2. The internal UUID as a fallback when the JSONB field is absent.
   */
  mongo_id: string;

  /**
   * Composite display label in the format "Full Name (EmployeeNo)".
   * Used by the frontend to render the employee chip inside the calendar block.
   */
  name_employee_no: string;

  /**
   * Relative URL for navigating to the employee's profile page.
   * Format: "/employeeprofile/view/id/{uuid}".
   */
  url: string;

  /** Date display format string; hardcoded to the Darwinbox legacy value "d-m-Y". */
  date_format: string;

  /** Time display format string; hardcoded to "24" (24-hour clock). */
  time_format: string;

  /**
   * Notice period indicator.
   * "No" when the employee is not serving a notice period (default for all
   * active employees in this deployment).
   */
  is_on_notice: string;

  /**
   * Timezone offset and label for the employee's display zone.
   * "+420|Bangkok" corresponds to UTC+7 (WIB / Indochina Time), matching the
   * primary timezone for this deployment's user base.
   */
  display_time_zone: string;

  /**
   * Avatar image URL from `user.payload.avatar_url`.
   * null when no avatar has been uploaded or synced from Darwinbox.
   */
  image: string | null;
}

/**
 * A single time-off block representing one category of absence on a given day.
 *
 * A day may contain multiple blocks (e.g. one holiday block and one leave block
 * when a holiday coincides with a leave type that has approved requests).
 *
 * Discriminator values for `type`:
 *   "holiday" — the entire department is affected by a national public holiday.
 *   "leave"   — a subset of the department has an approved leave of this type.
 *   ""        — sentinel value for days with no absence activity.
 */
export interface DWTeamTimeOffBlock {
  /**
   * Absence category discriminator.
   *   "holiday" — national public holiday block.
   *   "leave"   — approved leave block, grouped by leave type name.
   *   ""        — empty sentinel for days with no activity.
   */
  type: string;

  /**
   * Human-readable label for the block.
   *   Holiday block: the holiday name (e.g. "Hari Raya Waisak 2570 BE").
   *   Leave block:   the leave type display name (e.g. "Annual Leave").
   *   Sentinel:      "" (empty string).
   */
  title: string;

  /**
   * Department members affected by this block.
   *   Holiday block: all active members of the department peer pool.
   *   Leave block:   only the employees with an approved leave of this type.
   *   Sentinel:      [] (empty array).
   */
  users: DWTeamStatusUserSnapshot[];
}

/**
 * The typed accumulator unit for a single calendar day.
 *
 * Used internally by the service during the day-by-day loop before the result
 * is indexed into the `Record<string, DWTeamTimeOffBlock[]>` output map.
 * Carrying the `date` field alongside the `blocks` array avoids index-position
 * tracking errors in the accumulation loop.
 */
export interface DWDayTeamStatusEntry {
  /** Calendar date in "YYYY-MM-DD" format (UTC). */
  date: string;

  /**
   * All time-off blocks for this calendar day.
   * Always contains at least one entry — the empty sentinel block when no
   * holiday or leave activity exists for the day.
   */
  blocks: DWTeamTimeOffBlock[];
}

/**
 * Root response envelope for getTeamStatus.
 *
 * `data` is a Record keyed by ISO-8601 date strings ("YYYY-MM-DD"), covering
 * every calendar day in the requested window without gaps.  Each value is the
 * array of DWTeamTimeOffBlock items for that day.
 */
export interface GetTeamStatusResponse {
  status: 1;
  data:   Record<string, DWTeamTimeOffBlock[]>;
}

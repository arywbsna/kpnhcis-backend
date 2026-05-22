// =============================================================================
// employment-details.types.ts
//
// Strict TypeScript interfaces for the Darwinbox wire format returned by
// GET /Profileapi/ViewEmploymentDetails.
//
// Each employment attribute (designation, job level, contract, etc.) is
// represented as a "section" that contains one or more grid snapshots.  In
// the current implementation every section holds exactly one grid entry —
// the employee's CURRENT assignment — mirroring what Darwinbox returns for
// the active record.
//
// Field shapes vary by section:
//   DWSimpleField     — minimal { label, value }; used by from_to and
//                       office-location sub-fields.
//   DWEmploymentField — extends DWSimpleField with value_alias,
//                       disable_overflow, label_visibility_override, and
//                       optional is_promotion_or_demotion.
//   DWManagerField    — employment field extended with type "user",
//                       profile_url, and image_url for the manager card.
// =============================================================================

// ─── Primitive field shapes ────────────────────────────────────────────────

/** Minimal field — used for from_to and office-location sub-fields. */
export interface DWSimpleField {
  label: string;
  value: string;
}

/** Standard employment field with Darwinbox display metadata. */
export interface DWEmploymentField extends DWSimpleField {
  value_alias:               string;
  disable_overflow:          boolean;
  label_visibility_override: 'show' | 'hide';
  is_promotion_or_demotion?: string;
}

/** Manager card field — extends the standard field with user-type extras. */
export interface DWManagerField {
  label:                     string;
  value:                     string;
  type:                      'user';
  value_alias:               string;
  disable_overflow:          boolean;
  label_visibility_override: 'show' | 'hide';
  profile_url:               string;
  image_url:                 string | null;
}

// ─── Per-section field maps ────────────────────────────────────────────────

/** Fields inside the "designation" (Work Role) grid. */
export interface DWDesignationFields {
  group_company: DWEmploymentField;
  department:    DWEmploymentField;
  designation:   DWEmploymentField;
  from_to:       DWSimpleField;
}

/** Fields inside the "job_level" grid. */
export interface DWJobLevelFields {
  job_level: DWEmploymentField;
  from_to:   DWSimpleField;
}

/** Fields inside the "neev_level" (company entity) grid. */
export interface DWNeevLevelFields {
  neev_level: DWEmploymentField;
  from_to:    DWSimpleField;
}

/** Fields inside the "officelocation" grid. */
export interface DWOfficeLocationFields {
  area:    DWSimpleField;
  country: DWSimpleField;
  state:   DWSimpleField;
  city:    DWSimpleField;
  from_to: DWSimpleField;
}

/** Fields inside the "manager" grid. */
export interface DWManagerFields {
  manager: DWManagerField;
  from_to: DWSimpleField;
}

/** Fields inside the "employee_type" grid. */
export interface DWEmployeeTypeFields {
  employee_type: DWEmploymentField;
  emp_sub_type:  DWEmploymentField;
  from_to:       DWSimpleField;
}

/** Fields inside the "contract" grid. */
export interface DWContractFields {
  contract: DWEmploymentField;
  from_to:  DWSimpleField;
}

// ─── Grid and section wrappers ─────────────────────────────────────────────

export interface DWSwitchBtnDetails {
  view_modes:   ('list' | 'grid')[];
  default_view: 'grid' | 'list';
}

export interface DWCurrentBtnDetails {
  show_current_btn: boolean;
  label:            string;
}

/**
 * A single grid snapshot for one employment assignment period.
 * F is the typed fields map for each section — e.g. DWDesignationFields.
 */
export interface DWEmploymentGrid<F> {
  grid_id:             string;
  current_btn_details: DWCurrentBtnDetails;
  fields:              F;
}

/**
 * One top-level employment section (designation, job_level, contract, …).
 * Contains one or more grid snapshots (history); the current record is
 * flagged via current_btn_details.show_current_btn = true.
 */
export interface DWEmploymentSection<F> {
  label:              string;
  is_grid_section:    true;
  switch_btn_details: DWSwitchBtnDetails;
  grids:              DWEmploymentGrid<F>[];
}

// ─── Top-level response ────────────────────────────────────────────────────

export interface EmploymentDetailsData {
  designation:    DWEmploymentSection<DWDesignationFields>;
  job_level:      DWEmploymentSection<DWJobLevelFields>;
  neev_level:     DWEmploymentSection<DWNeevLevelFields>;
  officelocation: DWEmploymentSection<DWOfficeLocationFields>;
  manager:        DWEmploymentSection<DWManagerFields>;
  employee_type:  DWEmploymentSection<DWEmployeeTypeFields>;
  contract:       DWEmploymentSection<DWContractFields>;
}

export interface ViewEmploymentDetailsResponse {
  status:                  1;
  employment_details_data: EmploymentDetailsData;
}

// =============================================================================
// org-chart.types.ts
//
// Strict TypeScript interfaces for the Darwinbox wire format returned by
// GET /Profileapi/getOrganisationChartDetails.
//
// The response presents a single "lens" focused on one employee and reports
// three structural headcount metrics:
//   no_of_direct_reportees      — immediate subordinates (depth = 1)
//   no_of_dotted_line_reportees — dotted-line indirect reports from payload
//   total_team_size             — full sub-tree via recursive CTE (depth ≥ 1)
// =============================================================================

/** A single metric row inside org_chart_count_data. */
export interface DWChartCountMetric {
  id:    string;
  label: string;
  count: number;
}

/** The inner org-structure payload containing lens metadata and counts. */
export interface DWOrgStructureData {
  show_org_structure:   boolean;
  label:                string;
  lens_id:              string;
  lens_label:           string;
  org_chart_count_data: DWChartCountMetric[];
}

/** The data wrapper that holds org_structure_data. */
export interface DWOrgViewData {
  org_structure_data: DWOrgStructureData;
}

/**
 * The top-level org_view_data envelope.
 *
 * hide_org_view_redirect_icon — when true the frontend suppresses the
 * external link icon that navigates to the full Darwinbox org chart page.
 * Our backend always sets it to false so the link is shown.
 */
export interface DWOrgViewDataEnvelope {
  label:                       string;
  data:                        DWOrgViewData;
  hide_org_view_redirect_icon: boolean;
}

/** Complete ViewOrgChartDetails response. */
export interface ViewOrgChartDetailsResponse {
  status:        1;
  org_view_data: DWOrgViewDataEnvelope;
}

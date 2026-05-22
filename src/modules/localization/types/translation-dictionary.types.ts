// =============================================================================
// translation-dictionary.types.ts
//
// Strict TypeScript interfaces that model the Darwinbox UI translation
// dictionary returned by POST /TranslationApi/getTranslations.
//
// Every interface maps one-to-one with a node in the JSON wire format:
//   root → DWTranslationDictionary
//   bulkSelection → DWBulkSelection
//   common → DWCommon
//   ... (see below)
//
// No `any` types.  Adding a new locale key triggers a TypeScript error if
// the dictionary constant in localization.service.ts is incomplete.
// =============================================================================

// ─── Reusable primitives ──────────────────────────────────────────────────────

/** Pair of plural/singular template strings, e.g. "{count} Records Selected". */
export interface DWPluralSingularPair {
  plural:   string;
  singular: string;
}

// ─── bulkSelection ────────────────────────────────────────────────────────────

export interface DWBulkSelectionInfoMessage {
  cells: DWPluralSingularPair;
  rows:  DWPluralSingularPair;
}

export interface DWBulkSelection {
  bulkSelectCells: string;
  cancel:          string;
  infoMessage:     DWBulkSelectionInfoMessage;
}

// ─── columnSettings ───────────────────────────────────────────────────────────

export interface DWColumnSettings {
  btnText:               string;
  maxFrozenColumnsError: string;
}

// ─── common ───────────────────────────────────────────────────────────────────

export interface DWConfirmDialog {
  cancelBtnText: string;
  message:       string;
  okBtnText:     string;
  title:         string;
}

export interface DWCommon {
  actions:               string;
  additionalInfo:        string;
  automationTimedOut:    string;
  cancel:                string;
  clickToEdit:           string;
  confirmDialog:         DWConfirmDialog;
  edit:                  string;
  enabled:               string;
  nCards:                string;
  none:                  string;
  oneCard:               string;
  reset:                 string;
  resetToDefault:        string;
  save:                  string;
  unexpectedErrorOccured: string;
  view:                  string;
  formValidationError:   string;
  submit:                string;
  actionFor:             string;
  records:               string;
}

// ─── datatable ────────────────────────────────────────────────────────────────

/**
 * DataTables i18n strings.  Token placeholders (_START_, _END_, _TOTAL_,
 * _MENU_, _MAX_) are replaced client-side by the DataTables library.
 */
export interface DWDatatable {
  emptyTable:   string;
  info:         string;
  infoEmpty:    string;
  infoFiltered: string;
  lengthMenu:   string;
}

// ─── displayDensity ───────────────────────────────────────────────────────────

export interface DWDisplayDensityDensities {
  comfort:  string;
  compact:  string;
  expanded: string;
}

export interface DWDisplayDensity {
  btnText:   string;
  densities: DWDisplayDensityDensities;
}

// ─── edit ─────────────────────────────────────────────────────────────────────

export interface DWEditToasts {
  changesSavedSuccessfully: string;
  editModeDisabled:         string;
}

export interface DWEdit {
  disableEditing:    string;
  editingInProgress: string;
  errorFound:        string;
  errorsFound:       string;
  infoMessage:       DWPluralSingularPair;
  saveRecords:       string;
  toasts:            DWEditToasts;
}

// ─── export ───────────────────────────────────────────────────────────────────

export interface DWExport {
  exportAs: string;
  tooltip:  string;
}

// ─── groupBy ──────────────────────────────────────────────────────────────────

export interface DWGroupBy {
  btnText:        string;
  emptyDataGroup: string;
}

// ─── rowExpansion ─────────────────────────────────────────────────────────────

export interface DWRowExpansion {
  collapseAllBtnText: string;
  expandAllBtnText:   string;
}

// ─── savedViews ───────────────────────────────────────────────────────────────

export interface DWSavedViewsButtons {
  allRecords:    string;
  cancel:        string;
  save:          string;
  saveAsNewView: string;
  saveView:      string;
  updateView:    string;
}

export interface DWSavedViewsDeleteModal {
  cancelBtnText: string;
  message:       string;
  okBtnText:     string;
  title:         string;
}

export interface DWSavedViewsErrors {
  unique: string;
}

export interface DWSavedViewsFormEntry {
  heading:    string;
  subHeading: string;
}

export interface DWSavedViewsForm {
  rename: DWSavedViewsFormEntry;
  save:   DWSavedViewsFormEntry;
}

export interface DWSavedViewsPlaceholders {
  name:   string;
  search: string;
}

export interface DWSavedViewsToastEntry {
  failure: string;
  success: string;
}

export interface DWSavedViewsToastSetDefault {
  failure:      string;
  successSet:   string;
  successUnset: string;
}

export interface DWSavedViewsToasts {
  create:     DWSavedViewsToastEntry;
  delete:     DWSavedViewsToastEntry;
  rename:     DWSavedViewsToastEntry;
  setDefault: DWSavedViewsToastSetDefault;
  update:     DWSavedViewsToastEntry;
}

export interface DWSavedViewsTooltips {
  delete:          string;
  removeAsDefault: string;
  rename:          string;
  setAsDefault:    string;
}

export interface DWSavedViews {
  buttons:      DWSavedViewsButtons;
  deleteModal:  DWSavedViewsDeleteModal;
  errors:       DWSavedViewsErrors;
  form:         DWSavedViewsForm;
  placeholders: DWSavedViewsPlaceholders;
  toasts:       DWSavedViewsToasts;
  tooltips:     DWSavedViewsTooltips;
  views:        string;
}

// ─── search ───────────────────────────────────────────────────────────────────

export interface DWSearch {
  moreTokens:       string;
  noSuggestions:    string;
  placeholder:      string;
  selectedCriteria: string;
  suggestions:      string;
}

// ─── settings ─────────────────────────────────────────────────────────────────

export interface DWSettings {
  heading:         string;
  settingApplied:  string;
  settingsApplied: string;
}

// ─── skeletonTable ────────────────────────────────────────────────────────────

export interface DWSkeletonTable {
  deferredLoadingMessage:               string;
  deferredLoadingMessageWithoutFilters: string;
  selectCriteria:                       string;
}

// ─── Root dictionary ──────────────────────────────────────────────────────────

/** Complete Darwinbox UI translation dictionary. */
export interface DWTranslationDictionary {
  bulkSelection:  DWBulkSelection;
  columnSettings: DWColumnSettings;
  common:         DWCommon;
  datatable:      DWDatatable;
  displayDensity: DWDisplayDensity;
  edit:           DWEdit;
  export:         DWExport;
  groupBy:        DWGroupBy;
  rowExpansion:   DWRowExpansion;
  savedViews:     DWSavedViews;
  search:         DWSearch;
  settings:       DWSettings;
  skeletonTable:  DWSkeletonTable;
}

/** Full response envelope for POST /TranslationApi/getTranslations. */
export interface ViewTranslationsResponse {
  translations: DWTranslationDictionary;
  status:       string;
}

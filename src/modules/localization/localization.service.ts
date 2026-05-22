import { Injectable } from '@nestjs/common';

import type {
  DWTranslationDictionary,
  ViewTranslationsResponse,
} from './types/translation-dictionary.types';

// =============================================================================
// EN_TRANSLATIONS — English (default) locale dictionary.
//
// This is the single source of truth for all UI string tokens.  Every key
// maps 1-to-1 with the Darwinbox wire format so the Vue 3 / Quasar frontend
// can swap between the real Darwinbox and this backend without any changes
// to its translation-resolution code.
//
// Token conventions:
//   {count}, {n}, {type}, {viewName}, {totalCount}  — runtime interpolation
//   _START_, _END_, _TOTAL_, _MAX_, _MENU_           — DataTables tokens
//   <span class='count'>…</span>                     — inline HTML wrappers
// =============================================================================

const EN_TRANSLATIONS: DWTranslationDictionary = {

  // ── bulkSelection ─────────────────────────────────────────────────────────
  bulkSelection: {
    bulkSelectCells: 'Bulk Select Cells',
    cancel:          'Cancel',
    infoMessage: {
      cells: {
        plural:   '{count} Cells Selected',
        singular: '{count} Cell Selected',
      },
      rows: {
        plural:   "<span class='count'>{count}</span>/{totalCount} Records Selected",
        singular: "<span class='count'>{count}</span>/{totalCount} Record Selected",
      },
    },
  },

  // ── columnSettings ────────────────────────────────────────────────────────
  columnSettings: {
    btnText:               'Column Settings',
    maxFrozenColumnsError: 'Cannot freeze more than {count} columns',
  },

  // ── common ────────────────────────────────────────────────────────────────
  common: {
    actions:            'Actions',
    additionalInfo:     'Additional Information',
    automationTimedOut: 'Action cannot be completed because the automation timed out.',
    cancel:             'Cancel',
    clickToEdit:        'Click to Edit',
    confirmDialog: {
      cancelBtnText: 'No',
      message:       'Are you sure you want to continue?',
      okBtnText:     'Yes',
      title:         'Alert',
    },
    edit:                  'Edit',
    enabled:               'Enabled',
    nCards:                '{n} Cards',
    none:                  'None',
    oneCard:               '1 Card',
    reset:                 'Reset',
    resetToDefault:        'Reset to Default',
    save:                  'Save',
    unexpectedErrorOccured: 'An unexpected error occurred.',
    view:                  'View',
    formValidationError:   'Error : Invalid Form Entries',
    submit:                'Submit',
    actionFor:             'Action for',
    records:               'Records',
  },

  // ── datatable ─────────────────────────────────────────────────────────────
  datatable: {
    emptyTable:   'There are no records to display',
    info:         '_START_ - _END_ of _TOTAL_ Records',
    infoEmpty:    'No Records Found',
    infoFiltered: '(filtered from _MAX_ total entries)',
    lengthMenu:   '_MENU_ per page',
  },

  // ── displayDensity ────────────────────────────────────────────────────────
  displayDensity: {
    btnText: 'Display Density',
    densities: {
      comfort:  'Comfort',
      compact:  'Compact',
      expanded: 'Expanded',
    },
  },

  // ── edit ──────────────────────────────────────────────────────────────────
  edit: {
    disableEditing:    'Disable Editing',
    editingInProgress: 'Editing in progress',
    errorFound:        '1 Error Found',
    errorsFound:       '{n} Errors Found',
    infoMessage: {
      plural:   "<span class='count'>{count}</span>/{totalCount} Records Edited",
      singular: "<span class='count'>{count}</span>/{totalCount} Record Edited",
    },
    saveRecords: 'Save Records',
    toasts: {
      changesSavedSuccessfully: 'Changes Saved Successfully',
      editModeDisabled:         'Edit Mode Disabled',
    },
  },

  // ── export ────────────────────────────────────────────────────────────────
  export: {
    exportAs: 'Export ({type})',
    tooltip:  'Export',
  },

  // ── groupBy ───────────────────────────────────────────────────────────────
  groupBy: {
    btnText:        'Group By',
    emptyDataGroup: 'No Group',
  },

  // ── rowExpansion ──────────────────────────────────────────────────────────
  rowExpansion: {
    collapseAllBtnText: 'Collapse All',
    expandAllBtnText:   'Expand All',
  },

  // ── savedViews ────────────────────────────────────────────────────────────
  savedViews: {
    buttons: {
      allRecords:    'See All Records',
      cancel:        'Cancel',
      save:          'Ok',
      saveAsNewView: 'Save As New View',
      saveView:      'Save View',
      updateView:    'Update Current View',
    },
    deleteModal: {
      cancelBtnText: 'No',
      message:       'Are you sure you want to Delete {viewName}?',
      okBtnText:     'Yes',
      title:         'Alert',
    },
    errors: {
      unique: 'Name must be unique.',
    },
    form: {
      rename: {
        heading:    'Rename',
        subHeading: 'Please enter a new name for the view',
      },
      save: {
        heading:    'Save As',
        subHeading: 'Please enter a name for the view',
      },
    },
    placeholders: {
      name:   'Enter Name',
      search: 'Search',
    },
    toasts: {
      create: {
        failure: '{viewName} save failed',
        success: '{viewName} saved successfully',
      },
      delete: {
        failure: '{viewName} delete failed',
        success: '{viewName} deleted successfully',
      },
      rename: {
        failure: '{viewName} rename failed',
        success: '{viewName} renamed successfully',
      },
      setDefault: {
        failure:      'Default view updation failed',
        successSet:   '{viewName} has been set as default view for the table',
        successUnset: '{viewName} has been removed as default view for the table',
      },
      update: {
        failure: '{viewName} save failed',
        success: '{viewName} saved successfully',
      },
    },
    tooltips: {
      delete:          'Delete View',
      removeAsDefault: 'Remove as default',
      rename:          'Rename View',
      setAsDefault:    'Set as default',
    },
    views: 'Saved Views',
  },

  // ── search ────────────────────────────────────────────────────────────────
  search: {
    moreTokens:       '+ {count} more',
    noSuggestions:    'No Suggestions Found',
    placeholder:      'Search',
    selectedCriteria: 'Selected Criteria',
    suggestions:      'Suggestions',
  },

  // ── settings ──────────────────────────────────────────────────────────────
  settings: {
    heading:         'Settings',
    settingApplied:  '1 Setting Applied',
    settingsApplied: '{count} Settings Applied',
  },

  // ── skeletonTable ─────────────────────────────────────────────────────────
  skeletonTable: {
    deferredLoadingMessage:               'Select criteria to view records',
    deferredLoadingMessageWithoutFilters: 'Search to view records',
    selectCriteria:                       'SELECT CRITERIA',
  },
};

// =============================================================================
// Locale registry
//
// Maps BCP 47 language tags to their dictionary constants.  Add new locales
// here — the TypeScript compiler enforces DWTranslationDictionary completeness
// so a partial translation pack will not compile.
// =============================================================================

const LOCALE_MAP: Readonly<Record<string, DWTranslationDictionary>> = {
  en: EN_TRANSLATIONS,
  // id: ID_TRANSLATIONS,  // Indonesian — populate when ready
  // zh: ZH_TRANSLATIONS,  // Simplified Chinese — populate when ready
};

const DEFAULT_LOCALE = 'en';

// =============================================================================
// LocalizationService
// =============================================================================

@Injectable()
export class LocalizationService {

  /**
   * Returns the full UI translation dictionary for the requested locale.
   *
   * Locale resolution order:
   *   1. Exact match in LOCALE_MAP (e.g. 'en', 'id').
   *   2. Language subtag match — 'en-US' → 'en' (strips region code).
   *   3. DEFAULT_LOCALE ('en') if neither match is found.
   *
   * This means a client sending 'en-GB' or 'en-US' gets English strings,
   * and a client sending an unsupported locale also gets English rather
   * than a 404 or empty response.
   */
  getUiTranslations(locale?: string): ViewTranslationsResponse {
    const tag     = (locale ?? DEFAULT_LOCALE).toLowerCase().trim();
    const exact   = LOCALE_MAP[tag];
    const subtag  = exact ?? LOCALE_MAP[tag.split('-')[0]];
    const dict    = subtag ?? LOCALE_MAP[DEFAULT_LOCALE];

    return {
      translations: dict,
      status:       'success',
    };
  }
}

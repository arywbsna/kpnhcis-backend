import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../../casl/guards/permissions.guard';
import { GetTranslationsBodyDto } from './dto/get-translations.dto';
import { LocalizationService } from './localization.service';
import type { ViewTranslationsResponse } from './types/translation-dictionary.types';

/**
 * LocalizationController
 *
 * Serves the UI translation dictionary used by Vue 3 / Quasar frontend
 * components (DataTables, Saved Views, Export triggers, Search criteria,
 * Display density toggles).
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates Bearer token; ensures only authenticated
 *                      sessions receive the translation payload.
 *   PermissionsGuard — evaluates @CheckPermissions() against CASL ability.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *   POST /TranslationApi/getTranslations → read:User (any authenticated user)
 *
 *   Translations are UI strings — not sensitive per-user data.  The read:User
 *   permission is used as a broad "you are authenticated" gate rather than a
 *   resource-ownership check.
 *
 * ─── URL ──────────────────────────────────────────────────────────────────────
 *   With global prefix "api/v1" (set in main.ts):
 *     POST /api/v1/TranslationApi/getTranslations
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'User'])
export class LocalizationController {
  constructor(private readonly localizationService: LocalizationService) {}

  // ---------------------------------------------------------------------------
  // POST /TranslationApi/getTranslations
  //
  // Returns the full Darwinbox-compatible UI translation dictionary for the
  // requested locale.  The response is a single `translations` object
  // containing 13 top-level sections (bulkSelection, columnSettings, common,
  // datatable, displayDensity, edit, export, groupBy, rowExpansion,
  // savedViews, search, settings, skeletonTable) plus a `status: "success"`
  // sibling.
  //
  // Body: { locale?: string }
  //   locale — BCP 47 tag (e.g. "en", "en-US", "id").  Unsupported tags fall
  //            back to English.  Omit for the default English dictionary.
  //
  // HTTP 200 (not 201): POST is the Darwinbox wire method; this is a read
  // operation that returns a snapshot, not a resource creation.
  // ---------------------------------------------------------------------------
  @Post('TranslationApi/getTranslations')
  @HttpCode(HttpStatus.OK)
  getTranslations(
    @Body() dto: GetTranslationsBodyDto,
  ): ViewTranslationsResponse {
    return this.localizationService.getUiTranslations(dto.locale);
  }
}

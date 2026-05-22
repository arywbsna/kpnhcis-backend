import { IsOptional, IsString } from 'class-validator';

// =============================================================================
// GetTranslationsBodyDto
//
// Request body for POST /TranslationApi/getTranslations.
//
// locale — BCP 47 language tag identifying the desired translation set.
//   Supported: 'en' (English, default).
//   Unsupported tags (e.g. 'fr', 'de') silently fall back to 'en'.
//   Future locale packs are registered in LocalizationService.LOCALE_MAP
//   without requiring a schema change here.
//
// When the body is omitted entirely (empty POST), locale defaults to 'en'
// through the ?. nullish path in the controller/service.
// =============================================================================

export class GetTranslationsBodyDto {
  @IsString()
  @IsOptional()
  locale?: string;
}

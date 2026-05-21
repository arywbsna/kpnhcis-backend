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
import { AiAnalysisService } from './ai-analysis.service';
import {
  DivisionalHealthQueryDto,
  DivisionalHealthReport,
} from './dto/divisional-health.dto';

/**
 * AiAnalysisController
 *
 * Security gateway for AI-powered business intelligence endpoints.
 *
 * ─── Permission model ─────────────────────────────────────────────────────────
 *
 * The `analyze:BusinessIntelligence` permission is a high-privilege gate.
 * It should be assigned only to roles such as HR Director, C-Suite, or the
 * system administrator — never to general employee or supervisor roles.
 *
 * This is enforced at two layers:
 *   1. JwtAuthGuard   — rejects any request without a valid Bearer token (401)
 *   2. PermissionsGuard + @CheckPermissions — rejects authenticated users who
 *      lack the `analyze:BusinessIntelligence` CASL permission (403)
 *
 * ─── Rate limiting note ───────────────────────────────────────────────────────
 *
 * Each call to POST /divisional-health may consume significant Qwen API tokens
 * (prompt + completion ≈ 2 000–8 000 tokens per request depending on data
 * volume).  In production, add a @UseInterceptors(RateLimitInterceptor) or
 * NestJS Throttler guard to prevent accidental or malicious over-consumption.
 */
@Controller('ai/analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['analyze', 'BusinessIntelligence'])
export class AiAnalysisController {
  constructor(private readonly aiAnalysisService: AiAnalysisService) {}

  /**
   * POST /ai/analytics/divisional-health
   *
   * Triggers a full divisional health analysis for a single organisational unit.
   *
   * ─── Request body ─────────────────────────────────────────────────────────
   *   unitId      (required) UUID of the organisational unit to analyse
   *   windowDays  (optional) look-back window in days; default 90, range 7–365
   *
   * ─── Response (200 OK) ────────────────────────────────────────────────────
   *   DivisionalHealthReport — unit metadata + AI-generated analysis + token usage
   *
   * ─── Error states ─────────────────────────────────────────────────────────
   *   401 Unauthorized        — missing or invalid JWT
   *   403 Forbidden           — valid JWT but role lacks analyze:BusinessIntelligence
   *   404 Not Found           — unitId does not match any unit in the database
   *   503 Service Unavailable — Qwen API returned a non-2xx error
   *   504 Gateway Timeout     — Qwen API did not respond within QWEN_TIMEOUT_MS
   *   500 Internal Error      — Qwen response could not be parsed or failed schema check
   *
   * Returns 200 (not 201) because no new resource is created — the analysis is
   * a computed read derived from existing leave request data.
   */
  @Post('divisional-health')
  @HttpCode(HttpStatus.OK)
  analyzeDivisionalHealth(
    @Body() dto: DivisionalHealthQueryDto,
  ): Promise<DivisionalHealthReport> {
    return this.aiAnalysisService.analyzeDivisionalHealth(
      dto.unitId,
      dto.windowDays,
    );
  }
}

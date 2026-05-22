import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { CaslModule } from '../../casl/casl.module';
import { LocalizationController } from './localization.controller';
import { LocalizationService } from './localization.service';

/**
 * LocalizationModule — Darwinbox-compatible UI translation API.
 *
 * Provides:
 *   POST /TranslationApi/getTranslations
 *
 * ─── Dependencies ─────────────────────────────────────────────────────────────
 *   AuthModule  — provides JwtAuthGuard (via @nestjs/passport JWT strategy).
 *   CaslModule  — provides PermissionsGuard for broad read:User gate.
 *
 *   No PrismaModule dependency — translations are static dictionaries with
 *   no database reads at request time.
 */
@Module({
  imports:     [AuthModule, CaslModule],
  controllers: [LocalizationController],
  providers:   [LocalizationService],
})
export class LocalizationModule {}

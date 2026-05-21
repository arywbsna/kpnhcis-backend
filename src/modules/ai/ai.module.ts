import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthModule } from '../../auth/auth.module';
import { CaslModule } from '../../casl/casl.module';
import { AiAnalysisController } from './ai-analysis.controller';
import { AiAnalysisService } from './ai-analysis.service';

/**
 * AiModule
 *
 * Isolates all AI/BI functionality behind a single NestJS module boundary.
 * No other module needs to import this — it registers its own controller and
 * exposes no shared providers.
 *
 * ─── HttpModule configuration ─────────────────────────────────────────────────
 *
 * HttpModule.registerAsync pre-configures every Axios instance injected into
 * AiAnalysisService with:
 *   baseURL       — QWEN_BASE_URL from .env (e.g. dashscope-intl.aliyuncs.com/…/v1)
 *   Authorization — "Bearer <QWEN_API_KEY>" on every outbound request
 *   timeout       — QWEN_TIMEOUT_MS (fallback: 30 000 ms)
 *
 * This means AiAnalysisService only needs to pass the endpoint path
 * ("/chat/completions") to httpService.post() — no credential assembly per call.
 * Rotating the API key only requires changing the env variable and restarting.
 *
 * ─── Dependencies ─────────────────────────────────────────────────────────────
 *   AuthModule  — provides JwtAuthGuard
 *   CaslModule  — provides PermissionsGuard + CaslAbilityFactory
 *   PrismaModule — satisfied globally (AppModule registers it with @Global())
 *   ConfigModule — satisfied globally
 */
@Module({
  imports: [
    AuthModule,
    CaslModule,
    ConfigModule,

    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseURL: config.getOrThrow<string>('QWEN_BASE_URL'),
        timeout: config.get<number>('QWEN_TIMEOUT_MS', 30_000),
        headers: {
          // All outbound requests carry the DashScope API key.
          // getOrThrow() ensures a missing key crashes the module at startup
          // (which also fires env.validation.ts), not silently at request time.
          Authorization: `Bearer ${config.getOrThrow<string>('QWEN_API_KEY')}`,
          'Content-Type': 'application/json',
        },
      }),
    }),
  ],
  controllers: [AiAnalysisController],
  providers:   [AiAnalysisService],
})
export class AiModule {}

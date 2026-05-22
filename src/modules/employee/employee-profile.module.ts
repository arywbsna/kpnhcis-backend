import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { CaslModule } from '../../casl/casl.module';
import { EmployeeProfileController } from './employee-profile.controller';
import { EmployeeProfileService } from './employee-profile.service';

/**
 * EmployeeProfileModule — Darwinbox-compatible employee hydration API.
 *
 * Provides the five profile endpoints the Vue 3 / Quasar frontend calls before
 * rendering any HR transaction screen:
 *   POST   /Commondata/getemployeeDetails
 *   GET    /Profileapi/enabledModulesListForProfileApi
 *   GET    /Profileapi/ViewProfileDetails
 *   GET    /Profileapi/ViewEmploymentDetails
 *   GET    /Profileapi/getOrganisationChartDetails
 *
 * ─── Dependencies ─────────────────────────────────────────────────────────────
 *   AuthModule  — provides JwtAuthGuard (via @nestjs/passport JWT strategy).
 *   CaslModule  — provides PermissionsGuard + CaslAbilityFactory.
 *                 CaslAbilityFactory is injected into EmployeeProfileService
 *                 for subject-based "own data OR admin" authorization.
 *   PrismaModule — satisfied globally (AppModule registers it with @Global()).
 *   ConfigModule — satisfied globally.
 *   CacheModule  — satisfied globally (used by CaslAbilityFactory internally).
 */
@Module({
  imports:     [AuthModule, CaslModule],
  controllers: [EmployeeProfileController],
  providers:   [EmployeeProfileService],
  exports:     [EmployeeProfileService],
})
export class EmployeeProfileModule {}

import { Module } from '@nestjs/common';

import { CaslAbilityFactory } from './casl-ability.factory';
import { PoliciesGuard } from './guards/policies.guard';
import { PermissionsGuard } from './guards/permissions.guard';

/**
 * CaslModule
 *
 * Provides the RBAC layer for the entire application. Import this module in
 * any feature module that needs CASL ability checks (AuthModule, UsersModule,
 * UnitsModule, LeaveRequestModule, etc.).
 *
 * ─── Dependencies satisfied by @Global() providers ───────────────────────────
 *
 *  PrismaModule  (@Global) — PrismaService is available without re-importing.
 *  CacheModule   (@Global, isGlobal: true) — CACHE_MANAGER token is available
 *                without re-importing. The factory injects it via @Inject().
 *
 * No need to import PrismaModule or CacheModule here; both are registered
 * globally in AppModule and their providers are visible to every module.
 *
 * ─── Two guard families ───────────────────────────────────────────────────────
 *
 * PoliciesGuard + CheckPolicies decorator (original API)
 *   - Accepts arbitrary callback functions: (ability) => ability.can(...)
 *   - Uses reflector.get() — method-level metadata only
 *   - Kept for backward compatibility; existing controllers use it
 *
 * PermissionsGuard + CheckPermissions decorator (new API — Tahap 2)
 *   - Accepts action/subject tuples: ['read', 'LeaveRequest']
 *   - Also accepts callbacks for complex OR logic
 *   - Uses reflector.getAllAndOverride() — class-level defaults + method override
 *   - Provides descriptive ForbiddenException messages listing which permissions failed
 *   - Separates 401 (no user) from 403 (user lacks permission)
 *
 * Migrate controllers incrementally: swap @CheckPolicies + PoliciesGuard for
 * @CheckPermissions + PermissionsGuard at your own pace. Both are exported.
 */
@Module({
  providers: [
    CaslAbilityFactory,
    PoliciesGuard,
    PermissionsGuard,
  ],
  exports: [
    CaslAbilityFactory,
    PoliciesGuard,
    PermissionsGuard,
  ],
})
export class CaslModule {}

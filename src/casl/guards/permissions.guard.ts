import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '@prisma/client';
import type { Request } from 'express';

import { CaslAbilityFactory } from '../casl-ability.factory';
import { AppAbility } from '../casl.types';
import {
  CHECK_PERMISSIONS_KEY,
  PermissionCallback,
  PermissionRequirement,
  PermissionTuple,
} from '../decorators/check-permissions.decorator';

// =============================================================================
// Guard
// =============================================================================

/**
 * PermissionsGuard — evaluates @CheckPermissions() metadata against the
 * current user's CASL ability.
 *
 * ─── Key differences from the existing PoliciesGuard ─────────────────────────
 *
 * 1. Metadata resolution: getAllAndOverride() instead of get().
 *    Class-level @CheckPermissions() sets a default for every route on that
 *    controller. A method-level decorator OVERRIDES the class-level one
 *    (does not merge). This enables patterns like:
 *
 *      @CheckPermissions(['read', 'LeaveRequest'])          // class default
 *      class LeaveRequestController {
 *        @Get()   findAll() { ... }                         // inherits class default
 *
 *        @Post(':id/transition')
 *        @CheckPermissions(['approve', 'LeaveRequest'])     // overrides class default
 *        transition() { ... }
 *      }
 *
 * 2. Descriptive error messages: lists every failing requirement so the
 *    client knows exactly which permission is missing (safe to expose —
 *    it reveals no implementation details, only the permission name).
 *
 * 3. Separates 401 (no user on request) from 403 (user present, lacks access).
 *    PoliciesGuard throws 403 for both; this guard is precise.
 *
 * 4. Evaluates tuples natively — no need to write the full callback form
 *    (ability) => ability.can('action', 'Subject') for common cases.
 *
 * ─── Registration ─────────────────────────────────────────────────────────────
 *
 * Register globally in main.ts after JWT guard (so request.user is already set),
 * or locally per controller. When used locally, always pair with JwtAuthGuard:
 *
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *   @CheckPermissions(['read', 'LeaveRequest'])
 *   class LeaveRequestController { ... }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── 1. Resolve requirements ───────────────────────────────────────────────
    //
    // getAllAndOverride checks the method handler first, then the class.
    // The first non-empty metadata wins — class metadata is the fallback.
    const requirements = this.reflector.getAllAndOverride<
      PermissionRequirement[] | undefined
    >(CHECK_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // No @CheckPermissions() attached anywhere → CASL does not gate this route.
    // JWT authentication is still enforced by JwtAuthGuard running before this.
    if (!requirements || requirements.length === 0) {
      return true;
    }

    // ── 2. Extract user ───────────────────────────────────────────────────────
    //
    // JwtAuthGuard must run before this guard — it populates request.user.
    // If it's absent, the JWT guard failed silently (should not happen in
    // normal configuration) or this guard was applied without JwtAuthGuard.
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User | undefined;

    if (!user) {
      throw new UnauthorizedException(
        'No authenticated user found on request. ' +
        'Ensure JwtAuthGuard runs before PermissionsGuard.',
      );
    }

    // ── 3. Build ability ──────────────────────────────────────────────────────
    //
    // CaslAbilityFactory.createForUser() is cache-aware: the first call per
    // user hits Prisma; subsequent calls within the TTL window hit Redis.
    const ability = await this.abilityFactory.createForUser(user);

    // ── 4. Evaluate every requirement (AND semantics) ─────────────────────────
    //
    // All requirements must pass. We collect failures to produce a descriptive
    // error message rather than stopping at the first failure.
    const failures: string[] = [];

    for (const requirement of requirements) {
      if (this.isTuple(requirement)) {
        const [action, subjectName] = requirement;
        if (!ability.can(action, subjectName)) {
          failures.push(`${action}:${subjectName}`);
        }
      } else {
        // Callback form — let the application decide what to check
        const passed = this.safeExecCallback(requirement as PermissionCallback, ability, user);
        if (!passed) {
          failures.push('custom-policy');
        }
      }
    }

    if (failures.length > 0) {
      this.logger.debug(
        `Access denied for user ${user.id}. ` +
        `Missing: [${failures.join(', ')}]`,
      );
      throw new ForbiddenException(
        `Access denied. Missing permissions: ${failures.join(', ')}`,
      );
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Type guard: distinguishes a PermissionTuple from a PermissionCallback.
   *
   * A tuple is a readonly array of exactly two elements where the first is a
   * string (Action). Using Array.isArray() + checking the first element is
   * sufficient because PermissionCallback is always a function.
   */
  private isTuple(
    requirement: PermissionRequirement,
  ): requirement is PermissionTuple {
    return Array.isArray(requirement);
  }

  /**
   * Executes a PermissionCallback, catching any thrown error and treating it
   * as a denial. This prevents a poorly-written callback from crashing the
   * entire request — the error is logged, and access is denied.
   */
  private safeExecCallback(
    callback: PermissionCallback,
    ability: AppAbility,
    user: User,
  ): boolean {
    try {
      return callback(ability);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `PermissionsGuard: callback threw an error for user ${user.id}: ${message}`,
      );
      return false;
    }
  }
}

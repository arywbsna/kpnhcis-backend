import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { User } from '@prisma/client';
import type { Cache } from 'cache-manager';

import { PrismaService } from '../prisma/prisma.service';
import { Action, AppAbility, SubjectName } from './casl.types';

// =============================================================================
// Internal types
// =============================================================================

/**
 * The minimal shape of a permission row fetched from the DB.
 * Only these three fields are needed to build the ability — everything else
 * is DB metadata (createdAt, updatedAt, id) that we don't cache.
 */
interface CachedPermission {
  action: string;
  subject: string;
  conditions: Record<string, unknown> | null;
}

// =============================================================================
// Cache constants
// =============================================================================

// cache-manager v5 uses milliseconds for TTL
const ABILITY_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

const abilityCacheKey = (userId: string): string => `casl:perms:${userId}`;

// =============================================================================
// Factory
// =============================================================================

@Injectable()
export class CaslAbilityFactory {
  private readonly logger = new Logger(CaslAbilityFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Build an AppAbility for the given user.
   *
   * Flow:
   *   1. Try Redis/in-process cache (key = "casl:perms:{userId}")
   *   2. On miss: query Prisma, flatten + deduplicate permissions across all roles
   *   3. Store the raw permission rows in cache (the ability instance itself
   *      is a class with methods — not safely serialisable to Redis)
   *   4. Build and return the ability from the (possibly cached) permission list
   */
  async createForUser(user: User): Promise<AppAbility> {
    const cacheKey = abilityCacheKey(user.id);

    const cached = await this.cache.get<CachedPermission[]>(cacheKey);

    if (cached !== undefined && cached !== null) {
      this.logger.debug(`Ability cache HIT  — user ${user.id}`);
      return this.buildAbility(cached, user);
    }

    this.logger.debug(`Ability cache MISS — user ${user.id}`);

    const permissions = await this.queryPermissions(user.id);
    await this.cache.set(cacheKey, permissions, ABILITY_CACHE_TTL_MS);

    return this.buildAbility(permissions, user);
  }

  /**
   * Invalidate the cached permission list for a user.
   *
   * Call this from UsersService whenever:
   *   - A user's roles are reassigned
   *   - A role's permissions are modified
   *   - A permission's conditions are updated
   *
   * Without this, stale abilities remain live until the TTL expires.
   */
  async invalidateCache(userId: string): Promise<void> {
    await this.cache.del(abilityCacheKey(userId));
    this.logger.log(`Ability cache invalidated — user ${userId}`);
  }

  // ---------------------------------------------------------------------------
  // Private: data access
  // ---------------------------------------------------------------------------

  /**
   * Queries Prisma for every permission reachable by the user through any role.
   * The result is a flat, deduplicated list — a user with multiple roles that
   * share the same permission gets it exactly once.
   *
   * Deduplication key: action + subject + stable-JSON(conditions).
   * This prevents the same CASL rule from being registered multiple times,
   * which would produce redundant allow entries and inflate the ability object.
   */
  private async queryPermissions(userId: string): Promise<CachedPermission[]> {
    const userWithRoles = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        roles: {
          select: {
            role: {
              select: {
                permissions: {
                  select: {
                    permission: {
                      select: {
                        action:     true,
                        subject:    true,
                        conditions: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const seen      = new Set<string>();
    const collected: CachedPermission[] = [];

    for (const userRole of userWithRoles.roles) {
      for (const rolePermission of userRole.role.permissions) {
        const { action, subject, conditions } = rolePermission.permission;

        // Stable dedup key — JSON.stringify with sorted keys to avoid
        // { a:1, b:2 } vs { b:2, a:1 } being treated as distinct
        const conditionsKey = conditions
          ? JSON.stringify(conditions, Object.keys(conditions).sort())
          : 'null';
        const dedupKey = `${action}::${subject}::${conditionsKey}`;

        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          collected.push({
            action,
            subject,
            conditions: conditions as Record<string, unknown> | null,
          });
        }
      }
    }

    return collected;
  }

  // ---------------------------------------------------------------------------
  // Private: ability construction
  // ---------------------------------------------------------------------------

  /**
   * Builds the CASL AppAbility from a flat permission list and the current user.
   *
   * This function is PURE — it makes no DB calls and creates no side effects.
   * It can be called both on a cache miss (with freshly queried permissions)
   * and on a cache hit (with deserialised cached permissions).
   */
  private buildAbility(
    permissions: CachedPermission[],
    user: User,
  ): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    for (const perm of permissions) {
      const resolvedConditions = perm.conditions
        ? this.interpolateConditions(perm.conditions, user)
        : undefined;

      can(
        perm.action  as Action,
        perm.subject as SubjectName,
        resolvedConditions,
      );
    }

    return build({
      /**
       * detectSubjectType: tells CASL how to extract the subject name from
       * a plain object passed to ability.can().
       *
       * For Prisma plain objects, call CASL's subject() helper before checking:
       *   import { subject } from './casl.types';
       *   ability.can('update', subject('LeaveRequest', leaveRequest));
       *
       * The subject() wrapper exposes __caslSubjectType__ which this function reads.
       * Fallback: __typename convention (set manually if needed).
       */
      detectSubjectType: (object) => {
        // CASL's subject() helper stores the name under this symbol
        const caslKey = Symbol.for('@casl/ability:subject');
        if (typeof object === 'object' && object !== null && caslKey in object) {
          return (object as Record<symbol, SubjectName>)[caslKey];
        }
        // Secondary: __typename convention (GraphQL-inspired, opt-in)
        if (
          typeof object === 'object' &&
          object !== null &&
          '__typename' in object &&
          typeof (object as { __typename: unknown }).__typename === 'string'
        ) {
          return (object as { __typename: string }).__typename as SubjectName;
        }
        // Final fallback — prevents a runtime crash; logs a warning so we
        // can identify callers that forgot to wrap objects with subject()
        this.logger.warn(
          `detectSubjectType: received a plain object with no subject tag. ` +
          `Wrap it with subject('SubjectName', object) before calling ability.can().`,
        );
        return 'all';
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private: condition interpolation
  // ---------------------------------------------------------------------------

  /**
   * Recursively traverses a condition object and replaces every
   * "${user.some.nested.field}" placeholder with the corresponding
   * runtime value from the authenticated user.
   *
   * Supports:
   *   - Top-level fields:   { "userId":  "${user.id}" }
   *   - Nested JSONB paths: { "unitId":  "${user.payload.unitId}" }
   *   - Array elements:     { "ids":     ["${user.id}", "${user.unitId}"] }
   *   - Nested objects:     { "$or":     [{ "userId": "${user.id}" }] }
   *
   * Safety: if the placeholder resolves to undefined/null, the sentinel
   * "__CASL_UNRESOLVED__" is substituted instead of an empty string.
   * No real DB UUID will ever equal that string, so the condition fails
   * safely rather than granting access due to an empty-string match.
   */
  private interpolateConditions(
    conditions: Record<string, unknown>,
    user: User,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(conditions)) {
      result[key] = this.interpolateValue(value, user);
    }

    return result;
  }

  /**
   * Recursively interpolates any value type within a condition.
   * Dispatches on type: string → placeholder replace, array → map,
   * object → recurse, primitive → pass-through.
   */
  private interpolateValue(value: unknown, user: User): unknown {
    if (typeof value === 'string') {
      return this.interpolateString(value, user);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.interpolateValue(item, user));
    }

    if (typeof value === 'object' && value !== null) {
      return this.interpolateConditions(value as Record<string, unknown>, user);
    }

    // boolean, number, null — return as-is
    return value;
  }

  /**
   * Replaces all "${user.<path>}" tokens in a single string value.
   *
   * The regex captures the dot-notation path inside the braces.
   * Each capture is resolved via resolveNestedPath() against the user object.
   *
   * Examples:
   *   "${user.id}"               → "d7f3a1b2-..."
   *   "${user.unitId}"           → "c9e2f4a1-..."
   *   "${user.payload.customId}" → value of user.payload.customId if it exists
   *   "${user.nonExistent}"      → "__CASL_UNRESOLVED__"
   */
  private interpolateString(value: string, user: User): string {
    return value.replace(
      /\$\{user\.([^}]+)\}/g,
      (_match: string, path: string): string => {
        const resolved = this.resolveNestedPath(
          user as unknown as Record<string, unknown>,
          path,
        );

        if (resolved === undefined || resolved === null) {
          this.logger.warn(
            `CASL interpolation: "${path}" resolved to ${resolved} on user ` +
            `${user.id}. Using sentinel to prevent false-positive permission grant.`,
          );
          return '__CASL_UNRESOLVED__';
        }

        return String(resolved);
      },
    );
  }

  /**
   * Walks a dot-notation path on a plain object.
   *
   * resolveNestedPath({ a: { b: { c: 1 } } }, 'a.b.c') → 1
   * resolveNestedPath({ a: null },             'a.b')   → undefined
   */
  private resolveNestedPath(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    return path.split('.').reduce<unknown>((current, segment) => {
      if (current !== null && current !== undefined && typeof current === 'object') {
        return (current as Record<string, unknown>)[segment];
      }
      return undefined;
    }, obj);
  }
}

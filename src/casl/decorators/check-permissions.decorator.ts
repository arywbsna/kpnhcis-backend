import { SetMetadata } from '@nestjs/common';
import { Action, AppAbility, SubjectName } from '../casl.types';

// =============================================================================
// Requirement types
// =============================================================================

/**
 * A tuple of [action, subject] evaluated as ability.can(action, subject).
 *
 * @example
 * ['read',   'LeaveRequest']
 * ['approve','LeaveRequest']
 * ['manage', 'all']
 */
export type PermissionTuple = readonly [Action, SubjectName];

/**
 * An escape-hatch callback for logic that can't be expressed as a single tuple
 * (e.g. OR conditions, computed subject instances, cross-subject rules).
 *
 * @example
 * (ability) => ability.can('read', 'LeaveRequest') || ability.can('manage', 'all')
 */
export type PermissionCallback = (ability: AppAbility) => boolean;

/**
 * Either a shorthand tuple or a full callback function.
 * Both forms are evaluated by PermissionsGuard.
 */
export type PermissionRequirement = PermissionTuple | PermissionCallback;

// =============================================================================
// Metadata key
// =============================================================================

export const CHECK_PERMISSIONS_KEY = 'check_permissions' as const;

// =============================================================================
// Decorator
// =============================================================================

/**
 * Attach one or more permission requirements to a route handler or controller.
 *
 * ALL requirements must pass (AND semantics).
 * For OR logic, use a single PermissionCallback that evaluates the disjunction.
 *
 * PermissionsGuard uses getAllAndOverride(), so a method-level decorator
 * takes full precedence over a class-level decorator — it does NOT merge them.
 * Place requirements on the most specific scope (method preferred over class).
 *
 * ─── Usage examples ──────────────────────────────────────────────────────────
 *
 * // Single action/subject pair (most common)
 * @CheckPermissions(['read', 'LeaveRequest'])
 *
 * // Multiple pairs — all must be satisfied
 * @CheckPermissions(['read', 'LeaveRequest'], ['approve', 'LeaveRequest'])
 *
 * // Wildcard — only system admins with manage:all should pass
 * @CheckPermissions(['manage', 'all'])
 *
 * // Custom callback for OR logic
 * @CheckPermissions(
 *   (ability) => ability.can('approve', 'LeaveRequest') || ability.can('manage', 'all')
 * )
 *
 * // Mix of tuple and callback
 * @CheckPermissions(
 *   ['read', 'LeaveRequest'],
 *   (ability) => ability.can('approve', 'LeaveRequest') || ability.can('reject', 'LeaveRequest'),
 * )
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const CheckPermissions = (
  ...requirements: PermissionRequirement[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(CHECK_PERMISSIONS_KEY, requirements);

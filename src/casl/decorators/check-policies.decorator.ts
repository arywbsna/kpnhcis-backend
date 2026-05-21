import { SetMetadata } from '@nestjs/common';
import { AppAbility } from '../casl.types';

export interface PolicyHandler {
  handle(ability: AppAbility): boolean;
}

export type PolicyHandlerCallback = (ability: AppAbility) => boolean;

export type PolicyHandlerInput = PolicyHandler | PolicyHandlerCallback;

export const CHECK_POLICIES_KEY = 'check_policies';

/**
 * Attach one or more policy handlers to a route.
 * Each handler receives the current user's CASL ability and must return boolean.
 *
 * @example
 * @CheckPolicies((ability) => ability.can('read', 'LeaveRequest'))
 */
export const CheckPolicies = (...handlers: PolicyHandlerInput[]) =>
  SetMetadata(CHECK_POLICIES_KEY, handlers);

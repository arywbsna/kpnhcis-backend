import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '@prisma/client';
import { Request } from 'express';
import { CaslAbilityFactory } from '../casl-ability.factory';
import {
  CHECK_POLICIES_KEY,
  PolicyHandlerCallback,
  PolicyHandlerInput,
} from '../decorators/check-policies.decorator';
import { AppAbility } from '../casl.types';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policyHandlers =
      this.reflector.get<PolicyHandlerInput[]>(
        CHECK_POLICIES_KEY,
        context.getHandler(),
      ) ?? [];

    // No policies attached → route is unprotected by CASL (JWT guard still applies)
    if (policyHandlers.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User;

    if (!user) {
      throw new ForbiddenException('No authenticated user on request');
    }

    const ability = await this.abilityFactory.createForUser(user);

    const allAllowed = policyHandlers.every((handler) =>
      this.execPolicyHandler(handler, ability),
    );

    if (!allAllowed) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }

    return true;
  }

  private execPolicyHandler(
    handler: PolicyHandlerInput,
    ability: AppAbility,
  ): boolean {
    if (typeof handler === 'function') {
      return (handler as PolicyHandlerCallback)(ability);
    }
    return handler.handle(ability);
  }
}

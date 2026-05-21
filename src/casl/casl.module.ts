import { Module } from '@nestjs/common';

import { CaslAbilityFactory } from './casl-ability.factory';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  providers: [CaslAbilityFactory, PermissionsGuard],
  exports: [CaslAbilityFactory, PermissionsGuard],
})
export class CaslModule {}

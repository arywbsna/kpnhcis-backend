import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { CaslModule } from '../../casl/casl.module';
import { UnitController } from './unit.controller';
import { UnitService } from './unit.service';

/**
 * OrganizationModule
 *
 * Owns the organizational unit hierarchy (adjacency list).
 * Exposes UnitService for cross-module use (e.g. UsersModule validating unitId).
 *
 * Dependencies:
 *   AuthModule  — provides JwtAuthGuard for controller routes
 *   CaslModule  — provides PermissionsGuard + CaslAbilityFactory
 *   PrismaModule — satisfied globally (registered in AppModule)
 */
@Module({
  imports: [AuthModule, CaslModule],
  controllers: [UnitController],
  providers: [UnitService],
  exports: [UnitService],
})
export class OrganizationModule {}

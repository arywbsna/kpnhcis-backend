import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CaslModule } from '../casl/casl.module';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';

/**
 * UnitsModule
 *
 * Manages the organisational unit hierarchy (adjacency list).
 * Exports UnitsService for cross-module use (e.g. UsersModule validating unitId).
 *
 * Dependencies:
 *   AuthModule  — provides JwtAuthGuard for controller routes
 *   CaslModule  — provides PermissionsGuard + CaslAbilityFactory
 *   PrismaModule — satisfied globally (registered in AppModule)
 */
@Module({
  imports: [AuthModule, CaslModule],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}

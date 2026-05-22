import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CaslModule } from '../casl/casl.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * ProfilesModule — Darwinbox employee profile synchronisation.
 *
 * PrismaService is available globally via PrismaModule (@Global) — no import needed.
 * AuthModule provides JwtAuthGuard; CaslModule provides PermissionsGuard.
 */
@Module({
  imports:     [AuthModule, CaslModule],
  controllers: [ProfilesController],
  providers:   [ProfilesService],
  exports:     [ProfilesService],
})
export class ProfilesModule {}

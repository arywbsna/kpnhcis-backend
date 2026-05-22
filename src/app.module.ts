import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bullmq';
import { createKeyv } from '@keyv/redis';
import { CacheableMemory } from 'cacheable';
import { Keyv } from 'keyv';

import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { CaslModule } from './casl/casl.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { UnitsModule } from './units/units.module';
import { LeaveRequestModule } from './leave-request/leave-request.module';
import { AiModule } from './modules/ai/ai.module';
import { EmployeeProfileModule } from './modules/employee/employee-profile.module';
import { LocalizationModule } from './modules/localization/localization.module';
import { ProfilesModule } from './profiles/profiles.module';

@Module({
  imports: [
    // -------------------------------------------------------------------------
    // Configuration — validates .env at startup; throws on missing required vars
    // -------------------------------------------------------------------------
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),

    // -------------------------------------------------------------------------
    // Database — global PrismaModule exposes PrismaService everywhere
    // -------------------------------------------------------------------------
    PrismaModule,

    // -------------------------------------------------------------------------
    // Cache — Redis L1 with in-memory L2 fallback (cache-manager-redis-yet)
    // Using the async factory so ConfigService is available.
    // -------------------------------------------------------------------------
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisHost = config.get<string>('REDIS_HOST', 'localhost');
        const redisPort = config.get<number>('REDIS_PORT', 6379);
        const redisPassword = config.get<string>('REDIS_PASSWORD', '');
        const redisDb = config.get<number>('REDIS_DB', 0);

        const redisUrl = redisPassword
          ? `redis://:${redisPassword}@${redisHost}:${redisPort}/${redisDb}`
          : `redis://${redisHost}:${redisPort}/${redisDb}`;

        return {
          stores: [
            // L1: in-process memory (microsecond reads, survives Redis restarts)
            new Keyv({ store: new CacheableMemory({ ttl: 30_000, lruSize: 5000 }) }),
            // L2: Redis (shared across all instances / pods)
            createKeyv(redisUrl),
          ],
        };
      },
    }),

    // -------------------------------------------------------------------------
    // BullMQ — async factory wires Redis connection from ConfigService
    // -------------------------------------------------------------------------
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          db: config.get<number>('REDIS_DB', 0),
          // Automatically reconnect with exponential backoff
          retryStrategy: (times: number) => Math.min(times * 100, 3000),
        },
        defaultJobOptions: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      }),
    }),

    // -------------------------------------------------------------------------
    // Feature modules
    // -------------------------------------------------------------------------
    CaslModule,
    AuthModule,
    UsersModule,
    UnitsModule,
    LeaveRequestModule,
    AiModule,
    EmployeeProfileModule,
    LocalizationModule,
    ProfilesModule,
  ],
})
export class AppModule {}

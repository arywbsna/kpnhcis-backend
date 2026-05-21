import { NestFactory, Reflector } from '@nestjs/core';
import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    // Suppress NestJS default logger in favour of structured logging later
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('APP_PORT', 3000);
  const prefix = config.get<string>('APP_PREFIX', 'api/v1');
  const corsOrigin = config.get<string>('SOCKET_CORS_ORIGIN', 'http://localhost:9000');

  // ---------------------------------------------------------------------------
  // Global prefix — all routes served under /api/v1/...
  // ---------------------------------------------------------------------------
  app.setGlobalPrefix(prefix);

  // ---------------------------------------------------------------------------
  // URI versioning — allows /api/v1/v2/users when needed in future
  // ---------------------------------------------------------------------------
  app.enableVersioning({ type: VersioningType.URI });

  // ---------------------------------------------------------------------------
  // CORS — restrict to the Vue/Quasar frontend origin
  // ---------------------------------------------------------------------------
  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // ---------------------------------------------------------------------------
  // Global ValidationPipe
  //   whitelist:true        → strips any properties not in the DTO class
  //   forbidNonWhitelisted  → throws 400 if unknown properties are sent
  //   transform:true        → auto-coerces route/query params to their DTO types
  //   transformOptions      → enables implicit type conversion (e.g. "1" → 1)
  // ---------------------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // Strip null bytes to prevent PostgreSQL injection via NUL characters
      stopAtFirstError: false,
    }),
  );

  // ---------------------------------------------------------------------------
  // Global ClassSerializerInterceptor — honours @Exclude() / @Expose() on DTOs
  // Prevents accidental serialization of passwordHash, refreshTokenHash, etc.
  // ---------------------------------------------------------------------------
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // ---------------------------------------------------------------------------
  // Graceful shutdown — lets BullMQ workers drain before process exits
  // ---------------------------------------------------------------------------
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Application running on http://localhost:${port}/${prefix}`);
}

bootstrap();

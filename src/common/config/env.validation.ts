import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment;

  @IsInt()
  @Min(1)
  @Max(65535)
  APP_PORT: number;

  @IsString()
  @IsNotEmpty()
  APP_PREFIX: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_EXPIRES_IN: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number;

  // ---------------------------------------------------------------------------
  // Qwen AI (DashScope) — required for the AI analytics module.
  // The application will refuse to bootstrap if either field is missing or
  // malformed, preventing silent failures at analysis time.
  // ---------------------------------------------------------------------------

  @IsString()
  @IsNotEmpty()
  QWEN_API_KEY!: string;

  @IsUrl(
    {
      require_protocol: true,
      require_valid_protocol: true,
      protocols: ['https', 'http'],
    },
    {
      // Allow internal/localhost URLs in development without a TLD
      // (e.g. http://localhost:11434 when running a local Ollama gateway).
      message:
        'QWEN_BASE_URL must be a valid URL starting with http:// or https://',
    },
  )
  @IsNotEmpty()
  QWEN_BASE_URL!: string;

  // Model name — defaults to "qwen-plus" if not set.
  // Override to "qwen-max" for higher accuracy at higher cost.
  @IsOptional()
  @IsString()
  QWEN_MODEL?: string;

  // Per-request timeout in milliseconds (default: 30 000 ms).
  // Raise for large batches; lower for strict SLA requirements.
  @IsOptional()
  @IsInt()
  @Min(5_000)
  @Max(120_000)
  QWEN_TIMEOUT_MS?: number;
}

export function validateEnv(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.toString()}`);
  }

  return validatedConfig;
}

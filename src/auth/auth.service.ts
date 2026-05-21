import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { JwtRefreshPayload } from './strategies/jwt-refresh.strategy';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Login: verify credentials, issue tokens, persist hashed refresh token
  // ---------------------------------------------------------------------------
  async login(email: string, password: string): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Use a generic message to prevent user enumeration
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.deletedAt) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    return this.issueTokens(user);
  }

  // ---------------------------------------------------------------------------
  // Refresh: validate the hashed token from DB, issue a fresh token pair
  // ---------------------------------------------------------------------------
  async refreshTokens(payload: JwtRefreshPayload): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: payload.sub },
    });

    if (!user.refreshTokenHash) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const tokenMatches = await bcrypt.compare(
      payload.refreshToken,
      user.refreshTokenHash,
    );

    if (!tokenMatches) {
      // Token reuse detected — revoke all sessions for safety
      await this.logout(user.id);
      this.logger.warn(`Refresh token reuse detected for user ${user.id}`);
      throw new UnauthorizedException('Refresh token reuse detected. Please log in again.');
    }

    return this.issueTokens(user);
  }

  // ---------------------------------------------------------------------------
  // Logout: clear refresh token hash — invalidates all refresh tokens
  // ---------------------------------------------------------------------------
  async logout(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
  }

  // ---------------------------------------------------------------------------
  // Private: sign both tokens and persist the hashed refresh token
  // ---------------------------------------------------------------------------
  private async issueTokens(user: User): Promise<AuthTokensDto> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      employeeId: user.employeeId,
    };

    const accessExpiresIn = this.config.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn,
      }),
    ]);

    // Always hash before storing — never persist raw tokens
    const refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash },
    });

    // Parse expiresIn string (e.g. "15m") to seconds for the client
    const expiresIn = this.parseExpiresIn(accessExpiresIn);

    return { accessToken, refreshToken, expiresIn };
  }

  // Converts durations like "15m", "1h", "7d" → seconds
  private parseExpiresIn(duration: string): number {
    const unit = duration.slice(-1);
    const value = parseInt(duration.slice(0, -1), 10);
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[unit] ?? 1);
  }

  // ---------------------------------------------------------------------------
  // Hash a plain password — used by UsersService when creating accounts
  // ---------------------------------------------------------------------------
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }
}

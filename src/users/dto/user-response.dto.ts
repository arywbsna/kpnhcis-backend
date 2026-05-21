import { Exclude, Expose, Type } from 'class-transformer';
import { UserStatus } from '@prisma/client';

export class UserResponseDto {
  @Expose() id: string;
  @Expose() employeeId: string;
  @Expose() email: string;
  @Expose() fullName: string;
  @Expose() status: UserStatus;
  @Expose() unitId: string | null;
  @Expose() payload: Record<string, unknown> | null;
  @Expose() createdAt: Date;
  @Expose() updatedAt: Date;

  // Sensitive fields — never serialised to the response
  @Exclude() passwordHash: string;
  @Exclude() refreshTokenHash: string | null;
  @Exclude() deletedAt: Date | null;

  constructor(partial: Partial<UserResponseDto>) {
    Object.assign(this, partial);
  }
}

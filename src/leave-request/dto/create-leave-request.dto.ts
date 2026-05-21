import { LeaveType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateLeaveRequestDto {
  @IsEnum(LeaveType)
  leaveType: LeaveType;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.5)
  @Max(365)
  @Type(() => Number)
  totalDays: number;

  @IsString()
  @IsNotEmpty()
  reason: string;

  // Optional JSONB payload for dynamic fields (e.g. doctor certificate URL for sick leave)
  @IsOptional()
  payload?: Record<string, unknown>;
}

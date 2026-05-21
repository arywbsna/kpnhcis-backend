import { IsOptional, IsString } from 'class-validator';

export class ApproveLeaveRequestDto {
  @IsOptional()
  @IsString()
  remarks?: string;
}

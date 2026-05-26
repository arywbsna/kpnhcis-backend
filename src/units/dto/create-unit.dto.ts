import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateUnitDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'code must be uppercase alphanumeric with underscores/hyphens only',
  })
  code: string;

  @IsString()
  @IsOptional()
  description?: string;

  /// Mandatory tenant boundary — every unit must declare its legal entity owner.
  /// Must equal an existing Subsidiary.id. Enforced as NOT NULL at the DB level.
  @IsUUID()
  subsidiaryId: string;

  @IsUUID()
  @IsOptional()
  parentId?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

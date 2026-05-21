import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateUnitDto } from './create-unit.dto';

// code is immutable after creation
export class UpdateUnitDto extends PartialType(
  OmitType(CreateUnitDto, ['code'] as const),
) {}

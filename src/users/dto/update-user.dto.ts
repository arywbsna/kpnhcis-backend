import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

// employeeId and email are immutable after creation — omit from updates
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['employeeId', 'email'] as const),
) {}

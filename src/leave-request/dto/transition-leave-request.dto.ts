import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export type TransitionAction =
  | 'submit'
  | 'approve-supervisor'
  | 'approve'
  | 'reject'
  | 'cancel';

const VALID_ACTIONS: TransitionAction[] = [
  'submit',
  'approve-supervisor',
  'approve',
  'reject',
  'cancel',
];

export class TransitionLeaveRequestDto {
  @IsIn(VALID_ACTIONS, {
    message: `action must be one of: ${VALID_ACTIONS.join(', ')}`,
  })
  action: TransitionAction;

  @IsUUID()
  @IsOptional()
  approverId?: string;

  @IsString()
  @IsNotEmpty()
  @ValidateIf((o: TransitionLeaveRequestDto) => o.action === 'reject')
  remarks?: string;
}

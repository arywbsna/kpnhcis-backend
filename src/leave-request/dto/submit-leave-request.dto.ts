import { IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * Body payload for POST /leave-requests/:id/submit.
 *
 * approverIds is optional: if omitted, the request enters the normal approval
 * queue without pre-designated approvers. When provided, the IDs are stored in
 * the payload JSONB column and can be used by approval guards to verify that
 * the acting approver was explicitly nominated by the requester.
 */
export class SubmitLeaveRequestDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  approverIds?: string[];
}

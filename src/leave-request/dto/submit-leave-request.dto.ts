import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/**
 * Body payload for POST /leave-requests/:id/submit.
 *
 * approvalChain: ordered list of user or position UUIDs that must approve
 * in sequence. The first element is the first approver (e.g., RM), the last
 * is the final authority (e.g., JS). Chain length is variable to support
 * asymmetric routes:
 *
 *   Route A (long): [rmId, hcDivId, groupHcId, jsId]
 *   Route B (short): [hcHeadId, ceoId, jsId]
 *
 * Use position/role UUIDs (not personal user UUIDs) in slots where PLT /
 * dual-position actors may act on behalf of the role.
 */
export class SubmitLeaveRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  approvalChain: string[];
}

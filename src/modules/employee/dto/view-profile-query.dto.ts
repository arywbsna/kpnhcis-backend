import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

// =============================================================================
// ViewProfileQueryDto
//
// Query parameters for GET /Profileapi/ViewProfileDetails.
//
// user_id — Darwinbox source_employee_id, company employee_no, or internal
//   UUID. Resolved via three-pass lookup in the service layer (GIN → employeeId
//   → UUID). Omit to default to the authenticated user's own profile.
//
// skipLoader — Darwinbox UI hint. When true the frontend suppresses its global
//   loading spinner during this call. The backend accepts but ignores it.
// =============================================================================

export class ViewProfileQueryDto {
  @IsString()
  @IsOptional()
  user_id?: string;

  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  skipLoader?: boolean;
}

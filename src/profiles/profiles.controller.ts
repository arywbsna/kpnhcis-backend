import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { User } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../casl/guards/permissions.guard';
import { SyncProfileDto } from './dto/sync-profile.dto';
import { ProfilesService } from './profiles.service';

/**
 * ProfilesController
 *
 * Manages the Darwinbox → KPNHCIS profile synchronisation lifecycle.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates the Bearer token; populates request.user
 *   PermissionsGuard — evaluates @CheckPermissions() against CASL ability
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *   POST /sync          requires: sync:User  (integration service account only)
 *   GET  /by-department requires: read:User
 *
 * ─── Endpoints ────────────────────────────────────────────────────────────────
 *   POST /profiles/sync                      — upsert one employee from Darwinbox
 *   GET  /profiles/by-department/:deptId     — list users by Darwinbox department_id
 */
@Controller('profiles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  // ---------------------------------------------------------------------------
  // POST /profiles/sync
  //
  // Receives the assembled SyncProfileDto (coreDetails from getemployeeDetails,
  // profileDetails from ViewProfileDetails, employmentDetails from
  // ViewEmploymentDetails) and upserts the employee record.
  //
  // HTTP 200 OK is used instead of 201 Created because the operation is
  // idempotent — calling it multiple times with the same data is safe and
  // returns the same result (upsert semantics).
  //
  // Returns the full upserted User record including the resolved unit and
  // manager (sensitive fields are stripped by ClassSerializerInterceptor).
  // ---------------------------------------------------------------------------
  @Post('sync')
  @CheckPermissions(['sync', 'User'])
  @HttpCode(HttpStatus.OK)
  syncDarwinboxProfile(@Body() dto: SyncProfileDto): Promise<User> {
    return this.profilesService.syncDarwinboxProfile(dto);
  }

  // ---------------------------------------------------------------------------
  // GET /profiles/by-department/:departmentId
  //
  // Lists employees belonging to a given Darwinbox department_id.
  // Uses the GIN-accelerated @> containment query on payload.employment.department_id.
  //
  // Example: GET /profiles/by-department/DEPT_IT_001?skip=0&take=20
  // ---------------------------------------------------------------------------
  @Get('by-department/:departmentId')
  @CheckPermissions(['read', 'User'])
  findByDepartment(
    @Param('departmentId') departmentId: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ): Promise<{ data: User[]; total: number }> {
    return this.profilesService.findBySyncedDepartment(departmentId, {
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }
}

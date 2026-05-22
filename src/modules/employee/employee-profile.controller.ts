import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
// Note: 'Get' remains because ViewProfileDetails, ViewEmploymentDetails, and
// getOrganisationChartDetails are still GET endpoints per the Darwinbox spec.
import { User } from '@prisma/client';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../../casl/guards/permissions.guard';
import {
  GetEmployeeDetailsBodyDto,
  UserIdQueryDto,
} from './dto/profile-query.dto';
import { ViewProfileQueryDto } from './dto/view-profile-query.dto';
import {
  DarwinboxEmployeeDetailsResponse,
  EnabledModuleFlagsResponse,
  EmployeeProfileService,
  GetAttendanceStatusBodyDto,
  ViewAttendanceStatusResponse,
  ViewEmploymentDetailsResponse,
  ViewOrgChartDetailsResponse,
  ViewProfileDetailsResponse,
} from './employee-profile.service';

/**
 * EmployeeProfileController
 *
 * Serves the hydration data the Vue 3 / Quasar frontend needs before rendering
 * any HR transaction screens. The URL structure mirrors Darwinbox's own API
 * so that integration tests and Postman collections can be reused against
 * both the upstream and our local replica without path changes.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 *   JwtAuthGuard     — validates Bearer token; populates request.user (full
 *                      Prisma User object via JwtStrategy.validate()).
 *   PermissionsGuard — evaluates @CheckPermissions() against CASL ability.
 *
 * ─── Authorization overview ───────────────────────────────────────────────────
 *   POST /Commondata/getemployeeDetails        → read:User  (admin/HR only)
 *   POST /Profileapi/enabledModulesListForProfileApi → read:User (session-scoped, own only)
 *   GET  /Profileapi/ViewProfileDetails        → read:User  (own OR admin)
 *   GET  /Profileapi/ViewEmploymentDetails     → read:User  (own OR admin)
 *   GET  /Profileapi/getOrganisationChartDetails → read:User (own OR admin)
 *
 *   For the four single-user endpoints the class-level guard passes anyone
 *   who holds ANY read:User permission (including conditional own-data rules).
 *   The fine-grained "own data OR admin" enforcement is done inside the service
 *   via CASL subject-based evaluation — see EmployeeProfileService.assertProfileAccess().
 *
 * ─── URL convention ───────────────────────────────────────────────────────────
 *   With global prefix "api/v1" (set in main.ts), the full URLs are:
 *     POST   /api/v1/Commondata/getemployeeDetails
 *     POST   /api/v1/Profileapi/enabledModulesListForProfileApi
 *     GET    /api/v1/Profileapi/ViewProfileDetails?user_id=...
 *     GET    /api/v1/Profileapi/ViewEmploymentDetails?user_id=...
 *     GET    /api/v1/Profileapi/getOrganisationChartDetails?user_id=...
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'User'])
export class EmployeeProfileController {
  constructor(
    private readonly employeeProfileService: EmployeeProfileService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /Commondata/getemployeeDetails
  //
  // Returns a single employee's details in the exact Darwinbox wire format.
  // The Vue 3 / Quasar frontend calls this immediately after login to hydrate
  // the current user's profile context (header avatar, role, department, etc.).
  //
  // Body: { user_id?: string }
  //   user_id — Darwinbox source employee ID (payload.darwinbox.source_employee_id).
  //             Falls back to User.employeeId if not found by source_employee_id.
  //             Omit to get the authenticated user's own details.
  //
  // HTTP 200 (not 201) — this is a query, not a resource creation. POST is
  // required to match the upstream Darwinbox API contract.
  // ---------------------------------------------------------------------------
  @Post('Commondata/getemployeeDetails')
  @HttpCode(HttpStatus.OK)
  getEmployeeDetails(
    @Body() dto: GetEmployeeDetailsBodyDto,
    @Req() req: Request,
  ): Promise<DarwinboxEmployeeDetailsResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.getEmployeeDetails(requestingUser, dto);
  }

  // ---------------------------------------------------------------------------
  // POST /Profileapi/enabledModulesListForProfileApi
  //
  // Returns the exact boolean-flag envelope the Darwinbox wire format specifies:
  //   { vibe, rnr, skills, time_management, hover_data_enabled,
  //     enable_appreciations }
  //
  // This endpoint is session-scoped (matching the Darwinbox contract): it
  // always returns the authenticated user's own module flags derived from the
  // three-tier resolution pipeline in the service — no user_id body param.
  //
  // HTTP 200 (not 201): POST is the Darwinbox wire method; this is a read
  // operation that returns a snapshot, not a resource creation.
  // ---------------------------------------------------------------------------
  @Post('Profileapi/enabledModulesListForProfileApi')
  @HttpCode(HttpStatus.OK)
  getEnabledModules(
    @Req() req: Request,
  ): Promise<EnabledModuleFlagsResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.getEnabledModules(requestingUser.id);
  }

  // ---------------------------------------------------------------------------
  // GET /Profileapi/ViewProfileDetails?user_id=...&skipLoader=true
  //
  // Returns the full Darwinbox ViewProfileDetails wire format:
  //   profile_header  — avatar (S3), manager snapshot, role, social links
  //   overview_data   — key employment facts grid
  //   personal_details_data — biography, contact, addresses (current/permanent),
  //     resume, work experience grid, job details, education grid
  //
  // user_id — Darwinbox source_employee_id, company employee_no, or internal
  //   UUID. Omit to default to own profile.
  // skipLoader — UI hint for the frontend; ignored by the backend.
  // Cross-user access requires admin-level read:User (enforced in the service).
  // ---------------------------------------------------------------------------
  @Get('Profileapi/ViewProfileDetails')
  viewProfileDetails(
    @Query() query: ViewProfileQueryDto,
    @Req() req: Request,
  ): Promise<ViewProfileDetailsResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.viewProfileDetails(
      requestingUser,
      query.user_id,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /Profileapi/ViewEmploymentDetails?user_id=...&skipLoader=true
  //
  // Returns the full Darwinbox ViewEmploymentDetails wire format.
  // Each employment attribute is an is_grid_section envelope with one
  // "current" grid snapshot:
  //   designation    — work role, group company, unit, effective date
  //   job_level      — grade code and effective date
  //   neev_level     — legal company entity name
  //   officelocation — area, country, state, city
  //   manager        — supervisor card with Darwinbox hover-data alias
  //   employee_type  — employment type + sub-type
  //   contract       — duration label + from-to with end-date annotation
  //
  // user_id — Darwinbox source_employee_id, company employee_no, or internal
  //   UUID. Omit to default to own profile.
  // skipLoader — UI hint for the frontend; ignored by the backend.
  // Cross-user access requires admin-level read:User (enforced in the service).
  // ---------------------------------------------------------------------------
  @Get('Profileapi/ViewEmploymentDetails')
  viewEmploymentDetails(
    @Query() query: ViewProfileQueryDto,
    @Req() req: Request,
  ): Promise<ViewEmploymentDetailsResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.viewEmploymentDetails(
      requestingUser,
      query.user_id,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /Profileapi/getOrganisationChartDetails?user_id=...&skipLoader=true
  //
  // Returns the Darwinbox ViewOrgChartDetails wire format — a "lens" view
  // centred on one employee with three structural headcount metrics:
  //
  //   no_of_direct_reportees      — immediate subordinates (depth = 1)
  //   no_of_dotted_line_reportees — dotted-line count from payload.org
  //   total_team_size             — full recursive sub-tree headcount
  //
  // lens_id    — stable 18-char hex derived from the target user UUID.
  // lens_label — "[FullName] ([EmployeeId]) - [Designation] - [Department]"
  //
  // user_id — Darwinbox source_employee_id, company employee_no, or internal
  //   UUID. Omit to default to own profile.
  // skipLoader — UI hint for the frontend; ignored by the backend.
  // Cross-user access requires admin-level read:User (enforced in the service).
  // ---------------------------------------------------------------------------
  @Get('Profileapi/getOrganisationChartDetails')
  getOrganisationChartDetails(
    @Query() query: ViewProfileQueryDto,
    @Req() req: Request,
  ): Promise<ViewOrgChartDetailsResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.viewOrgChartDetails(
      requestingUser,
      query.user_id,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /attendance/attendance/GetAttendanceEmployeeStatus
  //
  // Evaluates whether the target employee is actively working today or is
  // currently on an APPROVED leave that spans the current calendar date.
  //
  // Body: { user_id?: string }
  //   user_id — Darwinbox source_employee_id, company employee_no, or internal
  //     UUID. Omit to evaluate the authenticated user's own attendance status.
  //
  // Response variants:
  //   Working: { employee_status: "Working", employee_status_code: "working",
  //              leave_type: "", leave_till_date: "" }
  //   On leave: { employee_status: "On Leave", employee_status_code: "leave",
  //               leave_type: "Annual Leave", leave_till_date: "dd-mm-yyyy" }
  //
  // HTTP 200 (not 201): POST is the Darwinbox wire method; this is a live
  // status query, not a resource creation.
  // ---------------------------------------------------------------------------
  @Post('attendance/attendance/GetAttendanceEmployeeStatus')
  @HttpCode(HttpStatus.OK)
  getAttendanceEmployeeStatus(
    @Body() dto: GetAttendanceStatusBodyDto,
    @Req() req: Request,
  ): Promise<ViewAttendanceStatusResponse> {
    const requestingUser = req.user as User;
    return this.employeeProfileService.getAttendanceEmployeeStatus(
      requestingUser,
      dto,
    );
  }
}

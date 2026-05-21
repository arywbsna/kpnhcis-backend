import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Unit } from '@prisma/client';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CheckPermissions,
} from '../../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../../casl/guards/permissions.guard';
import { CreateUnitDto } from '../../units/dto/create-unit.dto';
import { UpdateUnitDto } from '../../units/dto/update-unit.dto';
import { UnitTreeQueryDto } from './dto/unit-tree-query.dto';
import { GetCompanyTreeOptions, UnitService, UnitTreeNode } from './unit.service';

/**
 * UnitController
 *
 * Manages the organizational unit hierarchy under /organization/units.
 *
 * Auth model:
 *   JwtAuthGuard    — runs first; populates request.user
 *   PermissionsGuard — runs second; checks CASL ability built from DB roles
 *
 * The class-level @CheckPermissions sets the default for every route.
 * Method-level @CheckPermissions overrides (not merges) the class default
 * for routes that require a different permission (create/update/deactivate).
 *
 * This controller deliberately does NOT expose a hard-delete endpoint.
 * Units are soft-deactivated (PATCH /:id/deactivate) to preserve referential
 * integrity with users, leave requests, and audit trails.
 */
@Controller('organization/units')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'Unit'])
export class UnitController {
  constructor(private readonly unitService: UnitService) {}

  /**
   * POST /organization/units
   * Create a new unit, optionally nested under a parent.
   */
  @Post()
  @CheckPermissions(['create', 'Unit'])
  create(@Body() dto: CreateUnitDto): Promise<Unit> {
    return this.unitService.create(dto);
  }

  /**
   * GET /organization/units
   * Flat list — suitable for dropdowns and search-ahead selects.
   * Active-only by default; pass ?includeInactive=true for admin views.
   */
  @Get()
  findAll(@Query('includeInactive') includeInactive?: string): Promise<Unit[]> {
    return this.unitService.findAll({
      includeInactive: includeInactive === 'true',
    });
  }

  /**
   * GET /organization/units/tree
   * Full nested hierarchy for org-chart rendering.
   *
   * Query params:
   *   rootUnitId?    — start from a specific unit instead of org roots
   *   includeInactive? — include deactivated units (default: false)
   *
   * IMPORTANT: this route must be declared BEFORE /:id so NestJS does not
   * try to parse "tree" as a UUID and throw a 400.
   */
  @Get('tree')
  getCompanyTree(@Query() query: UnitTreeQueryDto): Promise<UnitTreeNode[]> {
    const options: GetCompanyTreeOptions = {
      rootUnitId: query.rootUnitId,
      includeInactive: query.includeInactive,
    };
    return this.unitService.getCompanyTree(options);
  }

  /**
   * GET /organization/units/:id
   * Single unit with parent summary and child/user counts.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Unit> {
    return this.unitService.findOne(id);
  }

  /**
   * GET /organization/units/:id/ancestors
   * Breadcrumb path from the org root down to (and including) this unit.
   * Returned in creation order (shallowest first).
   */
  @Get(':id/ancestors')
  findAncestors(@Param('id', ParseUUIDPipe) id: string): Promise<Unit[]> {
    return this.unitService.findAncestors(id);
  }

  /**
   * PATCH /organization/units/:id
   * Update unit fields; validates circular-hierarchy if parentId changes.
   */
  @Patch(':id')
  @CheckPermissions(['update', 'Unit'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
  ): Promise<Unit> {
    return this.unitService.update(id, dto);
  }

  /**
   * PATCH /organization/units/:id/deactivate
   * Soft-deactivate: sets isActive = false without cascading to children.
   * Supervisors must deactivate the subtree explicitly if needed.
   */
  @Patch(':id/deactivate')
  @CheckPermissions(['delete', 'Unit'])
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<Unit> {
    return this.unitService.deactivate(id);
  }
}

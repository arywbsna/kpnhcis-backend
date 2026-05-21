import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Unit } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../casl/guards/permissions.guard';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { UnitsService, UnitTreeNode } from './units.service';

/**
 * UnitsController
 *
 * Manages the organisational unit hierarchy under /organization/units.
 *
 * Auth flow:
 *   JwtAuthGuard     → validates the Bearer token and populates request.user
 *   PermissionsGuard → builds the CASL ability for request.user and evaluates
 *                      every @CheckPermissions() requirement on the handler
 *
 * The class-level @CheckPermissions(['read', 'Unit']) is the fallback for all
 * routes. Method-level decorators on create / update / deactivate override it
 * (getAllAndOverride semantics — the method wins, no merging).
 *
 * Route ordering note:
 *   GET /tree must appear before GET /:id in this file. NestJS registers routes
 *   in declaration order; if /:id comes first, the string "tree" is captured
 *   as the :id segment, ParseUUIDPipe throws a 400, and the tree route is
 *   never reached.
 *
 * Deletion policy:
 *   Hard DELETE is intentionally absent. Units are soft-deactivated
 *   (DELETE /:id/deactivate sets isActive = false) to preserve referential
 *   integrity with users, leave requests, and historical audit records.
 *   The HTTP verb is DELETE for semantic correctness; the operation is
 *   non-destructive at the database level.
 */
@Controller('organization/units')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'Unit'])
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * POST /organization/units
   * Creates a new unit. Optionally nests it under a parent by providing
   * parentId in the request body; the service validates that the parent exists.
   * Returns 201 Created with the persisted unit object.
   */
  @Post()
  @CheckPermissions(['create', 'Unit'])
  create(@Body() dto: CreateUnitDto): Promise<Unit> {
    return this.unitsService.create(dto);
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * GET /organization/units
   * Returns a flat, alphabetically sorted list of all units.
   * Suitable for dropdowns, search-ahead selects, and admin tables.
   */
  @Get()
  findAll(): Promise<Unit[]> {
    return this.unitsService.findAll();
  }

  /**
   * GET /organization/units/tree
   * Returns the full nested hierarchy as a recursive UnitTreeNode tree.
   * Built in O(n) via an in-memory Map — no recursive DB queries.
   * Suitable for org-chart rendering and hierarchical navigation menus.
   *
   * MUST be declared before GET /:id — see class-level ordering note above.
   */
  @Get('tree')
  findTree(): Promise<UnitTreeNode[]> {
    return this.unitsService.findTree();
  }

  /**
   * GET /organization/units/:id
   * Returns a single unit with its parent summary and child/user counts.
   * Throws 404 if the unit does not exist.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Unit> {
    return this.unitsService.findOne(id);
  }

  /**
   * GET /organization/units/:id/ancestors
   * Returns the full ancestor chain from the org root down to (and including)
   * the requested unit, ordered shallowest-first.
   * Used by the frontend to render breadcrumb navigation.
   */
  @Get(':id/ancestors')
  findAncestors(@Param('id', ParseUUIDPipe) id: string): Promise<Unit[]> {
    return this.unitsService.findAncestors(id);
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /**
   * PATCH /organization/units/:id
   * Partial update of unit fields (name, code, description, parentId, isActive).
   * Changing parentId triggers a circular-hierarchy check: setting a descendant
   * as the new parent is rejected with 400 Bad Request.
   */
  @Patch(':id')
  @CheckPermissions(['update', 'Unit'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
  ): Promise<Unit> {
    return this.unitsService.update(id, dto);
  }

  // ---------------------------------------------------------------------------
  // Soft-delete
  // ---------------------------------------------------------------------------

  /**
   * DELETE /organization/units/:id/deactivate
   * Soft-deactivates the unit by setting isActive = false.
   * Does NOT cascade to child units or reassign their users — callers must
   * handle the subtree explicitly if needed.
   * Returns 200 OK with the updated unit record (not 204, because the body
   * carries the deactivated state for the client to update its local store).
   */
  @Delete(':id/deactivate')
  @CheckPermissions(['delete', 'Unit'])
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<Unit> {
    return this.unitsService.deactivate(id);
  }
}

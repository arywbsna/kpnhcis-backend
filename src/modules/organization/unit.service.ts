import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Unit } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateUnitDto } from '../../units/dto/create-unit.dto';
import { UpdateUnitDto } from '../../units/dto/update-unit.dto';

// =============================================================================
// Internal types
// =============================================================================

/**
 * A row returned by the recursive CTE query.
 * Columns are aliased to camelCase in the SQL so this interface maps directly
 * to the JS objects Prisma hands back from $queryRaw.
 */
interface FlatUnitRow {
  id: string;
  name: string;
  code: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  depth: number;
}

// =============================================================================
// Public types
// =============================================================================

/**
 * A fully-nested unit node for org-chart / tree rendering.
 * Strips the CTE-internal `depth` field — callers don't need it.
 */
export type UnitTreeNode = Omit<FlatUnitRow, 'depth'> & {
  children: UnitTreeNode[];
};

export interface GetCompanyTreeOptions {
  rootUnitId?: string;
  includeInactive?: boolean;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class UnitService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(dto: CreateUnitDto): Promise<Unit> {
    const existing = await this.prisma.unit.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(`Unit code "${dto.code}" is already taken`);
    }

    if (dto.parentId) {
      const parent = await this.prisma.unit.findUnique({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new NotFoundException(`Parent unit ${dto.parentId} not found`);
      }
    }

    return this.prisma.unit.create({ data: dto });
  }

  // ---------------------------------------------------------------------------
  // Flat list — lightweight, for dropdowns / selects
  // ---------------------------------------------------------------------------

  findAll(options?: { includeInactive?: boolean }): Promise<Unit[]> {
    return this.prisma.unit.findMany({
      where: options?.includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Full company tree — PostgreSQL recursive CTE
  //
  // Strategy:
  //   1. Anchor: either all root nodes (parent_id IS NULL) or a specific unit
  //      if rootUnitId is provided — enabling partial subtree rendering.
  //   2. Recurse into children up to depth 20 (cycle safety for bad data).
  //   3. Return flat rows ordered by depth then name.
  //   4. buildTree() assembles them into a nested structure in O(n) using a Map.
  //
  // Column aliases in the SELECT use double-quoted identifiers so PostgreSQL
  // returns camelCase keys that match the FlatUnitRow interface directly,
  // without a separate snake_case → camelCase mapping step.
  // ---------------------------------------------------------------------------

  async getCompanyTree(options?: GetCompanyTreeOptions): Promise<UnitTreeNode[]> {
    const rootCondition = options?.rootUnitId
      ? Prisma.sql`id = ${options.rootUnitId}::uuid`
      : Prisma.sql`parent_id IS NULL`;

    const activeFilter = options?.includeInactive
      ? Prisma.sql`TRUE`
      : Prisma.sql`is_active = TRUE`;

    const activeFilterChild = options?.includeInactive
      ? Prisma.sql`TRUE`
      : Prisma.sql`u.is_active = TRUE`;

    const rows = await this.prisma.$queryRaw<FlatUnitRow[]>`
      WITH RECURSIVE org_tree AS (

        -- Anchor: starting node(s)
        SELECT
          id,
          name,
          code,
          description,
          parent_id  AS "parentId",
          is_active  AS "isActive",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          0::int     AS depth
        FROM units
        WHERE ${rootCondition}
          AND ${activeFilter}

        UNION ALL

        -- Recursive: each child of every row already in org_tree
        SELECT
          u.id,
          u.name,
          u.code,
          u.description,
          u.parent_id  AS "parentId",
          u.is_active  AS "isActive",
          u.created_at AS "createdAt",
          u.updated_at AS "updatedAt",
          ot.depth + 1 AS depth
        FROM units u
        INNER JOIN org_tree ot ON u.parent_id = ot.id
        WHERE ot.depth < 20          -- safety cap; real hierarchies never reach 20
          AND ${activeFilterChild}

      )
      SELECT
        id, name, code, description,
        "parentId", "isActive", "createdAt", "updatedAt",
        depth
      FROM org_tree
      ORDER BY depth ASC, name ASC
    `;

    return this.buildTree(rows);
  }

  // ---------------------------------------------------------------------------
  // Single unit — includes parent summary + child/user counts
  // ---------------------------------------------------------------------------

  async findOne(id: string): Promise<Unit> {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name: true, code: true } },
        _count: { select: { children: true, users: true } },
      },
    });

    if (!unit) throw new NotFoundException(`Unit ${id} not found`);
    return unit;
  }

  // ---------------------------------------------------------------------------
  // Ancestor chain (breadcrumb) — CTE walks upward from the given unit
  // ---------------------------------------------------------------------------

  async findAncestors(id: string): Promise<Unit[]> {
    await this.findOne(id);

    return this.prisma.$queryRaw<Unit[]>`
      WITH RECURSIVE ancestors AS (
        SELECT * FROM units WHERE id = ${id}::uuid
        UNION ALL
        SELECT u.* FROM units u
        INNER JOIN ancestors a ON u.id = a.parent_id
      )
      SELECT * FROM ancestors ORDER BY created_at ASC
    `;
  }

  // ---------------------------------------------------------------------------
  // Update — validates parentId changes to prevent circular hierarchy
  // ---------------------------------------------------------------------------

  async update(id: string, dto: UpdateUnitDto): Promise<Unit> {
    await this.findOne(id);

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A unit cannot be its own parent');
      }

      const descendants = await this.findDescendantIds(id);
      if (descendants.includes(dto.parentId)) {
        throw new BadRequestException(
          'Cannot set a descendant unit as the parent (circular hierarchy)',
        );
      }
    }

    return this.prisma.unit.update({ where: { id }, data: dto });
  }

  // ---------------------------------------------------------------------------
  // Soft-deactivate — sets isActive = false; does not cascade to children
  // Callers should decide separately whether to deactivate the subtree.
  // ---------------------------------------------------------------------------

  async deactivate(id: string): Promise<Unit> {
    await this.findOne(id);
    return this.prisma.unit.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Assembles a flat, depth-ordered list of unit rows into a nested tree.
   *
   * Algorithm (O(n)):
   *   1. Build a Map<id, UnitTreeNode> in one pass.
   *   2. Walk the list again: if a row's parentId is in the map, attach it as
   *      a child; otherwise it is a root (parentId null or not in this result
   *      set — the latter happens when rootUnitId subtree is requested).
   *
   * Ordering is preserved: rows come from the CTE ordered by depth then name,
   * so children are always inserted after their parents. This means the map
   * lookup in step 2 always finds an already-populated parent node.
   */
  private buildTree(rows: FlatUnitRow[]): UnitTreeNode[] {
    const map = new Map<string, UnitTreeNode>();
    const roots: UnitTreeNode[] = [];

    for (const row of rows) {
      const { depth: _depth, ...unitFields } = row;
      map.set(row.id, { ...unitFields, children: [] });
    }

    for (const row of rows) {
      const node = map.get(row.id)!;
      if (row.parentId && map.has(row.parentId)) {
        map.get(row.parentId)!.children.push(node);
      } else {
        // parentId is null (root node) OR parentId is outside the queried
        // subtree (when rootUnitId was provided) — either way, treat as root.
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Returns every descendant ID of a given unit via a recursive CTE.
   * Used by update() to detect circular hierarchy before changing parentId.
   */
  private async findDescendantIds(id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM units WHERE parent_id = ${id}::uuid
        UNION ALL
        SELECT u.id FROM units u
        INNER JOIN descendants d ON u.parent_id = d.id
      )
      SELECT id FROM descendants
    `;
    return rows.map((r) => r.id);
  }
}

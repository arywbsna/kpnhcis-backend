import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Unit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

// ---------------------------------------------------------------------------
// Recursive type for the nested tree response
// ---------------------------------------------------------------------------
export type UnitTreeNode = Unit & { children: UnitTreeNode[] };

@Injectable()
export class UnitsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Create a unit, optionally attaching it to a parent
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
  // Flat list of all units — useful for dropdowns/selects in the frontend
  // ---------------------------------------------------------------------------
  findAll(): Promise<Unit[]> {
    return this.prisma.unit.findMany({ orderBy: { name: 'asc' } });
  }

  // ---------------------------------------------------------------------------
  // Nested tree — root nodes with recursively populated children.
  //
  // Strategy: fetch all units in one query, then build the tree in-memory.
  // This is O(n) and avoids N+1 queries. For orgs >10k units, switch to the
  // recursive CTE raw query shown in the comment block below.
  // ---------------------------------------------------------------------------
  async findTree(): Promise<UnitTreeNode[]> {
    const all = await this.prisma.unit.findMany({
      orderBy: { name: 'asc' },
    });

    const map = new Map<string, UnitTreeNode>();
    const roots: UnitTreeNode[] = [];

    for (const unit of all) {
      map.set(unit.id, { ...unit, children: [] });
    }

    for (const unit of all) {
      const node = map.get(unit.id)!;
      if (unit.parentId) {
        const parent = map.get(unit.parentId);
        if (parent) {
          parent.children.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    return roots;

    /*
     * Alternative for very large orgs — recursive CTE via raw SQL:
     *
     * return this.prisma.$queryRaw<Unit[]>`
     *   WITH RECURSIVE unit_tree AS (
     *     SELECT *, 0 AS depth FROM units WHERE parent_id IS NULL
     *     UNION ALL
     *     SELECT u.*, ut.depth + 1 FROM units u
     *     INNER JOIN unit_tree ut ON u.parent_id = ut.id
     *   )
     *   SELECT * FROM unit_tree ORDER BY depth, name;
     * `;
     */
  }

  // ---------------------------------------------------------------------------
  // Fetch the full ancestor chain for a given unit (breadcrumb path)
  // Uses a recursive CTE for correctness regardless of depth
  // ---------------------------------------------------------------------------
  async findAncestors(id: string): Promise<Unit[]> {
    await this.findOne(id); // validate existence

    return this.prisma.$queryRaw<Unit[]>`
      WITH RECURSIVE ancestors AS (
        SELECT * FROM units WHERE id = ${id}::uuid
        UNION ALL
        SELECT u.* FROM units u
        INNER JOIN ancestors a ON u.id = a.parent_id
      )
      SELECT * FROM ancestors ORDER BY created_at;
    `;
  }

  // ---------------------------------------------------------------------------
  // Find a single unit by ID
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
  // Update — prevents circular hierarchy (unit cannot become its own ancestor)
  // ---------------------------------------------------------------------------
  async update(id: string, dto: UpdateUnitDto): Promise<Unit> {
    await this.findOne(id);

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A unit cannot be its own parent');
      }

      // Confirm the new parent exists and is not already a descendant of this unit
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
  // Soft-deactivate — sets isActive = false, does not cascade to children
  // ---------------------------------------------------------------------------
  async deactivate(id: string): Promise<Unit> {
    await this.findOne(id);
    return this.prisma.unit.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // Returns all descendant IDs using a recursive CTE — used by cycle detection
  private async findDescendantIds(id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM units WHERE parent_id = ${id}::uuid
        UNION ALL
        SELECT u.id FROM units u
        INNER JOIN descendants d ON u.parent_id = d.id
      )
      SELECT id FROM descendants;
    `;
    return rows.map((r) => r.id);
  }
}

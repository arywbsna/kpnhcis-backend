import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserStatus } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// ---------------------------------------------------------------------------
// RawUserRow — shape returned by $queryRaw JSONB queries.
//
// $queryRaw returns snake_case column names unless the SQL aliases them.
// Our JSONB queries alias every column to camelCase so the result maps
// directly to this interface without a second transformation pass.
// Sensitive columns (passwordHash, refreshTokenHash) are excluded from the
// SELECT list intentionally — they must never appear in list responses.
// ---------------------------------------------------------------------------
export interface RawUserRow {
  id: string;
  employeeId: string;
  email: string;
  fullName: string;
  status: UserStatus;
  unitId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Create a user + optionally assign roles in a single transaction
  // ---------------------------------------------------------------------------
  async create(dto: CreateUserDto): Promise<User> {
    const [existingEmail, existingEmployeeId] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email } }),
      this.prisma.user.findUnique({ where: { employeeId: dto.employeeId } }),
    ]);

    if (existingEmail) {
      throw new ConflictException(`Email "${dto.email}" is already in use`);
    }
    if (existingEmployeeId) {
      throw new ConflictException(
        `Employee ID "${dto.employeeId}" is already in use`,
      );
    }

    const passwordHash = await AuthService.hashPassword(dto.password);
    const { roleIds, password, ...userData } = dto;

    return this.prisma.user.create({
      data: {
        ...userData,
        passwordHash,
        roles: roleIds?.length
          ? {
              create: roleIds.map((roleId) => ({ roleId })),
            }
          : undefined,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Paginated list — excludes soft-deleted users by default
  // ---------------------------------------------------------------------------
  async findAll(params: {
    skip?: number;
    take?: number;
    unitId?: string;
    search?: string;
  }): Promise<{ data: User[]; total: number }> {
    const { skip = 0, take = 20, unitId, search } = params;

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(unitId && { unitId }),
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { employeeId: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  // ---------------------------------------------------------------------------
  // Find one — throws 404 if not found or soft-deleted
  // ---------------------------------------------------------------------------
  async findOne(id: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        unit: { select: { id: true, name: true, code: true } },
        roles: { include: { role: { select: { id: true, name: true } } } },
      },
    });

    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  // ---------------------------------------------------------------------------
  // Update — re-hashes password if provided, re-assigns roles if provided
  // ---------------------------------------------------------------------------
  async update(id: string, dto: UpdateUserDto): Promise<User> {
    await this.findOne(id); // ensures user exists

    const { roleIds, password, ...rest } = dto;

    const passwordHash = password
      ? await AuthService.hashPassword(password)
      : undefined;

    return this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        ...(passwordHash && { passwordHash }),
        ...(roleIds !== undefined && {
          roles: {
            deleteMany: {}, // replace all roles
            create: roleIds.map((roleId) => ({ roleId })),
          },
        }),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Soft delete — sets deletedAt timestamp, never physically removes the row
  // ---------------------------------------------------------------------------
  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------------
  // findByPayloadContainment — GIN-accelerated JSONB @> search
  //
  // Uses the PostgreSQL containment operator (@>) which is the ONLY operator
  // that causes the query planner to perform an index scan on the GIN index
  // created in migration add_gin_indexes_payload.
  //
  // How @> works with GIN:
  //   The GIN index stores every {key: value} pair from every payload document.
  //   @> decomposes the filter document into the same pairs and looks each one
  //   up in the GIN structure — O(log n) per key, not an O(n) sequential scan.
  //
  // The alternative `WHERE payload->>'key' = 'value'` extracts a text value
  // and performs a sequential scan unless a separate functional B-Tree index
  // exists on that expression.  It will NEVER use this GIN index.
  //
  // Usage examples:
  //   findByPayloadContainment({ is_union_member: true })
  //   findByPayloadContainment({ department: 'engineering', grade: 4 })
  //   findByPayloadContainment({ certifications: ['K3', 'ISO9001'] })
  // ---------------------------------------------------------------------------
  async findByPayloadContainment(
    filter: Record<string, unknown>,
    options?: { skip?: number; take?: number },
  ): Promise<{ data: RawUserRow[]; total: number }> {
    const { skip = 0, take = 20 } = options ?? {};
    const jsonFilter = JSON.stringify(filter);

    // $queryRaw parameterises jsonFilter as $1 — no string interpolation,
    // no SQL injection risk.  The ::jsonb cast happens inside PostgreSQL.
    const [data, countRows] = await Promise.all([
      this.prisma.$queryRaw<RawUserRow[]>`
        SELECT
          id,
          employee_id   AS "employeeId",
          email,
          full_name     AS "fullName",
          status,
          unit_id       AS "unitId",
          payload,
          created_at    AS "createdAt",
          updated_at    AS "updatedAt"
        FROM users
        WHERE payload @> ${jsonFilter}::jsonb   -- hits the GIN index
          AND deleted_at IS NULL
        ORDER BY full_name ASC
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM users
        WHERE payload @> ${jsonFilter}::jsonb
          AND deleted_at IS NULL
      `,
    ]);

    return {
      data,
      total: Number(countRows[0].count),
    };
  }

  // ---------------------------------------------------------------------------
  // findUnionMembers — typed, domain-specific wrapper over findByPayloadContainment
  //
  // The payload for a union-member employee contains { "is_union_member": true }.
  // This key is written by the HR admin portal at onboarding time and is the
  // canonical flag used by payroll (union dues deduction) and reporting.
  //
  // Returns paginated results identical to findByPayloadContainment so the
  // controller can pass them directly to the client without transformation.
  // ---------------------------------------------------------------------------
  findUnionMembers(
    options?: { skip?: number; take?: number },
  ): Promise<{ data: RawUserRow[]; total: number }> {
    return this.findByPayloadContainment({ is_union_member: true }, options);
  }
}

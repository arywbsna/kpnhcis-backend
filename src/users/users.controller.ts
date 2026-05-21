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
  Query,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckPermissions } from '../casl/decorators/check-permissions.decorator';
import { PermissionsGuard } from '../casl/guards/permissions.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@CheckPermissions(['read', 'User'])
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * POST /users
   * Requires: create User
   */
  @Post()
  @CheckPermissions(['create', 'User'])
  async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    const user = await this.usersService.create(dto);
    return plainToInstance(UserResponseDto, user, {
      excludeExtraneousValues: true,
    });
  }

  /**
   * GET /users?skip=0&take=20&unitId=...&search=...
   * Requires: read User
   */
  @Get()
  async findAll(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('unitId') unitId?: string,
    @Query('search') search?: string,
  ): Promise<{ data: UserResponseDto[]; total: number }> {
    const result = await this.usersService.findAll({
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      unitId,
      search,
    });

    return {
      data: result.data.map((u) =>
        plainToInstance(UserResponseDto, u, { excludeExtraneousValues: true }),
      ),
      total: result.total,
    };
  }

  /**
   * GET /users/:id
   * Requires: read User
   */
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findOne(id);
    return plainToInstance(UserResponseDto, user, {
      excludeExtraneousValues: true,
    });
  }

  /**
   * PATCH /users/:id
   * Requires: update User
   */
  @Patch(':id')
  @CheckPermissions(['update', 'User'])
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto);
    return plainToInstance(UserResponseDto, user, {
      excludeExtraneousValues: true,
    });
  }

  /**
   * DELETE /users/:id
   * Requires: delete User — performs a soft delete
   */
  @Delete(':id')
  @CheckPermissions(['delete', 'User'])
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.usersService.remove(id);
  }
}

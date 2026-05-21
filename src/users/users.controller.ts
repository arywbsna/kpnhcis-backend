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
import { CheckPolicies } from '../casl/decorators/check-policies.decorator';
import { PoliciesGuard } from '../casl/guards/policies.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, PoliciesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * POST /users
   * Requires: create User
   */
  @Post()
  @CheckPolicies((ability) => ability.can('create', 'User'))
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
  @CheckPolicies((ability) => ability.can('read', 'User'))
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
  @CheckPolicies((ability) => ability.can('read', 'User'))
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
  @CheckPolicies((ability) => ability.can('update', 'User'))
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
  @CheckPolicies((ability) => ability.can('delete', 'User'))
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.usersService.remove(id);
  }
}

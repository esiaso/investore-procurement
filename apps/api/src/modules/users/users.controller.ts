import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto, UserQueryDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() @RequirePermissions(Permissions.USERS_READ)
  list(@Query() query: UserQueryDto) {
    return this.users.list(query);
  }

  /** Active users' names (for picking a delegate etc.); any signed-in user. */
  @Get('directory')
  directory() {
    return this.users.directory();
  }

  @Get(':id') @RequirePermissions(Permissions.USERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post() @RequirePermissions(Permissions.USERS_MANAGE)
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.USERS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Post(':id/reset-password') @HttpCode(204) @RequirePermissions(Permissions.USERS_MANAGE)
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(id, dto.password);
  }

  /** Clears TOTP for a user who lost their authenticator. */
  @Post(':id/reset-2fa') @HttpCode(204) @RequirePermissions(Permissions.USERS_MANAGE)
  reset2fa(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.setTotp(id, null);
  }
}

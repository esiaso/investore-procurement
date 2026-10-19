import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { CreateRoleDto, UpdateRoleDto } from './rbac.dto';
import { RbacService } from './rbac.service';

@ApiTags('rbac')
@Controller()
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions') @RequirePermissions(Permissions.ROLES_READ)
  permissions() {
    return this.rbac.listPermissions();
  }

  @Get('roles') @RequirePermissions(Permissions.ROLES_READ)
  roles() {
    return this.rbac.listRoles();
  }

  @Get('roles/:id') @RequirePermissions(Permissions.ROLES_READ)
  role(@Param('id', ParseUUIDPipe) id: string) {
    return this.rbac.getRole(id);
  }

  @Post('roles') @RequirePermissions(Permissions.ROLES_MANAGE)
  create(@Body() dto: CreateRoleDto) {
    return this.rbac.createRole(dto);
  }

  @Patch('roles/:id') @RequirePermissions(Permissions.ROLES_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.rbac.updateRole(id, dto);
  }

  @Delete('roles/:id') @HttpCode(204) @RequirePermissions(Permissions.ROLES_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rbac.deleteRole(id);
  }
}

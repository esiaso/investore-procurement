import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditAction } from '@sil/shared';
import { AuditService } from '../audit/audit.service';
import { CreateRoleDto, UpdateRoleDto } from './rbac.dto';
import { Permission, Role } from './rbac.entities';

@Injectable()
export class RbacService {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission) private readonly permissions: Repository<Permission>,
    private readonly audit: AuditService,
  ) {}

  listPermissions(): Promise<Permission[]> {
    return this.permissions.find({ order: { code: 'ASC' } });
  }

  listRoles(): Promise<Role[]> {
    return this.roles.find({ relations: { permissions: true }, order: { name: 'ASC' } });
  }

  async getRole(id: string): Promise<Role> {
    const role = await this.roles.findOne({ where: { id }, relations: { permissions: true } });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async findRolesByIds(ids: string[]): Promise<Role[]> {
    if (!ids.length) return [];
    const found = await this.roles.findBy({ id: In(ids) });
    if (found.length !== new Set(ids).size) throw new BadRequestException('One or more roles do not exist');
    return found;
  }

  private async resolvePermissions(codes: string[]): Promise<Permission[]> {
    if (!codes.length) return [];
    const found = await this.permissions.findBy({ code: In(codes) });
    const missing = codes.filter((c) => !found.some((p) => p.code === c));
    if (missing.length) throw new BadRequestException(`Unknown permission(s): ${missing.join(', ')}`);
    return found;
  }

  async createRole(dto: CreateRoleDto): Promise<Role> {
    const permissions = await this.resolvePermissions(dto.permissionCodes);
    return this.roles.save(
      this.roles.create({ code: dto.code, name: dto.name, description: dto.description ?? null, permissions }),
    );
  }

  async updateRole(id: string, dto: UpdateRoleDto): Promise<Role> {
    const role = await this.getRole(id);
    if (dto.name !== undefined) role.name = dto.name;
    if (dto.description !== undefined) role.description = dto.description;
    const before = (role.permissions ?? []).map((p) => p.code).sort();
    if (dto.permissionCodes) role.permissions = await this.resolvePermissions(dto.permissionCodes);
    const after = (role.permissions ?? []).map((p) => p.code).sort();

    return this.roles.manager.transaction(async (manager) => {
      const saved = await manager.save(role);
      // Join-table changes do not raise entity update events; audit them explicitly.
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await this.audit.record(
          {
            action: AuditAction.UPDATE,
            entityType: 'Role',
            entityId: role.id,
            before: { permissionCodes: before },
            after: { permissionCodes: after },
          },
          manager,
        );
      }
      return saved;
    });
  }

  async deleteRole(id: string): Promise<void> {
    const role = await this.getRole(id);
    if (role.isSystem) throw new ConflictException('Built-in roles cannot be deleted');
    await this.roles.remove(role);
  }
}

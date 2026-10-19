import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditAction, Paginated, Permissions, SessionUser } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { AuditService } from '../audit/audit.service';
import { OrgService } from '../org/org.service';
import { RbacService } from '../rbac/rbac.service';
import { PasswordService } from './password.service';
import { User } from './user.entity';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';

export function toSessionUser(user: User): SessionUser {
  const permissions = new Set<string>();
  for (const role of user.roles ?? []) for (const p of role.permissions ?? []) permissions.add(p.code);
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    roles: (user.roles ?? []).map((r) => ({ code: r.code, name: r.name })),
    permissions: [...permissions].sort(),
    storeIds: permissions.has(Permissions.STORE_ALL) ? null : (user.stores ?? []).map((s) => s.id),
    totpEnabled: user.totpEnabled,
    mustChangePassword: user.mustChangePassword,
  };
}

const ids = (list?: { id: string }[]) => (list ?? []).map((x) => x.id).sort();

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly passwords: PasswordService,
    private readonly rbac: RbacService,
    private readonly org: OrgService,
    private readonly audit: AuditService,
  ) {}

  /** Loads the user with roles, permissions and stores; null if missing or inactive. */
  async findForSession(id: string): Promise<SessionUser | null> {
    const user = await this.users.findOne({
      where: { id, isActive: true },
      relations: { roles: { permissions: true }, stores: true },
    });
    return user ? toSessionUser(user) : null;
  }

  /** Includes the secret columns; for authentication only. */
  findWithSecretsByUsername(username: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect(['u.passwordHash', 'u.totpSecretEnc'])
      .where('u.username = :username', { username: username.trim().toLowerCase() })
      .getOne();
  }

  findWithSecretsById(id: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect(['u.passwordHash', 'u.totpSecretEnc'])
      .where('u.id = :id', { id })
      .getOne();
  }

  list(query: UserQueryDto): Promise<Paginated<User>> {
    const qb = this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.roles', 'role')
      .leftJoinAndSelect('u.stores', 'store')
      .orderBy('u.username', 'ASC');
    if (query.search) {
      qb.andWhere('(u.username ILIKE :q OR u.full_name ILIKE :q OR u.email ILIKE :q)', { q: likeTerm(query.search) });
    }
    if (query.roleId) {
      qb.andWhere('u.id IN (SELECT user_id FROM user_role WHERE role_id = :roleId)', { roleId: query.roleId });
    }
    return paginate(qb, query);
  }

  directory(): Promise<{ id: string; username: string; fullName: string }[]> {
    return this.users.find({ select: { id: true, username: true, fullName: true }, where: { isActive: true }, order: { fullName: 'ASC' } });
  }

  async get(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id }, relations: { roles: true, stores: true } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    await this.passwords.assertPolicy(dto.password, dto.username);
    const roles = await this.rbac.findRolesByIds(dto.roleIds);
    const stores = await this.resolveStores(dto.storeIds ?? []);
    const passwordHash = await this.passwords.hash(dto.password);
    return this.users.manager.transaction(async (manager) => {
      const user = await manager.save(
        manager.create(User, {
          username: dto.username,
          fullName: dto.fullName,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          isActive: dto.isActive ?? true,
          departmentId: dto.departmentId ?? null,
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          roles,
          stores,
        }),
      );
      await this.auditAssignments(manager, user.id, { roleIds: [], storeIds: [] }, { roleIds: ids(roles), storeIds: ids(stores) });
      return this.stripSecrets(user);
    });
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.get(id);
    const before = { roleIds: ids(user.roles), storeIds: ids(user.stores) };
    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.email !== undefined) user.email = dto.email;
    if (dto.phone !== undefined) user.phone = dto.phone;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    if (dto.departmentId !== undefined) user.departmentId = dto.departmentId;
    if (dto.roleIds) user.roles = await this.rbac.findRolesByIds(dto.roleIds);
    if (dto.storeIds) user.stores = await this.resolveStores(dto.storeIds);
    return this.users.manager.transaction(async (manager) => {
      const saved = await manager.save(user);
      await this.auditAssignments(manager, id, before, { roleIds: ids(user.roles), storeIds: ids(user.stores) });
      return saved;
    });
  }

  /** Admin reset: user must change the password at next login. */
  async resetPassword(id: string, password: string): Promise<void> {
    const user = await this.get(id);
    await this.passwords.assertPolicy(password, user.username);
    await this.setPassword(id, password, true);
  }

  async setPassword(id: string, password: string, mustChange: boolean): Promise<void> {
    const user = await this.findWithSecretsById(id);
    if (!user) throw new NotFoundException('User not found');
    user.passwordHash = await this.passwords.hash(password);
    user.mustChangePassword = mustChange;
    user.passwordChangedAt = new Date();
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await this.users.save(user);
  }

  async setTotp(id: string, secretEnc: string | null): Promise<void> {
    const user = await this.findWithSecretsById(id);
    if (!user) throw new NotFoundException('User not found');
    user.totpSecretEnc = secretEnc;
    user.totpEnabled = secretEnc !== null;
    await this.users.save(user);
  }

  /** Login bookkeeping; deliberately not row-audited (LOGIN / LOGIN_FAILED events are). */
  async recordFailedLogin(user: User, maxFailed: number, lockoutMinutes: number): Promise<void> {
    const count = user.failedLoginCount + 1;
    const lockedUntil = count >= maxFailed ? new Date(Date.now() + lockoutMinutes * 60_000) : user.lockedUntil;
    await this.users.update(user.id, { failedLoginCount: count >= maxFailed ? 0 : count, lockedUntil });
  }

  async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.users.update(userId, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });
  }

  private async resolveStores(storeIds: string[]) {
    const stores = await this.org.findStoresByIds(storeIds);
    if (stores.length !== new Set(storeIds).size) throw new BadRequestException('One or more stores do not exist');
    return stores;
  }

  private async auditAssignments(
    manager: EntityManager,
    userId: string,
    before: { roleIds: string[]; storeIds: string[] },
    after: { roleIds: string[]; storeIds: string[] },
  ): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await this.audit.record({ action: AuditAction.UPDATE, entityType: 'User', entityId: userId, before, after }, manager);
  }

  private stripSecrets(user: User): User {
    const { passwordHash: _p, totpSecretEnc: _t, ...rest } = user;
    return rest as User;
  }
}

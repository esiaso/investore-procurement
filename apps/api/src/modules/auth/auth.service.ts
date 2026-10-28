import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction } from '@sil/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { PasswordService } from '../users/password.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { TotpService } from './totp.service';

const INVALID = 'Invalid username or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Password check with lockout. Returns the user (with secrets) on success. */
  async validateCredentials(username: string, password: string): Promise<User> {
    const user = await this.users.findWithSecretsByUsername(username);
    const ok = await this.passwords.verify(user?.passwordHash, password);

    if (!user) {
      await this.audit.record({ action: AuditAction.LOGIN_FAILED, entityType: 'User', entityId: null, after: { username } });
      throw new UnauthorizedException(INVALID);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        after: { username: user.username, reason: 'locked' },
      });
      throw new UnauthorizedException({ message: 'Account temporarily locked. Try again later.', code: 'LOCKED' });
    }
    if (!ok || !user.isActive) {
      const [maxFailed, lockoutMinutes] = await Promise.all([
        this.settings.get('security.maxFailedLogins'),
        this.settings.get('security.lockoutMinutes'),
      ]);
      if (ok === false) await this.users.recordFailedLogin(user, maxFailed, lockoutMinutes);
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        after: { username: user.username, reason: ok ? 'inactive' : 'bad_password' },
      });
      throw new UnauthorizedException(INVALID);
    }
    return user;
  }

  async verifySecondFactor(userId: string, code: string): Promise<boolean> {
    const user = await this.users.findWithSecretsById(userId);
    if (!user?.totpEnabled || !user.totpSecretEnc) return false;
    // A locked account takes no codes; wrong codes count towards the same lockout as wrong passwords.
    if (user.lockedUntil && user.lockedUntil > new Date()) return false;
    const ok = this.totp.verify(code, this.totp.decrypt(user.totpSecretEnc));
    if (!ok) {
      const [maxFailed, lockoutMinutes] = await Promise.all([
        this.settings.get('security.maxFailedLogins'),
        this.settings.get('security.lockoutMinutes'),
      ]);
      await this.users.recordFailedLogin(user, maxFailed, lockoutMinutes);
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: userId,
        after: { username: user.username, reason: 'bad_totp' },
      });
    }
    return ok;
  }

  async onLoggedIn(userId: string, username: string): Promise<void> {
    await this.users.recordSuccessfulLogin(userId);
    await this.audit.record({ action: AuditAction.LOGIN, entityType: 'User', entityId: userId, userId, username });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findWithSecretsById(userId);
    if (!user || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new BadRequestException('New password must differ from the current password');
    }
    await this.passwords.assertPolicy(newPassword, user.username);
    await this.users.setPassword(userId, newPassword, false);
    await this.audit.record({ action: AuditAction.PASSWORD_CHANGE, entityType: 'User', entityId: userId });
  }

  async startTotpEnrolment(username: string) {
    const issuer = await this.settings.get('security.totpIssuer');
    return this.totp.enrolment(this.totp.generateSecret(), username, issuer);
  }

  async enableTotp(userId: string, secret: string, code: string): Promise<void> {
    if (!this.totp.verify(code, secret)) throw new BadRequestException('Invalid code');
    await this.users.setTotp(userId, this.totp.encrypt(secret));
    await this.audit.record({ action: AuditAction.TWO_FACTOR_ENABLED, entityType: 'User', entityId: userId });
  }

  async disableTotp(userId: string, password: string, code: string): Promise<void> {
    const user = await this.users.findWithSecretsById(userId);
    if (!user || !(await this.passwords.verify(user.passwordHash, password))) {
      throw new BadRequestException('Password is incorrect');
    }
    if (!(await this.verifySecondFactor(userId, code))) throw new BadRequestException('Invalid code');
    await this.users.setTotp(userId, null);
    await this.audit.record({ action: AuditAction.TWO_FACTOR_DISABLED, entityType: 'User', entityId: userId });
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { checkPassword } from '@sil/shared';
import { SettingsService } from '../settings/settings.service';

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  /** Verified against unknown usernames so response time does not reveal them. */
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly settings: SettingsService) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= this.hash('dummy-password-for-timing');
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Throws 400 with the list of violations when the password breaks policy. */
  async assertPolicy(password: string, username?: string): Promise<void> {
    const policy = await this.settings.get('security.passwordPolicy');
    const errors = checkPassword(password, policy, username);
    if (errors.length) {
      throw new BadRequestException({ message: 'Password does not meet the policy', errors, code: 'PASSWORD_POLICY' });
    }
  }
}

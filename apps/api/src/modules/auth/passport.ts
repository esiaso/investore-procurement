import { Injectable } from '@nestjs/common';
import { AuthGuard, PassportSerializer, PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import type { SessionUser } from '@sil/shared';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly auth: AuthService) {
    super({ usernameField: 'username', passwordField: 'password' });
  }

  validate(username: string, password: string): Promise<User> {
    return this.auth.validateCredentials(username, password);
  }
}

/**
 * Checks the password only; the controller decides whether to log in or to
 * wait for the second factor.
 */
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}

/** Only the user id goes into the session; everything else is reloaded per request. */
@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly users: UsersService) {
    super();
  }

  serializeUser(user: SessionUser, done: (err: unknown, id?: string) => void): void {
    done(null, user.id);
  }

  async deserializeUser(id: string, done: (err: unknown, user?: SessionUser | false) => void): Promise<void> {
    try {
      // Deactivated or deleted users lose their session immediately.
      done(null, (await this.users.findForSession(id)) ?? false);
    } catch (err) {
      done(err);
    }
  }
}

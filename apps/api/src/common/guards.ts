import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SessionUser } from '@sil/shared';
import {
  ALLOW_PENDING_PASSWORD_KEY,
  ANY_PERMISSIONS_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  STORE_SCOPE_KEY,
} from './decorators';
import { StoreScope } from './store-scope';

/** Global: every route needs a logged-in session unless marked @Public(). */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (!req.isAuthenticated?.() || !req.user) throw new UnauthorizedException('Not logged in');

    const user = req.user as SessionUser;
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, targets)) {
      throw new ForbiddenException({ message: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    return true;
  }
}

/** Global: enforces @RequirePermissions(). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets);
    if (!required?.length && !any?.length) return true;
    const user = context.switchToHttp().getRequest<Request>().user as SessionUser | undefined;
    const held = new Set(user?.permissions ?? []);
    const missing = (required ?? []).filter((p) => !held.has(p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    if (any?.length && !any.some((p) => held.has(p))) throw new ForbiddenException(`Missing permission: one of ${any.join(', ')}`);
    return true;
  }
}

/** Global: enforces @StoreScoped() against the user's store assignments. */
@Injectable()
export class StoreScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const locations = this.reflector.getAllAndOverride<string[]>(STORE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!locations?.length) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as SessionUser | undefined;
    const allowed = user ? user.storeIds : [];
    if (allowed === null) return true;

    for (const location of locations) {
      const [source, key] = location.split('.') as ['params' | 'query' | 'body', string];
      const raw = (req[source] as Record<string, unknown> | undefined)?.[key];
      const values = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
      for (const v of values) {
        if (!StoreScope.allows(allowed, String(v))) {
          throw new ForbiddenException('You do not have access to this store');
        }
      }
    }
    return true;
  }
}

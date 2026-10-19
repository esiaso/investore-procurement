import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionCode, SessionUser } from '@sil/shared';

export const IS_PUBLIC_KEY = 'isPublic';
/** Route needs no authenticated session. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPassword';
/** Route stays reachable while the user must still change their password. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

export const PERMISSIONS_KEY = 'permissions';
/** All listed permissions are required. */
export const RequirePermissions = (...permissions: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const STORE_SCOPE_KEY = 'storeScope';
/**
 * Request locations ("params.id", "query.storeId", "body.storeId") holding a
 * store id the current user must have access to. Missing values are ignored.
 */
export const StoreScoped = (...locations: string[]) => SetMetadata(STORE_SCOPE_KEY, locations);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest().user;
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from '@sil/shared';

export interface RequestContextData {
  requestId: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Stores the current user may see; null = all stores. */
  storeIds: string[] | null;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  run<T>(data: Partial<RequestContextData>, fn: () => T): T {
    return storage.run(
      {
        requestId: randomUUID(),
        userId: null,
        username: null,
        ip: null,
        userAgent: null,
        storeIds: null,
        ...data,
      },
      fn,
    );
  },

  /** Updates the current context in place (e.g. right after login). */
  setUser(user: SessionUser | null): void {
    const ctx = storage.getStore();
    if (!ctx) return;
    ctx.userId = user?.id ?? null;
    ctx.username = user?.username ?? null;
    ctx.storeIds = user ? user.storeIds : [];
  },
};

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const user = req.user as SessionUser | undefined;
  RequestContext.run(
    {
      userId: user?.id ?? null,
      username: user?.username ?? null,
      ip: req.ip ?? req.socket.remoteAddress ?? null,
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      // Unauthenticated requests can see no store data.
      storeIds: user ? user.storeIds : [],
    },
    () => next(),
  );
}

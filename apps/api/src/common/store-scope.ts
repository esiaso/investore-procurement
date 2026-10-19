import { ForbiddenException } from '@nestjs/common';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { RequestContext } from './request-context';

/**
 * Per-store data scoping. The allowed store ids come from the request context
 * (null = all stores). Services call `apply` on every query over store-owned
 * rows and `assert` before touching a single row.
 */
export const StoreScope = {
  current(): string[] | null {
    const ctx = RequestContext.get();
    // Outside a request (seeds, jobs) there is no scoping.
    if (!ctx) return null;
    return ctx.storeIds;
  },

  allows(allowed: string[] | null, storeId: string): boolean {
    return allowed === null || allowed.includes(storeId);
  },

  assert(storeId: string): void {
    if (!StoreScope.allows(StoreScope.current(), storeId)) {
      throw new ForbiddenException('You do not have access to this store');
    }
  },

  /** Adds `column IN (allowed)` to the query; `column` is e.g. "bin.store_id". */
  apply<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, column: string): SelectQueryBuilder<T> {
    const allowed = StoreScope.current();
    if (allowed === null) return qb;
    if (allowed.length === 0) return qb.andWhere('1 = 0');
    return qb.andWhere(`${column} IN (:...scopeStoreIds)`, { scopeStoreIds: allowed });
  },
};

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@sil/shared';

/**
 * Department documents (requisitions, issues, returns) are visible to the
 * department's own staff and to users of the store involved (or store.all).
 */
export function canSee(actor: SessionUser, doc: { departmentId: string; storeId: string }): boolean {
  return actor.storeIds === null || actor.storeIds.includes(doc.storeId) || (!!actor.departmentId && actor.departmentId === doc.departmentId);
}

export function assertCanSee(actor: SessionUser, doc: { departmentId: string; storeId: string }, what: string): void {
  if (!canSee(actor, doc)) throw new NotFoundException(`${what} not found`);
}

/** Users without store.all act for their own department only. */
export function assertOwnDepartment(actor: SessionUser, departmentId: string): void {
  if (actor.storeIds === null) return;
  if (actor.departmentId !== departmentId) throw new ForbiddenException('You can only act for your own department');
}

/** SQL filter for lists: `<alias>.store_id` in scope or `<alias>.department_id` = own department. */
export function scopeClause(actor: SessionUser, alias: string): { sql: string; params: Record<string, unknown> } | null {
  if (actor.storeIds === null) return null;
  const stores = actor.storeIds.length ? actor.storeIds : ['00000000-0000-0000-0000-000000000000'];
  return {
    sql: `(${alias}.store_id IN (:...scopeStores) OR ${alias}.department_id = :scopeDept)`,
    params: { scopeStores: stores, scopeDept: actor.departmentId ?? '00000000-0000-0000-0000-000000000000' },
  };
}

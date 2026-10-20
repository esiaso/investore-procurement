import {
  EntityManager,
  EntityMetadata,
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  ObjectLiteral,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { AuditAction } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { AuditLog } from './audit-log.entity';

/** Never written to the audit trail in clear. */
const REDACTED_FIELDS = new Set(['passwordHash', 'totpSecretEnc', 'bankAccountEnc']);
/** Bookkeeping columns not worth diffing. */
const IGNORED_FIELDS = new Set(['updatedAt', 'updatedBy']);
/** Tables that are not audited row-by-row (the audit log itself, counters). */
// The stock ledger is its own append-only trail; balances are derived from it.
// Notifications and the mail outbox are delivery plumbing; budget entries are an append-only ledger.
const SKIPPED_ENTITIES = new Set([
  'AuditLog',
  'DocumentSequence',
  'StockTransaction',
  'StockBalance',
  'ItemStoreCost',
  'Notification',
  'EmailOutbox',
  'BudgetEntry',
  // Job runs are themselves the log of background work.
  'JobRun',
  // eTIMS keeps its own logs: every call (masked) and the outbox history.
  'EtimsTransmission',
  'EtimsOutbox',
]);

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'id' in (value as ObjectLiteral)) return (value as ObjectLiteral).id;
  return value;
}

/**
 * Column values as plain JSON. Many-to-many (join table) changes raise no
 * entity events; services that change them audit them explicitly.
 */
export function snapshot(metadata: EntityMetadata, entity: ObjectLiteral | undefined): Record<string, unknown> | null {
  if (!entity) return null;
  const out: Record<string, unknown> = {};
  for (const column of metadata.columns) {
    if (column.relationMetadata && !column.propertyName.endsWith('Id')) continue;
    const value = column.getEntityValue(entity);
    if (value === undefined) continue;
    out[column.propertyName] = REDACTED_FIELDS.has(column.propertyName) ? (value ? '[REDACTED]' : null) : normalise(value);
  }
  return out;
}

function changedOnly(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (!after || !(key in after)) continue;
    const bv = before?.[key];
    const av = after[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[key] = bv ?? null;
      a[key] = av ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

export async function writeAudit(
  manager: EntityManager,
  entry: {
    action: AuditAction | string;
    entityType: string;
    entityId: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    userId?: string | null;
    username?: string | null;
  },
): Promise<void> {
  const ctx = RequestContext.get();
  const repo = manager.getRepository(AuditLog);
  await repo.insert(repo.create({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    userId: entry.userId !== undefined ? entry.userId : (ctx?.userId ?? null),
    username: entry.username !== undefined ? entry.username : (ctx?.username ?? (ctx ? null : 'system')),
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
    requestId: ctx?.requestId ?? null,
  }));
}

function entityIdOf(metadata: EntityMetadata, entity: ObjectLiteral | undefined): string | null {
  if (!entity) return null;
  const id = metadata.getEntityIdMixedMap(entity);
  if (id === undefined || id === null) return null;
  return typeof id === 'object' ? JSON.stringify(id) : String(id);
}

/**
 * Writes an audit row for every insert/update/remove done through the
 * repository/entity-manager API, inside the same transaction as the change.
 */
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  private skip(metadata: EntityMetadata): boolean {
    return SKIPPED_ENTITIES.has(metadata.name);
  }

  beforeInsert(event: InsertEvent<ObjectLiteral>): void {
    const userId = RequestContext.get()?.userId;
    if (!userId || !event.entity) return;
    if (event.metadata.findColumnWithPropertyName('createdBy') && !event.entity.createdBy) event.entity.createdBy = userId;
    if (event.metadata.findColumnWithPropertyName('updatedBy')) event.entity.updatedBy = userId;
  }

  beforeUpdate(event: UpdateEvent<ObjectLiteral>): void {
    const userId = RequestContext.get()?.userId;
    if (!userId || !event.entity) return;
    if (event.metadata.findColumnWithPropertyName('updatedBy')) event.entity.updatedBy = userId;
  }

  async afterInsert(event: InsertEvent<ObjectLiteral>): Promise<void> {
    if (this.skip(event.metadata)) return;
    await writeAudit(event.manager, {
      action: AuditAction.CREATE,
      entityType: event.metadata.name,
      entityId: entityIdOf(event.metadata, event.entity),
      after: snapshot(event.metadata, event.entity),
    });
  }

  async afterUpdate(event: UpdateEvent<ObjectLiteral>): Promise<void> {
    if (this.skip(event.metadata)) return;
    const before = snapshot(event.metadata, event.databaseEntity);
    const after = { ...(before ?? {}), ...(snapshot(event.metadata, event.entity as ObjectLiteral) ?? {}) };
    const diff = changedOnly(before, after);
    if (!diff) return;
    await writeAudit(event.manager, {
      action: AuditAction.UPDATE,
      entityType: event.metadata.name,
      entityId: entityIdOf(event.metadata, event.databaseEntity ?? (event.entity as ObjectLiteral)),
      before: diff.before,
      after: diff.after,
    });
  }

  async afterRemove(event: RemoveEvent<ObjectLiteral>): Promise<void> {
    if (this.skip(event.metadata)) return;
    const source = event.databaseEntity ?? event.entity;
    const id = event.entityId !== undefined && event.entityId !== null ? event.entityId : entityIdOf(event.metadata, source);
    await writeAudit(event.manager, {
      action: AuditAction.DELETE,
      entityType: event.metadata.name,
      entityId: typeof id === 'object' && id !== null ? JSON.stringify(id) : (id as string | null),
      before: snapshot(event.metadata, source),
    });
  }
}

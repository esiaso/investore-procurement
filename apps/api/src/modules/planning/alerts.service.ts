import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { NotificationCategory, Permissions, StockAlertStatus, StockAlertType } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { StockAlert } from './planning.entities';

export interface NewAlert {
  type: StockAlertType;
  storeId: string;
  itemId: string;
  batchId?: string | null;
  horizonDays?: number | null;
  dedupeKey: string;
  message: string;
  details?: Record<string, unknown>;
  value?: number | null;
}

const CATEGORY: Record<StockAlertType, NotificationCategory> = {
  [StockAlertType.REORDER]: NotificationCategory.REORDER,
  [StockAlertType.STOCKOUT]: NotificationCategory.STOCKOUT,
  [StockAlertType.NEAR_EXPIRY]: NotificationCategory.EXPIRY,
  [StockAlertType.EXPIRED]: NotificationCategory.EXPIRY,
};

const TITLE: Record<StockAlertType, string> = {
  [StockAlertType.REORDER]: 'at or below reorder level',
  [StockAlertType.STOCKOUT]: 'out of stock',
  [StockAlertType.NEAR_EXPIRY]: 'nearing expiry',
  [StockAlertType.EXPIRED]: 'expired and put on hold',
};

const LINK: Record<StockAlertType, string> = {
  [StockAlertType.REORDER]: '/stock-planning/reorder',
  [StockAlertType.STOCKOUT]: '/stock-planning/reorder',
  [StockAlertType.NEAR_EXPIRY]: '/stock-planning/expiry',
  [StockAlertType.EXPIRED]: '/stock-planning/expiry',
};

/** Stock alerts: insert-once by key, resolved when the condition clears, notified per store. */
@Injectable()
export class AlertsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** Inserts the alerts that are not already there; returns only the new ones. */
  async raise(m: EntityManager, alerts: NewAlert[]): Promise<StockAlert[]> {
    const created: StockAlert[] = [];
    for (const a of alerts) {
      const rows: StockAlert[] = await m.query(
        `INSERT INTO stock_alert (type, store_id, item_id, batch_id, horizon_days, dedupe_key, message, details, value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id, type, store_id AS "storeId", item_id AS "itemId", batch_id AS "batchId", horizon_days AS "horizonDays", message`,
        [a.type, a.storeId, a.itemId, a.batchId ?? null, a.horizonDays ?? null, a.dedupeKey, a.message.slice(0, 300), a.details ?? {}, a.value ?? null],
      );
      if (rows[0]) created.push(rows[0]);
    }
    return created;
  }

  /** Resolves open alerts of a type in a store whose item is no longer in `stillOpen`; frees their key. */
  async resolveExcept(m: EntityManager, type: StockAlertType, storeId: string, stillOpen: Set<string>): Promise<number> {
    const open: { id: string; item_id: string }[] = await m.query(
      `SELECT id, item_id FROM stock_alert WHERE type = $1 AND store_id = $2 AND status = 'OPEN'`,
      [type, storeId],
    );
    const done = open.filter((o) => !stillOpen.has(o.item_id)).map((o) => o.id);
    if (done.length) {
      await m.query(
        `UPDATE stock_alert SET status = 'RESOLVED', resolved_at = now(), dedupe_key = dedupe_key || '|' || id::text WHERE id = ANY($1::uuid[])`,
        [done],
      );
    }
    return done.length;
  }

  /** Users who get stock alerts for a store: inventory.alerts + access to the store. */
  async recipients(m: EntityManager, storeId: string): Promise<string[]> {
    const rows: { id: string }[] = await m.query(
      `SELECT DISTINCT u.id FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $2
        WHERE u.is_active
          AND (EXISTS (SELECT 1 FROM user_store us WHERE us.user_id = u.id AND us.store_id = $1)
               OR EXISTS (SELECT 1 FROM user_role ur2 JOIN role_permission rp2 ON rp2.role_id = ur2.role_id
                           WHERE ur2.user_id = u.id AND rp2.permission_code = $3))`,
      [storeId, Permissions.INVENTORY_ALERTS, Permissions.STORE_ALL],
    );
    return rows.map((r) => r.id);
  }

  /** One message per store and alert type, listing the new alerts (in-app + email per preference). */
  async notify(m: EntityManager, created: StockAlert[]): Promise<number> {
    const groups = new Map<string, StockAlert[]>();
    for (const a of created) {
      const k = `${a.storeId}|${a.type}`;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    let reached = 0;
    for (const [k, alerts] of groups) {
      const [storeId, type] = k.split('|') as [string, StockAlertType];
      const users = await this.recipients(m, storeId);
      if (!users.length) continue;
      const [store] = await m.query(`SELECT name FROM store WHERE id = $1`, [storeId]);
      const n = alerts.length;
      const title = `${store?.name ?? 'Store'}: ${n} item${n === 1 ? '' : 's'} ${TITLE[type]}`;
      const lines = alerts.map((a) => `• ${a.message}`);
      const sent = await this.notifications.dispatch(m, users, CATEGORY[type], {
        title,
        body: lines.slice(0, 5).join('\n') + (n > 5 ? `\n… and ${n - 5} more` : ''),
        link: `${LINK[type]}?storeId=${storeId}`,
        emailText: `${title}\n\n${lines.join('\n')}\n\nOpen the system to act on these alerts.`,
      });
      await m.query(`UPDATE stock_alert SET notified_count = $2 WHERE id = ANY($1::uuid[])`, [alerts.map((a) => a.id), sent]);
      reached += sent;
    }
    return reached;
  }

  async list(q: { storeId?: string; type?: string; status?: string; storeIds: string[] | null }) {
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = ['1 = 1'];
    if (q.storeIds !== null) where.push(`a.store_id = ANY(${p(q.storeIds)}::uuid[])`);
    if (q.storeId) where.push(`a.store_id = ${p(q.storeId)}`);
    if (q.type) where.push(`a.type = ${p(q.type)}`);
    where.push(`a.status = ${p(q.status ?? StockAlertStatus.OPEN)}`);
    return this.ds.query(
      `SELECT a.id, a.type, a.status, a.message, a.horizon_days AS "horizonDays", a.value::float AS value, a.details,
              a.raised_at AS "raisedAt", a.resolved_at AS "resolvedAt", a.store_id AS "storeId", s.name AS "storeName",
              a.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName", a.batch_id AS "batchId", b.batch_no AS "batchNo"
         FROM stock_alert a JOIN store s ON s.id = a.store_id JOIN item i ON i.id = a.item_id LEFT JOIN batch b ON b.id = a.batch_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.raised_at DESC LIMIT 500`,
      params,
    );
  }
}

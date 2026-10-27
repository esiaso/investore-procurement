import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Permissions as P, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { ApprovalsService } from '../approvals/approvals.service';
import { SettingsService } from '../settings/settings.service';
import { WRITE_OFF_REASONS } from './report-types';

export interface Tile {
  key: string;
  section: string;
  label: string;
  value: number;
  format: 'count' | 'money';
  link: string;
  /** warning / error when the number needs attention. */
  tone?: 'default' | 'warning' | 'error' | 'success';
  hint?: string;
}

export interface Trend {
  key: string;
  label: string;
  format: 'money' | 'count';
  points: { period: string; value: number }[];
}

/**
 * The home dashboard: tiles chosen by the user's permissions (pharmacy work,
 * stock alerts and value, procurement pipeline, sales, integrations,
 * documents) within their store scope, and six-month trends.
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
  ) {}

  async get(user: SessionUser) {
    const can = (...p: string[]) => p.some((x) => user.permissions.includes(x));
    const scope = StoreScope.current();
    const tz = await this.settings.get('locale.timezone');
    const today = await this.settings.today();
    const month = `${today.slice(0, 7)}-01`;
    /** `col` in the user's stores; params start at $1 = scope. */
    const sc = (col: string) => `($1::uuid[] IS NULL OR ${col} = ANY($1::uuid[]))`;
    const one = async (sql: string, extra: unknown[] = []): Promise<number> => Number((await this.ds.query(sql, [scope, ...extra]))[0]?.v ?? 0);
    /** Records not tied to a store. */
    const all = async (sql: string, params: unknown[] = []): Promise<number> => Number((await this.ds.query(sql, params))[0]?.v ?? 0);
    const tiles: Tile[] = [];
    const add = (t: Tile) => tiles.push({ tone: 'default', ...t });

    const inbox = (await this.approvals.inbox(user)) as unknown[];
    if (inbox.length || can(P.PURCHASING_READ)) add({ key: 'approvals', section: 'My work', label: 'Waiting for my approval', value: inbox.length, format: 'count', link: '/approvals', tone: inbox.length ? 'warning' : 'success' });

    if (can(P.PHARMACY_READ)) {
      const waiting = await one(`SELECT COUNT(*) AS v FROM prescription WHERE status IN ('RECEIVED', 'VERIFIED', 'PARTIALLY_DISPENSED') AND ${sc('store_id')}`);
      add({ key: 'rx-waiting', section: 'Pharmacy', label: 'Prescriptions waiting', value: waiting, format: 'count', link: '/pharmacy', tone: waiting ? 'warning' : 'default' });
      add({ key: 'rx-today', section: 'Pharmacy', label: 'Dispenses today', value: await one(`SELECT COUNT(*) AS v FROM dispense WHERE (dispensed_at AT TIME ZONE $2)::date = $3::date AND ${sc('store_id')}`, [tz, today]), format: 'count', link: '/reports?key=dispensing-volume' });
      add({
        key: 'overrides',
        section: 'Pharmacy',
        label: 'Interaction overrides (7 days)',
        value: await one(`SELECT COUNT(*) AS v FROM interaction_override o JOIN prescription rx ON rx.id = o.prescription_id WHERE o.at > now() - interval '7 days' AND ${sc('rx.store_id')}`),
        format: 'count',
        link: '/reports?key=interaction-alerts',
      });
    }

    if (can(P.INVENTORY_READ, P.INVENTORY_ALERTS)) {
      const alerts: { type: string; n: number }[] = await this.ds.query(`SELECT type, COUNT(*)::int AS n FROM stock_alert WHERE status = 'OPEN' AND ${sc('store_id')} GROUP BY type`, [scope]);
      const n = (t: string) => alerts.find((a) => a.type === t)?.n ?? 0;
      add({ key: 'expired', section: 'Stock', label: 'Expired batches in stock', value: n('EXPIRED'), format: 'count', link: '/stock-planning/alerts?type=EXPIRED', tone: n('EXPIRED') ? 'error' : 'success' });
      add({ key: 'near-expiry', section: 'Stock', label: 'Near-expiry alerts', value: n('NEAR_EXPIRY'), format: 'count', link: '/stock-planning/alerts?type=NEAR_EXPIRY', tone: n('NEAR_EXPIRY') ? 'warning' : 'default' });
      add({ key: 'reorder', section: 'Stock', label: 'At reorder level', value: n('REORDER'), format: 'count', link: '/stock-planning/alerts?type=REORDER', tone: n('REORDER') ? 'warning' : 'default' });
      add({ key: 'stockout', section: 'Stock', label: 'Stocked out', value: n('STOCKOUT'), format: 'count', link: '/stock-planning/alerts?type=STOCKOUT', tone: n('STOCKOUT') ? 'error' : 'success' });
      add({
        key: 'to-issue',
        section: 'Stock',
        label: 'Requisitions to issue',
        value: await one(`SELECT COUNT(*) AS v FROM store_requisition WHERE status IN ('APPROVED', 'PARTIALLY_ISSUED') AND ${sc('store_id')}`),
        format: 'count',
        link: '/store-requisitions',
      });
    }

    if (can(P.INVENTORY_VALUATION)) {
      add({ key: 'stock-value', section: 'Value', label: 'Stock value', value: await one(`SELECT COALESCE(SUM(value_delta), 0)::float AS v FROM stock_transaction WHERE ${sc('store_id')}`), format: 'money', link: '/reports?key=stock-status' });
      const horizon = await this.settings.get('reports.nearExpiryDays');
      add({
        key: 'expiring-value',
        section: 'Value',
        label: `Value expiring in ${horizon} days`,
        value: await one(
          `SELECT COALESCE(SUM(sb.on_hand * COALESCE(b.unit_cost, 0)), 0)::float AS v FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id
            WHERE sb.on_hand > 0 AND b.expiry_date BETWEEN $2::date AND $2::date + $3::int AND ${sc('sb.store_id')}`,
          [today, horizon],
        ),
        format: 'money',
        link: '/reports?key=near-expiry',
      });
      const losses = await one(`SELECT COALESCE(-SUM(value_delta), 0)::float AS v FROM stock_transaction WHERE reason_code IN ${WRITE_OFF_REASONS} AND effective_date >= $2::date AND ${sc('store_id')}`, [month]);
      add({ key: 'losses', section: 'Value', label: 'Write-offs this month', value: losses, format: 'money', link: '/reports?key=expiry-losses', tone: losses > 0 ? 'warning' : 'default' });
    }

    if (can(P.PURCHASING_READ)) {
      const [open] = await this.ds.query(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE expected_delivery < $2::date)::int AS late FROM purchase_order WHERE status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') AND ${sc('store_id')}`,
        [scope, today],
      );
      add({ key: 'open-pos', section: 'Procurement', label: 'Outstanding orders', value: open.n, format: 'count', link: '/reports?key=outstanding-pos' });
      add({ key: 'late-pos', section: 'Procurement', label: 'Orders past due date', value: open.late, format: 'count', link: '/reports?key=outstanding-pos', tone: open.late ? 'error' : 'success' });
      add({ key: 'inspection', section: 'Procurement', label: 'Deliveries awaiting inspection', value: await one(`SELECT COUNT(*) AS v FROM goods_received_note WHERE status = 'INSPECTION' AND ${sc('store_id')}`), format: 'count', link: '/grns' });
      add({
        key: 'spend',
        section: 'Procurement',
        label: 'Ordered this month',
        value: await one(`SELECT COALESCE(SUM(total), 0)::float AS v FROM purchase_order WHERE status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') AND order_date >= $2::date AND ${sc('store_id')}`, [month]),
        format: 'money',
        link: '/reports?key=po-status',
      });
      if (can(P.PURCHASING_INVOICE, P.PURCHASING_PAYMENT)) {
        add({ key: 'to-pay', section: 'Procurement', label: 'Approved invoices to pay', value: await all(`SELECT COUNT(*) AS v FROM supplier_invoice WHERE status = 'APPROVED'`), format: 'count', link: '/invoices' });
      }
    }

    if (can(P.BILLING_READ, P.POS_REPORTS)) {
      const sales = (from: string) =>
        one(`SELECT COALESCE(SUM(CASE WHEN doc_type = 'CREDIT_NOTE' THEN -total_amount ELSE total_amount END), 0)::float AS v FROM sales_invoice WHERE status = 'ISSUED' AND (issued_at AT TIME ZONE $2)::date >= $3::date AND ${sc('store_id')}`, [tz, from]);
      add({ key: 'sales-today', section: 'Sales', label: 'Sales today', value: await sales(today), format: 'money', link: '/sales' });
      add({ key: 'sales-month', section: 'Sales', label: 'Sales this month', value: await sales(month), format: 'money', link: '/reports?key=sales-margin' });
    }

    if (can(P.ETIMS_READ)) {
      const n = await all(`SELECT COUNT(*) AS v FROM etims_outbox WHERE status = 'FAILED' OR (status = 'PENDING' AND created_at < now() - interval '1 hour')`);
      add({ key: 'etims', section: 'Integrations', label: 'eTIMS failed or delayed', value: n, format: 'count', link: '/etims', tone: n ? 'error' : 'success' });
    }
    if (can(P.HMIS_READ)) {
      const n = await all(`SELECT COUNT(*) AS v FROM hmis_message WHERE status = 'FAILED'`);
      add({ key: 'hmis', section: 'Integrations', label: 'HMIS messages failed', value: n, format: 'count', link: '/hmis', tone: n ? 'error' : 'success' });
    }
    if (can(P.ACCOUNTING_READ)) {
      const n = await all(`SELECT COUNT(*) AS v FROM accounting_posting WHERE status IN ('FAILED', 'BLOCKED')`);
      add({ key: 'quickbooks', section: 'Integrations', label: 'QuickBooks errors', value: n, format: 'count', link: '/accounting/quickbooks', tone: n ? 'error' : 'success' });
    }
    if (can(P.DOCUMENTS_READ, P.SUPPLIERS_READ)) {
      const n = await all(`SELECT COUNT(*) AS v FROM supplier_document WHERE expires_on <= $1::date + 30`, [today]);
      add({ key: 'docs-expiring', section: 'Documents', label: 'Supplier documents expired or expiring in 30 days', value: n, format: 'count', link: '/documents?tab=expiring', tone: n ? 'warning' : 'success' });
    }

    return { tiles, trends: await this.trends(user, scope, tz, today) };
  }

  /** Six months: stock value at month end, ordered, sales, write-offs. */
  private async trends(user: SessionUser, scope: string[] | null, tz: string, today: string): Promise<Trend[]> {
    const can = (...p: string[]) => p.some((x) => user.permissions.includes(x));
    const months: { m: string; start: string; end: string }[] = await this.ds.query(
      `SELECT to_char(d, 'YYYY-MM') AS m, d::date::text AS start, (d + interval '1 month' - interval '1 day')::date::text AS end
         FROM generate_series(date_trunc('month', $1::date) - interval '5 months', date_trunc('month', $1::date), '1 month') d`,
      [today],
    );
    /** $1 scope, $2 first month, $3 today ($4 time zone when `zoned`). */
    const series = async (sql: string, zoned = false) => {
      const rows: { m: string; v: number }[] = await this.ds.query(sql, [scope, months[0].start, today, ...(zoned ? [tz] : [])]);
      return months.map((x) => ({ period: x.m, value: Math.round(Number(rows.find((r) => r.m === x.m)?.v ?? 0) * 100) / 100 }));
    };
    const sc = (col: string) => `($1::uuid[] IS NULL OR ${col} = ANY($1::uuid[]))`;
    const out: Trend[] = [];
    if (can(P.INVENTORY_VALUATION)) {
      const rows: { m: string; v: number }[] = await this.ds.query(
        `SELECT to_char(m, 'YYYY-MM') AS m, (SELECT COALESCE(SUM(t.value_delta), 0) FROM stock_transaction t WHERE t.effective_date < m + interval '1 month' AND ${sc('t.store_id')})::float AS v
           FROM generate_series($2::date, $3::date, '1 month') m`,
        [scope, months[0].start, today],
      );
      out.push({ key: 'stock-value', label: 'Stock value at month end', format: 'money', points: months.map((x) => ({ period: x.m, value: Math.round(Number(rows.find((r) => r.m === x.m)?.v ?? 0)) })) });
      out.push({
        key: 'write-offs',
        label: 'Write-offs',
        format: 'money',
        points: await series(
          `SELECT to_char(effective_date, 'YYYY-MM') AS m, -SUM(value_delta)::float AS v FROM stock_transaction
            WHERE reason_code IN ${WRITE_OFF_REASONS} AND effective_date BETWEEN $2::date AND $3::date AND ${sc('store_id')} GROUP BY 1`,
        ),
      });
    }
    if (can(P.PURCHASING_READ)) {
      out.push({
        key: 'ordered',
        label: 'Ordered (purchase orders)',
        format: 'money',
        points: await series(
          `SELECT to_char(order_date, 'YYYY-MM') AS m, SUM(total)::float AS v FROM purchase_order
            WHERE status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') AND order_date BETWEEN $2::date AND $3::date AND ${sc('store_id')} GROUP BY 1`,
        ),
      });
    }
    if (can(P.BILLING_READ, P.POS_REPORTS)) {
      out.push({
        key: 'sales',
        label: 'Sales',
        format: 'money',
        points: await series(
          `SELECT to_char(issued_at AT TIME ZONE $4, 'YYYY-MM') AS m, SUM(CASE WHEN doc_type = 'CREDIT_NOTE' THEN -total_amount ELSE total_amount END)::float AS v
             FROM sales_invoice WHERE status = 'ISSUED' AND (issued_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ${sc('store_id')} GROUP BY 1`,
          true,
        ),
      });
    }
    return out;
  }
}

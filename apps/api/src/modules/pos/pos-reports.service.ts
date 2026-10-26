import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StoreScope } from '../../common/store-scope';
import { SettingsService } from '../settings/settings.service';
import { PosEventsQueryDto, PosReportDto } from './pos.dto';

/**
 * Till reports: sales by cashier, shift, item, category, payment mode or
 * hour, with OTC margin (net of VAT, less FEFO batch cost, net of refunds);
 * voids, refunds and overrides.
 */
@Injectable()
export class PosReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  private scope(params: unknown[], storeId?: string) {
    let f = '';
    if (storeId) {
      params.push(storeId);
      f += ` AND ps.store_id = $${params.length}`;
    }
    const allowed = StoreScope.current();
    if (allowed !== null) {
      params.push(allowed);
      f += ` AND ps.store_id = ANY($${params.length}::uuid[])`;
    }
    return f;
  }

  async sales(q: PosReportDto) {
    const tz = await this.settings.get('locale.timezone');
    const params: unknown[] = [q.from, q.to, tz];
    const f = this.scope(params, q.storeId);
    if (q.groupBy === 'mode') {
      return this.ds.query(
        `SELECT sp.mode_code AS key, pm.name AS label, COUNT(DISTINCT ps.id)::int AS sales, SUM(sp.amount)::float AS amount
           FROM pos_sale ps JOIN sales_payment sp ON sp.invoice_id = ps.invoice_id LEFT JOIN payment_mode pm ON pm.code = sp.mode_code
          WHERE (ps.sold_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date AND ps.status <> 'VOIDED' ${f}
          GROUP BY sp.mode_code, pm.name ORDER BY amount DESC`,
        params,
      );
    }
    const key = {
      cashier: `u.full_name`,
      shift: `sh.number`,
      item: `i.code || ' · ' || i.name`,
      category: `cat.name`,
      hour: `lpad(extract(hour FROM l.sold_at AT TIME ZONE $3)::text, 2, '0') || ':00'`,
    }[q.groupBy];
    return this.ds.query(
      `WITH l AS (
         SELECT ps.id AS sale_id, ps.sold_at, ps.cashier_id, ps.shift_id, sl.item_id, sl.quantity::numeric AS qty, sl.gross_amount::numeric AS gross, sl.net_amount::numeric AS net,
                sl.discount_amount::numeric AS discount,
                COALESCE((SELECT SUM(cl.quantity) FROM sales_invoice_line cl JOIN sales_invoice c ON c.id = cl.invoice_id WHERE cl.original_line_id = sl.id AND c.status = 'ISSUED'), 0) AS credited,
                (SELECT COALESCE(SUM((a->>'quantity')::numeric * (a->>'unitCost')::numeric), 0) FROM jsonb_array_elements(sl.allocations) a) AS cost
           FROM pos_sale ps JOIN sales_invoice_line sl ON sl.invoice_id = ps.invoice_id
          WHERE (ps.sold_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ${f})
       SELECT ${key} AS key, COUNT(DISTINCT l.sale_id)::int AS sales,
              ROUND(SUM(l.qty - l.credited), 4)::float AS quantity,
              ROUND(SUM(l.gross * (1 - l.credited / NULLIF(l.qty, 0))), 2)::float AS gross,
              ROUND(SUM(l.discount * (1 - l.credited / NULLIF(l.qty, 0))), 2)::float AS discounts,
              ROUND(SUM(l.net * (1 - l.credited / NULLIF(l.qty, 0))), 2)::float AS net,
              ROUND(SUM(l.cost * (1 - l.credited / NULLIF(l.qty, 0))), 2)::float AS cost,
              ROUND(SUM((l.net - l.cost) * (1 - l.credited / NULLIF(l.qty, 0))), 2)::float AS margin,
              ROUND(100 * SUM((l.net - l.cost) * (1 - l.credited / NULLIF(l.qty, 0))) / NULLIF(SUM(l.net * (1 - l.credited / NULLIF(l.qty, 0))), 0), 1)::float AS "marginPct"
         FROM l JOIN app_user u ON u.id = l.cashier_id JOIN pos_shift sh ON sh.id = l.shift_id JOIN item i ON i.id = l.item_id JOIN item_category cat ON cat.id = i.category_id
        GROUP BY 1 ORDER BY ${q.groupBy === 'hour' ? '1' : 'gross DESC'}`,
      params.map((p, i) => (i === 2 ? tz : p)),
    );
  }

  /** Voids, refunds, overrides and approvals with who did and who approved them. */
  async events(q: PosEventsQueryDto) {
    const params: unknown[] = [q.from, q.to];
    let f = '';
    if (q.storeId) {
      params.push(q.storeId);
      f += ` AND t.store_id = $${params.length}`;
    }
    const allowed = StoreScope.current();
    if (allowed !== null) {
      params.push(allowed);
      f += ` AND t.store_id = ANY($${params.length}::uuid[])`;
    }
    return this.ds.query(
      `SELECT e.at, e.type, t.code AS terminal, sh.number AS shift, si.number AS invoice, u.full_name AS "user", a.full_name AS "approvedBy", e.amount::float, e.reason,
              e.details->>'modeCode' AS "refundMode", e.details->>'creditNote' AS "creditNote"
         FROM pos_event e LEFT JOIN pos_terminal t ON t.id = e.terminal_id LEFT JOIN pos_shift sh ON sh.id = e.shift_id
         LEFT JOIN pos_sale ps ON ps.id = e.sale_id LEFT JOIN sales_invoice si ON si.id = ps.invoice_id
         JOIN app_user u ON u.id = e.user_id LEFT JOIN app_user a ON a.id = e.approved_by
        WHERE e.at >= $1::date AND e.at < $2::date + 1 ${f}
        ORDER BY e.at DESC LIMIT 2000`,
      params,
    );
  }
}

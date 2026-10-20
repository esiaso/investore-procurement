import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StoreScope } from '../../common/store-scope';
import { SettingsService } from '../settings/settings.service';

export interface PeriodQuery {
  from: string;
  to: string;
  storeId?: string;
}

/**
 * Finance / tax reports over sales invoices, credit notes, supplier invoices
 * and the eTIMS outbox. Periods are calendar dates in the hospital time zone.
 */
@Injectable()
export class SalesReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  /** Parameters and SQL filter on a store column, honouring the user's store scope. */
  private async scope(q: PeriodQuery, column: string, params: unknown[]): Promise<string> {
    let sql = '';
    if (q.storeId) {
      params.push(q.storeId);
      sql += ` AND ${column} = $${params.length}`;
    }
    const allowed = StoreScope.current();
    if (allowed !== null) {
      params.push(allowed);
      sql += ` AND ${column} = ANY($${params.length}::uuid[])`;
    }
    return sql;
  }

  private async period(q: PeriodQuery, column: string): Promise<{ params: unknown[]; sql: string }> {
    const tz = await this.settings.get('locale.timezone');
    const params: unknown[] = [q.from, q.to, tz];
    return { params, sql: `(${column} AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date` };
  }

  /** Outbox by status and kind per outlet, plus what is overdue. */
  async etimsSyncStatus(q: Partial<PeriodQuery>) {
    const params: unknown[] = [];
    const f = await this.scope({ from: '', to: '', ...q }, 'c.store_id', params);
    const byStatus = await this.ds.query(
      `SELECT s.name AS store, o.kind, o.status, count(*)::int AS n, min(o.created_at) AS oldest
         FROM etims_outbox o JOIN etims_config c ON c.id = o.config_id JOIN store s ON s.id = c.store_id
        WHERE true ${f} GROUP BY s.name, o.kind, o.status ORDER BY s.name, o.kind, o.status`,
      params,
    );
    const minutes = await this.settings.get('etims.alertAfterMinutes');
    const overdue = await this.ds.query(
      `SELECT o.id, s.name AS store, o.kind, o.doc_no, o.status, o.attempts, o.result_cd, o.result_msg, o.created_at, o.next_attempt_at
         FROM etims_outbox o JOIN etims_config c ON c.id = o.config_id JOIN store s ON s.id = c.store_id
        WHERE o.status <> 'ACCEPTED' AND o.created_at < now() - ($${params.length + 1} || ' minutes')::interval ${f}
        ORDER BY o.created_at LIMIT 500`,
      [...params, String(minutes)],
    );
    const invoices = await this.ds.query(
      `SELECT si.etims_status AS status, count(*)::int AS n, COALESCE(sum(si.total_amount), 0)::float AS amount
         FROM sales_invoice si JOIN etims_config c ON c.store_id = si.store_id WHERE true ${f} GROUP BY si.etims_status`,
      params,
    );
    const stock = await this.ds.query(
      `SELECT s.name AS store, c.last_stock_txn_id::text AS reported_up_to,
              (SELECT count(*)::int FROM stock_transaction t WHERE t.store_id = c.store_id AND t.id > c.last_stock_txn_id) AS unreported_movements,
              c.stock_report_error
         FROM etims_config c JOIN store s ON s.id = c.store_id WHERE c.is_active ${f}`,
      params,
    );
    return { byStatus, invoices, overdue, stock, alertAfterMinutes: minutes };
  }

  /** Output VAT by eTIMS tax type and local tax category (invoices less credit notes). */
  async vatOutput(q: PeriodQuery) {
    const p = await this.period(q, 'si.issued_at');
    const f = await this.scope(q, 'si.store_id', p.params);
    return this.ds.query(
      `SELECT l.tax_type_code, tc.code AS tax_category, tc.name AS tax_category_name, l.tax_rate_percent::float AS rate,
              sum(CASE WHEN si.doc_type = 'INVOICE' THEN l.gross_amount ELSE -l.gross_amount END)::float AS taxable_incl_vat,
              sum(CASE WHEN si.doc_type = 'INVOICE' THEN l.net_amount ELSE -l.net_amount END)::float AS net,
              sum(CASE WHEN si.doc_type = 'INVOICE' THEN l.tax_amount ELSE -l.tax_amount END)::float AS vat,
              count(DISTINCT si.id) FILTER (WHERE si.doc_type = 'INVOICE')::int AS invoices,
              count(DISTINCT si.id) FILTER (WHERE si.doc_type = 'CREDIT_NOTE')::int AS credit_notes
         FROM sales_invoice_line l JOIN sales_invoice si ON si.id = l.invoice_id JOIN tax_category tc ON tc.id = l.tax_category_id
        WHERE si.status = 'ISSUED' AND ${p.sql} ${f}
        GROUP BY l.tax_type_code, tc.code, tc.name, l.tax_rate_percent ORDER BY l.tax_type_code, tc.code`,
      p.params,
    );
  }

  /** Purchases (supplier invoices) by tax category, split by eTIMS verification. */
  async purchasesByTax(q: PeriodQuery) {
    const params: unknown[] = [q.from, q.to];
    let f = '';
    if (q.storeId) {
      params.push(q.storeId);
      f = ` AND po.store_id = $${params.length}`;
    }
    return this.ds.query(
      `SELECT tc.code AS tax_category, tc.name AS tax_category_name, pl.tax_rate_percent::float AS rate,
              CASE WHEN inv.etims_status = 'VERIFIED' THEN 'VERIFIED' ELSE 'UNVERIFIED' END AS etims,
              count(DISTINCT inv.id)::int AS invoices,
              sum(l.quantity * l.unit_price)::float AS net, sum(l.tax_amount)::float AS vat, sum(l.line_total)::float AS gross
         FROM supplier_invoice_line l JOIN supplier_invoice inv ON inv.id = l.invoice_id
         JOIN purchase_order_line pl ON pl.id = l.po_line_id JOIN purchase_order po ON po.id = inv.purchase_order_id
         JOIN tax_category tc ON tc.id = pl.tax_category_id
        WHERE inv.status NOT IN ('REJECTED', 'CANCELLED') AND inv.invoice_date BETWEEN $1::date AND $2::date ${f}
        GROUP BY tc.code, tc.name, pl.tax_rate_percent, 4 ORDER BY tc.code, 4`,
      params,
    );
  }

  async creditNoteRegister(q: PeriodQuery) {
    const p = await this.period(q, 'cn.issued_at');
    const f = await this.scope(q, 'cn.store_id', p.params);
    return this.ds.query(
      `SELECT cn.number, cn.issued_at, s.name AS store, o.number AS original_invoice, o.cu_invoice_no AS original_cu_invoice_no,
              cn.credit_reason_code, cn.notes AS reason, cn.customer_name, cn.total_amount::float AS amount, cn.total_tax::float AS vat,
              cn.etims_status, cn.cu_invoice_no
         FROM sales_invoice cn JOIN sales_invoice o ON o.id = cn.original_invoice_id JOIN store s ON s.id = cn.store_id
        WHERE cn.doc_type = 'CREDIT_NOTE' AND ${p.sql} ${f}
        ORDER BY cn.issued_at`,
      p.params,
    );
  }

  /**
   * Local documents vs what eTIMS accepted: per outlet, counts and totals of
   * issued vs accepted documents, documents not accepted, accepted documents
   * whose transmitted total differs from the local total, and gaps in the CU
   * receipt counter. (OSCU/VSCU v2.0 offers no "list my sales" call, so the
   * control unit's answers stored on each document are the eTIMS side.)
   */
  async reconciliation(q: PeriodQuery) {
    const p = await this.period(q, 'si.issued_at');
    const f = await this.scope(q, 'si.store_id', p.params);
    const summary = await this.ds.query(
      `SELECT s.name AS store, si.doc_type,
              count(*)::int AS local_count, sum(si.total_amount)::float AS local_total,
              count(*) FILTER (WHERE si.etims_status = 'ACCEPTED')::int AS etims_count,
              COALESCE(sum((o.payload->>'totAmt')::numeric) FILTER (WHERE si.etims_status = 'ACCEPTED'), 0)::float AS etims_total,
              count(*) FILTER (WHERE si.etims_status IN ('PENDING', 'SENT', 'FAILED'))::int AS not_accepted
         FROM sales_invoice si JOIN store s ON s.id = si.store_id
         JOIN etims_config c ON c.store_id = si.store_id
         LEFT JOIN etims_outbox o ON o.kind = 'SALE' AND o.doc_id = si.id
        WHERE si.status = 'ISSUED' AND ${p.sql} ${f}
        GROUP BY s.name, si.doc_type ORDER BY s.name, si.doc_type`,
      p.params,
    );
    const exceptions = await this.ds.query(
      `SELECT si.id, si.number, si.doc_type, s.name AS store, si.issued_at, si.total_amount::float AS local_total,
              (o.payload->>'totAmt')::float AS transmitted_total, si.etims_status, si.etims_error,
              CASE WHEN si.etims_status <> 'ACCEPTED' THEN 'NOT_ACCEPTED'
                   WHEN o.id IS NULL THEN 'NO_OUTBOX'
                   WHEN abs((o.payload->>'totAmt')::numeric - si.total_amount) > 0.01 THEN 'TOTAL_MISMATCH'
                   WHEN si.rcpt_sign IS NULL THEN 'NO_SIGNATURE' END AS issue
         FROM sales_invoice si JOIN store s ON s.id = si.store_id JOIN etims_config c ON c.store_id = si.store_id
         LEFT JOIN etims_outbox o ON o.kind = 'SALE' AND o.doc_id = si.id
        WHERE si.status = 'ISSUED' AND ${p.sql} ${f}
          AND (si.etims_status <> 'ACCEPTED' OR o.id IS NULL OR abs((o.payload->>'totAmt')::numeric - si.total_amount) > 0.01 OR si.rcpt_sign IS NULL)
        ORDER BY si.issued_at LIMIT 1000`,
      p.params,
    );
    const gaps = await this.ds.query(
      `WITH r AS (SELECT si.store_id, si.tot_rcpt_no, lag(si.tot_rcpt_no) OVER (PARTITION BY si.store_id ORDER BY si.tot_rcpt_no) AS prev
                    FROM sales_invoice si WHERE si.tot_rcpt_no IS NOT NULL AND ${p.sql} ${f})
       SELECT s.name AS store, r.prev AS after_receipt, r.tot_rcpt_no AS next_receipt FROM r JOIN store s ON s.id = r.store_id
        WHERE r.prev IS NOT NULL AND r.tot_rcpt_no <> r.prev + 1 ORDER BY s.name, r.prev`,
      p.params,
    );
    const matched = summary.every((r: { local_count: number; etims_count: number; local_total: number; etims_total: number }) => r.local_count === r.etims_count && Math.abs(r.local_total - r.etims_total) < 0.01) && !exceptions.length;
    return { matched, summary, exceptions, receiptGaps: gaps };
  }
}

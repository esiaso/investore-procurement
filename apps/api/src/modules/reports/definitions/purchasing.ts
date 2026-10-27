import { Permissions as P } from '@sil/shared';
import { col, pct, r2, ReportDef, Sql, sum, TXN_CONSUMPTION, WRITE_OFF_REASONS } from '../report-types';

const PURCHASING = [P.PURCHASING_READ];
/** Orders that commit money (not draft, rejected or cancelled). */
const LIVE = `('PENDING_APPROVAL','APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`;
const OPEN = `('APPROVED','SENT','PARTIALLY_RECEIVED')`;

const poStatus: ReportDef = {
  key: 'po-status',
  title: 'Purchase order status',
  group: 'PURCHASING',
  description: 'Purchase orders raised in the period with their status and how much has been received.',
  permissions: PURCHASING,
  filters: ['from', 'to', 'storeId', 'supplierId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Order'),
    col('date', 'Ordered', 'date'),
    col('supplier', 'Supplier'),
    col('store', 'Deliver to'),
    col('status', 'Status'),
    col('expected', 'Expected', 'date'),
    col('total', 'Total', 'money'),
    col('received', 'Received %', 'percent'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT po.number, po.order_date::text AS date, s.name AS supplier, st.name AS store, po.status, po.expected_delivery::text AS expected, ROUND(po.total, 2)::float AS total,
              ROUND(100 * COALESCE((SELECT SUM(l.received_base_qty) / NULLIF(SUM(l.quantity * l.conversion_factor), 0) FROM purchase_order_line l WHERE l.purchase_order_id = po.id), 0), 1)::float AS received
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN store st ON st.id = po.store_id
        WHERE ${q.between('po.order_date', ctx)} AND ${q.store('po.store_id', ctx)} AND ${q.eq('po.supplier_id', ctx.f.supplierId)} AND ${q.eq('po.status::text', ctx.f.status)}
        ORDER BY po.order_date, po.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { total: sum(rows, 'total') } };
  },
};

const outstanding: ReportDef = {
  key: 'outstanding-pos',
  title: 'Outstanding purchase orders',
  group: 'PURCHASING',
  description: 'Approved and sent orders not yet fully received: the value still to come and how late it is.',
  permissions: PURCHASING,
  filters: ['storeId', 'supplierId'],
  landscape: true,
  columns: [
    col('number', 'Order'),
    col('date', 'Ordered', 'date'),
    col('supplier', 'Supplier'),
    col('store', 'Deliver to'),
    col('status', 'Status'),
    col('expected', 'Expected', 'date'),
    col('daysLate', 'Days late', 'number'),
    col('total', 'Order total', 'money'),
    col('outstanding', 'Outstanding value', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT po.number, po.order_date::text AS date, s.name AS supplier, st.name AS store, po.status, po.expected_delivery::text AS expected,
              GREATEST(${q.p(ctx.today)}::date - po.expected_delivery, 0) AS "daysLate", ROUND(po.total, 2)::float AS total,
              ROUND((SELECT SUM(l.line_total * GREATEST(1 - l.received_base_qty / NULLIF(l.quantity * l.conversion_factor, 0), 0)) FROM purchase_order_line l WHERE l.purchase_order_id = po.id), 2)::float AS outstanding
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN store st ON st.id = po.store_id
        WHERE po.status::text IN ${OPEN} AND ${q.store('po.store_id', ctx)} AND ${q.eq('po.supplier_id', ctx.f.supplierId)}
        ORDER BY po.expected_delivery NULLS LAST, po.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { outstanding: sum(rows, 'outstanding') } };
  },
};

const supplierPerformance: ReportDef = {
  key: 'supplier-performance',
  title: 'Supplier performance',
  group: 'PURCHASING',
  description: 'Per supplier in the period: orders and value, deliveries, lead time, on-time delivery, rejections and returns.',
  permissions: [P.PURCHASING_READ, P.SUPPLIERS_PERFORMANCE],
  filters: ['from', 'to', 'supplierId', 'storeId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('supplier', 'Supplier'),
    col('orders', 'Orders', 'number'),
    col('orderValue', 'Order value', 'money'),
    col('deliveries', 'Deliveries', 'number'),
    col('leadDays', 'Average lead time (days)', 'number'),
    col('onTime', 'On time %', 'percent'),
    col('rejected', 'Rejected %', 'percent'),
    col('returns', 'Returns', 'number'),
  ],
  async run(ctx) {
    const q = new Sql();
    const f = q.p(ctx.f.from);
    const t = q.p(ctx.f.to);
    const store = (c: string) => q.store(c, ctx);
    const rows = await ctx.ds.query(
      `SELECT s.name AS supplier,
              (SELECT COUNT(*)::int FROM purchase_order po WHERE po.supplier_id = s.id AND po.status::text IN ${LIVE} AND po.order_date BETWEEN ${f}::date AND ${t}::date AND ${store('po.store_id')}) AS orders,
              (SELECT ROUND(COALESCE(SUM(po.total), 0), 2)::float FROM purchase_order po WHERE po.supplier_id = s.id AND po.status::text IN ${LIVE} AND po.order_date BETWEEN ${f}::date AND ${t}::date AND ${store('po.store_id')}) AS "orderValue",
              g.deliveries, g.lead_days AS "leadDays", g.on_time AS "onTime", g.rejected,
              (SELECT COUNT(*)::int FROM return_to_supplier r WHERE r.supplier_id = s.id AND r.status::text <> 'CANCELLED' AND r.return_date BETWEEN ${f}::date AND ${t}::date AND ${store('r.store_id')}) AS returns
         FROM supplier s
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS deliveries, ROUND(AVG(gr.received_date - po.order_date)::numeric, 1)::float AS lead_days,
                  ROUND(100.0 * COUNT(*) FILTER (WHERE po.expected_delivery IS NULL OR gr.received_date <= po.expected_delivery) / NULLIF(COUNT(*), 0), 1)::float AS on_time,
                  ROUND(100.0 * (SELECT COALESCE(SUM(l.rejected_base_qty), 0) / NULLIF(SUM(l.received_base_qty), 0) FROM grn_line l JOIN goods_received_note g2 ON g2.id = l.grn_id
                                  WHERE g2.supplier_id = s.id AND g2.status::text = 'POSTED' AND g2.received_date BETWEEN ${f}::date AND ${t}::date), 1)::float AS rejected
             FROM goods_received_note gr JOIN purchase_order po ON po.id = gr.purchase_order_id
            WHERE gr.supplier_id = s.id AND gr.status::text = 'POSTED' AND gr.received_date BETWEEN ${f}::date AND ${t}::date AND ${store('gr.store_id')}) g
        WHERE ${q.eq('s.id', ctx.f.supplierId)}
        ORDER BY s.name`,
      q.params,
    );
    return { rows: rows.filter((r: { orders: number; deliveries: number; returns: number }) => r.orders || r.deliveries || r.returns), totals: { orderValue: sum(rows, 'orderValue') } };
  },
};

const priceHistory: ReportDef = {
  key: 'price-history',
  title: 'Price history and variance',
  group: 'PURCHASING',
  description: 'Prices paid per base unit on purchase orders, with the change from the previous order and from the period average.',
  permissions: PURCHASING,
  filters: ['from', 'to', 'itemId', 'supplierId', 'categoryId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('date', 'Ordered', 'date'),
    col('order', 'Order'),
    col('supplier', 'Supplier'),
    col('code', 'Code'),
    col('item', 'Item'),
    col('unitPrice', 'Price per base unit', 'money'),
    col('previous', 'Previous price', 'money'),
    col('change', 'Change %', 'percent'),
    col('vsAverage', 'vs. period average %', 'percent'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT * FROM (
         SELECT po.order_date::text AS date, po.number AS "order", s.name AS supplier, i.code, i.name AS item,
                ROUND(l.unit_price / NULLIF(l.conversion_factor, 0), 4)::float AS "unitPrice",
                ROUND(LAG(l.unit_price / NULLIF(l.conversion_factor, 0)) OVER w, 4)::float AS previous,
                ROUND(AVG(l.unit_price / NULLIF(l.conversion_factor, 0)) OVER (PARTITION BY l.item_id), 4)::float AS average,
                po.order_date AS d, po.supplier_id
           FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id JOIN supplier s ON s.id = po.supplier_id JOIN item i ON i.id = l.item_id
          WHERE po.status::text IN ${LIVE} AND ${q.between('po.order_date', ctx)} AND ${q.eq('l.item_id', ctx.f.itemId)} AND ${q.category('i', ctx)}
         WINDOW w AS (PARTITION BY l.item_id ORDER BY po.order_date, po.number)) h
        WHERE ${q.eq('h.supplier_id', ctx.f.supplierId)}
        ORDER BY item, d LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return {
      rows: rows.map((r: { unitPrice: number; previous: number | null; average: number }) => {
        const { average, d: _d, supplier_id: _s, ...rest } = r as typeof r & { d: unknown; supplier_id: unknown };
        return { ...rest, change: r.previous ? pct(r.unitPrice - r.previous, r.previous) : null, vsAverage: average ? pct(r.unitPrice - average, average) : null };
      }),
    };
  },
};

/** Supply chain KPIs for the period, as rows (metric, value, unit). */
const kpis: ReportDef = {
  key: 'supply-chain-kpis',
  title: 'Supply chain KPIs',
  group: 'SUPPLY_CHAIN',
  description: 'Lead time, on-time-in-full, fill rate, months of stock, wastage, stock-outs and inventory turnover for the period.',
  permissions: [P.PROCUREMENT_KPIS, P.INVENTORY_VALUATION],
  filters: ['from', 'to', 'storeId'],
  required: ['from', 'to'],
  columns: [col('area', 'Area'), col('metric', 'Measure'), col('value', 'Value', 'number'), col('unit', 'Unit'), col('basis', 'Basis')],
  async run(ctx) {
    /** Each query has $1 from and $2 to; the time zone and store filters are added where used. */
    const query = async (sql: (h: { store: (c: string) => string; tz: () => string }) => string) => {
      const q = new Sql();
      q.p(ctx.f.from);
      q.p(ctx.f.to);
      const text = sql({ store: (c) => q.store(c, ctx), tz: () => q.p(ctx.tz) });
      return (await ctx.ds.query(text, q.params))[0];
    };
    const from = '$1';
    const to = '$2';
    const lead = await query(
      ({ store, tz }) => `SELECT COUNT(*)::int AS deliveries, ROUND(AVG(g.received_date - po.order_date)::numeric, 1)::float AS po_to_grn,
              ROUND(AVG(po.order_date - (pr.created_at AT TIME ZONE ${tz()})::date)::numeric, 1)::float AS pr_to_po
         FROM goods_received_note g JOIN purchase_order po ON po.id = g.purchase_order_id LEFT JOIN purchase_requisition pr ON pr.id = po.requisition_id
        WHERE g.status::text = 'POSTED' AND g.received_date BETWEEN ${from}::date AND ${to}::date AND ${store('g.store_id')}`,
    );
    // OTIF: orders due in the period, received in full by their expected date.
    const otif = await query(
      ({ store, tz }) => `SELECT COUNT(*)::int AS due,
              COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.purchase_order_id = po.id AND l.received_base_qty < l.quantity * l.conversion_factor)
                                 AND (SELECT MAX(g.received_date) FROM goods_received_note g WHERE g.purchase_order_id = po.id AND g.status::text = 'POSTED') <= po.expected_delivery)::int AS otif
         FROM purchase_order po
        WHERE po.status::text IN ${LIVE} AND po.expected_delivery BETWEEN ${from}::date AND ${to}::date AND ${store('po.store_id')}`,
    );
    const fill = await query(
      ({ store, tz }) => `SELECT COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE l.issued_qty >= l.requested_qty - l.cancelled_qty)::int AS filled
         FROM store_requisition_line l JOIN store_requisition r ON r.id = l.requisition_id
        WHERE (r.created_at AT TIME ZONE ${tz()})::date BETWEEN ${from}::date AND ${to}::date AND r.status::text NOT IN ('DRAFT', 'REJECTED', 'CANCELLED') AND ${store('r.store_id')}`,
    );
    const stock = await query(
      ({ store, tz }) => `SELECT COALESCE(SUM(t.value_delta) FILTER (WHERE t.effective_date < ${from}::date), 0)::float AS opening,
              COALESCE(SUM(t.value_delta), 0)::float AS closing,
              COALESCE(-SUM(t.value_delta) FILTER (WHERE t.effective_date >= ${from}::date AND t.txn_type::text IN ${TXN_CONSUMPTION}), 0)::float AS consumption,
              COALESCE(-SUM(t.value_delta) FILTER (WHERE t.effective_date >= ${from}::date AND t.reason_code IN ${WRITE_OFF_REASONS}), 0)::float AS wastage,
              COALESCE(-SUM(t.value_delta) FILTER (WHERE t.effective_date >= ${from}::date AND t.reason_code = 'EXPIRY'), 0)::float AS expired
         FROM stock_transaction t WHERE t.effective_date <= ${to}::date AND ${store('t.store_id')}`,
    );
    const outs = await query(
      ({ store, tz }) => `SELECT COUNT(*)::int AS events, COUNT(DISTINCT a.item_id)::int AS items FROM stock_alert a
        WHERE a.type = 'STOCKOUT' AND (a.raised_at AT TIME ZONE ${tz()})::date BETWEEN ${from}::date AND ${to}::date AND ${store('a.store_id')}`,
    );
    const days = Math.max(1, Math.round((Date.parse(ctx.f.to!) - Date.parse(ctx.f.from!)) / 86_400_000) + 1);
    const monthly = (stock.consumption / days) * 30.4;
    const avg = (stock.opening + stock.closing) / 2;
    const row = (area: string, metric: string, value: number | null, unit: string, basis: string) => ({ area, metric, value: value === null ? null : r2(value), unit, basis });
    return {
      rows: [
        row('Lead time', 'Requisition to order', lead.pr_to_po, 'days', `orders delivered in the period (${lead.deliveries})`),
        row('Lead time', 'Order to delivery', lead.po_to_grn, 'days', `${lead.deliveries} posted GRNs`),
        row('Delivery', 'On time in full (OTIF)', pct(otif.otif, otif.due), '%', `${otif.otif} of ${otif.due} orders due in the period`),
        row('Availability', 'Requisition fill rate', pct(fill.filled, fill.lines), '%', `${fill.filled} of ${fill.lines} lines issued in full`),
        row('Availability', 'Stock-out events', outs.events, 'events', `${outs.items} item(s)`),
        row('Stock', 'Stock value at end', stock.closing, 'KES', `ledger value at ${ctx.f.to}`),
        row('Stock', 'Months of stock', monthly > 0 ? stock.closing / monthly : null, 'months', 'closing value ÷ average monthly consumption'),
        row('Stock', 'Inventory turnover', avg > 0 ? stock.consumption / avg : null, 'times', `consumption ${r2(stock.consumption)} ÷ average stock ${r2(avg)}`),
        row('Wastage', 'Write-offs', stock.wastage, 'KES', 'expiry, damage, disposal, theft and loss'),
        row('Wastage', 'Wastage rate', pct(stock.wastage, stock.consumption + stock.wastage), '%', 'write-offs ÷ (consumption + write-offs)'),
        row('Wastage', 'Expiry losses', stock.expired, 'KES', 'expiry write-offs'),
      ],
    };
  },
};

export const PURCHASING_REPORTS: ReportDef[] = [poStatus, outstanding, supplierPerformance, priceHistory, kpis];

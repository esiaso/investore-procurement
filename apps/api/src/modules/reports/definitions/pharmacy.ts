import { Permissions as P } from '@sil/shared';
import { col, daysBetween, pct, r2, ReportColumn, ReportDef, Sql, sum, TXN_CONSUMPTION, WRITE_OFF_REASONS } from '../report-types';

const PHARMACY = [P.PHARMACY_READ];

const dispensingVolume: ReportDef = {
  key: 'dispensing-volume',
  title: 'Prescriptions and items dispensed',
  group: 'PHARMACY',
  description: 'Prescriptions, dispenses, lines and quantity dispensed per pharmacist, outlet, day or month.',
  permissions: PHARMACY,
  filters: ['from', 'to', 'storeId', 'groupBy'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'pharmacist', label: 'Pharmacist' },
    { value: 'outlet', label: 'Outlet' },
    { value: 'day', label: 'Day' },
    { value: 'month', label: 'Month' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const tz = q.p(ctx.tz);
    const g = ctx.f.groupBy ?? 'pharmacist';
    const key =
      g === 'outlet'
        ? { sel: 's.name AS label', head: 'Outlet' }
        : g === 'day'
          ? { sel: `to_char(d.dispensed_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS label`, head: 'Day' }
          : g === 'month'
            ? { sel: `to_char(d.dispensed_at AT TIME ZONE ${tz}, 'YYYY-MM') AS label`, head: 'Month' }
            : { sel: 'u.full_name AS label', head: 'Pharmacist' };
    const rows = await ctx.ds.query(
      `SELECT ${key.sel}, COUNT(DISTINCT d.prescription_id)::int AS prescriptions, COUNT(DISTINCT d.id)::int AS dispenses, COUNT(l.id)::int AS lines,
              SUM(l.quantity - l.returned_qty)::float AS quantity, ROUND(SUM((l.quantity - l.returned_qty) * l.unit_cost), 2)::float AS cost
         FROM dispense d JOIN dispense_line l ON l.dispense_id = d.id JOIN store s ON s.id = d.store_id JOIN app_user u ON u.id = d.dispensed_by
        WHERE (d.dispensed_at AT TIME ZONE ${tz})::date BETWEEN ${q.p(ctx.f.from)}::date AND ${q.p(ctx.f.to)}::date AND ${q.store('d.store_id', ctx)}
        GROUP BY 1 ORDER BY 1 LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return {
      columns: [col('label', key.head), col('prescriptions', 'Prescriptions', 'number'), col('dispenses', 'Dispenses', 'number'), col('lines', 'Lines', 'number'), col('quantity', 'Quantity', 'qty'), col('cost', 'Cost', 'money')],
      rows,
      totals: { dispenses: sum(rows, 'dispenses'), lines: sum(rows, 'lines'), cost: sum(rows, 'cost') },
    };
  },
};

const turnaround: ReportDef = {
  key: 'turnaround',
  title: 'Dispensing turnaround',
  group: 'PHARMACY',
  description: 'Minutes from a prescription received to its first dispense and to completion, per outlet.',
  permissions: PHARMACY,
  filters: ['from', 'to', 'storeId'],
  required: ['from', 'to'],
  columns: [
    col('outlet', 'Outlet'),
    col('prescriptions', 'Prescriptions', 'number'),
    col('dispensed', 'Dispensed', 'number'),
    col('avgMinutes', 'Average (min)', 'number'),
    col('medianMinutes', 'Median (min)', 'number'),
    col('p90Minutes', '90th percentile (min)', 'number'),
    col('avgToCompleteMinutes', 'Average to complete (min)', 'number'),
  ],
  async run(ctx) {
    const q = new Sql();
    const m = (a: string, b: string) => `EXTRACT(EPOCH FROM (${b} - ${a})) / 60`;
    const rows = await ctx.ds.query(
      `SELECT s.name AS outlet, COUNT(*)::int AS prescriptions, COUNT(rx.first_dispensed_at)::int AS dispensed,
              ROUND(AVG(${m('rx.received_at', 'rx.first_dispensed_at')})::numeric, 1)::float AS "avgMinutes",
              ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${m('rx.received_at', 'rx.first_dispensed_at')}))::numeric, 1)::float AS "medianMinutes",
              ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY ${m('rx.received_at', 'rx.first_dispensed_at')}))::numeric, 1)::float AS "p90Minutes",
              ROUND(AVG(${m('rx.received_at', 'rx.completed_at')})::numeric, 1)::float AS "avgToCompleteMinutes"
         FROM prescription rx JOIN store s ON s.id = rx.store_id
        WHERE ${q.localDate('rx.received_at', ctx)} AND ${q.store('rx.store_id', ctx)}
        GROUP BY s.name ORDER BY s.name`,
      q.params,
    );
    return { rows };
  },
};

const salesMargin: ReportDef = {
  key: 'sales-margin',
  title: 'Revenue, cost of sales and gross margin',
  group: 'PHARMACY',
  description: 'Issued sales invoices net of credit notes (excluding VAT), against the FEFO batch cost of what was sold.',
  permissions: [P.BILLING_READ, P.POS_REPORTS],
  filters: ['from', 'to', 'storeId', 'categoryId', 'groupBy'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'item', label: 'Item' },
    { value: 'category', label: 'Category' },
    { value: 'payer', label: 'Payer' },
    { value: 'store', label: 'Outlet' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'item';
    const key =
      g === 'category'
        ? { sel: 'c.name AS label', head: 'Category' }
        : g === 'payer'
          ? { sel: `COALESCE(p.name, 'Cash / self-pay') AS label`, head: 'Payer' }
          : g === 'store'
            ? { sel: 's.name AS label', head: 'Outlet' }
            : { sel: `i.code || ' ' || i.name AS label`, head: 'Item' };
    const rows: { label: string; quantity: number; revenue: number; cost: number }[] = await ctx.ds.query(
      `SELECT ${key.sel}, SUM(sg.sign * l.quantity)::float AS quantity, ROUND(SUM(sg.sign * l.net_amount), 2)::float AS revenue,
              ROUND(SUM(sg.sign * COALESCE((SELECT SUM((a->>'quantity')::numeric * (a->>'unitCost')::numeric) FROM jsonb_array_elements(l.allocations) a), 0)), 2)::float AS cost
         FROM sales_invoice si JOIN sales_invoice_line l ON l.invoice_id = si.id JOIN item i ON i.id = l.item_id JOIN item_category c ON c.id = i.category_id JOIN store s ON s.id = si.store_id
         LEFT JOIN sales_invoice o ON o.id = si.original_invoice_id LEFT JOIN payer p ON p.id = COALESCE(si.payer_id, o.payer_id)
         CROSS JOIN LATERAL (SELECT CASE WHEN si.doc_type = 'CREDIT_NOTE' THEN -1 ELSE 1 END AS sign) sg
        WHERE si.status = 'ISSUED' AND ${q.localDate('si.issued_at', ctx)} AND ${q.store('si.store_id', ctx)} AND ${q.category('i', ctx)}
        GROUP BY 1 ORDER BY 3 DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    // Quantities only add up per item.
    const out = rows.map(({ quantity, ...r }) => ({ ...r, ...(g === 'item' ? { quantity } : {}), margin: r2(r.revenue - r.cost), marginPercent: pct(r.revenue - r.cost, r.revenue) }));
    const rev = sum(out, 'revenue') ?? 0;
    const cost = sum(out, 'cost') ?? 0;
    const columns: ReportColumn[] = [
      col('label', key.head),
      ...(g === 'item' ? [col('quantity', 'Quantity', 'qty')] : []),
      col('revenue', 'Revenue (excl. VAT)', 'money'),
      col('cost', 'Cost of sales', 'money'),
      col('margin', 'Gross margin', 'money'),
      col('marginPercent', 'Margin %', 'percent'),
    ];
    return { columns, rows: out, totals: { revenue: rev, cost, margin: r2(rev - cost), marginPercent: pct(rev - cost, rev) } };
  },
};

/** Net consumption (dispensed and issued less returns) per item in the period. */
async function movers(ctx: Parameters<ReportDef['run']>[0], order: 'top' | 'slow') {
  const q = new Sql();
  const days = daysBetween(ctx.f.from!, ctx.f.to!);
  const limit = q.p(ctx.f.limit ?? 50);
  const store = q.store('t.store_id', ctx);
  const store2 = q.store('sb.store_id', ctx);
  const rows = await ctx.ds.query(
    `WITH used AS (
       SELECT t.item_id, -SUM(t.quantity)::float AS quantity, -SUM(t.value_delta)::float AS value
         FROM stock_transaction t WHERE t.txn_type::text IN ${TXN_CONSUMPTION} AND ${q.between('t.effective_date', ctx)} AND ${store}
        GROUP BY t.item_id),
     held AS (SELECT sb.item_id, SUM(sb.on_hand)::float AS on_hand FROM stock_balance sb WHERE ${store2} GROUP BY sb.item_id)
     SELECT i.code, i.name AS item, c.name AS category, COALESCE(u.quantity, 0) AS quantity, ROUND(COALESCE(u.value, 0)::numeric, 2)::float AS value, COALESCE(h.on_hand, 0) AS "onHand"
       FROM item i JOIN item_category c ON c.id = i.category_id LEFT JOIN used u ON u.item_id = i.id LEFT JOIN held h ON h.item_id = i.id
      WHERE ${q.category('i', ctx)} AND ${order === 'top' ? 'COALESCE(u.quantity, 0) > 0' : 'COALESCE(h.on_hand, 0) > 0'}
      ORDER BY ${order === 'top' ? 'u.value DESC NULLS LAST' : 'COALESCE(u.quantity, 0) ASC, h.on_hand DESC'} LIMIT ${limit}`,
    q.params,
  );
  return {
    rows: rows.map((r: { quantity: number; onHand: number }) => ({ ...r, daysOfStock: r.quantity > 0 ? Math.round(r.onHand / (r.quantity / days)) : null })),
    notes: [`Consumption over ${days} days (dispensed and issued, net of returns).`],
  };
}

const moverColumns = [
  col('code', 'Code'),
  col('item', 'Item'),
  col('category', 'Category'),
  col('quantity', 'Quantity used', 'qty'),
  col('value', 'Value used', 'money'),
  col('onHand', 'On hand', 'qty'),
  col('daysOfStock', 'Days of stock', 'number'),
];

const topMoving: ReportDef = {
  key: 'top-moving',
  title: 'Top-moving items',
  group: 'PHARMACY',
  description: 'Items with the highest consumption value in the period.',
  permissions: [P.INVENTORY_READ],
  filters: ['from', 'to', 'storeId', 'categoryId', 'limit'],
  required: ['from', 'to'],
  columns: moverColumns,
  run: (ctx) => movers(ctx, 'top'),
};

const slowMoving: ReportDef = {
  key: 'slow-moving',
  title: 'Slow and non-moving items',
  group: 'PHARMACY',
  description: 'Items in stock with the least (or no) consumption in the period.',
  permissions: [P.INVENTORY_READ],
  filters: ['from', 'to', 'storeId', 'categoryId', 'limit'],
  required: ['from', 'to'],
  columns: moverColumns,
  run: (ctx) => movers(ctx, 'slow'),
};

const MATRIX: Record<string, string> = { AV: 'I', AE: 'I', AD: 'I', BV: 'I', CV: 'I', BE: 'II', CE: 'II', BD: 'II', CD: 'III' };

const abcVed: ReportDef = {
  key: 'abc-ved',
  title: 'ABC and VED analysis',
  group: 'PHARMACY',
  description: 'Items ranked by consumption value (A / B / C at reports.abcThresholds) crossed with their VED criticality; category I needs the tightest control.',
  permissions: [P.INVENTORY_VALUATION],
  filters: ['from', 'to', 'storeId', 'categoryId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('code', 'Code'),
    col('item', 'Item'),
    col('value', 'Consumption value', 'money'),
    col('share', 'Share %', 'percent'),
    col('cumulative', 'Cumulative %', 'percent'),
    col('abc', 'ABC'),
    col('ved', 'VED'),
    col('class', 'ABC-VED'),
    col('category', 'Category'),
  ],
  async run(ctx) {
    const q = new Sql();
    const { a, b } = await ctx.settings.get('reports.abcThresholds');
    const rows: { code: string; item: string; value: number; ved: string | null }[] = await ctx.ds.query(
      `SELECT i.code, i.name AS item, g.ved_class AS ved, ROUND(-SUM(t.value_delta), 2)::float AS value
         FROM stock_transaction t JOIN item i ON i.id = t.item_id LEFT JOIN generic g ON g.id = i.generic_id
        WHERE t.txn_type::text IN ${TXN_CONSUMPTION} AND ${q.between('t.effective_date', ctx)} AND ${q.store('t.store_id', ctx)} AND ${q.category('i', ctx)}
        GROUP BY i.code, i.name, g.ved_class HAVING SUM(t.value_delta) < 0 ORDER BY 4 DESC`,
      q.params,
    );
    const total = rows.reduce((s, r) => s + r.value, 0);
    let run = 0;
    const out = rows.map((r) => {
      const before = total ? (100 * run) / total : 0;
      run += r.value;
      const abc = before < a ? 'A' : before < b ? 'B' : 'C';
      const ved = r.ved ?? null;
      return { code: r.code, item: r.item, value: r.value, share: pct(r.value, total), cumulative: pct(run, total), abc, ved: ved ?? '—', class: ved ? `${abc}${ved}` : abc, category: ved ? MATRIX[`${abc}${ved}`] : '' };
    });
    const count = (k: string) => out.filter((r) => r.abc === k).length;
    return {
      rows: out.slice(0, ctx.maxRows),
      totals: { value: r2(total) },
      notes: [`A: ${count('A')} items (first ${a}% of value), B: ${count('B')} (to ${b}%), C: ${count('C')}. ${out.filter((r) => r.ved === '—').length} item(s) have no VED class (set it on the generic).`],
    };
  },
};

const fillRate: ReportDef = {
  key: 'fill-rate',
  title: 'Fill rate and stock-out frequency',
  group: 'PHARMACY',
  description: 'Prescription lines and internal requisition lines filled in full, and stock-out events raised, per store.',
  permissions: [P.INVENTORY_READ, P.PHARMACY_READ],
  filters: ['from', 'to', 'storeId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('store', 'Store'),
    col('rxLines', 'Prescription lines', 'number'),
    col('rxFilled', 'Filled in full', 'number'),
    col('rxFillRate', 'Rx fill rate %', 'percent'),
    col('rxQtyFill', 'Rx quantity fill %', 'percent'),
    col('reqLines', 'Requisition lines', 'number'),
    col('reqFilled', 'Issued in full', 'number'),
    col('reqFillRate', 'Requisition fill rate %', 'percent'),
    col('stockOuts', 'Stock-out events', 'number'),
    col('itemsOut', 'Items stocked out', 'number'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rx = await ctx.ds.query(
      `SELECT rx.store_id, COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE l.dispensed_qty >= l.quantity - l.cancelled_qty)::int AS filled,
              SUM(l.dispensed_qty)::float AS dispensed, SUM(l.quantity - l.cancelled_qty)::float AS wanted
         FROM prescription_line l JOIN prescription rx ON rx.id = l.prescription_id
        WHERE ${q.localDate('rx.received_at', ctx)} AND ${q.store('rx.store_id', ctx)} AND l.quantity > l.cancelled_qty AND rx.status::text NOT IN ('CANCELLED')
        GROUP BY rx.store_id`,
      q.params,
    );
    const q2 = new Sql();
    const req = await ctx.ds.query(
      `SELECT r.store_id, COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE l.issued_qty >= l.requested_qty - l.cancelled_qty)::int AS filled
         FROM store_requisition_line l JOIN store_requisition r ON r.id = l.requisition_id
        WHERE ${q2.localDate('r.created_at', ctx)} AND ${q2.store('r.store_id', ctx)} AND r.status::text NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
        GROUP BY r.store_id`,
      q2.params,
    );
    const q3 = new Sql();
    const outs = await ctx.ds.query(
      `SELECT a.store_id, COUNT(*)::int AS events, COUNT(DISTINCT a.item_id)::int AS items FROM stock_alert a
        WHERE a.type = 'STOCKOUT' AND ${q3.localDate('a.raised_at', ctx)} AND ${q3.store('a.store_id', ctx)} GROUP BY a.store_id`,
      q3.params,
    );
    const ids = [...new Set([...rx, ...req, ...outs].map((r: { store_id: string }) => r.store_id))];
    const names: { id: string; name: string }[] = ids.length ? await ctx.ds.query(`SELECT id, name FROM store WHERE id = ANY($1::uuid[]) ORDER BY name`, [ids]) : [];
    const rows = names.map((s) => {
      const a = rx.find((r: { store_id: string }) => r.store_id === s.id) ?? { lines: 0, filled: 0, dispensed: 0, wanted: 0 };
      const b = req.find((r: { store_id: string }) => r.store_id === s.id) ?? { lines: 0, filled: 0 };
      const c = outs.find((r: { store_id: string }) => r.store_id === s.id) ?? { events: 0, items: 0 };
      return {
        store: s.name,
        rxLines: a.lines,
        rxFilled: a.filled,
        rxFillRate: pct(a.filled, a.lines),
        rxQtyFill: pct(a.dispensed, a.wanted),
        reqLines: b.lines,
        reqFilled: b.filled,
        reqFillRate: pct(b.filled, b.lines),
        stockOuts: c.events,
        itemsOut: c.items,
      };
    });
    const t = (k: string) => rows.reduce((s, r) => s + Number((r as Record<string, unknown>)[k] ?? 0), 0);
    return { rows, totals: { rxLines: t('rxLines'), rxFilled: t('rxFilled'), rxFillRate: pct(t('rxFilled'), t('rxLines')), reqLines: t('reqLines'), reqFilled: t('reqFilled'), reqFillRate: pct(t('reqFilled'), t('reqLines')), stockOuts: t('stockOuts') } };
  },
};

const interactionAlerts: ReportDef = {
  key: 'interaction-alerts',
  title: 'Interaction alerts raised and overridden',
  group: 'PHARMACY',
  description: 'Clinical alerts raised at verification and dispensing, and how many a pharmacist overrode.',
  permissions: PHARMACY,
  filters: ['from', 'to', 'storeId'],
  required: ['from', 'to'],
  columns: [col('type', 'Alert'), col('severity', 'Severity'), col('raised', 'Raised', 'number'), col('blocking', 'Blocking', 'number'), col('overridden', 'Overridden', 'number'), col('overrideRate', 'Override %', 'percent')],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT a.type, a.severity, COUNT(*)::int AS raised, COUNT(*) FILTER (WHERE a.blocking)::int AS blocking, COUNT(o.id)::int AS overridden
         FROM clinical_alert a JOIN prescription rx ON rx.id = a.prescription_id LEFT JOIN interaction_override o ON o.alert_id = a.id
        WHERE ${q.localDate('a.created_at', ctx)} AND ${q.store('rx.store_id', ctx)}
        GROUP BY a.type, a.severity ORDER BY a.type, a.severity`,
      q.params,
    );
    const out = rows.map((r: { raised: number; overridden: number }) => ({ ...r, overrideRate: pct(r.overridden, r.raised) }));
    return { rows: out, totals: { raised: sum(out, 'raised'), overridden: sum(out, 'overridden'), overrideRate: pct(Number(sum(out, 'overridden')), Number(sum(out, 'raised'))) } };
  },
};

const expiryLosses: ReportDef = {
  key: 'expiry-losses',
  title: 'Expiry losses and write-offs',
  group: 'PHARMACY',
  description: 'Stock written off (expiry, damage, disposal, theft, loss) as value and as a percentage of average stock value.',
  permissions: [P.INVENTORY_VALUATION],
  filters: ['from', 'to', 'storeId', 'categoryId', 'groupBy'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'store', label: 'Store' },
    { value: 'reason', label: 'Reason' },
    { value: 'category', label: 'Category' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'store';
    const key = g === 'reason' ? { sel: `COALESCE(r.name, t.reason_code) AS label`, head: 'Reason' } : g === 'category' ? { sel: 'c.name AS label', head: 'Category' } : { sel: 's.name AS label', head: 'Store' };
    const from = q.p(ctx.f.from);
    const to = q.p(ctx.f.to);
    const store = q.store('t.store_id', ctx);
    const cat = q.category('i', ctx);
    const rows: { label: string; loss: number; quantity: number }[] = await ctx.ds.query(
      `SELECT ${key.sel}, ROUND(-SUM(t.value_delta), 2)::float AS loss, -SUM(t.quantity)::float AS quantity
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN item_category c ON c.id = i.category_id JOIN store s ON s.id = t.store_id
         LEFT JOIN adjustment_reason r ON r.code = t.reason_code
        WHERE t.reason_code IN ${WRITE_OFF_REASONS} AND t.effective_date BETWEEN ${from}::date AND ${to}::date AND ${store} AND ${cat}
        GROUP BY 1 HAVING SUM(t.value_delta) <> 0 ORDER BY 2 DESC`,
      q.params,
    );
    // Average stock value over the period, per store when grouped by store.
    const avg: { label: string; avg: number }[] = await ctx.ds.query(
      `SELECT ${g === 'store' ? 's.name' : `'all'`} AS label,
              ((COALESCE(SUM(t.value_delta) FILTER (WHERE t.effective_date < ${from}::date), 0) + SUM(t.value_delta)) / 2)::float AS avg
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN store s ON s.id = t.store_id
        WHERE t.effective_date <= ${to}::date AND ${store} AND ${cat} GROUP BY 1`,
      q.params,
    );
    const totalAvg = avg.reduce((s, x) => s + x.avg, 0);
    const totalLoss = rows.reduce((s, x) => s + x.loss, 0);
    const out = rows.map((r) => ({ ...r, percentOfStock: pct(r.loss, g === 'store' ? (avg.find((x) => x.label === r.label)?.avg ?? 0) : totalAvg), shareOfLosses: pct(r.loss, totalLoss) }));
    return {
      columns: [col('label', key.head), col('quantity', 'Quantity', 'qty'), col('loss', 'Value written off', 'money'), col('percentOfStock', '% of average stock', 'percent'), col('shareOfLosses', '% of losses', 'percent')],
      rows: out,
      totals: { loss: r2(totalLoss), percentOfStock: pct(totalLoss, totalAvg), shareOfLosses: totalLoss ? 100 : null },
      notes: [`Average stock value ${r2(totalAvg)} (opening and closing of the period).`],
    };
  },
};

export const PHARMACY_REPORTS: ReportDef[] = [dispensingVolume, turnaround, salesMargin, topMoving, slowMoving, abcVed, fillRate, interactionAlerts, expiryLosses];

import { Permissions as P } from '@sil/shared';
import { col, daysBetween, r2, ReportColumn, ReportDef, Sql, sum, TXN_ADJ, TXN_CONSUMPTION, TXN_IN, TXN_OUT } from '../report-types';

const READ = [P.INVENTORY_READ];
const VALUE = [P.INVENTORY_VALUATION];

const stockStatus: ReportDef = {
  key: 'stock-status',
  title: 'Stock status / stock on hand',
  group: 'INVENTORY',
  description: 'Stock on hand and its value (stock ledger, in transit included) by item, store, category or batch.',
  permissions: VALUE,
  filters: ['storeId', 'categoryId', 'itemId', 'groupBy'],
  groupBy: [
    { value: 'item', label: 'Item' },
    { value: 'store', label: 'Store' },
    { value: 'category', label: 'Category' },
    { value: 'batch', label: 'Store and batch' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'item';
    const shapes: Record<string, { select: string; group: string; order: string; columns: ReportColumn[] }> = {
      item: {
        select: `i.code, i.name AS item, c.name AS category, COUNT(DISTINCT t.store_id)::int AS stores`,
        group: 'i.code, i.name, c.name',
        order: 'i.name',
        columns: [col('code', 'Code'), col('item', 'Item'), col('category', 'Category'), col('stores', 'Stores', 'number')],
      },
      store: {
        select: `s.code, s.name AS store, COUNT(DISTINCT t.item_id)::int AS items`,
        group: 's.code, s.name',
        order: 's.name',
        columns: [col('code', 'Code'), col('store', 'Store'), col('items', 'Items', 'number')],
      },
      category: {
        select: `c.code, c.name AS category, COUNT(DISTINCT t.item_id)::int AS items`,
        group: 'c.code, c.name',
        order: 'c.name',
        columns: [col('code', 'Code'), col('category', 'Category'), col('items', 'Items', 'number')],
      },
      batch: {
        select: `s.name AS store, i.code, i.name AS item, b.batch_no AS batch, b.expiry_date::text AS expiry, b.hold_status AS hold`,
        group: 's.name, i.code, i.name, b.batch_no, b.expiry_date, b.hold_status',
        order: 's.name, i.name, b.expiry_date',
        columns: [col('store', 'Store'), col('code', 'Code'), col('item', 'Item'), col('batch', 'Batch'), col('expiry', 'Expiry', 'date'), col('hold', 'Hold')],
      },
    };
    const sh = shapes[g] ?? shapes.item;
    const rows = await ctx.ds.query(
      `SELECT ${sh.select}, SUM(t.quantity + t.in_transit_delta)::float AS quantity, ROUND(SUM(t.value_delta), 2)::float AS value
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN item_category c ON c.id = i.category_id
         JOIN store s ON s.id = t.store_id JOIN batch b ON b.id = t.batch_id
        WHERE ${q.store('t.store_id', ctx)} AND ${q.category('i', ctx)} AND ${q.eq('t.item_id', ctx.f.itemId)}
        GROUP BY ${sh.group} HAVING SUM(t.quantity + t.in_transit_delta) <> 0 OR SUM(t.value_delta) <> 0
        ORDER BY ${sh.order} LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    // Quantities only add up for one item.
    const withQty = g === 'item' || g === 'batch';
    const columns = [...sh.columns, ...(withQty ? [col('quantity', 'Quantity', 'qty')] : []), col('value', 'Value', 'money')];
    return { columns, rows: withQty ? rows : rows.map(({ quantity: _q, ...r }: Record<string, unknown>) => r), totals: { value: sum(rows, 'value') } };
  },
};

const movement: ReportDef = {
  key: 'stock-movement',
  title: 'Stock movement summary',
  group: 'INVENTORY',
  description: 'Per store and item: opening, receipts, issues, adjustments and closing quantity, with opening and closing value.',
  permissions: VALUE,
  filters: ['from', 'to', 'storeId', 'categoryId', 'itemId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('store', 'Store'),
    col('code', 'Code'),
    col('item', 'Item'),
    col('opening', 'Opening', 'qty'),
    col('receipts', 'Receipts', 'qty'),
    col('issues', 'Issues', 'qty'),
    col('adjustments', 'Adjustments', 'qty'),
    col('closing', 'Closing', 'qty'),
    col('openingValue', 'Opening value', 'money'),
    col('closingValue', 'Closing value', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const from = q.p(ctx.f.from);
    const to = q.p(ctx.f.to);
    const rows = await ctx.ds.query(
      `SELECT s.name AS store, i.code, i.name AS item,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.effective_date < ${from}::date), 0)::float AS opening,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.effective_date >= ${from}::date AND t.txn_type::text IN ${TXN_IN}), 0)::float AS receipts,
              COALESCE(-SUM(t.quantity) FILTER (WHERE t.effective_date >= ${from}::date AND t.txn_type::text IN ${TXN_OUT}), 0)::float AS issues,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.effective_date >= ${from}::date AND t.txn_type::text IN ${TXN_ADJ}), 0)::float AS adjustments,
              SUM(t.quantity)::float AS closing,
              ROUND(COALESCE(SUM(t.value_delta) FILTER (WHERE t.effective_date < ${from}::date), 0), 2)::float AS "openingValue",
              ROUND(SUM(t.value_delta), 2)::float AS "closingValue"
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN store s ON s.id = t.store_id
        WHERE t.effective_date <= ${to}::date AND ${q.store('t.store_id', ctx)} AND ${q.category('i', ctx)} AND ${q.eq('t.item_id', ctx.f.itemId)}
        GROUP BY s.name, i.code, i.name
       HAVING SUM(t.quantity) <> 0 OR COUNT(*) FILTER (WHERE t.effective_date >= ${from}::date) > 0
        ORDER BY s.name, i.name LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { openingValue: sum(rows, 'openingValue'), closingValue: sum(rows, 'closingValue') } };
  },
};

const binCard: ReportDef = {
  key: 'bin-card',
  title: 'Item ledger (bin card)',
  group: 'INVENTORY',
  description: 'Every movement of one item in one store, with the running balance from the opening balance.',
  permissions: READ,
  filters: ['from', 'to', 'storeId', 'itemId'],
  required: ['from', 'to', 'storeId', 'itemId'],
  landscape: true,
  columns: [
    col('date', 'Date', 'date'),
    col('type', 'Movement'),
    col('document', 'Document'),
    col('batch', 'Batch'),
    col('reason', 'Reason'),
    col('received', 'In', 'qty'),
    col('issued', 'Out', 'qty'),
    col('balance', 'Balance', 'qty'),
    col('value', 'Value change', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const store = q.store('t.store_id', ctx);
    const item = q.p(ctx.f.itemId);
    const from = q.p(ctx.f.from);
    const [{ opening }] = await ctx.ds.query(`SELECT COALESCE(SUM(t.quantity), 0)::float AS opening FROM stock_transaction t WHERE ${store} AND t.item_id = ${item} AND t.effective_date < ${from}::date`, q.params);
    const to = q.p(ctx.f.to);
    const rows = await ctx.ds.query(
      `SELECT t.effective_date::text AS date, t.txn_type AS type, t.source_doc_no AS document, b.batch_no AS batch, t.reason_code AS reason,
              CASE WHEN t.quantity > 0 THEN t.quantity::float END AS received, CASE WHEN t.quantity < 0 THEN -t.quantity::float END AS issued,
              (${opening} + SUM(t.quantity) OVER (ORDER BY t.effective_date, t.posted_at, t.id))::float AS balance, ROUND(t.value_delta, 2)::float AS value
         FROM stock_transaction t JOIN batch b ON b.id = t.batch_id
        WHERE ${store} AND t.item_id = ${item} AND t.effective_date BETWEEN ${from}::date AND ${to}::date
        ORDER BY t.effective_date, t.posted_at, t.id LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows: [{ date: ctx.f.from, type: 'OPENING BALANCE', balance: opening }, ...rows], totals: { received: sum(rows, 'received'), issued: sum(rows, 'issued'), balance: rows.at(-1)?.balance ?? opening } };
  },
};

const consumption: ReportDef = {
  key: 'consumption-by-department',
  title: 'Consumption by department / cost centre',
  group: 'INVENTORY',
  description: 'Stock issued to departments, net of their returns, at cost.',
  permissions: [P.INVENTORY_CONSUMPTION, P.INVENTORY_VALUATION],
  filters: ['from', 'to', 'storeId', 'categoryId', 'departmentId', 'groupBy'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'department', label: 'Department' },
    { value: 'category', label: 'Department and category' },
    { value: 'item', label: 'Department and item' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'department';
    const extra = g === 'category' ? { sel: ', c.name AS category', grp: ', c.name', cols: [col('category', 'Category')] } : g === 'item' ? { sel: ', i.code, i.name AS item', grp: ', i.code, i.name', cols: [col('code', 'Code'), col('item', 'Item')] } : { sel: '', grp: '', cols: [] };
    const rows = await ctx.ds.query(
      `SELECT d.name AS department, d.cost_centre_code AS "costCentre"${extra.sel}${g === 'item' ? ', -SUM(t.quantity)::float AS quantity' : ''}, ROUND(-SUM(t.value_delta), 2)::float AS value
         FROM stock_transaction t JOIN department d ON d.id = t.department_id JOIN item i ON i.id = t.item_id JOIN item_category c ON c.id = i.category_id
        WHERE t.txn_type IN ('ISSUE', 'RETURN_IN') AND ${q.between('t.effective_date', ctx)} AND ${q.store('t.store_id', ctx)} AND ${q.category('i', ctx)} AND ${q.eq('t.department_id', ctx.f.departmentId)}
        GROUP BY d.name, d.cost_centre_code${extra.grp} HAVING SUM(t.value_delta) <> 0
        ORDER BY d.name, value DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return {
      columns: [col('department', 'Department'), col('costCentre', 'Cost centre'), ...extra.cols, ...(g === 'item' ? [col('quantity', 'Quantity', 'qty')] : []), col('value', 'Value', 'money')],
      rows,
      totals: { value: sum(rows, 'value') },
    };
  },
};

const grnRegister: ReportDef = {
  key: 'grn-register',
  title: 'GRN register',
  group: 'INVENTORY',
  description: 'Goods received notes in the period with their supplier, order and value received into stock.',
  permissions: [P.PURCHASING_READ],
  filters: ['from', 'to', 'storeId', 'supplierId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'GRN'),
    col('date', 'Received', 'date'),
    col('supplier', 'Supplier'),
    col('store', 'Store'),
    col('po', 'Order'),
    col('deliveryNote', 'Delivery note'),
    col('status', 'Status'),
    col('emergency', 'Emergency'),
    col('lines', 'Lines', 'number'),
    col('value', 'Value in stock', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT g.number, g.received_date::text AS date, sup.name AS supplier, s.name AS store, po.number AS po, g.delivery_note_no AS "deliveryNote", g.status,
              CASE WHEN g.is_emergency THEN 'Yes' ELSE '' END AS emergency, (SELECT COUNT(*)::int FROM grn_line l WHERE l.grn_id = g.id) AS lines,
              ROUND(COALESCE((SELECT SUM(t.value_delta) FROM stock_transaction t WHERE t.source_doc_type = 'GRN' AND t.source_doc_id = g.id AND t.txn_type = 'RECEIPT'), 0), 2)::float AS value
         FROM goods_received_note g JOIN supplier sup ON sup.id = g.supplier_id JOIN store s ON s.id = g.store_id LEFT JOIN purchase_order po ON po.id = g.purchase_order_id
        WHERE ${q.between('g.received_date', ctx)} AND ${q.store('g.store_id', ctx)} AND ${q.eq('g.supplier_id', ctx.f.supplierId)} AND ${q.eq('g.status::text', ctx.f.status)}
        ORDER BY g.received_date, g.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const issueRegister: ReportDef = {
  key: 'issue-register',
  title: 'Issue register',
  group: 'INVENTORY',
  description: 'Issue vouchers to departments in the period.',
  permissions: READ,
  filters: ['from', 'to', 'storeId', 'departmentId'],
  required: ['from', 'to'],
  columns: [col('number', 'Voucher'), col('date', 'Issued', 'date'), col('store', 'Store'), col('department', 'Department'), col('requisition', 'Requisition'), col('lines', 'Lines', 'number'), col('value', 'Value', 'money')],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT v.number, v.issue_date::text AS date, s.name AS store, d.name AS department, r.number AS requisition,
              (SELECT COUNT(*)::int FROM issue_voucher_line l WHERE l.voucher_id = v.id) AS lines, ROUND(v.total_value, 2)::float AS value
         FROM issue_voucher v JOIN store s ON s.id = v.store_id JOIN department d ON d.id = v.department_id LEFT JOIN store_requisition r ON r.id = v.requisition_id
        WHERE ${q.between('v.issue_date', ctx)} AND ${q.store('v.store_id', ctx)} AND ${q.eq('v.department_id', ctx.f.departmentId)}
        ORDER BY v.issue_date, v.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const transferRegister: ReportDef = {
  key: 'transfer-register',
  title: 'Transfer register',
  group: 'INVENTORY',
  description: 'Transfers between stores raised in the period (either store), with the value dispatched.',
  permissions: READ,
  filters: ['from', 'to', 'storeId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Transfer'),
    col('date', 'Raised', 'date'),
    col('fromStore', 'From'),
    col('toStore', 'To'),
    col('status', 'Status'),
    col('dispatchedAt', 'Dispatched', 'datetime'),
    col('receivedAt', 'Received', 'datetime'),
    col('lines', 'Lines', 'number'),
    col('value', 'Value dispatched', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const scope = ctx.scope === null && !ctx.f.storeId ? 'TRUE' : `(${q.store('x.from_store_id', ctx)} OR ${q.store('x.to_store_id', ctx)})`;
    const rows = await ctx.ds.query(
      `SELECT x.number, (x.created_at AT TIME ZONE ${q.p(ctx.tz)})::date::text AS date, fs.name AS "fromStore", ts.name AS "toStore", x.status,
              x.dispatched_at AS "dispatchedAt", x.received_at AS "receivedAt", (SELECT COUNT(*)::int FROM stock_transfer_line l WHERE l.transfer_id = x.id) AS lines,
              ROUND(COALESCE((SELECT -SUM(t.value_delta) FROM stock_transaction t WHERE t.source_doc_type = 'TRF' AND t.source_doc_id = x.id AND t.txn_type = 'TRANSFER_DISPATCH'), 0), 2)::float AS value
         FROM stock_transfer x JOIN store fs ON fs.id = x.from_store_id JOIN store ts ON ts.id = x.to_store_id
        WHERE ${q.localDate('x.created_at', ctx)} AND ${scope} AND ${q.eq('x.status::text', ctx.f.status)}
        ORDER BY x.created_at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const adjustmentRegister: ReportDef = {
  key: 'adjustment-register',
  title: 'Adjustment register',
  group: 'INVENTORY',
  description: 'Stock adjustments in the period with reason, value and who approved them.',
  permissions: READ,
  filters: ['from', 'to', 'storeId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Adjustment'),
    col('date', 'Date', 'date'),
    col('store', 'Store'),
    col('reason', 'Reason'),
    col('status', 'Status'),
    col('value', 'Value', 'money'),
    col('submittedBy', 'Submitted by'),
    col('approvedBy', 'Approved by'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT a.number, a.adjustment_date::text AS date, s.name AS store, COALESCE(r.name, a.reason_code) AS reason, a.status, ROUND(a.total_value, 2)::float AS value,
              us.full_name AS "submittedBy", concat_ws(', ', u1.full_name, u2.full_name) AS "approvedBy"
         FROM stock_adjustment a JOIN store s ON s.id = a.store_id LEFT JOIN adjustment_reason r ON r.code = a.reason_code
         LEFT JOIN app_user us ON us.id = a.submitted_by LEFT JOIN app_user u1 ON u1.id = a.first_approved_by LEFT JOIN app_user u2 ON u2.id = a.second_approved_by
        WHERE ${q.between('a.adjustment_date', ctx)} AND ${q.store('a.store_id', ctx)} AND ${q.eq('a.status::text', ctx.f.status)}
        ORDER BY a.adjustment_date, a.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const stocktakeVariance: ReportDef = {
  key: 'stocktake-variance',
  title: 'Stock-take variance',
  group: 'INVENTORY',
  description: 'Counted against system quantity for stock takes posted in the period, valued at batch cost.',
  permissions: READ,
  filters: ['from', 'to', 'storeId', 'categoryId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Stock take'),
    col('store', 'Store'),
    col('code', 'Code'),
    col('item', 'Item'),
    col('batch', 'Batch'),
    col('system', 'System', 'qty'),
    col('counted', 'Counted', 'qty'),
    col('variance', 'Variance', 'qty'),
    col('value', 'Variance value', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT k.number, s.name AS store, i.code, i.name AS item, b.batch_no AS batch, l.system_qty::float AS system, l.counted_qty::float AS counted,
              (l.counted_qty - l.system_qty)::float AS variance, ROUND((l.counted_qty - l.system_qty) * COALESCE(b.unit_cost, 0), 2)::float AS value
         FROM stock_take_line l JOIN stock_take k ON k.id = l.stock_take_id JOIN store s ON s.id = k.store_id JOIN item i ON i.id = l.item_id LEFT JOIN batch b ON b.id = l.batch_id
        WHERE k.posted_at IS NOT NULL AND ${q.localDate('k.posted_at', ctx)} AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.system_qty
          AND ${q.store('k.store_id', ctx)} AND ${q.category('i', ctx)}
        ORDER BY k.number, i.name LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

/** Batches on hand by expiry (stock balances valued at batch cost). */
function expiryReport(key: string, title: string, description: string, expired: boolean): ReportDef {
  return {
    key,
    title,
    group: 'INVENTORY',
    description,
    permissions: READ,
    filters: expired ? ['storeId', 'categoryId'] : ['storeId', 'categoryId', 'days'],
    landscape: true,
    columns: [
      col('store', 'Store'),
      col('code', 'Code'),
      col('item', 'Item'),
      col('batch', 'Batch'),
      col('expiry', 'Expiry', 'date'),
      col('days', expired ? 'Days expired' : 'Days left', 'number'),
      col('quantity', 'Quantity', 'qty'),
      col('value', 'Value', 'money'),
    ],
    async run(ctx) {
      const q = new Sql();
      const days = ctx.f.days ?? (await ctx.settings.get('reports.nearExpiryDays'));
      const today = q.p(ctx.today);
      const window = expired ? `b.expiry_date < ${today}::date` : `b.expiry_date BETWEEN ${today}::date AND ${today}::date + ${q.p(days)}::int`;
      const rows = await ctx.ds.query(
        `SELECT s.name AS store, i.code, i.name AS item, b.batch_no AS batch, b.expiry_date::text AS expiry, ABS(b.expiry_date - ${today}::date) AS days,
                SUM(sb.on_hand)::float AS quantity, ROUND(SUM(sb.on_hand * COALESCE(b.unit_cost, 0)), 2)::float AS value
           FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id JOIN item i ON i.id = sb.item_id JOIN store s ON s.id = sb.store_id
          WHERE sb.on_hand > 0 AND ${window} AND ${q.store('sb.store_id', ctx)} AND ${q.category('i', ctx)}
          GROUP BY s.name, i.code, i.name, b.batch_no, b.expiry_date ORDER BY b.expiry_date, s.name LIMIT ${q.p(ctx.maxRows)}`,
        q.params,
      );
      return { rows, totals: { value: sum(rows, 'value') }, notes: expired ? [] : [`Expiring within ${days} days of ${ctx.today}.`] };
    },
  };
}

/** On hand per store and item, for the planning reports. */
const ON_HAND = `(SELECT COALESCE(SUM(sb.on_hand), 0) FROM stock_balance sb WHERE sb.store_id = x.store_id AND sb.item_id = x.item_id)`;

const reorder: ReportDef = {
  key: 'reorder',
  title: 'Reorder report',
  group: 'INVENTORY',
  description: 'Items at or below their reorder level, with the quantity to bring them to the maximum.',
  permissions: READ,
  filters: ['storeId', 'categoryId'],
  landscape: true,
  columns: [
    col('store', 'Store'),
    col('code', 'Code'),
    col('item', 'Item'),
    col('onHand', 'On hand', 'qty'),
    col('reorderLevel', 'Reorder level', 'qty'),
    col('max', 'Maximum', 'qty'),
    col('amc', 'AMC', 'qty'),
    col('suggested', 'Suggested order', 'qty'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT * FROM (
         SELECT s.name AS store, i.code, i.name AS item, ${ON_HAND}::float AS "onHand", x.reorder_level::float AS "reorderLevel", x.max_level::float AS max, x.amc::float AS amc,
                GREATEST(COALESCE(x.max_level, 0) - ${ON_HAND}, COALESCE(x.reorder_qty, 0), 0)::float AS suggested
           FROM store_item_setting x JOIN item i ON i.id = x.item_id JOIN store s ON s.id = x.store_id
          WHERE x.is_active AND x.reorder_level IS NOT NULL AND ${q.store('x.store_id', ctx)} AND ${q.category('i', ctx)}) r
        WHERE "onHand" <= "reorderLevel" ORDER BY store, item LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows };
  },
};

const stockOut: ReportDef = {
  key: 'stock-out',
  title: 'Stock-out report',
  group: 'INVENTORY',
  description: 'Items stocked in a store (active stock level) with nothing on hand, and since when.',
  permissions: READ,
  filters: ['storeId', 'categoryId'],
  columns: [col('store', 'Store'), col('code', 'Code'), col('item', 'Item'), col('amc', 'AMC', 'qty'), col('lastMovement', 'Last movement', 'date'), col('lastReceipt', 'Last receipt', 'date')],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT s.name AS store, i.code, i.name AS item, x.amc::float AS amc,
              (SELECT MAX(t.effective_date)::text FROM stock_transaction t WHERE t.store_id = x.store_id AND t.item_id = x.item_id) AS "lastMovement",
              (SELECT MAX(t.effective_date)::text FROM stock_transaction t WHERE t.store_id = x.store_id AND t.item_id = x.item_id AND t.txn_type IN ('RECEIPT', 'TRANSFER_RECEIPT', 'OPENING')) AS "lastReceipt"
         FROM store_item_setting x JOIN item i ON i.id = x.item_id JOIN store s ON s.id = x.store_id
        WHERE x.is_active AND ${ON_HAND} <= 0 AND ${q.store('x.store_id', ctx)} AND ${q.category('i', ctx)}
        ORDER BY s.name, i.name LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows };
  },
};

const deadStock: ReportDef = {
  key: 'dead-stock',
  title: 'Dead stock',
  group: 'INVENTORY',
  description: 'Stock on hand with no issue, dispense, transfer or supplier return for the given number of days.',
  permissions: VALUE,
  filters: ['storeId', 'categoryId', 'days'],
  columns: [col('store', 'Store'), col('code', 'Code'), col('item', 'Item'), col('lastOut', 'Last movement out', 'date'), col('quantity', 'On hand', 'qty'), col('value', 'Value', 'money')],
  async run(ctx) {
    const q = new Sql();
    const days = ctx.f.days ?? (await ctx.settings.get('reports.deadStockDays'));
    const today = q.p(ctx.today);
    const rows = await ctx.ds.query(
      `SELECT * FROM (
         SELECT s.name AS store, i.code, i.name AS item,
                (SELECT MAX(t.effective_date) FROM stock_transaction t WHERE t.store_id = sb.store_id AND t.item_id = sb.item_id AND t.txn_type::text IN ${TXN_OUT}) AS last_out,
                SUM(sb.on_hand)::float AS quantity, ROUND(SUM(sb.on_hand * COALESCE(b.unit_cost, 0)), 2)::float AS value
           FROM stock_balance sb JOIN item i ON i.id = sb.item_id JOIN store s ON s.id = sb.store_id JOIN batch b ON b.id = sb.batch_id
          WHERE sb.on_hand > 0 AND ${q.store('sb.store_id', ctx)} AND ${q.category('i', ctx)}
          GROUP BY s.name, i.code, i.name, sb.store_id, sb.item_id) d
        WHERE last_out IS NULL OR last_out < ${today}::date - ${q.p(days)}::int
        ORDER BY value DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows: rows.map((r: Record<string, unknown>) => ({ store: r.store, code: r.code, item: r.item, lastOut: r.last_out ? String((r.last_out as Date).toISOString?.() ?? r.last_out).slice(0, 10) : null, quantity: r.quantity, value: r.value })), totals: { value: sum(rows, 'value') }, notes: [`No movement out for ${days} days.`] };
  },
};

const turnover: ReportDef = {
  key: 'inventory-turnover',
  title: 'Inventory turnover and days of inventory',
  group: 'INVENTORY',
  description: 'Cost of consumption (dispensed and issued, net of returns) over average stock value, and the days of stock that represents.',
  permissions: VALUE,
  filters: ['from', 'to', 'storeId', 'categoryId', 'groupBy'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'store', label: 'Store' },
    { value: 'category', label: 'Category' },
    { value: 'item', label: 'Item' },
  ],
  columns: [],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'store';
    const key = g === 'category' ? { sel: 'c.name AS label', grp: 'c.name', head: 'Category' } : g === 'item' ? { sel: "i.code || ' ' || i.name AS label", grp: 'i.code, i.name', head: 'Item' } : { sel: 's.name AS label', grp: 's.name', head: 'Store' };
    const from = q.p(ctx.f.from);
    const to = q.p(ctx.f.to);
    const rows: { label: string; opening: number; closing: number; consumption: number }[] = await ctx.ds.query(
      `SELECT ${key.sel},
              COALESCE(SUM(t.value_delta) FILTER (WHERE t.effective_date < ${from}::date), 0)::float AS opening,
              SUM(t.value_delta)::float AS closing,
              COALESCE(-SUM(t.value_delta) FILTER (WHERE t.effective_date >= ${from}::date AND t.txn_type::text IN ${TXN_CONSUMPTION}), 0)::float AS consumption
         FROM stock_transaction t JOIN item i ON i.id = t.item_id JOIN item_category c ON c.id = i.category_id JOIN store s ON s.id = t.store_id
        WHERE t.effective_date <= ${to}::date AND ${q.store('t.store_id', ctx)} AND ${q.category('i', ctx)}
        GROUP BY ${key.grp} ORDER BY 4 DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const days = daysBetween(ctx.f.from!, ctx.f.to!);
    const out = rows
      .filter((r) => r.opening || r.closing || r.consumption)
      .map((r) => {
        const avg = (r.opening + r.closing) / 2;
        const t = avg > 0 && r.consumption > 0 ? r.consumption / avg : null;
        return { label: r.label, opening: r2(r.opening), closing: r2(r.closing), average: r2(avg), consumption: r2(r.consumption), turnover: t === null ? null : Math.round(t * 100) / 100, daysOfInventory: t ? Math.round(days / t) : null };
      });
    const tot = out.reduce((a, r) => ({ average: a.average + Number(r.average), consumption: a.consumption + Number(r.consumption) }), { average: 0, consumption: 0 });
    const tt = tot.average > 0 && tot.consumption > 0 ? tot.consumption / tot.average : null;
    return {
      columns: [
        col('label', key.head),
        col('opening', 'Opening value', 'money'),
        col('closing', 'Closing value', 'money'),
        col('average', 'Average stock', 'money'),
        col('consumption', 'Consumption at cost', 'money'),
        col('turnover', 'Turnover (times)', 'number'),
        col('daysOfInventory', 'Days of inventory', 'number'),
      ],
      rows: out,
      totals: { average: r2(tot.average), consumption: r2(tot.consumption), turnover: tt === null ? null : Math.round(tt * 100) / 100, daysOfInventory: tt ? Math.round(days / tt) : null },
      notes: [`Period of ${days} days. Turnover = consumption ÷ average of opening and closing stock value.`],
    };
  },
};

export const INVENTORY_REPORTS: ReportDef[] = [
  stockStatus,
  movement,
  binCard,
  consumption,
  grnRegister,
  issueRegister,
  transferRegister,
  adjustmentRegister,
  stocktakeVariance,
  expiryReport('near-expiry', 'Near-expiry stock', 'Batches on hand expiring within the horizon (default reports.nearExpiryDays).', false),
  expiryReport('expired', 'Expired stock', 'Batches on hand past their expiry date.', true),
  reorder,
  stockOut,
  deadStock,
  turnover,
];

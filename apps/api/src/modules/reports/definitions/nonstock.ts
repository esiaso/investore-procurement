import { Permissions as P } from '@sil/shared';
import { col, pct, r2, ReportDef, Sql, sum } from '../report-types';

/**
 * Non-stock procurement, payments, petty cash, audit and integration reports
 * (spec Part F). Money is in the base currency unless a column says otherwise;
 * document numbers drill down to the document.
 */

const BUYING = [P.PURCHASING_READ, P.STAFF_REQUISITION_READ_ALL];
const PAYING = [P.PAYMENTS_PREPARE, P.PAYMENTS_RELEASE, P.PAYMENTS_RECONCILE];
const PETTY = [P.PETTY_CASH_MANAGE, P.PETTY_CASH_DISBURSE];
const ORDERED = `('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','INVOICED','PAID','CLOSED')`;
const OPEN_ORDER = `('APPROVED','SENT','PARTIALLY_RECEIVED')`;
const APPROVED_INVOICE = `('APPROVED','SCHEDULED','PARTIALLY_PAID','PAID')`;

/** Who the pending approval of a document waits for (step approvers, less the requester and excluded users). */
const awaiting = (docId: string) => `(SELECT string_agg(DISTINCT x.full_name, ', ')
    FROM approval_request ar JOIN approval_step s ON s.workflow_id = ar.workflow_id AND s.sequence = ar.current_step
    JOIN app_user x ON x.is_active AND (x.id = s.user_id OR x.id IN (SELECT ur.user_id FROM user_role ur WHERE ur.role_id = s.role_id))
   WHERE ar.document_id = ${docId} AND ar.status = 'PENDING' AND x.id <> ar.requested_by AND NOT (ar.excluded_user_ids ? x.id::text)
     AND (s.approver_type <> 'DEPARTMENT_ROLE' OR x.department_id = ar.department_id))`;
const pendingStep = (docId: string) =>
  `(SELECT s.name FROM approval_request ar JOIN approval_step s ON s.workflow_id = ar.workflow_id AND s.sequence = ar.current_step WHERE ar.document_id = ${docId} AND ar.status = 'PENDING' LIMIT 1)`;

/** date_trunc unit and label of a period filter. */
const BUCKET: Record<string, { unit: string; label: string }> = {
  DAY: { unit: 'day', label: 'YYYY-MM-DD' },
  WEEK: { unit: 'week', label: 'IYYY-"W"IW' },
  MONTH: { unit: 'month', label: 'YYYY-MM' },
  QUARTER: { unit: 'quarter', label: 'YYYY-"Q"Q' },
  YEAR: { unit: 'year', label: 'YYYY' },
};
const bucket = (expr: string, period = 'MONTH') => `to_char(date_trunc('${BUCKET[period].unit}', ${expr}), '${BUCKET[period].label}')`;
const PERIODS = [
  { value: 'DAY', label: 'Day' },
  { value: 'WEEK', label: 'Week' },
  { value: 'MONTH', label: 'Month' },
  { value: 'QUARTER', label: 'Quarter' },
  { value: 'YEAR', label: 'Year' },
];

// ------------------------------------------------------------------ procurement

const pendingRequisitions: ReportDef = {
  key: 'pending-requisitions',
  title: 'Pending requisitions',
  group: 'PURCHASING',
  description: 'Staff requisitions not yet fully with procurement or the store: waiting for approval, returned, or approved and waiting to be bought. Age and who the approval waits for.',
  permissions: BUYING,
  filters: ['departmentId', 'userId', 'status'],
  landscape: true,
  columns: [
    col('number', 'Requisition', 'text', { docType: 'REQ', idKey: '_id' }),
    col('department', 'Department'),
    col('requester', 'Requested by'),
    col('status', 'Status'),
    col('submitted', 'Submitted', 'date'),
    col('ageDays', 'Age (days)', 'number'),
    col('step', 'Approval step'),
    col('awaiting', 'Waiting for'),
    col('amount', 'Estimate', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const today = q.p(ctx.today);
    const rows = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, d.name AS department, u.full_name AS requester, r.status, (r.submitted_at AT TIME ZONE ${q.p(ctx.tz)})::date::text AS submitted,
              (${today}::date - (COALESCE(r.submitted_at, r.created_at) AT TIME ZONE ${q.p(ctx.tz)})::date) AS "ageDays",
              ${pendingStep('r.id')} AS step, ${awaiting('r.id')} AS awaiting, ROUND(r.estimated_total, 2)::float AS amount
         FROM staff_requisition r JOIN department d ON d.id = r.department_id JOIN app_user u ON u.id = r.requested_by
        WHERE r.status IN ('SUBMITTED', 'RETURNED', 'APPROVED', 'PARTLY_CONVERTED') AND ${q.eq('r.department_id', ctx.f.departmentId)} AND ${q.eq('r.requested_by', ctx.f.userId)} AND ${q.eq('r.status::text', ctx.f.status)}
        ORDER BY "ageDays" DESC, r.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { amount: sum(rows, 'amount') } };
  },
};

const pendingPrs: ReportDef = {
  key: 'pending-prs',
  title: 'Pending purchase requests',
  group: 'PURCHASING',
  description: 'Purchase requisitions in approval or approved but not yet fully ordered, with value, days pending and who the approval waits for.',
  permissions: [P.PURCHASING_READ],
  filters: ['departmentId', 'status'],
  landscape: true,
  columns: [
    col('number', 'Purchase request', 'text', { docType: 'PR', idKey: '_id' }),
    col('department', 'Department'),
    col('status', 'Status'),
    col('method', 'Method'),
    col('raised', 'Raised', 'date'),
    col('daysPending', 'Days pending', 'number'),
    col('awaiting', 'Waiting for'),
    col('value', 'Estimated value', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT pr.id AS _id, pr.number, d.name AS department, pr.status, pr.sourcing_method AS method, (pr.created_at AT TIME ZONE ${q.p(ctx.tz)})::date::text AS raised,
              (${q.p(ctx.today)}::date - (pr.created_at AT TIME ZONE ${q.p(ctx.tz)})::date) AS "daysPending", ${awaiting('pr.id')} AS awaiting, ROUND(pr.estimated_total, 2)::float AS value
         FROM purchase_requisition pr JOIN department d ON d.id = pr.department_id
        WHERE pr.status IN ('PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'RFQ_ISSUED', 'PARTIALLY_FULFILLED') AND ${q.eq('pr.department_id', ctx.f.departmentId)} AND ${q.eq('pr.status::text', ctx.f.status)}
        ORDER BY "daysPending" DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const openLpos: ReportDef = {
  key: 'open-lpos',
  title: 'Open purchase orders and LPOs',
  group: 'PURCHASING',
  description: 'Approved orders not fully received: not received, partly received, delivery overdue, or expiring within 14 days. Value in the base currency.',
  permissions: [P.PURCHASING_READ],
  filters: ['supplierId', 'departmentId', 'currency'],
  landscape: true,
  columns: [
    col('number', 'Order', 'text', { docType: 'PO', idKey: '_id' }),
    col('supplier', 'Supplier'),
    col('department', 'Department'),
    col('ordered', 'Ordered', 'date'),
    col('expected', 'Expected', 'date'),
    col('expires', 'Valid until', 'date'),
    col('currency', 'Currency'),
    col('value', 'Value (base)', 'money'),
    col('received', 'Received %', 'percent'),
    col('flag', 'Attention'),
  ],
  async run(ctx) {
    const q = new Sql();
    const today = q.p(ctx.today);
    const rows: Record<string, unknown>[] = await ctx.ds.query(
      `SELECT po.id AS _id, po.number, s.name AS supplier, d.name AS department, po.order_date::text AS ordered, po.expected_delivery::text AS expected, po.expires_on::text AS expires, po.currency,
              ROUND(COALESCE(NULLIF(po.base_total, 0), po.total), 2)::float AS value,
              ROUND(100 * COALESCE((SELECT SUM(l.received_base_qty) / NULLIF(SUM(l.quantity * l.conversion_factor), 0) FROM purchase_order_line l WHERE l.purchase_order_id = po.id), 0), 1)::float AS received,
              po.expected_delivery < ${today}::date AS overdue, po.expires_on <= ${today}::date + 14 AS expiring
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id LEFT JOIN department d ON d.id = po.department_id
        WHERE po.status IN ${OPEN_ORDER} AND ${q.eq('po.supplier_id', ctx.f.supplierId)} AND ${q.eq('po.department_id', ctx.f.departmentId)} AND ${q.eq('po.currency', ctx.f.currency)}
        ORDER BY po.expected_delivery NULLS LAST, po.number LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    for (const r of rows) {
      const flags = [r.overdue ? 'Delivery overdue' : null, r.expiring ? 'Expiring' : null, Number(r.received) === 0 ? 'Not received' : 'Partly received'].filter(Boolean);
      r.flag = flags.join(', ');
      delete r.overdue;
      delete r.expiring;
    }
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const rfqAwards: ReportDef = {
  key: 'rfq-awards',
  title: 'RFQ status and awards',
  group: 'PURCHASING',
  description: 'RFQs raised in the period: invited suppliers, quotations, evaluation, recommendation, award and the justification when the lowest bid was not chosen.',
  permissions: [P.PURCHASING_READ],
  filters: ['from', 'to', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'RFQ', 'text', { docType: 'RFQ', idKey: '_id' }),
    col('title', 'Title'),
    col('status', 'Status'),
    col('invited', 'Invited', 'number'),
    col('quotes', 'Quotations', 'number'),
    col('technicalWeight', 'Technical %', 'number'),
    col('recommended', 'Recommended'),
    col('awarded', 'Awarded to'),
    col('awardValue', 'Award value', 'money'),
    col('justification', 'Justification'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, r.title, r.status, jsonb_array_length(to_jsonb(r.supplier_ids)) AS invited,
              (SELECT COUNT(*)::int FROM quotation qt WHERE qt.rfq_id = r.id) AS quotes, r.technical_weight AS "technicalWeight",
              (SELECT name FROM supplier WHERE id = r.recommended_supplier_id) AS recommended,
              (SELECT string_agg(DISTINCT s.name, ', ') FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id WHERE po.rfq_id = r.id AND po.status::text <> 'CANCELLED') AS awarded,
              (SELECT ROUND(COALESCE(SUM(COALESCE(NULLIF(po.base_total, 0), po.total)), 0), 2)::float FROM purchase_order po WHERE po.rfq_id = r.id AND po.status::text <> 'CANCELLED') AS "awardValue",
              COALESCE(r.award_justification, r.fewer_suppliers_justification) AS justification
         FROM rfq r WHERE ${q.localDate('r.created_at', ctx)} AND ${q.eq('r.status::text', ctx.f.status)}
        ORDER BY r.created_at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { awardValue: sum(rows, 'awardValue') } };
  },
};

const acceptanceRegister: ReportDef = {
  key: 'acceptance-register',
  title: 'Goods received (non-stock) and service acceptance register',
  group: 'PURCHASING',
  description: 'Acceptance certificates posted in the period (non-stock goods, services and works): accepted and rejected quantities, who signed and the value. Stock deliveries are in the GRN register.',
  permissions: [P.PURCHASING_READ],
  filters: ['from', 'to', 'supplierId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Certificate', 'text', { docType: 'SCC', idKey: '_id' }),
    col('posted', 'Accepted', 'date'),
    col('order', 'Order', 'text', { docType: 'PO', idKey: '_poId' }),
    col('supplier', 'Supplier'),
    col('acceptedBy', 'Signed by'),
    col('accepted', 'Accepted qty', 'qty'),
    col('rejected', 'Rejected qty', 'qty'),
    col('value', 'Value', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT c.id AS _id, c.number, (c.posted_at AT TIME ZONE ${q.p(ctx.tz)})::date::text AS posted, po.id AS "_poId", po.number AS order, s.name AS supplier,
              COALESCE(ua.full_name, uc.full_name) AS "acceptedBy", SUM(cl.quantity)::float AS accepted, SUM(cl.rejected_qty)::float AS rejected,
              ROUND(SUM(cl.quantity * pl.unit_price * po.exchange_rate), 2)::float AS value
         FROM service_certificate c JOIN purchase_order po ON po.id = c.purchase_order_id JOIN supplier s ON s.id = c.supplier_id
         JOIN service_certificate_line cl ON cl.certificate_id = c.id JOIN purchase_order_line pl ON pl.id = cl.po_line_id
         LEFT JOIN app_user ua ON ua.id = c.accepted_by LEFT JOIN app_user uc ON uc.id = c.certified_by
        WHERE c.status = 'POSTED' AND ${q.localDate('c.posted_at', ctx)} AND ${q.eq('c.supplier_id', ctx.f.supplierId)}
        GROUP BY c.id, po.id, s.name, ua.full_name, uc.full_name ORDER BY c.posted_at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { value: sum(rows, 'value') } };
  },
};

const accruals: ReportDef = {
  key: 'received-not-invoiced',
  title: 'Received not invoiced (accruals)',
  group: 'PURCHASING',
  description: 'Order lines received or accepted but not yet covered by an invoice: the value to accrue (base currency, excl. VAT).',
  permissions: [P.PURCHASING_READ, ...PAYING],
  filters: ['supplierId', 'departmentId'],
  landscape: true,
  columns: [
    col('order', 'Order', 'text', { docType: 'PO', idKey: '_poId' }),
    col('supplier', 'Supplier'),
    col('line', 'Line'),
    col('type', 'Type'),
    col('received', 'Received', 'qty'),
    col('invoiced', 'Invoiced', 'qty'),
    col('uninvoiced', 'Not invoiced', 'qty'),
    col('value', 'Accrual', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT * FROM (
         SELECT po.id AS "_poId", po.number AS order, s.name AS supplier, COALESCE(it.name, l.description) AS line, l.line_type AS type,
                ROUND(l.received_base_qty / l.conversion_factor, 4)::float AS received,
                COALESCE((SELECT SUM(il.quantity) FROM supplier_invoice_line il JOIN supplier_invoice i ON i.id = il.invoice_id WHERE il.po_line_id = l.id AND i.status::text NOT IN ('REJECTED', 'CANCELLED')), 0)::float AS invoiced,
                l.unit_price, po.exchange_rate
           FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id JOIN supplier s ON s.id = po.supplier_id LEFT JOIN item it ON it.id = l.item_id
          WHERE l.received_base_qty > 0 AND po.status::text NOT IN ('CANCELLED', 'DRAFT') AND ${q.eq('po.supplier_id', ctx.f.supplierId)} AND ${q.eq('po.department_id', ctx.f.departmentId)}) x
        WHERE x.received > x.invoiced + 0.0001 ORDER BY x.order LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const out = rows.map((r: Record<string, unknown>) => {
      const un = Math.round((Number(r.received) - Number(r.invoiced)) * 10_000) / 10_000;
      const { unit_price: price, exchange_rate: rate, ...rest } = r;
      return { ...rest, uninvoiced: un, value: r2(un * Number(price) * Number(rate)) };
    });
    return { rows: out, totals: { value: sum(out, 'value') } };
  },
};

const matchExceptions: ReportDef = {
  key: 'match-exceptions',
  title: 'Three-way match exceptions',
  group: 'PURCHASING',
  description: 'Supplier invoices captured in the period that do not match the order and what was received or accepted, with each variance.',
  permissions: [P.PURCHASING_READ, ...PAYING],
  filters: ['from', 'to', 'supplierId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Invoice', 'text', { docType: 'INV', idKey: '_id' }),
    col('supplierInvoiceNo', 'Supplier no.'),
    col('supplier', 'Supplier'),
    col('date', 'Invoice date', 'date'),
    col('order', 'Order', 'text', { docType: 'PO', idKey: '_poId' }),
    col('status', 'Status'),
    col('total', 'Total', 'money'),
    col('codes', 'Variances'),
    col('detail', 'Detail'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT i.id AS _id, i.number, i.supplier_invoice_no AS "supplierInvoiceNo", s.name AS supplier, i.invoice_date::text AS date, po.id AS "_poId", po.number AS order, i.status,
              ROUND(i.total * i.exchange_rate, 2)::float AS total,
              (SELECT string_agg(DISTINCT v->>'code', ', ') FROM jsonb_array_elements(i.variances) v) AS codes,
              (SELECT string_agg(v->>'message', '; ') FROM jsonb_array_elements(i.variances) v) AS detail
         FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id JOIN purchase_order po ON po.id = i.purchase_order_id
        WHERE i.match_status = 'VARIANCE' AND i.status::text <> 'CANCELLED' AND ${q.between('i.invoice_date', ctx)} AND ${q.eq('i.supplier_id', ctx.f.supplierId)} AND ${q.eq('i.status::text', ctx.f.status)}
        ORDER BY i.invoice_date LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { total: sum(rows, 'total') } };
  },
};

const purchasesOverTime: ReportDef = {
  key: 'purchases-over-time',
  title: 'Value of purchases over time',
  group: 'PURCHASING',
  description: 'Orders raised (approved and later), excl. VAT in the base currency, by day, week, month, quarter or year, optionally broken down by department, supplier, category or GL account, with the change on the previous period.',
  permissions: [P.PURCHASING_READ],
  filters: ['from', 'to', 'period', 'groupBy', 'departmentId', 'supplierId', 'projectId', 'currency'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'none', label: 'Total only' },
    { value: 'department', label: 'Department' },
    { value: 'supplier', label: 'Supplier' },
    { value: 'category', label: 'Category' },
    { value: 'gl', label: 'GL account' },
  ],
  chart: { type: 'line', x: 'period', series: ['value'] },
  columns: [col('period', 'Period'), col('value', 'Value', 'money'), col('previous', 'Previous period', 'money'), col('change', 'Change %', 'percent')],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'none';
    const dim: Record<string, string> = {
      none: `NULL`,
      department: `COALESCE(d.name, '(none)')`,
      supplier: `s.name`,
      category: `COALESCE(c.name, CASE l.line_type WHEN 'SERVICE' THEN 'Services' ELSE 'Non-stock goods' END)`,
      gl: `CASE WHEN l.line_type = 'STOCK' THEN 'Stock (inventory)' ELSE COALESCE(gl.code || ' ' || gl.name, '(no GL account)') END`,
    };
    const rows: { period: string; dim: string | null; value: number }[] = await ctx.ds.query(
      `SELECT ${bucket('po.order_date::timestamp', ctx.f.period ?? 'MONTH')} AS period, ${dim[g]} AS dim, ROUND(SUM(l.line_subtotal * po.exchange_rate), 2)::float AS value
         FROM purchase_order po JOIN purchase_order_line l ON l.purchase_order_id = po.id JOIN supplier s ON s.id = po.supplier_id
         LEFT JOIN department d ON d.id = po.department_id LEFT JOIN item it ON it.id = l.item_id LEFT JOIN item_category c ON c.id = it.category_id LEFT JOIN gl_account gl ON gl.id = l.gl_account_id
         LEFT JOIN purchase_requisition_line prl ON prl.id = l.requisition_line_id LEFT JOIN staff_requisition_line srl ON srl.pr_line_id = prl.id LEFT JOIN staff_requisition sr ON sr.id = srl.requisition_id
        WHERE po.status IN ${ORDERED} AND ${q.between('po.order_date', ctx)} AND ${q.eq('po.department_id', ctx.f.departmentId)} AND ${q.eq('po.supplier_id', ctx.f.supplierId)}
          AND ${q.eq('po.currency', ctx.f.currency)} AND ${q.eq('sr.project_id', ctx.f.projectId)}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      q.params,
    );
    const periods = [...new Set(rows.map((r) => r.period))].sort();
    const out = rows.map((r) => {
      const prevPeriod = periods[periods.indexOf(r.period) - 1];
      const prev = prevPeriod ? (rows.find((x) => x.period === prevPeriod && x.dim === r.dim)?.value ?? 0) : null;
      return { period: r.period, ...(g === 'none' ? {} : { [g]: r.dim }), value: r.value, previous: prev, change: prev ? pct(r.value - prev, prev) : null };
    });
    return {
      columns: [col('period', 'Period'), ...(g === 'none' ? [] : [col(g, purchasesOverTime.groupBy!.find((x) => x.value === g)!.label)]), ...purchasesOverTime.columns.slice(1)],
      rows: out,
      totals: { value: sum(out, 'value') },
    };
  },
};

const cycleTime: ReportDef = {
  key: 'procurement-cycle-time',
  title: 'Procurement cycle time',
  group: 'PURCHASING',
  description: 'For requisitions raised in the period: days from submission to approval, purchase request, order, receipt / acceptance, payment and delivery to the requester.',
  permissions: BUYING,
  filters: ['from', 'to', 'departmentId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Requisition', 'text', { docType: 'REQ', idKey: '_id' }),
    col('department', 'Department'),
    col('toApproval', 'To approval', 'number'),
    col('toPr', 'To PR', 'number'),
    col('toOrder', 'To order', 'number'),
    col('toReceipt', 'To receipt', 'number'),
    col('toPayment', 'To payment', 'number'),
    col('toDelivery', 'To delivery', 'number'),
    col('total', 'Total days', 'number'),
  ],
  async run(ctx) {
    const q = new Sql();
    const tz = q.p(ctx.tz);
    const d = (e: string) => `(${e} AT TIME ZONE ${tz})::date`;
    const rows: Record<string, unknown>[] = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, dp.name AS department, ${d('r.submitted_at')} AS submitted, ${d('r.approved_at')} AS approved,
              (SELECT MIN(${d('pr.created_at')}) FROM staff_requisition_line sl JOIN purchase_requisition_line pl ON pl.id = sl.pr_line_id JOIN purchase_requisition pr ON pr.id = pl.requisition_id WHERE sl.requisition_id = r.id) AS pr,
              (SELECT MIN(po.order_date) FROM staff_requisition_line sl JOIN purchase_order_line ol ON ol.requisition_line_id = sl.pr_line_id JOIN purchase_order po ON po.id = ol.purchase_order_id
                WHERE sl.requisition_id = r.id AND po.status IN ${ORDERED}) AS ordered,
              (SELECT MAX(${d('c.posted_at')}) FROM staff_requisition_line sl JOIN purchase_order_line ol ON ol.requisition_line_id = sl.pr_line_id
                 JOIN service_certificate_line cl ON cl.po_line_id = ol.id JOIN service_certificate c ON c.id = cl.certificate_id AND c.status = 'POSTED' WHERE sl.requisition_id = r.id) AS received,
              (SELECT MAX(v.paid_on) FROM staff_requisition_line sl JOIN purchase_order_line ol ON ol.requisition_line_id = sl.pr_line_id JOIN supplier_invoice_line il ON il.po_line_id = ol.id
                 JOIN payment_voucher_line vl ON vl.invoice_id = il.invoice_id JOIN payment_voucher v ON v.id = vl.voucher_id AND v.status = 'PAID' WHERE sl.requisition_id = r.id) AS paid,
              CASE WHEN r.status = 'CLOSED' THEN COALESCE((SELECT MAX(${d('h.acknowledged_at')}) FROM handover h WHERE h.requisition_id = r.id AND h.status = 'ACKNOWLEDGED'), ${d('r.updated_at')}) END AS delivered
         FROM staff_requisition r JOIN department dp ON dp.id = r.department_id
        WHERE r.submitted_at IS NOT NULL AND ${q.localDate('r.created_at', ctx)} AND ${q.eq('r.department_id', ctx.f.departmentId)}
        ORDER BY r.created_at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const days = (a: unknown, b: unknown) => (a && b ? Math.round((Date.parse(String(b instanceof Date ? b.toISOString() : b)) - Date.parse(String(a instanceof Date ? a.toISOString() : a))) / 86_400_000) : null);
    const out = rows.map((r) => ({
      _id: r._id,
      number: r.number,
      department: r.department,
      toApproval: days(r.submitted, r.approved),
      toPr: days(r.approved, r.pr),
      toOrder: days(r.pr, r.ordered),
      toReceipt: days(r.ordered, r.received),
      toPayment: days(r.received, r.paid),
      toDelivery: days(r.received, r.delivered),
      total: days(r.submitted, r.delivered ?? r.paid ?? r.received ?? r.ordered ?? r.pr ?? r.approved),
    }));
    const avg = (k: string) => {
      const v = out.map((x) => (x as Record<string, unknown>)[k]).filter((x): x is number => typeof x === 'number');
      return v.length ? Math.round((10 * v.reduce((a, b) => a + b, 0)) / v.length) / 10 : null;
    };
    return { rows: out, totals: { number: 'Average', toApproval: avg('toApproval'), toPr: avg('toPr'), toOrder: avg('toOrder'), toReceipt: avg('toReceipt'), toPayment: avg('toPayment'), toDelivery: avg('toDelivery'), total: avg('total') } };
  },
};

const budgetVsActual: ReportDef = {
  key: 'budget-vs-actual',
  title: 'Budget vs committed vs actual',
  group: 'PURCHASING',
  description: 'Per budget line (cost centre): the budget, what is committed by open orders, what is actual (approved invoices) and paid, and what is left.',
  permissions: [P.BUDGETS_READ, P.PURCHASING_READ],
  filters: ['departmentId'],
  landscape: true,
  columns: [
    col('department', 'Cost centre'),
    col('voteHead', 'Vote head'),
    col('year', 'Financial year'),
    col('budget', 'Budget', 'money'),
    col('committed', 'Committed', 'money'),
    col('actual', 'Actual', 'money'),
    col('paid', 'Paid', 'money'),
    col('available', 'Available', 'money'),
    col('used', 'Used %', 'percent'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows: Record<string, number | string>[] = await ctx.ds.query(
      `SELECT d.name AS department, b.vote_head AS "voteHead", b.financial_year AS year, ROUND(b.amount, 2)::float AS budget,
              ROUND(COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type IN ('COMMITMENT', 'RELEASE')), 0), 2)::float AS committed,
              ROUND(COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'ACTUAL'), 0), 2)::float AS actual,
              ROUND(COALESCE((SELECT SUM(vl.amount * i.exchange_rate) FROM supplier_invoice i JOIN purchase_order po ON po.id = i.purchase_order_id
                                JOIN payment_voucher_line vl ON vl.invoice_id = i.id JOIN payment_voucher v ON v.id = vl.voucher_id AND v.status = 'PAID' WHERE po.budget_id = b.id), 0), 2)::float AS paid
         FROM budget b JOIN department d ON d.id = b.department_id LEFT JOIN budget_entry e ON e.budget_id = b.id
        WHERE b.is_active AND ${q.eq('b.department_id', ctx.f.departmentId)}
        GROUP BY b.id, d.name ORDER BY d.name, b.vote_head LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const out = rows.map((r) => ({ ...r, available: r2(Number(r.budget) - Number(r.committed) - Number(r.actual)), used: pct(Number(r.committed) + Number(r.actual), Number(r.budget)) }));
    return { rows: out, totals: { budget: sum(out, 'budget'), committed: sum(out, 'committed'), actual: sum(out, 'actual'), paid: sum(out, 'paid'), available: sum(out, 'available') } };
  },
};

const deliveredToUsers: ReportDef = {
  key: 'delivered-to-users',
  title: 'Delivered to final users vs outstanding',
  group: 'PURCHASING',
  description: 'Non-stock requisition lines approved in the period: ordered, received from the supplier, delivered to the requester, and what is still outstanding.',
  permissions: BUYING,
  filters: ['from', 'to', 'departmentId', 'userId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('number', 'Requisition', 'text', { docType: 'REQ', idKey: '_id' }),
    col('department', 'Department'),
    col('requester', 'Requester'),
    col('line', 'Goods / service'),
    col('quantity', 'Requested', 'qty'),
    col('received', 'Received', 'qty'),
    col('delivered', 'Delivered', 'qty'),
    col('outstanding', 'Outstanding', 'qty'),
    col('status', 'Status'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, d.name AS department, u.full_name AS requester, l.description AS line, l.quantity::float AS quantity, l.received_qty::float AS received,
              l.delivered_qty::float AS delivered, GREATEST(l.quantity - l.delivered_qty, 0)::float AS outstanding, l.status
         FROM staff_requisition_line l JOIN staff_requisition r ON r.id = l.requisition_id JOIN department d ON d.id = r.department_id JOIN app_user u ON u.id = r.requested_by
        WHERE l.line_type <> 'STOCK' AND l.status <> 'CANCELLED' AND r.approved_at IS NOT NULL AND ${q.localDate('r.approved_at', ctx)}
          AND ${q.eq('r.department_id', ctx.f.departmentId)} AND ${q.eq('r.requested_by', ctx.f.userId)}
        ORDER BY r.number, l.line_no LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const delivered = rows.filter((r: { outstanding: number }) => r.outstanding <= 0).length;
    return { rows, notes: [`${delivered} of ${rows.length} line(s) fully delivered`] };
  },
};

// ------------------------------------------------------------------ payments

const apAgeing: ReportDef = {
  key: 'ap-ageing',
  title: 'Accounts payable ageing',
  group: 'PAYMENTS',
  description: 'Approved supplier invoices still owed (less what is paid), by days past their due date as at today, per supplier, in the base currency.',
  permissions: [...PAYING, P.PURCHASING_INVOICE],
  filters: ['supplierId'],
  landscape: true,
  columns: [
    col('supplier', 'Supplier'),
    col('current', 'Current', 'money'),
    col('d30', '1–30', 'money'),
    col('d60', '31–60', 'money'),
    col('d90', '61–90', 'money'),
    col('over90', '90+', 'money'),
    col('total', 'Total owed', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const today = q.p(ctx.today);
    const age = `(${today}::date - COALESCE(i.due_date, i.invoice_date))`;
    const owed = `(i.total - i.paid_amount) * i.exchange_rate`;
    const rows = await ctx.ds.query(
      `SELECT s.name AS supplier,
              ROUND(SUM(${owed}) FILTER (WHERE ${age} <= 0), 2)::float AS current,
              ROUND(SUM(${owed}) FILTER (WHERE ${age} BETWEEN 1 AND 30), 2)::float AS d30,
              ROUND(SUM(${owed}) FILTER (WHERE ${age} BETWEEN 31 AND 60), 2)::float AS d60,
              ROUND(SUM(${owed}) FILTER (WHERE ${age} BETWEEN 61 AND 90), 2)::float AS d90,
              ROUND(SUM(${owed}) FILTER (WHERE ${age} > 90), 2)::float AS over90,
              ROUND(SUM(${owed}), 2)::float AS total
         FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id
        WHERE i.status IN ('APPROVED', 'SCHEDULED', 'PARTIALLY_PAID') AND i.total > i.paid_amount AND ${q.eq('i.supplier_id', ctx.f.supplierId)}
        GROUP BY s.name ORDER BY total DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const clean = rows.map((r: Record<string, number | null>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? 0])));
    return { rows: clean, totals: Object.fromEntries(['current', 'd30', 'd60', 'd90', 'over90', 'total'].map((k) => [k, sum(clean, k)])) };
  },
};

const paymentsByMethod: ReportDef = {
  key: 'payments-by-method',
  title: 'Payments by method',
  group: 'PAYMENTS',
  description: 'Supplier payments made in the period by method (bank, cheque, M-PESA B2B / B2C, cash), optionally per day, week, month, quarter or year; petty cash paid out alongside.',
  permissions: [...PAYING, ...PETTY],
  filters: ['from', 'to', 'period', 'method', 'supplierId'],
  required: ['from', 'to'],
  chart: { type: 'bar', x: 'method', series: ['amount'] },
  columns: [col('period', 'Period'), col('source', 'Paid from'), col('method', 'Method'), col('count', 'Payments', 'number'), col('amount', 'Paid', 'money'), col('wht', 'WHT deducted', 'money')],
  async run(ctx) {
    const q = new Sql();
    const per = ctx.f.period;
    const rows = await ctx.ds.query(
      `SELECT ${per ? bucket('x.d::timestamp', per) : `'All'`} AS period, x.source, x.method, COUNT(*)::int AS count, ROUND(SUM(x.amount), 2)::float AS amount, ROUND(SUM(x.wht), 2)::float AS wht FROM (
         SELECT v.paid_on AS d, 'Supplier payments' AS source, v.method, v.amount * COALESCE((SELECT MAX(i.exchange_rate) FROM payment_voucher_line l JOIN supplier_invoice i ON i.id = l.invoice_id WHERE l.voucher_id = v.id), 1) AS amount, v.wht_amount AS wht
           FROM payment_voucher v WHERE v.status = 'PAID' AND ${q.between('v.paid_on', ctx)} AND ${q.eq('v.supplier_id', ctx.f.supplierId)}
         UNION ALL
         SELECT r.disbursed_on, 'Petty cash', r.method, r.amount, 0 FROM petty_cash_request r WHERE r.disbursed_on IS NOT NULL AND r.status::text NOT IN ('REVERSED') AND ${q.between('r.disbursed_on', ctx)} AND ${ctx.f.supplierId ? 'FALSE' : 'TRUE'}
       ) x WHERE ${q.eq('x.method', ctx.f.method)}
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      q.params,
    );
    return { rows, totals: { count: rows.reduce((s: number, r: { count: number }) => s + r.count, 0), amount: sum(rows, 'amount'), wht: sum(rows, 'wht') } };
  },
};

const paymentSchedule: ReportDef = {
  key: 'payment-schedule',
  title: 'Payment schedule and cash requirement',
  group: 'PAYMENTS',
  description: 'Cash needed per week from today: vouchers approved or in progress by their payment date, and approved invoices not yet on a voucher by their due date (net of WHT), with the running total.',
  permissions: PAYING,
  filters: ['days', 'supplierId'],
  columns: [
    col('week', 'Week starting', 'date'),
    col('vouchers', 'Scheduled vouchers', 'money'),
    col('invoices', 'Invoices due (not scheduled)', 'money'),
    col('total', 'Cash needed', 'money'),
    col('cumulative', 'Cumulative', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const today = q.p(ctx.today);
    const horizon = q.p(ctx.f.days ?? 90);
    const wk = (e: string) => `GREATEST(date_trunc('week', ${e}::timestamp), date_trunc('week', ${today}::date::timestamp))::date::text`;
    const rows: { week: string; vouchers: number; invoices: number }[] = await ctx.ds.query(
      `SELECT week, ROUND(SUM(v), 2)::float AS vouchers, ROUND(SUM(i), 2)::float AS invoices FROM (
         SELECT ${wk(`COALESCE(v.due_date, ${today}::date)`)} AS week, v.amount AS v, 0 AS i FROM payment_voucher v
          WHERE v.status IN ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'REVIEW', 'FAILED') AND ${q.eq('v.supplier_id', ctx.f.supplierId)}
         UNION ALL
         SELECT ${wk('COALESCE(i.due_date, i.invoice_date)')}, 0,
                (i.total - i.paid_amount - COALESCE((SELECT SUM(l.amount) FROM payment_voucher_line l JOIN payment_voucher v ON v.id = l.voucher_id
                   WHERE l.invoice_id = i.id AND v.status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PROCESSING', 'FAILED', 'REVIEW')), 0)) * (1 - i.wht_total / NULLIF(i.total, 0)) * i.exchange_rate
           FROM supplier_invoice i WHERE i.status IN ('APPROVED', 'SCHEDULED', 'PARTIALLY_PAID') AND ${q.eq('i.supplier_id', ctx.f.supplierId)}
       ) x WHERE week::date <= ${today}::date + ${horizon}::int GROUP BY week ORDER BY week`,
      q.params,
    );
    let running = 0;
    const out = rows
      .map((r) => ({ ...r, total: r2(r.vouchers + r.invoices)! }))
      .filter((r) => r.total > 0.004)
      .map((r) => ({ ...r, cumulative: r2((running += r.total))! }));
    return { rows: out, totals: { vouchers: sum(out, 'vouchers'), invoices: sum(out, 'invoices'), total: sum(out, 'total') } };
  },
};

const mpesaLog: ReportDef = {
  key: 'mpesa-log',
  title: 'M-PESA transactions and reconciliation',
  group: 'PAYMENTS',
  description: 'Every M-PESA payout attempt in the period (supplier and petty cash): status, receipt, recipient, charges, and whether it is on the imported statement.',
  permissions: [...PAYING, P.PETTY_CASH_MANAGE],
  filters: ['from', 'to', 'status', 'method'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('at', 'Sent', 'datetime'),
    col('document', 'Document', 'text', { docType: '@_docType', idKey: '_docId' }),
    col('attempt', 'Attempt', 'number'),
    col('command', 'Command'),
    col('partyB', 'To'),
    col('amount', 'Amount', 'money'),
    col('status', 'Status'),
    col('receipt', 'Receipt'),
    col('recipient', 'Recipient'),
    col('charges', 'Charges', 'money'),
    col('onStatement', 'On statement'),
    col('result', 'Result'),
  ],
  async run(ctx) {
    const q = new Sql();
    const methodCmd: Record<string, string> = { MPESA_B2C: 'BusinessPayment', MPESA_PAYBILL: 'BusinessPayBill', MPESA_TILL: 'BusinessBuyGoods' };
    const rows = await ctx.ds.query(
      `SELECT p.created_at AS at, COALESCE(v.number, pc.number) AS document, CASE WHEN p.voucher_id IS NOT NULL THEN 'PV' ELSE 'PCV' END AS "_docType", COALESCE(p.voucher_id, p.petty_cash_id) AS "_docId",
              p.attempt, p.command_id AS command, CASE WHEN length(p.party_b) > 9 THEN left(p.party_b, 4) || '****' || right(p.party_b, 4) ELSE p.party_b END AS "partyB",
              ROUND(p.amount, 2)::float AS amount, p.status, p.receipt_no AS receipt, p.recipient_name AS recipient, ROUND(COALESCE(p.charges, 0), 2)::float AS charges,
              CASE WHEN p.receipt_no IS NULL THEN '' WHEN EXISTS (SELECT 1 FROM mpesa_statement_line sl WHERE sl.receipt_no = p.receipt_no) THEN 'Yes' ELSE 'No' END AS "onStatement", p.result_desc AS result
         FROM mpesa_payout p LEFT JOIN payment_voucher v ON v.id = p.voucher_id LEFT JOIN petty_cash_request pc ON pc.id = p.petty_cash_id
        WHERE ${q.localDate('p.created_at', ctx)} AND ${q.eq('p.status::text', ctx.f.status)} AND ${q.eq('p.command_id', ctx.f.method ? (methodCmd[ctx.f.method] ?? ctx.f.method) : undefined)}
        ORDER BY p.created_at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const by = (s: string) => rows.filter((r: { status: string }) => r.status === s).length;
    return {
      rows,
      totals: { amount: r2(rows.filter((r: { status: string }) => r.status === 'SUCCESS').reduce((s: number, r: { amount: number }) => s + r.amount, 0)), charges: sum(rows, 'charges') },
      notes: [`Success ${by('SUCCESS')}, failed ${by('FAILED')}, pending ${by('PENDING') + by('UNKNOWN')}, reversed ${by('REVERSED')} (amount total: successful only)`],
    };
  },
};

const whtVat: ReportDef = {
  key: 'wht-vat-summary',
  title: 'Withholding tax and VAT summary',
  group: 'PAYMENTS',
  description: 'Per supplier (with KRA PIN) or per month: input VAT on approved invoices dated in the period, and withholding tax deducted on payments made in the period, in the base currency.',
  permissions: [...PAYING, P.PURCHASING_INVOICE],
  filters: ['from', 'to', 'groupBy', 'supplierId'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'supplier', label: 'Supplier' },
    { value: 'month', label: 'Month' },
  ],
  columns: [col('key', 'Supplier / month'), col('kraPin', 'KRA PIN'), col('invoiced', 'Invoiced (excl. VAT)', 'money'), col('vat', 'Input VAT', 'money'), col('paid', 'Paid', 'money'), col('wht', 'WHT deducted', 'money')],
  async run(ctx) {
    const q = new Sql();
    const byMonth = ctx.f.groupBy === 'month';
    const key = (s: string, d: string) => (byMonth ? `to_char(${d}, 'YYYY-MM')` : s);
    const rows = await ctx.ds.query(
      `SELECT key, MAX(kra_pin) AS "kraPin", ROUND(SUM(invoiced), 2)::float AS invoiced, ROUND(SUM(vat), 2)::float AS vat, ROUND(SUM(paid), 2)::float AS paid, ROUND(SUM(wht), 2)::float AS wht FROM (
         SELECT ${key('s.name', 'i.invoice_date')} AS key, ${byMonth ? 'NULL' : 's.kra_pin'} AS kra_pin, i.subtotal * i.exchange_rate AS invoiced, i.tax_total * i.exchange_rate AS vat, 0 AS paid, 0 AS wht
           FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id WHERE i.status IN ${APPROVED_INVOICE} AND ${q.between('i.invoice_date', ctx)} AND ${q.eq('i.supplier_id', ctx.f.supplierId)}
         UNION ALL
         SELECT ${key('s.name', 'v.paid_on')}, ${byMonth ? 'NULL' : 's.kra_pin'}, 0, 0, v.amount, v.wht_amount
           FROM payment_voucher v JOIN supplier s ON s.id = v.supplier_id WHERE v.status = 'PAID' AND ${q.between('v.paid_on', ctx)} AND ${q.eq('v.supplier_id', ctx.f.supplierId)}
       ) x GROUP BY key ORDER BY key`,
      q.params,
    );
    return { rows, totals: { invoiced: sum(rows, 'invoiced'), vat: sum(rows, 'vat'), paid: sum(rows, 'paid'), wht: sum(rows, 'wht') } };
  },
};

// ------------------------------------------------------------------ petty cash

const pettyCashBook: ReportDef = {
  key: 'petty-cash-book',
  title: 'Petty cash book',
  group: 'PETTY_CASH',
  description: 'A float’s cash book for the period: opening balance, every receipt (replenishment, refund) and disbursement, and the closing balance.',
  permissions: PETTY,
  filters: ['floatId', 'from', 'to'],
  required: ['floatId', 'from', 'to'],
  landscape: true,
  columns: [
    col('date', 'Date', 'date'),
    col('type', 'Type'),
    col('document', 'Document', 'text', { docType: '@_docType', idKey: '_docId' }),
    col('details', 'Details'),
    col('receipts', 'Receipts', 'money'),
    col('payments', 'Disbursements', 'money'),
    col('balance', 'Balance', 'money'),
  ],
  async run(ctx) {
    const q = new Sql();
    const [open] = await ctx.ds.query(
      `SELECT balance_after::float AS b FROM petty_cash_transaction WHERE float_id = $1 AND txn_date < $2::date ORDER BY txn_date DESC, created_at DESC LIMIT 1`,
      [ctx.f.floatId, ctx.f.from],
    );
    const rows: Record<string, unknown>[] = await ctx.ds.query(
      `SELECT t.txn_date::text AS date, t.type, t.ref_no AS document, t.ref_type AS "_docType", t.ref_id AS "_docId", t.note AS details,
              CASE WHEN t.amount > 0 THEN t.amount END::float AS receipts, CASE WHEN t.amount < 0 THEN -t.amount END::float AS payments, t.balance_after::float AS balance
         FROM petty_cash_transaction t WHERE t.float_id = ${q.p(ctx.f.floatId)} AND ${q.between('t.txn_date', ctx)} ORDER BY t.txn_date, t.created_at`,
      q.params,
    );
    const opening = open?.b ?? 0;
    const closing = rows.length ? Number(rows[rows.length - 1].balance) : opening;
    return {
      rows: [{ date: ctx.f.from, type: 'OPENING BALANCE', document: null, details: 'Brought forward', receipts: null, payments: null, balance: opening }, ...rows],
      totals: { receipts: sum(rows, 'receipts'), payments: sum(rows, 'payments'), balance: closing },
      notes: [`Opening ${opening} + receipts ${sum(rows, 'receipts')} − disbursements ${sum(rows, 'payments')} = closing ${closing}`],
    };
  },
};

const pettyPending: ReportDef = {
  key: 'petty-cash-pending',
  title: 'Pending petty cash requests',
  group: 'PETTY_CASH',
  description: 'Petty cash requests waiting for approval (with the level and who it waits for) or approved and waiting to be paid.',
  permissions: PETTY,
  filters: ['floatId', 'userId'],
  landscape: true,
  columns: [
    col('number', 'Voucher', 'text', { docType: 'PCV', idKey: '_id' }),
    col('float', 'Float'),
    col('requester', 'Requested by'),
    col('kind', 'Type'),
    col('amount', 'Amount', 'money'),
    col('status', 'Status'),
    col('level', 'Approval level'),
    col('awaiting', 'Waiting for'),
    col('days', 'Days waiting', 'number'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, f.name AS float, u.full_name AS requester, r.kind, ROUND(r.amount, 2)::float AS amount, r.status,
              ${pendingStep('r.id')} AS level, CASE WHEN r.status = 'APPROVED' THEN cu.full_name || ' (custodian)' ELSE ${awaiting('r.id')} END AS awaiting,
              (${q.p(ctx.today)}::date - (COALESCE((SELECT ar.step_started_at FROM approval_request ar WHERE ar.document_id = r.id ORDER BY ar.created_at DESC LIMIT 1), r.created_at) AT TIME ZONE ${q.p(ctx.tz)})::date) AS days
         FROM petty_cash_request r JOIN petty_cash_float f ON f.id = r.float_id JOIN app_user u ON u.id = r.requested_by JOIN app_user cu ON cu.id = f.custodian_id
        WHERE r.status IN ('PENDING_APPROVAL', 'APPROVED') AND ${q.eq('r.float_id', ctx.f.floatId)} AND ${q.eq('r.requested_by', ctx.f.userId)}
        ORDER BY days DESC LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    return { rows, totals: { amount: sum(rows, 'amount') } };
  },
};

const pettySpend: ReportDef = {
  key: 'petty-cash-spend',
  title: 'Petty cash spend',
  group: 'PETTY_CASH',
  description: 'What petty cash was spent on in the period: payments when paid out, advances when retired (by their receipts), by category (GL account), department, user or month.',
  permissions: PETTY,
  filters: ['from', 'to', 'groupBy', 'floatId', 'departmentId'],
  required: ['from', 'to'],
  groupBy: [
    { value: 'category', label: 'Category (GL account)' },
    { value: 'department', label: 'Department' },
    { value: 'user', label: 'User' },
    { value: 'month', label: 'Month' },
  ],
  chart: { type: 'bar', x: 'key', series: ['amount'] },
  columns: [col('key', 'Category / department / user / month'), col('count', 'Items', 'number'), col('amount', 'Spent', 'money')],
  async run(ctx) {
    const q = new Sql();
    const g = ctx.f.groupBy ?? 'category';
    const key: Record<string, string> = {
      category: `COALESCE(gl.code || ' ' || gl.name, '(uncoded)')`,
      department: 'd.name',
      user: 'u.full_name',
      month: `to_char(x.d, 'YYYY-MM')`,
    };
    const rows = await ctx.ds.query(
      `SELECT ${key[g]} AS key, COUNT(*)::int AS count, ROUND(SUM(x.amount), 2)::float AS amount FROM (
         SELECT r.disbursed_on AS d, r.gl_account_id AS gl_id, r.department_id, r.requested_by, r.float_id, r.amount FROM petty_cash_request r
          WHERE r.kind = 'PAYMENT' AND r.disbursed_on IS NOT NULL AND r.status::text <> 'REVERSED'
         UNION ALL
         SELECT (r.retired_at AT TIME ZONE ${q.p(ctx.tz)})::date, COALESCE(l.gl_account_id, r.gl_account_id), r.department_id, r.requested_by, r.float_id, l.amount
           FROM petty_cash_retirement_line l JOIN petty_cash_request r ON r.id = l.request_id WHERE r.status = 'RETIRED'
       ) x LEFT JOIN gl_account gl ON gl.id = x.gl_id JOIN department d ON d.id = x.department_id JOIN app_user u ON u.id = x.requested_by
       WHERE ${q.between('x.d', ctx)} AND ${q.eq('x.float_id', ctx.f.floatId)} AND ${q.eq('x.department_id', ctx.f.departmentId)}
       GROUP BY 1 ORDER BY ${g === 'month' ? '1' : 'amount DESC'}`,
      q.params,
    );
    return { rows, totals: { count: rows.reduce((s: number, r: { count: number }) => s + r.count, 0), amount: sum(rows, 'amount') } };
  },
};

const outstandingAdvances: ReportDef = {
  key: 'outstanding-advances',
  title: 'Outstanding advances and overdue retirements',
  group: 'PETTY_CASH',
  description: 'Advances paid out and not yet retired (or waiting for the custodian’s check), with the days overdue.',
  permissions: PETTY,
  filters: ['floatId', 'userId'],
  columns: [
    col('number', 'Advance', 'text', { docType: 'PCV', idKey: '_id' }),
    col('holder', 'Holder'),
    col('float', 'Float'),
    col('amount', 'Amount', 'money'),
    col('paid', 'Paid', 'date'),
    col('due', 'Retire by', 'date'),
    col('overdueDays', 'Days overdue', 'number'),
    col('status', 'Status'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT r.id AS _id, r.number, u.full_name AS holder, f.name AS float, ROUND(r.amount, 2)::float AS amount, r.disbursed_on::text AS paid, r.retirement_due_on::text AS due,
              GREATEST(${q.p(ctx.today)}::date - r.retirement_due_on, 0) AS "overdueDays", r.status
         FROM petty_cash_request r JOIN app_user u ON u.id = r.requested_by JOIN petty_cash_float f ON f.id = r.float_id
        WHERE r.kind = 'ADVANCE' AND r.status IN ('DISBURSED', 'RETIREMENT_SUBMITTED') AND ${q.eq('r.float_id', ctx.f.floatId)} AND ${q.eq('r.requested_by', ctx.f.userId)}
        ORDER BY "overdueDays" DESC, r.retirement_due_on LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const overdue = rows.filter((r: { overdueDays: number }) => r.overdueDays > 0);
    return { rows, totals: { amount: sum(rows, 'amount') }, notes: [`${overdue.length} overdue, ${sum(overdue, 'amount')} outstanding past the retirement date`] };
  },
};

const replenishments: ReportDef = {
  key: 'petty-cash-replenishments',
  title: 'Replenishments and float reconciliation',
  group: 'PETTY_CASH',
  description: 'Replenishments requested in the period with their status, and the cash counts with their variance against the cash book.',
  permissions: PETTY,
  filters: ['from', 'to', 'floatId'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('date', 'Date', 'date'),
    col('float', 'Float'),
    col('event', 'Event'),
    col('document', 'Document', 'text', { docType: 'PCRP', idKey: '_id' }),
    col('amount', 'Amount / counted', 'money'),
    col('expected', 'Balance / expected', 'money'),
    col('variance', 'Variance', 'money'),
    col('status', 'Status'),
  ],
  async run(ctx) {
    const q = new Sql();
    const tz = q.p(ctx.tz);
    const rows = await ctx.ds.query(
      `SELECT * FROM (
         SELECT (rp.created_at AT TIME ZONE ${tz})::date::text AS date, f.name AS float, 'Replenishment' AS event, rp.number AS document, rp.id AS _id,
                ROUND(rp.amount, 2)::float AS amount, ROUND(rp.balance_at_request, 2)::float AS expected, NULL::float AS variance, rp.status::text AS status
           FROM petty_cash_replenishment rp JOIN petty_cash_float f ON f.id = rp.float_id WHERE ${q.localDate('rp.created_at', ctx)} AND ${q.eq('rp.float_id', ctx.f.floatId)}
         UNION ALL
         SELECT (c.created_at AT TIME ZONE ${tz})::date::text, f.name, 'Cash count', NULL, NULL, ROUND(c.counted, 2)::float, ROUND(c.expected, 2)::float, ROUND(c.variance, 2)::float, CASE WHEN c.variance = 0 THEN 'BALANCED' ELSE 'VARIANCE' END
           FROM petty_cash_count c JOIN petty_cash_float f ON f.id = c.float_id WHERE ${q.localDate('c.created_at', ctx)} AND ${q.eq('c.float_id', ctx.f.floatId)}
       ) x ORDER BY date, event LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const counts = rows.filter((r: { event: string }) => r.event === 'Cash count');
    return { rows, totals: { variance: sum(counts, 'variance') }, notes: [`${counts.filter((r: { variance: number }) => r.variance !== 0).length} of ${counts.length} count(s) with a variance`] };
  },
};

// ------------------------------------------------------------------ audit and integration


const approvalAudit: ReportDef = {
  key: 'approval-audit',
  title: 'Approval audit trail',
  group: 'AUDIT',
  description: 'Every approval action in the period: document, step, decision, who acted (and for whom, when delegated), channel and IP, including reminders and escalations.',
  permissions: [P.AUDIT_READ],
  filters: ['from', 'to', 'userId', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('at', 'When', 'datetime'),
    col('documentType', 'Type'),
    col('document', 'Document', 'text', { docType: '@documentType', idKey: '_docId' }),
    col('step', 'Step'),
    col('action', 'Action'),
    col('user', 'By'),
    col('onBehalfOf', 'For (delegation)'),
    col('channel', 'Channel'),
    col('ip', 'IP'),
    col('comment', 'Comment'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT a.at, r.document_type AS "documentType", r.document_no AS document, r.document_id AS "_docId", a.step_name AS step, a.action, u.full_name AS user, ob.full_name AS "onBehalfOf",
              a.channel, a.ip, a.comment
         FROM approval_action a JOIN approval_request r ON r.id = a.request_id LEFT JOIN app_user u ON u.id = a.user_id LEFT JOIN app_user ob ON ob.id = a.on_behalf_of_user_id
        WHERE ${q.localDate('a.at', ctx)} AND (${q.eq('a.user_id', ctx.f.userId)} OR ${ctx.f.userId ? q.eq('a.on_behalf_of_user_id', ctx.f.userId) : 'FALSE'}) AND ${q.eq('a.action::text', ctx.f.status)}
        ORDER BY a.at LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const delegated = rows.filter((r: { onBehalfOf: string | null }) => r.onBehalfOf).length;
    return { rows, notes: [`${rows.length} action(s), ${delegated} on behalf of someone else`] };
  },
};

const qboSync: ReportDef = {
  key: 'quickbooks-sync',
  title: 'QuickBooks sync status and errors',
  group: 'AUDIT',
  description: 'Documents sent (or waiting to be sent) to QuickBooks in the period with their status, QuickBooks id, attempts and the error to fix.',
  permissions: [P.ACCOUNTING_READ, P.ACCOUNTING_POST],
  filters: ['from', 'to', 'status'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('date', 'Date', 'date'),
    col('docType', 'QuickBooks type'),
    col('source', 'Source'),
    col('document', 'Document'),
    col('amount', 'Amount', 'money'),
    col('status', 'Status'),
    col('externalId', 'QuickBooks id'),
    col('attempts', 'Attempts', 'number'),
    col('error', 'Error'),
  ],
  async run(ctx) {
    const q = new Sql();
    const rows = await ctx.ds.query(
      `SELECT p.txn_date::text AS date, p.doc_type AS "docType", p.local_doc_type AS source, p.local_doc_no AS document, ROUND(p.amount, 2)::float AS amount, p.status, p.external_id AS "externalId", p.attempts, p.error
         FROM accounting_posting p WHERE ${q.between('p.txn_date', ctx)} AND ${q.eq('p.status::text', ctx.f.status)}
        ORDER BY CASE p.status WHEN 'FAILED' THEN 0 WHEN 'BLOCKED' THEN 1 WHEN 'PENDING' THEN 2 WHEN 'READY' THEN 3 ELSE 4 END, p.txn_date LIMIT ${q.p(ctx.maxRows)}`,
      q.params,
    );
    const n = (s: string) => rows.filter((r: { status: string }) => r.status === s).length;
    return { rows, notes: [`Posted ${n('POSTED')}, failed ${n('FAILED')}, blocked ${n('BLOCKED')}, retrying ${n('PENDING')}, ready ${n('READY')}`] };
  },
};

const controlExceptions: ReportDef = {
  key: 'control-exceptions',
  title: 'Payment control exceptions',
  group: 'AUDIT',
  description: 'Possible duplicate payments (an invoice paid more than once; the same petty cash payee and amount paid twice within the duplicate window), requests split to stay under an approval threshold, and supplier payments without any goods received or service accepted.',
  permissions: [P.AUDIT_READ, P.PAYMENTS_RECONCILE],
  filters: ['from', 'to'],
  required: ['from', 'to'],
  landscape: true,
  columns: [
    col('kind', 'Exception'),
    col('document', 'Document', 'text', { docType: '@_docType', idKey: '_docId' }),
    col('date', 'Date', 'date'),
    col('party', 'Supplier / payee'),
    col('amount', 'Amount', 'money'),
    col('detail', 'Detail'),
  ],
  async run(ctx) {
    const f = ctx.f.from!;
    const t = ctx.f.to!;
    const out: Record<string, unknown>[] = [];
    // An invoice settled for more than its total, or by more than one paid voucher.
    const dupInv = await ctx.ds.query(
      `SELECT i.id, i.number, i.invoice_date::text AS date, s.name AS party, ROUND(i.total, 2)::float AS amount, COUNT(DISTINCT v.id)::int AS vouchers, ROUND(SUM(vl.amount), 2)::float AS settled
         FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id JOIN payment_voucher_line vl ON vl.invoice_id = i.id JOIN payment_voucher v ON v.id = vl.voucher_id AND v.status = 'PAID'
        WHERE v.paid_on BETWEEN $1::date AND $2::date GROUP BY i.id, s.name HAVING SUM(vl.amount) > i.total + 0.01 LIMIT $3`,
      [f, t, ctx.maxRows],
    );
    for (const r of dupInv) out.push({ kind: 'DUPLICATE_PAYMENT', document: r.number, _docType: 'INV', _docId: r.id, date: r.date, party: r.party, amount: r.amount, detail: `Settled ${r.settled} by ${r.vouchers} voucher(s) against a total of ${r.amount}` });
    // The same supplier invoice number captured twice (different spelling of the number is caught by eye).
    const window = await ctx.settings.get('pettyCash.duplicateWindowDays');
    const dupPetty = await ctx.ds.query(
      `SELECT a.id, a.number, a.disbursed_on::text AS date, a.payee_name AS party, ROUND(a.amount, 2)::float AS amount, b.number AS other
         FROM petty_cash_request a JOIN petty_cash_request b ON b.amount = a.amount AND b.disbursed_on BETWEEN a.disbursed_on - $3::int AND a.disbursed_on + $3::int
              AND b.id <> a.id AND b.created_at < a.created_at
              AND (lower(a.payee_name) = lower(b.payee_name) OR (a.payee_phone IS NOT NULL AND a.payee_phone = b.payee_phone) OR (a.payee_user_id IS NOT NULL AND a.payee_user_id = b.payee_user_id))
        WHERE a.disbursed_on BETWEEN $1::date AND $2::date AND a.status::text <> 'REVERSED' AND b.status::text <> 'REVERSED' LIMIT $4`,
      [f, t, window, ctx.maxRows],
    );
    for (const r of dupPetty) out.push({ kind: 'DUPLICATE_PAYMENT', document: r.number, _docType: 'PCV', _docId: r.id, date: r.date, party: r.party, amount: r.amount, detail: `Same payee and amount as ${r.other}` });
    // Splits: requests each under an approval threshold that together cross it (same requester / supplier within 3 days).
    // One pass per threshold: a window over the qualifying documents counts and sums each one's neighbours within
    // ±3 days (the period widened by 3 days so neighbours just outside it still count).
    const thresholds: { document_type: string; min_amount: number }[] = await ctx.ds.query(
      `SELECT DISTINCT document_type, min_amount::float AS min_amount FROM approval_workflow WHERE is_active AND min_amount > 0 AND document_type IN ('PCV', 'PO', 'REQ')`,
    );
    const OPEN = `status::text NOT IN ('CANCELLED', 'REJECTED', 'DRAFT')`;
    const split = (from: string, amount: string, day: string, partition: string, extra = 'TRUE') =>
      `WITH c AS (SELECT x.*, ${amount} AS amt, ${day} AS d FROM ${from} x
                  WHERE x.${OPEN} AND ${amount} < $3 AND ${day} BETWEEN $1::date - 3 AND $2::date + 3 AND ${extra}),
            w AS (SELECT c.*, COUNT(*) OVER win AS split_n, SUM(c.amt) OVER win AS split_total FROM c
                  WINDOW win AS (PARTITION BY ${partition} ORDER BY c.d RANGE BETWEEN interval '3 days' PRECEDING AND interval '3 days' FOLLOWING))`;
    for (const th of thresholds) {
      const sql =
        th.document_type === 'PCV'
          ? `${split('petty_cash_request', 'x.amount', 'x.created_at::date', 'c.requested_by, lower(c.payee_name)', 'x.payee_name IS NOT NULL')}
             SELECT w.id, w.number, w.d::text AS date, w.payee_name AS party, w.amt::float AS amount, u.full_name AS who, w.split_n::int AS n, w.split_total::float AS total
               FROM w JOIN app_user u ON u.id = w.requested_by WHERE w.d BETWEEN $1::date AND $2::date AND w.split_n > 1 AND w.split_total >= $3 LIMIT $4`
          : th.document_type === 'PO'
            ? `${split('purchase_order', 'COALESCE(NULLIF(x.base_total, 0), x.total)', 'x.order_date', 'c.supplier_id')}
               SELECT w.id, w.number, w.d::text AS date, s.name AS party, w.amt::float AS amount, s.name AS who, w.split_n::int AS n, w.split_total::float AS total
                 FROM w JOIN supplier s ON s.id = w.supplier_id WHERE w.d BETWEEN $1::date AND $2::date AND w.split_n > 1 AND w.split_total >= $3 LIMIT $4`
            : `${split('staff_requisition', 'x.estimated_total', 'x.created_at::date', 'c.requested_by')}
               SELECT w.id, w.number, w.d::text AS date, u.full_name AS party, w.amt::float AS amount, u.full_name AS who, w.split_n::int AS n, w.split_total::float AS total
                 FROM w JOIN app_user u ON u.id = w.requested_by WHERE w.d BETWEEN $1::date AND $2::date AND w.split_n > 1 AND w.split_total >= $3 LIMIT $4`;
      for (const r of await ctx.ds.query(sql, [f, t, th.min_amount, ctx.maxRows])) {
        out.push({ kind: 'POSSIBLE_SPLIT', document: r.number, _docType: th.document_type, _docId: r.id, date: r.date, party: r.party, amount: r.amount, detail: `${r.n} ${th.document_type} by ${r.who} within 3 days total ${r2(r.total)}, each under the ${th.min_amount} threshold` });
      }
    }
    // Paid without anything received or accepted on the order lines invoiced.
    const noReceipt = await ctx.ds.query(
      `SELECT DISTINCT v.id, v.number, v.paid_on::text AS date, s.name AS party, ROUND(v.amount, 2)::float AS amount, i.number AS invoice
         FROM payment_voucher v JOIN supplier s ON s.id = v.supplier_id JOIN payment_voucher_line vl ON vl.voucher_id = v.id JOIN supplier_invoice i ON i.id = vl.invoice_id
        WHERE v.status = 'PAID' AND v.paid_on BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM supplier_invoice_line il JOIN purchase_order_line l ON l.id = il.po_line_id WHERE il.invoice_id = i.id AND l.received_base_qty > 0) LIMIT $3`,
      [f, t, ctx.maxRows],
    );
    for (const r of noReceipt) out.push({ kind: 'PAID_WITHOUT_RECEIPT', document: r.number, _docType: 'PV', _docId: r.id, date: r.date, party: r.party, amount: r.amount, detail: `${r.invoice}: nothing received or accepted on its order lines` });
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const n = (k: string) => out.filter((r) => r.kind === k).length;
    return { rows: out.slice(0, ctx.maxRows), notes: [`Duplicates ${n('DUPLICATE_PAYMENT')}, possible splits ${n('POSSIBLE_SPLIT')}, paid without receipt ${n('PAID_WITHOUT_RECEIPT')}`] };
  },
};

export const NON_STOCK_REPORTS: ReportDef[] = [
  pendingRequisitions,
  pendingPrs,
  openLpos,
  rfqAwards,
  acceptanceRegister,
  accruals,
  matchExceptions,
  purchasesOverTime,
  cycleTime,
  budgetVsActual,
  deliveredToUsers,
  apAgeing,
  paymentsByMethod,
  paymentSchedule,
  mpesaLog,
  whtVat,
  pettyCashBook,
  pettyPending,
  pettySpend,
  outstandingAdvances,
  replenishments,
  approvalAudit,
  qboSync,
  controlExceptions,
];


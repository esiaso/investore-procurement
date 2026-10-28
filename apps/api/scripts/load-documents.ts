/**
 * Bulk procurement / payments / petty-cash documents for the load test.
 *
 * Multiplies the documents already in the load database (`copies` times each)
 * by copying every row of the document tables below with derived ids, so a
 * copied purchase order keeps its own lines, GRNs, invoices, vouchers, M-PESA
 * attempts, approvals, links and QuickBooks postings. Master data (suppliers,
 * items, users, departments, floats) is shared, not copied.
 *
 *  - ids: md5(id || ':' || k)::uuid, and the same for every uuid column that
 *    points at a copied row (foreign keys and polymorphic document ids alike);
 *  - text columns holding the id of a copied row (accounting_posting.local_doc_id,
 *    audit_log.entity_id) are remapped the same way;
 *  - other text columns of a unique index with no remapped column (document
 *    numbers, supplier invoice numbers) get a "-Lk" suffix;
 *  - dates and timestamps move back k mod 1095 days, so copies spread over
 *    three years and every period filter has work to do;
 *  - rows that would still collide with a partial unique index (one open
 *    count per float…) are skipped.
 *
 * Foreign keys are not checked while copying (session_replication_role), so the
 * order of the tables does not matter; the copy is consistent by construction.
 */
import type { Client as PgClient } from 'pg';

export const DOCUMENT_TABLES = [
  'staff_requisition', 'staff_requisition_line', 'handover', 'handover_line',
  'purchase_requisition', 'purchase_requisition_line',
  'rfq', 'rfq_line', 'quotation', 'quotation_line', 'rfq_evaluation_score',
  'purchase_order', 'purchase_order_line', 'purchase_order_version', 'purchase_order_delivery',
  'goods_received_note', 'grn_line', 'service_certificate', 'service_certificate_line',
  'supplier_invoice', 'supplier_invoice_line',
  'payment_voucher', 'payment_voucher_line', 'mpesa_payout',
  'petty_cash_request', 'petty_cash_retirement_line', 'petty_cash_replenishment', 'petty_cash_transaction',
  'approval_request', 'approval_action', 'document_link', 'accounting_posting', 'budget_entry', 'audit_log',
];

type Col = { name: string; type: string; udt: string; maxLen: number | null };

export async function multiplyDocuments(
  c: PgClient,
  copies: number,
  opts: { perTable?: Record<string, number>; log?: (s: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? console.log;
  const tables = (
    await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [DOCUMENT_TABLES])
  ).rows.map((r) => r.table_name as string);

  // Every id that gets copied: uuid columns holding one of these are remapped too.
  await c.query(`DROP TABLE IF EXISTS load_ids; CREATE UNLOGGED TABLE load_ids (id uuid PRIMARY KEY)`);
  // Tables with bigint ids (audit log, budget entries) get new ids from their sequence; originals = ids up to the current maximum.
  const serialMax = new Map<string, string>();
  for (const t of tables) {
    const [{ udt }] = (await c.query(`SELECT udt_name AS udt FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`, [t])).rows;
    if (udt === 'uuid') await c.query(`INSERT INTO load_ids SELECT id FROM "${t}" ON CONFLICT DO NOTHING`);
    else serialMax.set(t, String((await c.query(`SELECT COALESCE(max(id), 0) AS m FROM "${t}"`)).rows[0].m));
  }
  await c.query(`ANALYZE load_ids`);

  // Foreign keys to tables that are not copied keep their value.
  const fkOut = new Set(
    (
      await c.query(
        `SELECT c.conrelid::regclass::text AS t, a.attname AS col
           FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.contype = 'f' AND NOT (c.confrelid::regclass::text = ANY($1))`,
        [tables],
      )
    ).rows.map((r) => `${r.t}.${r.col}`),
  );

  await c.query(`SET session_replication_role = replica`);
  for (const t of tables) {
    const started = Date.now();
    const cols: Col[] = (
      await c.query(
        `SELECT column_name AS name, data_type AS type, udt_name AS udt, character_maximum_length AS "maxLen"
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' AND is_identity = 'NO'
          ORDER BY ordinal_position`,
        [t],
      )
    ).rows.filter((x: Col) => !(x.name === 'id' && serialMax.has(t)));
    // Unique indexes made only of non-uuid columns: their text columns take a suffix.
    const uniques: string[][] = (
      await c.query(
        `SELECT array_agg(a.attname::text) AS cols
           FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary
          GROUP BY i.indexrelid`,
        [t],
      )
    ).rows.map((r) => r.cols);
    const isText = (x?: Col) => !!x && ['text', 'character varying'].includes(x.type);
    const remapped = (x?: Col) => !!x && (x.name === 'id' || (x.udt === 'uuid' && !fkOut.has(`${t}.${x.name}`)));
    const suffixed = new Set<string>();
    for (const u of uniques) {
      const ucols = u.map((n) => cols.find((x) => x.name === n));
      if (ucols.some(remapped)) continue;
      for (const x of ucols) if (isText(x)) suffixed.add(x!.name);
    }
    /** A text column that may hold a copied row's id: the copy's id, else `otherwise`. */
    const textId = (q: string, otherwise: string) =>
      `CASE WHEN ${q} !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${otherwise} WHEN ${q}::uuid IN (SELECT id FROM load_ids) THEN md5(${q} || ':' || k)::uuid::text ELSE ${otherwise} END`;
    const expr = (x: Col): string => {
      const q = `s."${x.name}"`;
      if (x.name === 'id') return `md5(s.id::text || ':' || k)::uuid`;
      if (x.udt === 'uuid' && !fkOut.has(`${t}.${x.name}`)) return `CASE WHEN ${q} IN (SELECT id FROM load_ids) THEN md5(${q}::text || ':' || k)::uuid ELSE ${q} END`;
      if (suffixed.has(x.name)) return textId(q, x.maxLen ? `right(${q} || '-L' || k, ${x.maxLen})` : `${q} || '-L' || k`);
      if (isText(x) && /_id$/.test(x.name)) return textId(q, q);
      if (x.type === 'date') return `${q} - (k % 1095)`;
      if (x.type.startsWith('timestamp')) return `${q} - ((k % 1095) * interval '1 day')`;
      return q;
    };
    const names = cols.map((x) => `"${x.name}"`).join(', ');
    const r = await c.query(
      `INSERT INTO "${t}" (${names})
       SELECT ${cols.map(expr).join(', ')}
         FROM "${t}" s CROSS JOIN generate_series(1, ${opts.perTable?.[t] ?? copies}) k
        WHERE ${serialMax.has(t) ? `s.id <= ${serialMax.get(t)}` : 's.id IN (SELECT id FROM load_ids)'}
       ON CONFLICT DO NOTHING`,
    );
    log(`  ${t}: +${(r.rowCount ?? 0).toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  await c.query(`SET session_replication_role = DEFAULT`);
  await c.query(`DROP TABLE load_ids`);
}

/**
 * QuickBooks postings for every purchase order, invoice and payment voucher
 * (the integration tests leave none behind): mostly POSTED, some PENDING and
 * FAILED, so the sync-status report and the per-document sync chips have
 * realistic volume. Only when the table is empty.
 */
export async function synthesizePostings(c: PgClient): Promise<number> {
  if ((await c.query(`SELECT 1 FROM accounting_posting LIMIT 1`)).rowCount) return 0;
  const status = `(CASE WHEN abs(hashtext(d.id::text)) % 20 = 0 THEN 'FAILED' WHEN abs(hashtext(d.id::text)) % 20 = 1 THEN 'PENDING' ELSE 'POSTED' END)::posting_status`;
  const r = await c.query(`
    INSERT INTO accounting_posting (doc_type, local_doc_type, local_doc_id, local_doc_no, txn_date, amount, status, payload, external_id, error, attempts, posted_at, created_at)
    SELECT d.doc_type::posting_doc_type, d.local_type, d.id::text, d.number, d.dt, d.amount, ${status}, '{}'::jsonb,
           CASE WHEN ${status} = 'POSTED' THEN (abs(hashtext(d.id::text)) % 900000 + 100000)::text END,
           CASE WHEN ${status} = 'FAILED' THEN 'Load test: QuickBooks rejected the document' END,
           CASE WHEN ${status} = 'PENDING' THEN 0 ELSE 1 END,
           CASE WHEN ${status} = 'POSTED' THEN d.dt::timestamptz + interval '1 hour' END,
           d.dt::timestamptz
      FROM (SELECT id, number, order_date AS dt, total AS amount, 'PURCHASE_ORDER' AS doc_type, 'PURCHASE_ORDER' AS local_type FROM purchase_order
            UNION ALL SELECT id, number, invoice_date, total, 'BILL', 'SUPPLIER_INVOICE' FROM supplier_invoice
            UNION ALL SELECT id, number, COALESCE(due_date, created_at::date), amount, 'BILL_PAYMENT', 'PAYMENT_VOUCHER' FROM payment_voucher) d
     WHERE d.dt IS NOT NULL
    ON CONFLICT DO NOTHING`);
  return r.rowCount ?? 0;
}

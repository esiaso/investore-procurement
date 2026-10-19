import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';
import { TEST_PASSWORD } from './env';

const addDays = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000));
const TODAY = addDays(0);

describe('Internal requisitions, issues and returns', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  let ids: Record<string, string>;
  const witness = { username: 'pharm.tech', password: TEST_PASSWORD };

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'storekeeper', 'scm', 'quality', 'finance', 'ward.nurse', 'ward.incharge', 'surg.incharge', 'surg.nurse']) {
      c[u] = await loggedIn(ctx, u);
    }
    ids = {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      ipd: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      surg: await idByCode(ctx.ds, 'department', 'IPD-SURG'),
      cat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      s1: (await ctx.ds.query(`SELECT id FROM supplier WHERE code = 'SUP0001'`))[0].id,
    };
    const [bin] = await ctx.ds.query(`SELECT b.id FROM bin b JOIN store s ON s.id = b.store_id WHERE s.code = 'MS' AND b.code = 'A-02'`);
    ids.msBin = bin.id;
  });
  afterAll(() => ctx.close());

  async function newItem(opts: { controlled?: boolean } = {}) {
    const g = await c.admin
      .post('/generics', { innName: `Wardamycin ${uniq('g')}`, strength: '500 mg', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: opts.controlled ? 'SCHEDULE_II' : 'NONE' })
      .expect(201);
    const item = await c.admin
      .post('/items', { genericId: g.body.id, categoryId: ids.cat, name: `Wardamycin ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 10, taxCategoryId: ids.exempt, isControlled: !!opts.controlled })
      .expect(201);
    return item.body as { id: string; code: string };
  }

  /** Opening balances (allows expired batches) into MS; returns batch ids by batch number. */
  async function stock(itemId: string, batches: { no: string; expiry: string; qty: number; cost: number }[], extra: object = {}) {
    await c.scm
      .post('/inventory/receipts', { storeId: ids.MS, type: 'OPENING', lines: batches.map((b) => ({ itemId, batchNo: b.no, expiryDate: b.expiry, quantity: b.qty, unitCost: b.cost })), ...extra })
      .expect(201);
    const rows = await ctx.ds.query(`SELECT id, batch_no FROM batch WHERE item_id = $1`, [itemId]);
    return Object.fromEntries(rows.map((r: { id: string; batch_no: string }) => [r.batch_no, r.id])) as Record<string, string>;
  }

  const pending = async (docId: string) =>
    (await ctx.ds.query(`SELECT * FROM approval_request WHERE document_type = 'SR' AND document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId]))[0];

  /** Raised by the ward nurse, approved by the ward in-charge. */
  async function approvedSr(lines: { itemId: string; quantity: number; patientRef?: string }[], priority = 'ROUTINE') {
    const sr = await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.ipd, storeId: ids.MS, priority, lines, submit: true }).expect(201);
    expect(sr.body.status).toBe('PENDING_APPROVAL');
    const req = await pending(sr.body.id);
    await c['ward.incharge'].post(`/approvals/${req.id}/approve`, {}).expect(200);
    return (await c.storekeeper.get(`/store-requisitions/${sr.body.id}`).expect(200)).body;
  }

  const balance = async (batchId: string) =>
    (await ctx.ds.query(`SELECT COALESCE(SUM(on_hand), 0)::float AS on_hand, COALESCE(SUM(reserved), 0)::float AS reserved FROM stock_balance WHERE batch_id = $1 AND store_id = $2`, [batchId, ids.MS]))[0];

  describe('requisition approval', () => {
    it('routes to the in-charge of the requesting department only; the requester cannot approve', async () => {
      const item = await newItem();
      await stock(item.id, [{ no: 'A', expiry: addDays(200), qty: 50, cost: 4 }]);
      const sr = await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 10 }] }).expect(201);
      expect(sr.body).toMatchObject({ status: 'DRAFT', estimatedValue: 40 });
      expect(sr.body.number).toMatch(/^SR\/MS\//);
      // Ward staff raise for their own department only.
      await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.surg, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 1 }] }).expect(403);

      await c['ward.nurse'].post(`/store-requisitions/${sr.body.id}/submit`).expect(200);
      const req = await pending(sr.body.id);
      const [wf] = await ctx.ds.query(`SELECT code FROM approval_workflow WHERE id = $1`, [req.workflow_id]);
      expect(wf.code).toBe('SR-1');

      await c['ward.nurse'].post(`/approvals/${req.id}/approve`, {}).expect(403);
      await c['surg.incharge'].post(`/approvals/${req.id}/approve`, {}).expect(403); // in-charge of another ward
      const otherInbox = await c['surg.incharge'].get('/approvals/inbox').expect(200);
      expect(otherInbox.body.some((r: { documentId: string }) => r.documentId === sr.body.id)).toBe(false);
      // The other ward cannot even see it.
      await c['surg.nurse'].get(`/store-requisitions/${sr.body.id}`).expect(404);

      const inbox = await c['ward.incharge'].get('/approvals/inbox').expect(200);
      expect(inbox.body.some((r: { documentId: string }) => r.documentId === sr.body.id)).toBe(true);
      await c['ward.incharge'].post(`/approvals/${req.id}/approve`, {}).expect(200);
      const approved = await c.storekeeper.get(`/store-requisitions/${sr.body.id}`).expect(200);
      expect(approved.body.status).toBe('APPROVED');
      expect(approved.body.lines[0]).toMatchObject({ outstandingQty: 10, reservedQty: 10 });
    });

    it('does not let an in-charge approve a requisition they raised', async () => {
      const item = await newItem();
      const sr = await c['ward.incharge'].post('/store-requisitions', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 1 }], submit: true }).expect(201);
      const req = await pending(sr.body.id);
      await c['ward.incharge'].post(`/approvals/${req.id}/approve`, {}).expect(403);
    });
  });

  describe('reservations and FEFO issue', () => {
    let item: { id: string; code: string };
    let b: Record<string, string>;

    beforeAll(async () => {
      item = await newItem();
      b = await stock(item.id, [
        { no: 'EXPIRED', expiry: addDays(-5), qty: 100, cost: 2 },
        { no: 'HELD', expiry: addDays(30), qty: 100, cost: 2 },
        { no: 'EARLY', expiry: addDays(60), qty: 30, cost: 3 },
        { no: 'LATE', expiry: addDays(300), qty: 100, cost: 5 },
      ]);
      await c.quality.put(`/inventory/batches/${b.HELD}/hold`, { holdStatus: 'QUARANTINE', reason: 'Temperature excursion' }).expect(200);
    });

    it('reserves FEFO on approval: earliest usable expiry first, never expired or held stock', async () => {
      const sr = await approvedSr([{ itemId: item.id, quantity: 40 }]);
      const res = sr.lines[0].reservations as { batchId: string; quantity: number }[];
      expect(res.map((r) => [r.batchId, r.quantity])).toEqual([
        [b.EARLY, 30],
        [b.LATE, 10],
      ]);
      expect(await balance(b.EARLY)).toEqual({ on_hand: 30, reserved: 30 });
      expect((await balance(b.EXPIRED)).reserved).toBe(0);
      expect((await balance(b.HELD)).reserved).toBe(0);

      // Available = on hand − reserved, usable only.
      const s = await c.storekeeper.get(`/inventory/stock?groupBy=item&storeId=${ids.MS}&itemId=${item.id}`).expect(200);
      expect(s.body.items[0]).toMatchObject({ onHand: 330, reserved: 40, usable: 90 });

      // A second requisition only gets what is left.
      const sr2 = await approvedSr([{ itemId: item.id, quantity: 500 }]);
      expect(sr2.lines[0].reservedQty).toBe(90);
      expect(sr2.lines[0].availableQty).toBe(0);

      // Reserved stock cannot be transferred away.
      const trf = await c.scm.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.MP, lines: [{ itemId: item.id, quantity: 1 }] }).expect(201);
      const denied = await c.scm.post(`/inventory/transfers/${trf.body.id}/dispatch`, {});
      expect(denied.status).toBe(400);
      expect(denied.body.code).toBe('INSUFFICIENT_STOCK');
      await c.scm.post(`/inventory/transfers/${trf.body.id}/cancel`).expect(200);

      // Cancelling the second requisition releases its reservations.
      await c['ward.nurse'].post(`/store-requisitions/${sr2.id}/cancel`, { reason: 'Duplicate' }).expect(200);
      expect((await balance(b.LATE)).reserved).toBe(10);

      // Issue: suggestion and voucher follow FEFO; the reservation is consumed.
      const plan = await c.storekeeper.get(`/store-requisitions/${sr.id}/issue-plan`).expect(200);
      expect(plan.body.lines[0].picks.map((p: { batchNo: string; quantity: number }) => [p.batchNo, p.quantity])).toEqual([
        ['EARLY', 30],
        ['LATE', 10],
      ]);
      expect(plan.body.lines[0].candidates.map((x: { batchNo: string }) => x.batchNo)).not.toContain('EXPIRED');
      // The dry run left reservations untouched.
      expect((await balance(b.EARLY)).reserved).toBe(30);

      const iv = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { collectedBy: 'Nurse Moraa' }).expect(201);
      expect(iv.body.number).toMatch(/^ISS\/MS\//);
      expect(iv.body.lines.map((l: { batchId: string; quantity: number }) => [l.batchId, l.quantity])).toEqual([
        [b.EARLY, 30],
        [b.LATE, 10],
      ]);
      // WAC of the store at issue: (100·2 + 100·2 + 30·3 + 100·5) / 330.
      const wac = (200 + 200 + 90 + 500) / 330;
      expect(iv.body.totalValue).toBeCloseTo(40 * wac, 1);
      expect(await balance(b.EARLY)).toEqual({ on_hand: 0, reserved: 0 });
      expect(await balance(b.LATE)).toEqual({ on_hand: 90, reserved: 0 });
      const after = await c['ward.nurse'].get(`/store-requisitions/${sr.id}`).expect(200);
      expect(after.body.status).toBe('ISSUED');

      // Ledger: ISSUE rows charged to the department.
      const rows = await ctx.ds.query(`SELECT txn_type, department_id, quantity::float AS q FROM stock_transaction WHERE source_doc_id = $1`, [iv.body.id]);
      expect(rows.every((r: { txn_type: string; department_id: string }) => r.txn_type === 'ISSUE' && r.department_id === ids.ipd)).toBe(true);
      expect(rows.reduce((s: number, r: { q: number }) => s + r.q, 0)).toBe(-40);
    });

    it('never issues expired or held stock, even when picked by hand', async () => {
      const sr = await approvedSr([{ itemId: item.id, quantity: 5 }]);
      const expired = await c.scm.post(`/store-requisitions/${sr.id}/issues`, {
        lines: [{ requisitionLineId: sr.lines[0].id, picks: [{ batchId: b.EXPIRED, quantity: 5 }] }],
        fefoOverrideReason: 'test',
      });
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('BATCH_EXPIRED');
      const held = await c.scm.post(`/store-requisitions/${sr.id}/issues`, {
        lines: [{ requisitionLineId: sr.lines[0].id, picks: [{ batchId: b.HELD, quantity: 5 }] }],
        fefoOverrideReason: 'test',
      });
      expect(held.status).toBe(400);
      expect(held.body.code).toBe('BATCH_ON_HOLD');
      // Failed attempts leave the reservation in place.
      expect((await c.storekeeper.get(`/store-requisitions/${sr.id}`)).body.lines[0].reservedQty).toBe(5);
      await c['ward.nurse'].post(`/store-requisitions/${sr.id}/cancel`, { reason: 'Test done' }).expect(200);
    });

    it('needs inventory.override_fefo and a reason to pick out of FEFO order', async () => {
      const it2 = await newItem();
      const bb = await stock(it2.id, [
        { no: 'FIRST', expiry: addDays(40), qty: 10, cost: 1 },
        { no: 'SECOND', expiry: addDays(400), qty: 10, cost: 1 },
      ]);
      const sr = await approvedSr([{ itemId: it2.id, quantity: 4 }]);
      const body = { lines: [{ requisitionLineId: sr.lines[0].id, picks: [{ batchId: bb.SECOND, quantity: 4 }] }] };
      await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { ...body, fefoOverrideReason: 'Ward asked' }).expect(403);
      await c.scm.post(`/store-requisitions/${sr.id}/issues`, body).expect(400);
      const ok = await c.scm.post(`/store-requisitions/${sr.id}/issues`, { ...body, fefoOverrideReason: 'Short-dated stock kept for theatre' }).expect(201);
      expect(ok.body).toMatchObject({ fefoOverrideReason: 'Short-dated stock kept for theatre' });
      expect(ok.body.lines[0]).toMatchObject({ batchId: bb.SECOND, fefoOverridden: true });
      const [t] = await ctx.ds.query(`SELECT fefo_override_reason FROM stock_transaction WHERE source_doc_id = $1`, [ok.body.id]);
      expect(t.fefo_override_reason).toBe('Short-dated stock kept for theatre');
    });
  });

  describe('partial issue and back-orders', () => {
    it('issues what is available, keeps the rest on back-order, fills it later', async () => {
      const item = await newItem();
      const b = await stock(item.id, [{ no: 'P1', expiry: addDays(100), qty: 6, cost: 10 }]);
      const sr = await approvedSr([{ itemId: item.id, quantity: 10, patientRef: 'IP-0042' }], 'URGENT');
      expect(sr.lines[0]).toMatchObject({ reservedQty: 6, outstandingQty: 10 });

      // Asking explicitly for more than is there is refused; stock never goes negative.
      const tooMuch = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { lines: [{ requisitionLineId: sr.lines[0].id, quantity: 8 }] });
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.body.code).toBe('INSUFFICIENT_STOCK');

      const first = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, {}).expect(201);
      expect(first.body.lines[0]).toMatchObject({ quantity: 6, patientRef: 'IP-0042' });
      let now = (await c.storekeeper.get(`/store-requisitions/${sr.id}`)).body;
      expect(now.status).toBe('PARTIALLY_ISSUED');
      expect(now.lines[0]).toMatchObject({ issuedQty: 6, outstandingQty: 4, reservedQty: 0 });
      expect((await balance(b.P1)).on_hand).toBe(0);

      const bo = await c.storekeeper.get(`/store-requisitions/backorders?storeId=${ids.MS}`).expect(200);
      expect(bo.body.find((r: { lineId: string }) => r.lineId === sr.lines[0].id)).toMatchObject({ outstandingQty: 4, availableQty: 0, department: 'Medical Ward' });

      // Nothing usable: a further issue is refused.
      const nothing = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, {});
      expect(nothing.body.code).toBe('NOTHING_TO_ISSUE');

      // New stock arrives: re-plan reservations, then fill the back-order.
      await stock(item.id, [{ no: 'P2', expiry: addDays(200), qty: 20, cost: 10 }]);
      now = (await c.storekeeper.post(`/store-requisitions/${sr.id}/reserve`).expect(200)).body;
      expect(now.lines[0].reservedQty).toBe(4);
      await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, {}).expect(201);
      now = (await c.storekeeper.get(`/store-requisitions/${sr.id}`)).body;
      expect(now.status).toBe('ISSUED');
      expect(now.issues).toHaveLength(2);
      const chain = await c.storekeeper.get(`/documents/chain?type=SR&id=${sr.id}`).expect(200);
      expect(chain.body.nodes.filter((n: { type: string }) => n.type === 'ISS')).toHaveLength(2);
    });

    it('cancels a back-order with a reason and closes the requisition', async () => {
      const item = await newItem();
      await stock(item.id, [{ no: 'C1', expiry: addDays(100), qty: 3, cost: 1 }]);
      const sr = await approvedSr([{ itemId: item.id, quantity: 5 }]);
      await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, {}).expect(201);
      // Cannot cancel the whole requisition once something was issued.
      await c['ward.nurse'].post(`/store-requisitions/${sr.id}/cancel`, { reason: 'x' }).expect(409);
      await c.storekeeper.post(`/store-requisitions/${sr.id}/cancel-backorder`, {}).expect(400); // reason required
      const closed = await c['ward.nurse'].post(`/store-requisitions/${sr.id}/cancel-backorder`, { reason: 'Patient discharged' }).expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.lines[0]).toMatchObject({ issuedQty: 3, cancelledQty: 2, outstandingQty: 0 });
    });
  });

  describe('scan confirmation and controlled drugs', () => {
    it('records scanned picks and refuses codes that do not match', async () => {
      const item = await newItem();
      const b = await stock(item.id, [{ no: 'SCAN-1', expiry: addDays(100), qty: 10, cost: 1 }]);
      const sr = await approvedSr([{ itemId: item.id, quantity: 2 }]);
      const line = sr.lines[0].id;
      const wrong = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { lines: [{ requisitionLineId: line, picks: [{ batchId: b['SCAN-1'], quantity: 2, scannedCode: 'NOPE' }] }] });
      expect(wrong.body.code).toBe('SCAN_MISMATCH');
      const ok = await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { lines: [{ requisitionLineId: line, picks: [{ batchId: b['SCAN-1'], quantity: 2, scannedCode: 'scan-1' }] }] }).expect(201);
      expect(ok.body.lines[0].scanConfirmed).toBe(true);
    });

    it('needs a second signatory for controlled drugs and the controlled-drug permission', async () => {
      const item = await newItem({ controlled: true });
      await stock(item.id, [{ no: 'CD-1', expiry: addDays(100), qty: 10, cost: 50 }], { witness });
      const sr = await approvedSr([{ itemId: item.id, quantity: 2 }]);
      // The storekeeper may not handle controlled drugs at all.
      await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, { witness }).expect(403);
      const noWitness = await c.scm.post(`/store-requisitions/${sr.id}/issues`, {});
      expect(noWitness.body.code).toBe('SECOND_SIGNATURE_REQUIRED');
      const ok = await c.scm.post(`/store-requisitions/${sr.id}/issues`, { witness }).expect(201);
      expect(ok.body.witnessName).toBeTruthy();
      const [t] = await ctx.ds.query(`SELECT second_signer_id FROM stock_transaction WHERE source_doc_id = $1`, [ok.body.id]);
      expect(t.second_signer_id).toBeTruthy();
    });
  });

  describe('department returns', () => {
    let item: { id: string; code: string };
    let b: Record<string, string>;
    let voucher: { id: string; lines: { id: string; batchId: string; unitCost: number; quantity: number }[] };

    beforeAll(async () => {
      item = await newItem();
      b = await stock(item.id, [{ no: 'R1', expiry: addDays(150), qty: 20, cost: 8 }]);
      const sr = await approvedSr([{ itemId: item.id, quantity: 10 }]);
      voucher = (await c.storekeeper.post(`/store-requisitions/${sr.id}/issues`, {}).expect(201)).body;
    });

    it('puts resaleable stock back on the same batch and damaged stock in quarantine, crediting the department', async () => {
      const ivl = voucher.lines[0];
      const ret = await c['ward.nurse']
        .post('/department-returns', {
          departmentId: ids.ipd,
          storeId: ids.MS,
          lines: [
            { itemId: item.id, batchId: b.R1, issueVoucherLineId: ivl.id, quantity: 3, reasonCode: 'NOT_USED', condition: 'RESALEABLE', binId: ids.msBin },
            { itemId: item.id, batchId: b.R1, issueVoucherLineId: ivl.id, quantity: 2, reasonCode: 'DAMAGED', condition: 'DAMAGED' },
          ],
        })
        .expect(201);
      expect(ret.body).toMatchObject({ status: 'DRAFT' });
      expect(ret.body.number).toMatch(/^DRT\/MS\//);
      // The ward cannot post it; the store does.
      await c['ward.nurse'].post(`/department-returns/${ret.body.id}/post`, {}).expect(403);
      const posted = await c.storekeeper.post(`/department-returns/${ret.body.id}/post`, {}).expect(200);
      expect(posted.body.status).toBe('POSTED');
      expect(posted.body.totalValue).toBeCloseTo(5 * ivl.unitCost, 2);

      const rows = await ctx.ds.query(
        `SELECT t.quantity::float AS q, t.unit_cost::float AS cost, bn.code, bn.is_quarantine, t.department_id
           FROM stock_transaction t LEFT JOIN bin bn ON bn.id = t.bin_id WHERE t.source_doc_id = $1 ORDER BY t.quantity DESC`,
        [ret.body.id],
      );
      expect(rows[0]).toMatchObject({ q: 3, code: 'A-02', is_quarantine: false, department_id: ids.ipd });
      expect(rows[1]).toMatchObject({ q: 2, code: 'QUARANTINE', is_quarantine: true });
      expect(rows[0].cost).toBeCloseTo(ivl.unitCost, 4);

      // Quarantined stock is not picked for issue.
      const sr = await approvedSr([{ itemId: item.id, quantity: 100 }]);
      expect(sr.lines[0].reservedQty).toBe(13); // 10 never issued + 3 resaleable back
      await c['ward.nurse'].post(`/store-requisitions/${sr.id}/cancel`, { reason: 'Test done' }).expect(200);
    });

    it('cannot return more than was issued, nor expired stock as resaleable', async () => {
      const ivl = voucher.lines[0];
      const tooMany = await c.storekeeper
        .post('/department-returns', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId: item.id, batchId: b.R1, issueVoucherLineId: ivl.id, quantity: 6, reasonCode: 'NOT_USED', condition: 'RESALEABLE' }] })
        .expect(201);
      await c.storekeeper.post(`/department-returns/${tooMany.body.id}/post`, {}).expect(400); // 5 left on that issue line
      await c.storekeeper.post(`/department-returns/${tooMany.body.id}/cancel`).expect(200);
      // Another department never received it.
      const other = await c.storekeeper
        .post('/department-returns', { departmentId: ids.surg, storeId: ids.MS, lines: [{ itemId: item.id, batchId: b.R1, quantity: 1, reasonCode: 'NOT_USED', condition: 'RESALEABLE' }] })
        .expect(201);
      await c.storekeeper.post(`/department-returns/${other.body.id}/post`, {}).expect(400);
      await c.storekeeper
        .post('/department-returns', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId: item.id, batchId: b.R1, quantity: 1, reasonCode: 'BOGUS', condition: 'RESALEABLE' }] })
        .expect(400);
    });

    it('reports consumption per department net of returns, with CSV export', async () => {
      const issued = voucher.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
      const credited = 5 * voucher.lines[0].unitCost;
      const r = await c.finance.get(`/consumption?from=${TODAY}&to=${TODAY}&groupBy=item&itemId=${item.id}`).expect(200);
      expect(r.body.rows).toHaveLength(1);
      expect(r.body.rows[0]).toMatchObject({ issuedQty: 10, returnedQty: 5, netQty: 5 });
      expect(r.body.rows[0].netValue).toBeCloseTo(issued - credited, 1);

      const dept = await c.finance.get(`/consumption?from=${TODAY}&to=${TODAY}&departmentId=${ids.ipd}`).expect(200);
      expect(dept.body.rows[0]).toMatchObject({ costCentre: 'CC-210', department: 'Medical Ward' });
      expect(dept.body.rows[0].issuedQty).toBeNull();

      const csv = await c.finance.get(`/consumption?from=${TODAY}&to=${TODAY}&groupBy=item&itemId=${item.id}&format=csv`).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.split('\r\n')[0]).toBe('Item code,Item,Unit,Issued qty,Returned qty,Net qty,Issued value (KES),Returned value (KES),Net value (KES),Movements');
      expect(csv.text).toContain(item.code);

      // Ward in-charge sees only their own department; ward staff have no access.
      const own = await c['surg.incharge'].get(`/consumption?from=${TODAY}&to=${TODAY}&departmentId=${ids.ipd}`).expect(200);
      expect(own.body.rows).toHaveLength(0);
      await c['ward.nurse'].get(`/consumption?from=${TODAY}&to=${TODAY}`).expect(403);
    });

    it('traces a batch from receipt to department and back', async () => {
      const t = await c.storekeeper.get(`/inventory/batches/${b.R1}/trace`).expect(200);
      const types = t.body.movements.map((m: { txnType: string }) => m.txnType);
      expect(types).toEqual(expect.arrayContaining(['OPENING', 'ISSUE', 'RETURN_IN']));
      const issue = t.body.movements.find((m: { txnType: string }) => m.txnType === 'ISSUE');
      expect(issue).toMatchObject({ to: 'Medical Ward (CC-210)', user: 'storekeeper' });
      expect(issue.from).toMatch(/^Main Store/);
      expect(t.body.totals).toMatchObject({ received: 20, issued: 10, returnedFromDepartments: 5 });
      expect(t.body.locations.some((l: { inQuarantine: boolean; onHand: number }) => l.inQuarantine && l.onHand === 2)).toBe(true);
    });
  });

  describe('returns to supplier', () => {
    it('posts stock out (quarantined stock allowed, reserved stock not) and records the credit note', async () => {
      const item = await newItem();
      const b = await stock(item.id, [{ no: 'RTS-1', expiry: addDays(100), qty: 10, cost: 7 }]);
      const sr = await approvedSr([{ itemId: item.id, quantity: 8 }]); // 8 of 10 reserved

      const tooMuch = await c.storekeeper
        .post('/supplier-returns', { supplierId: ids.s1, storeId: ids.MS, reasonCode: 'QUALITY', lines: [{ batchId: b['RTS-1'], quantity: 5 }] })
        .expect(201);
      const denied = await c.storekeeper.post(`/supplier-returns/${tooMuch.body.id}/dispatch`, {});
      expect(denied.body.code).toBe('INSUFFICIENT_STOCK');
      await c.storekeeper.post(`/supplier-returns/${tooMuch.body.id}/cancel`).expect(200);
      await c['ward.nurse'].post(`/store-requisitions/${sr.id}/cancel`, { reason: 'Returning batch' }).expect(200);

      // Unknown reason codes are refused.
      await c.storekeeper.post('/supplier-returns', { supplierId: ids.s1, storeId: ids.MS, reasonCode: 'NOT_USED', lines: [{ batchId: b['RTS-1'], quantity: 1 }] }).expect(400);

      const rts = await c.storekeeper
        .post('/supplier-returns', { supplierId: ids.s1, storeId: ids.MS, reasonCode: 'QUALITY', notes: 'Discoloured tablets', lines: [{ batchId: b['RTS-1'], quantity: 4 }] })
        .expect(201);
      expect(rts.body).toMatchObject({ status: 'DRAFT', source: 'STOCK' });
      const sent = await c.storekeeper.post(`/supplier-returns/${rts.body.id}/dispatch`, {}).expect(200);
      expect(sent.body.status).toBe('DISPATCHED');
      expect(sent.body.totalValue).toBeCloseTo(28, 2);
      expect((await balance(b['RTS-1'])).on_hand).toBe(6);
      const [t] = await ctx.ds.query(`SELECT txn_type, quantity::float AS q FROM stock_transaction WHERE source_doc_id = $1`, [rts.body.id]);
      expect(t).toMatchObject({ txn_type: 'SUPPLIER_RETURN', q: -4 });

      await c.storekeeper.post(`/supplier-returns/${rts.body.id}/dispatch`, {}).expect(409);
      const credited = await c.finance.post(`/supplier-returns/${rts.body.id}/credit-note`, { creditNoteNo: `CN-${uniq('x')}`, creditNoteDate: TODAY, amount: 28 }).expect(200);
      expect(credited.body).toMatchObject({ status: 'CREDITED', creditVariance: 0 });
    });

    it('returns quarantined (damaged) stock to the supplier', async () => {
      const [q] = await ctx.ds.query(
        `SELECT sb.batch_id, sb.bin_id, sb.on_hand::float AS q FROM stock_balance sb JOIN bin bn ON bn.id = sb.bin_id
          WHERE bn.is_quarantine AND sb.store_id = $1 AND sb.on_hand > 0 LIMIT 1`,
        [ids.MS],
      );
      const rts = await c.storekeeper
        .post('/supplier-returns', { supplierId: ids.s1, storeId: ids.MS, reasonCode: 'DAMAGED', lines: [{ batchId: q.batch_id, binId: q.bin_id, quantity: q.q }] })
        .expect(201);
      await c.storekeeper.post(`/supplier-returns/${rts.body.id}/dispatch`, {}).expect(200);
    });
  });

  it('keeps the ledger, balances and reservations reconciled', async () => {
    const r = await c.scm.get(`/inventory/reconciliation?storeId=${ids.MS}`).expect(200);
    expect(r.body).toMatchObject({ driftCount: 0, reservationDriftCount: 0, overReservedCount: 0 });
    const [neg] = await ctx.ds.query(`SELECT count(*)::int AS n FROM stock_balance WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand`);
    expect(neg.n).toBe(0);
  });
});

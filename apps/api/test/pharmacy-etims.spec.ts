import request from 'supertest';
import { BillingService } from '../src/modules/billing/billing.service';
import { computeLine } from '../src/modules/billing/tax-calc';
import { sharedMockEtims as mock } from '../src/modules/etims/mock/mock-etims';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const pdf = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('Pharmacy, billing and KRA eTIMS (mock control unit)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  let configId: string;
  let kraPin: string;
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  /** Generic + brand items, optionally with opening stock at the OPD pharmacy. */
  async function drug(opts: { cls?: string; brands?: number; stock?: { brand: number; batch: string; expiryDays: number; qty: number }[]; price?: number } = {}) {
    const inn = `Testamycin ${uniq('g')}`;
    const g = await c.admin.post('/generics', { innName: inn, strength: '250 mg', dosageForm: 'Tablet', route: 'Oral', therapeuticClass: opts.cls ?? `Test class ${uniq('c')}`, controlledSchedule: 'NONE' }).expect(201);
    const brands: { id: string; name: string }[] = [];
    for (let i = 0; i < (opts.brands ?? 1); i++) {
      const it = await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.antiinf, name: `${inn} brand ${i + 1}`, brandName: `Brand${i + 1}`, baseUomId: ids.tab, unitPrice: opts.price ?? 10, taxCategoryId: ids.exempt }).expect(201);
      brands.push(it.body);
    }
    for (const s of opts.stock ?? []) {
      await c.scm.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: brands[s.brand].id, batchNo: s.batch, expiryDate: day(s.expiryDays), quantity: s.qty, unitCost: 4 }] }).expect(201);
    }
    return { genericId: g.body.id as string, inn: inn.toLowerCase(), brands };
  }

  async function supply(taxCategoryId: string, price: number, uomId = ids.pcs) {
    const it = await c.admin.post('/items', { categoryId: ids.supGen, name: `Test dressing ${uniq('s')}`, baseUomId: uomId, unitPrice: price, taxCategoryId, isBatchTracked: false }).expect(201);
    if (uomId === ids.pcs) await c.scm.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: it.body.id, quantity: 100, unitCost: 3 }] }).expect(201);
    return it.body as { id: string; name: string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    mock.reset();
    for (const u of ['admin', 'scm', 'pharmacist', 'pharm.tech', 'cashier', 'finance', 'accountant', 'storekeeper', 'quality', 'tender', 'proc.officer', 'proc.manager', 'ward.incharge']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      antiinf: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      supGen: await idByCode(ctx.ds, 'item_category', 'SUP-GEN'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      ml: await idByCode(ctx.ds, 'unit_of_measure', 'ML'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      standard: await idByCode(ctx.ds, 'tax_category', 'STANDARD'),
    });
    kraPin = (await one(`SELECT kra_pin FROM facility LIMIT 1`)).kra_pin;

    // One mock control unit for the OPD pharmacy: initialise, sync code tables, map item classes.
    await c.pharmacist.put('/etims/configs', { storeId: ids.OPD, adapter: 'MOCK', kraPin, branchId: '00', deviceSerial: 'TEST-CU-1' }).expect(403);
    const cfg = await c.finance.put('/etims/configs', { storeId: ids.OPD, adapter: 'MOCK', kraPin, branchId: '00', deviceSerial: 'TEST-CU-1' }).expect(200);
    configId = cfg.body.id;
    const init = await c.finance.post(`/etims/configs/${configId}/initialise`).expect(200);
    expect(init.body.cuId).toMatch(/^KRACU/);
    expect(init.body.cmcKeyEnc).toBeUndefined();
    const stored = await one(`SELECT cmc_key_enc FROM etims_config WHERE id = $1`, [configId]);
    expect(stored.cmc_key_enc).toBeTruthy();
    expect(stored.cmc_key_enc).not.toContain([...mock.devices.values()][0].cmcKey); // encrypted at rest
    const synced = await c.finance.post('/etims/codes/sync').expect(200);
    expect(synced.body.codes).toBeGreaterThan(20);
    await c.finance.put('/etims/mappings', { kind: 'ITEM_CLASS', localKey: 'category:DRUG', etimsCode: '9999999999' }).expect(400); // not in the classification
    await c.finance.put('/etims/mappings', { kind: 'ITEM_CLASS', localKey: 'category:DRUG', etimsCode: '5100000000' }).expect(200);
    await c.finance.put('/etims/mappings', { kind: 'ITEM_CLASS', localKey: 'category:SUP', etimsCode: '4214000000' }).expect(200);
    // A second outlet cannot share the KRA branch.
    await c.finance.put('/etims/configs', { storeId: ids.MS, adapter: 'MOCK', kraPin, branchId: '00', deviceSerial: 'TEST-CU-2' }).expect(409);
  });

  afterAll(async () => {
    // Other suites run without eTIMS.
    await q(`UPDATE etims_config SET is_active = false`);
    mock.reset();
    await ctx.close();
  });

  describe('clinical checks', () => {
    let a: Awaited<ReturnType<typeof drug>>;
    let b: Awaited<ReturnType<typeof drug>>;
    let patientId: string;
    let rx: { id: string; lines: { id: string; genericId: string }[] };

    beforeAll(async () => {
      a = await drug({ brands: 2, stock: [{ brand: 1, batch: 'LATE', expiryDays: 400, qty: 50 }, { brand: 1, batch: 'EARLY', expiryDays: 120, qty: 8 }] });
      b = await drug();
      const p = await c.pharmacist.post('/patients', { hospitalNo: uniq('H'), name: 'Test Patient', dateOfBirth: '1990-05-01', sex: 'M', allergies: [] }).expect(201);
      patientId = p.body.id;
      await c['pharm.tech'].post('/pharmacy/interactions', { innA: a.inn, innB: b.inn, severity: 'CONTRAINDICATED', mechanism: 'Test mechanism', management: 'Do not combine' }).expect(403);
      await c.pharmacist.post('/pharmacy/interactions', { innA: b.inn, innB: a.inn, severity: 'CONTRAINDICATED', mechanism: 'Test mechanism', management: 'Do not combine' }).expect(201);
    });

    it('blocks a contraindicated combination until a pharmacist overrides it with a logged reason', async () => {
      const created = await c['pharm.tech']
        .post('/pharmacy/prescriptions', {
          patientId,
          storeId: ids.OPD,
          prescriber: 'Dr. Test',
          lines: [
            { genericId: a.genericId, preferredItemId: a.brands[0].id, dose: '250 mg', frequency: 'TDS', duration: '5 days', route: 'PO', quantity: 15 },
            { genericId: b.genericId, dose: '250 mg', frequency: 'BD', quantity: 10 },
          ],
        })
        .expect(201);
      rx = created.body;
      expect(created.body.status).toBe('RECEIVED');
      expect(created.body.alerts).toEqual([expect.objectContaining({ type: 'INTERACTION', severity: 'CONTRAINDICATED', blocking: true, override: null })]);

      const blocked = await c.pharmacist.post(`/pharmacy/prescriptions/${rx.id}/verify`).expect(409);
      expect(blocked.body.code).toBe('INTERACTION_BLOCKED');
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.id}/verify`).expect(403);
      // Cannot dispense before verification either.
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: a.brands[1].id, quantity: 1 }] }).expect(409);

      const alertId = created.body.alerts[0].id;
      await c['pharm.tech'].post(`/pharmacy/alerts/${alertId}/override`, { reason: 'Prescriber confirmed, benefits outweigh risk' }).expect(403);
      await c.pharmacist.post(`/pharmacy/alerts/${alertId}/override`, { reason: 'ok' }).expect(400); // reason too short
      await c.pharmacist.post(`/pharmacy/alerts/${alertId}/override`, { reason: 'Prescriber confirmed by phone; monitor the patient' }).expect(201);
      await c.pharmacist.post(`/pharmacy/alerts/${alertId}/override`, { reason: 'Second time round' }).expect(409);

      const verified = await c.pharmacist.post(`/pharmacy/prescriptions/${rx.id}/verify`).expect(200);
      expect(verified.body.status).toBe('VERIFIED');
      expect(verified.body.alerts[0].override).toMatchObject({ reason: 'Prescriber confirmed by phone; monitor the patient' });

      // The override is the record of a clinical decision: it cannot be edited.
      await expect(q(`UPDATE interaction_override SET reason = 'changed' WHERE alert_id = $1`, [alertId])).rejects.toThrow();
      const report = await c.pharmacist.get(`/pharmacy/reports/alerts?from=${day()}&to=${day()}`).expect(200);
      expect(report.body.summary).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'INTERACTION', severity: 'CONTRAINDICATED', raised: expect.any(Number), overridden: expect.any(Number) })]));
      expect(report.body.overrides.some((o: { reason: string }) => o.reason === 'Prescriber confirmed by phone; monitor the patient')).toBe(true);
    });

    it('moderate alerts are shown but do not block', async () => {
      const m1 = await drug();
      const m2 = await drug();
      await c.pharmacist.post('/pharmacy/interactions', { innA: m1.inn, innB: m2.inn, severity: 'MODERATE', mechanism: 'Mild', management: 'Monitor' }).expect(201);
      const r = await c.pharmacist
        .post('/pharmacy/prescriptions', { patientId, storeId: ids.OPD, prescriber: 'Dr. Test', lines: [{ genericId: m1.genericId, dose: '1', frequency: 'OD', quantity: 1 }, { genericId: m2.genericId, dose: '1', frequency: 'OD', quantity: 1 }] })
        .expect(201);
      expect(r.body.alerts).toEqual([expect.objectContaining({ severity: 'MODERATE', blocking: false })]);
      await c.pharmacist.post(`/pharmacy/prescriptions/${r.body.id}/verify`).expect(200);
    });

    it('allergy and pregnancy checks use the patient record', async () => {
      const p = await c.pharmacist.post('/patients', { hospitalNo: uniq('H'), name: 'Pregnant Patient', dateOfBirth: '1995-01-01', sex: 'F', isPregnant: true, allergies: ['Test allergens'] }).expect(201);
      const allergen = await drug({ cls: 'Test allergen class' });
      const teratogen = await drug();
      await c.admin.patch(`/generics/${teratogen.genericId}`, { pregnancyContraindicated: true }).expect(200);
      const r = await c.pharmacist
        .post('/pharmacy/prescriptions', { patientId: p.body.id, storeId: ids.OPD, prescriber: 'Dr. Test', lines: [{ genericId: allergen.genericId, dose: '1', frequency: 'OD', quantity: 1 }, { genericId: teratogen.genericId, dose: '1', frequency: 'OD', quantity: 1 }] })
        .expect(201);
      expect(r.body.alerts.map((x: { type: string }) => x.type).sort()).toEqual(['ALLERGY', 'PREGNANCY']);
    });

    it('dispenses part of a line with another brand of the generic, FEFO batch, and invoices it through eTIMS', async () => {
      // A brand of a different generic is refused.
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: b.brands[0].id, quantity: 1 }] }).expect(400);
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: a.brands[1].id, quantity: 16 }] }).expect(400); // more than prescribed
      const opts = await c['pharm.tech'].get(`/pharmacy/prescriptions/${rx.id}/options`).expect(200);
      expect(opts.body[0].brands.find((x: { itemId: string }) => x.itemId === a.brands[1].id)).toMatchObject({ available: 58, earliestExpiry: day(120) });

      const lineA = rx.lines.find((l) => l.genericId === a.genericId)!;
      const d = await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ prescriptionLineId: lineA.id, itemId: a.brands[1].id, quantity: 10 }], payments: [{ modeCode: 'CASH', amount: 1000 }] }).expect(201);
      expect(d.body.status).toBe('PARTIALLY_DISPENSED');
      expect(d.body.firstDispensedAt).toBeTruthy();
      const dispense = d.body.dispenses[0];
      // FEFO: the 8 of the early batch first, then 2 of the later one; brand substituted.
      const batches = dispense.lines.map((l: { batch: { batchNo: string }; quantity: number; substituted: boolean }) => [l.batch.batchNo, l.quantity, l.substituted]).sort();
      expect(batches).toEqual([['EARLY', 8, true], ['LATE', 2, true]]);
      const inv = d.body.invoices[0];
      expect(inv).toMatchObject({ etimsStatus: 'ACCEPTED', cuInvoiceNo: expect.stringMatching(/^KRACU\d+\/\d+$/), totalAmount: 100 });
      const ledger = await q(`SELECT txn_type, quantity::float AS q, patient_ref FROM stock_transaction WHERE source_doc_id = $1 ORDER BY id`, [dispense.id]);
      expect(ledger.every((r: { txn_type: string; patient_ref: string }) => r.txn_type === 'DISPENSE' && !!r.patient_ref)).toBe(true);
      ids.dispenseId = dispense.id;
      ids.dispenseLineA = lineA.id;
    });

    it('takes back unused medicines: credit note to eTIMS and stock back on the same batch', async () => {
      const before = await one(`SELECT COALESCE(sum(on_hand), 0)::float AS q FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE sb.store_id = $1 AND b.batch_no = 'LATE' AND sb.item_id = $2`, [ids.OPD, a.brands[1].id]);
      const r = await c['pharm.tech'].post(`/pharmacy/dispenses/${ids.dispenseId}/returns`, { lines: [{ prescriptionLineId: ids.dispenseLineA, quantity: 2 }], reason: 'Patient stopped treatment' }).expect(201);
      const cn = r.body.invoices.find((i: { docType: string }) => i.docType === 'CREDIT_NOTE');
      expect(cn).toMatchObject({ etimsStatus: 'ACCEPTED', totalAmount: 20 });
      const after = await one(`SELECT COALESCE(sum(on_hand), 0)::float AS q FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE sb.store_id = $1 AND sb.item_id = $2 AND b.batch_no = 'EARLY'`, [ids.OPD, a.brands[1].id]);
      const late = await one(`SELECT COALESCE(sum(on_hand), 0)::float AS q FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE sb.store_id = $1 AND b.batch_no = 'LATE' AND sb.item_id = $2`, [ids.OPD, a.brands[1].id]);
      expect(after.q + late.q - before.q).toBe(2); // two units back (first allocation batch)
      const sent = [...mock.sales.values()].map((s) => s.request).find((s) => s.trdInvcNo === (cn.number as string));
      expect(sent).toMatchObject({ rcptTyCd: 'R', rfdRsnCd: '06' });
      expect(r.body.lines.find((l: { id: string }) => l.id === ids.dispenseLineA)).toMatchObject({ dispensedQty: 8 });
    });
  });

  describe('sales, receipts and eTIMS resilience', () => {
    let vatItem: { id: string; name: string };
    let exemptItem: { id: string; name: string };
    let saleId: string;

    beforeAll(async () => {
      vatItem = await supply(ids.standard, 100); // 116 incl. VAT on the retail list
      exemptItem = await supply(ids.exempt, 50);
    });

    it('sale → VAT invoice → mock eTIMS → receipt with CU invoice number and QR', async () => {
      const base = { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: vatItem.id, quantity: 2 }, { itemId: exemptItem.id, quantity: 1 }] };
      await c.cashier.post('/billing/invoices', { ...base, payments: [{ modeCode: 'MPESA', amount: 282 }] }).expect(400); // M-Pesa needs its code
      await c.cashier.post('/billing/invoices', { ...base, customer: { name: 'Acme Ltd', kraPin: 'P05123' } }).expect(400); // bad PIN
      const r = await c.cashier.post('/billing/invoices', { ...base, customer: { name: 'Acme Ltd', kraPin: 'P051234567X' }, payments: [{ modeCode: 'MPESA', amount: 300, reference: 'QAB12CD34' }] }).expect(201);
      saleId = r.body.id;
      const vat = computeLine({ quantity: 2, unitPrice: 116, taxRatePercent: 16, taxTypeCode: 'B' });
      expect(r.body).toMatchObject({ etimsStatus: 'ACCEPTED', totalAmount: 282, totalTax: vat.taxAmount, change: 18, customerPin: 'P051234567X' });
      expect(r.body.taxSummary.B).toEqual({ taxable: 232, tax: 32, rate: 16 });
      expect(r.body.taxSummary.A).toMatchObject({ taxable: 50, tax: 0 });
      expect(r.body.cuInvoiceNo).toMatch(/^KRACU\d+\/\d+$/);
      expect(r.body.rcptSign).toHaveLength(16);
      expect(r.body.payments).toEqual([expect.objectContaining({ modeCode: 'MPESA', etimsPaymentTypeCode: '06', amount: 282, reference: 'QAB12CD34' })]);

      const sent = [...mock.sales.values()].find((s) => s.request.trdInvcNo === r.body.number)!;
      expect(sent.request).toMatchObject({ custTin: 'P051234567X', pmtTyCd: '06', taxblAmtB: 232, taxAmtB: 32, taxblAmtA: 50, totAmt: 282, rcptTyCd: 'S' });

      const qr = await ctx.app.get(BillingService).qrFor(saleId);
      expect(qr).toContain(`${kraPin}00${r.body.rcptSign}`);
      for (const layout of ['THERMAL', 'A4']) {
        const res = await pdf(c.cashier, `/billing/invoices/${saleId}/receipt?layout=${layout}`);
        expect(res.status).toBe(200);
        expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      }
      // Issued invoices are immutable.
      await expect(q(`UPDATE sales_invoice SET total_amount = 1 WHERE id = $1`, [saleId])).rejects.toThrow(/immutable|cannot be changed/);
      await expect(q(`DELETE FROM sales_invoice_line WHERE invoice_id = $1`, [saleId])).rejects.toThrow();
    });

    it('refuses to invoice an item without eTIMS mapping and lists it for the mapping screen', async () => {
      const unmapped = await supply(ids.standard, 10, ids.ml);
      const r = await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', deductStock: false, lines: [{ itemId: unmapped.id, quantity: 1 }] }).expect(400);
      expect(r.body.code).toBe('ETIMS_MAPPING_MISSING');
      const list = await c.finance.get('/etims/unmapped-items').expect(200);
      expect(list.body.find((x: { itemId: string }) => x.itemId === unmapped.id).missing.join()).toMatch(/quantity unit for ML/);
    });

    it('eTIMS down: the sale is queued ("eTIMS pending" receipt) and sent once later, without duplicates', async () => {
      mock.failure = { mode: 'offline' };
      const salesBefore = mock.sales.size;
      const r = await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: vatItem.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 116 }] }).expect(201);
      expect(r.body).toMatchObject({ etimsStatus: 'PENDING', cuInvoiceNo: null, rcptSign: null });
      const pending = await pdf(c.cashier, `/billing/invoices/${r.body.id}/receipt`);
      expect(pending.status).toBe(200);
      const ob = await one(`SELECT * FROM etims_outbox WHERE doc_id = $1`, [r.body.id]);
      expect(ob).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(new Date(ob.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // backed off

      // Dispatching early sends nothing; still offline when due → another back-off.
      await c.finance.post('/etims/outbox/dispatch').expect(200);
      expect((await one(`SELECT attempts FROM etims_outbox WHERE id = $1`, [ob.id])).attempts).toBe(1);
      await q(`UPDATE etims_outbox SET next_attempt_at = now() WHERE id = $1`, [ob.id]);
      await c.finance.post('/etims/outbox/dispatch').expect(200);
      const second = await one(`SELECT attempts, next_attempt_at FROM etims_outbox WHERE id = $1`, [ob.id]);
      expect(second.attempts).toBe(2);
      expect(new Date(second.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(45_000); // 30 s × 2

      // Back online.
      mock.failure = null;
      await q(`UPDATE etims_outbox SET next_attempt_at = now() WHERE id = $1`, [ob.id]);
      const d1 = await c.finance.post('/etims/outbox/dispatch').expect(200);
      expect(d1.body.accepted).toBeGreaterThanOrEqual(1);
      const done = await c.cashier.get(`/billing/invoices/${r.body.id}`).expect(200);
      expect(done.body).toMatchObject({ etimsStatus: 'ACCEPTED', cuInvoiceNo: expect.stringMatching(/^KRACU/) });
      // A second dispatch (or a reprocess attempt) does not send it again.
      const requests = mock.requests;
      await q(`UPDATE etims_outbox SET next_attempt_at = now() WHERE id = $1`, [ob.id]);
      await c.finance.post('/etims/outbox/dispatch').expect(200);
      await c.finance.post(`/etims/outbox/${ob.id}/reprocess`).expect(409);
      expect(mock.requests).toBe(requests);
      expect(mock.sales.size).toBe(salesBefore + 1);
      const sentNos = [...mock.sales.values()].filter((s) => s.request.trdInvcNo === r.body.number);
      expect(sentNos).toHaveLength(1);

      // Every call was logged, communication key masked.
      const log = await c.finance.get(`/etims/transmissions?outboxId=${ob.id}`).expect(200);
      expect(log.body).toHaveLength(3);
      expect(log.body.every((t: { request: { cmcKey: string } }) => t.request.cmcKey === '***')).toBe(true);
      expect(log.body.map((t: { error: string | null }) => !!t.error)).toEqual([false, true, true]);
    });

    it('a business error fails the document; finance is alerted; reprocessing sends it once fixed', async () => {
      mock.failure = { mode: 'business', count: 1 };
      const r = await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: exemptItem.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 50 }] }).expect(201);
      expect(r.body.etimsStatus).toBe('FAILED');
      expect(r.body.etimsError).toMatch(/^921/);
      const ob = await one(`SELECT id FROM etims_outbox WHERE doc_id = $1`, [r.body.id]);
      await q(`UPDATE etims_outbox SET created_at = now() - interval '2 hours' WHERE id = $1`, [ob.id]);
      const mon = await c.scm.post('/jobs/etims.monitor/run', {}).expect(200);
      expect(mon.body.run.result.overdue).toBeGreaterThanOrEqual(1);
      const [fin] = await q(`SELECT id FROM app_user WHERE username = 'finance'`);
      const note = await one(`SELECT title FROM notification WHERE user_id = $1 AND title LIKE 'eTIMS:%' ORDER BY created_at DESC LIMIT 1`, [fin.id]);
      expect(note.title).toMatch(/not accepted/);
      await c.cashier.post(`/etims/outbox/${ob.id}/reprocess`).expect(403);
      const re = await c.finance.post(`/etims/outbox/${ob.id}/reprocess`).expect(200);
      expect(re.body.status).toBe('ACCEPTED');
      expect((await c.cashier.get(`/billing/invoices/${r.body.id}`)).body.etimsStatus).toBe('ACCEPTED');
    });

    it('credit notes reference the original, refund and restock', async () => {
      await c.cashier.post(`/billing/invoices/${saleId}/credit-notes`, { reason: 'Returned' }).expect(403);
      const cn = await c.finance.post(`/billing/invoices/${saleId}/credit-notes`, { reason: 'Wrong item sold', restock: true, lines: [] }).expect(201);
      expect(cn.body).toMatchObject({ docType: 'CREDIT_NOTE', etimsStatus: 'ACCEPTED', totalAmount: 282, originalInvoiceId: saleId });
      await c.finance.post(`/billing/invoices/${saleId}/credit-notes`, { reason: 'Again' }).expect(400); // nothing left
      const orig = await c.finance.get(`/billing/invoices/${saleId}`).expect(200);
      expect(orig.body.creditNotes).toHaveLength(1);
      const sent = [...mock.sales.values()].find((s) => s.request.trdInvcNo === cn.body.number)!.request;
      const origNo = (await one(`SELECT etims_invoice_no FROM sales_invoice WHERE id = $1`, [saleId])).etims_invoice_no;
      expect(sent).toMatchObject({ rcptTyCd: 'R', orgInvcNo: Number(origNo) });
    });

    it('HMIS integration: issue an eTIMS invoice with an API key (idempotent on the HMIS bill id)', async () => {
      const [svc] = await q(`SELECT id FROM app_user WHERE username = 'cashier'`);
      await c.cashier.post('/api-clients', { name: 'HMIS', userId: svc.id }).expect(403);
      const client = await c.admin.post('/api-clients', { name: `HMIS ${uniq('x')}`, userId: svc.id }).expect(201);
      const key = client.body.apiKey as string;
      expect(key).toMatch(/^silp_/);
      expect(JSON.stringify((await c.admin.get('/api-clients').expect(200)).body)).not.toContain(key);
      const body = { storeId: ids.OPD, source: 'HMIS', externalRef: uniq('BILL'), lines: [{ itemId: vatItem.id, quantity: 1 }] };
      const http = () => request(ctx.app.getHttpServer());
      await http().post(`${API}/integration/invoices`).send(body).expect(401);
      await http().post(`${API}/integration/invoices`).set('x-api-key', 'silp_wrongwrongwrongwrongwrong').send(body).expect(401);
      const stockBefore = await one(`SELECT count(*)::int AS n FROM stock_transaction WHERE item_id = $1`, [vatItem.id]);
      const r = await http().post(`${API}/integration/invoices`).set('x-api-key', key).send(body).expect(201);
      expect(r.body).toMatchObject({ etimsStatus: 'ACCEPTED', totalAmount: 116, cuInvoiceNo: expect.stringMatching(/^KRACU/), qrUrl: expect.stringContaining(kraPin) });
      const dup = await http().post(`${API}/integration/invoices`).set('x-api-key', key).send(body).expect(409);
      expect(dup.body.invoiceId).toBe(r.body.id);
      // HMIS charges do not move stock unless asked; the invoice is on account (no payment given).
      expect((await one(`SELECT count(*)::int AS n FROM stock_transaction WHERE item_id = $1`, [vatItem.id])).n).toBe(stockBefore.n);
      const inv = await c.finance.get(`/billing/invoices/${r.body.id}`).expect(200);
      expect(inv.body.payments).toEqual([expect.objectContaining({ modeCode: 'CREDIT', etimsPaymentTypeCode: '02' })]);
      expect(inv.body.createdBy).toBe(svc.id);
      await http().get(`${API}/integration/invoices/${r.body.id}`).set('x-api-key', key).expect(200);
      await c.admin.put(`/api-clients/${client.body.id}/active`, { isActive: false }).expect(200);
      await http().get(`${API}/integration/invoices/${r.body.id}`).set('x-api-key', key).expect(401);
    });
  });

  describe('purchases, stock reporting and reconciliation', () => {
    let po: { id: string; lines: { id: string; unitPrice: number }[] };
    let supplierPin: string;

    beforeAll(async () => {
      const [s1] = await q(`SELECT id, kra_pin FROM supplier WHERE code = 'SUP0001'`);
      supplierPin = s1.kra_pin;
      const item = (await one(`SELECT i.id FROM item i WHERE i.pack_size = '10x10' AND NOT i.is_controlled AND NOT i.is_cold_chain AND EXISTS (SELECT 1 FROM unit_conversion uc WHERE uc.item_id = i.id) ORDER BY i.code LIMIT 1`)).id;
      const box = await idByCode(ctx.ds, 'unit_of_measure', 'BOX');
      const ipd = await idByCode(ctx.ds, 'department', 'IPD-MED');
      const budget = (await one(`SELECT id FROM budget WHERE vote_head = 'WARD-SUPPLIES'`)).id;
      const pr = await c['ward.incharge'].post('/requisitions', { departmentId: ipd, storeId: ids.MS, budgetId: budget, justification: 'eTIMS test', lines: [{ itemId: item, quantity: 200, estimatedUnitPrice: 5 }] }).expect(201);
      await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(200);
      const prReq = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [pr.body.id]);
      await c['proc.manager'].post(`/approvals/${prReq.id}/approve`, {}).expect(200);
      const created = await c['proc.officer'].post('/purchase-orders', { supplierId: s1.id, requisitionId: pr.body.id, expectedDelivery: day(7), lines: [{ requisitionLineId: pr.body.lines[0].id, uomId: box, quantity: 2, unitPrice: 400 }] }).expect(201);
      po = created.body;
      await c['proc.officer'].post(`/purchase-orders/${po.id}/submit`).expect(200);
      const poReq = await one(`SELECT id FROM approval_request WHERE document_id = $1 AND status = 'PENDING'`, [po.id]);
      await c['proc.manager'].post(`/approvals/${poReq.id}/approve`, {}).expect(200);
      await c['proc.officer'].post(`/purchase-orders/${po.id}/send`).expect(200);
      const grn = await c.storekeeper.post('/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, quantity: 2, batchNo: uniq('B'), expiryDate: day(500) }] }).expect(201);
      await c.storekeeper.post(`/grns/${grn.body.id}/submit`).expect(200);
      await c.quality.post(`/grns/${grn.body.id}/inspect`, { lines: [{ lineId: grn.body.lines[0].id, acceptedQty: 200, rejectedQty: 0 }] }).expect(200);
      await c.tender.post(`/grns/${grn.body.id}/inspect`, {}).expect(200);
      await c.storekeeper.post(`/grns/${grn.body.id}/post`, {}).expect(200);
    });

    it('flags a supplier invoice that is not on eTIMS at the three-way match; matches one that is', async () => {
      const onEtims = uniq('INV');
      mock.offerPurchase(kraPin, { spplrTin: supplierPin, spplrNm: 'Sample supplier', spplrBhfId: '00', spplrInvcNo: ` ${onEtims} `, salesDt: day().replace(/-/g, ''), totTaxblAmt: 400, totTaxAmt: 0, totAmt: 400, taxblAmtA: 400, itemList: [] });
      const good = await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: onEtims.toLowerCase(), invoiceDate: day(), lines: [{ poLineId: po.lines[0].id, quantity: 1, unitPrice: 400 }] }).expect(201);
      expect(good.body).toMatchObject({ etimsStatus: 'VERIFIED', matchStatus: 'MATCHED' });

      const missing = await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('INV'), invoiceDate: day(), lines: [{ poLineId: po.lines[0].id, quantity: 1, unitPrice: 400 }] }).expect(201);
      expect(missing.body).toMatchObject({ etimsStatus: 'NOT_ON_ETIMS', matchStatus: 'VARIANCE' });
      expect(missing.body.variances).toEqual([expect.objectContaining({ code: 'NOT_ON_ETIMS', poLineId: '' })]);

      // The supplier transmits it later: a rematch clears the flag.
      mock.offerPurchase(kraPin, { spplrTin: supplierPin, spplrNm: 'Sample supplier', spplrBhfId: '00', spplrInvcNo: missing.body.supplierInvoiceNo, salesDt: day().replace(/-/g, ''), totTaxblAmt: 400, totTaxAmt: 0, totAmt: 400, taxblAmtA: 400, itemList: [] });
      const re = await c.accountant.post(`/invoices/${missing.body.id}/rematch`).expect(200);
      expect(re.body).toMatchObject({ etimsStatus: 'VERIFIED', matchStatus: 'MATCHED' });

      const report = await c.finance.get(`/billing/reports/purchases-by-tax?from=${day()}&to=${day()}`).expect(200);
      expect(report.body.some((r: { etims: string }) => r.etims === 'VERIFIED')).toBe(true);
    });

    it('confirms a supplier sale on eTIMS', async () => {
      const list = await c.finance.get('/etims/purchases?status=RECEIVED').expect(200);
      expect(list.body.length).toBeGreaterThanOrEqual(2);
      const p = list.body[0];
      const done = await c.finance.post(`/etims/purchases/${p.id}/decision`, { accept: true, note: 'Goods received' }).expect(200);
      expect(done.body.status).toBe('CONFIRMED');
      expect(mock.purchaseConfirmations.at(-1)).toMatchObject({ spplrInvcNo: p.spplrInvcNo, pchsSttsCd: '02' });
      await c.finance.post(`/etims/purchases/${p.id}/decision`, { accept: false }).expect(409);
    });

    it('reports stock movements (sales, returns, receipts) and stock master to eTIMS', async () => {
      const before = mock.stockIO.length;
      const r = await c.finance.post('/etims/stock/report').expect(200);
      expect(r.body.paused).toEqual([]);
      expect(r.body.movements).toBeGreaterThan(0);
      await c.finance.post('/etims/outbox/dispatch').expect(200);
      await c.finance.post('/etims/outbox/dispatch').expect(200); // stock master after its movement
      const sent = mock.stockIO.slice(before);
      const types = new Set(sent.map((s) => s.sarTyCd));
      expect([...types]).toEqual(expect.arrayContaining(['06', '11', '03'])); // opening adjustment, sale, return
      expect(mock.stockMaster.length).toBeGreaterThan(0);
      const open = await one(`SELECT count(*)::int AS n FROM etims_outbox WHERE status <> 'ACCEPTED'`);
      expect(open.n).toBe(0);
      // Nothing new: nothing reported twice.
      const again = await c.finance.post('/etims/stock/report').expect(200);
      expect(again.body.movements).toBe(0);
    });

    it('reconciles local documents with eTIMS; VAT and credit-note reports add up', async () => {
      const rec = await c.finance.get(`/billing/reports/reconciliation?from=${day()}&to=${day()}&storeId=${ids.OPD}`).expect(200);
      expect(rec.body.exceptions).toEqual([]);
      expect(rec.body.receiptGaps).toEqual([]);
      expect(rec.body.matched).toBe(true);
      const inv = rec.body.summary.find((s: { doc_type: string }) => s.doc_type === 'INVOICE');
      expect(inv.local_count).toBe(inv.etims_count);
      expect(inv.local_total).toBeCloseTo(inv.etims_total, 2);

      const vat = await c.finance.get(`/billing/reports/vat-output?from=${day()}&to=${day()}&storeId=${ids.OPD}`).expect(200);
      const b = vat.body.find((r: { tax_type_code: string }) => r.tax_type_code === 'B');
      const [{ v }] = await q(
        `SELECT sum(CASE WHEN s.doc_type = 'INVOICE' THEN l.tax_amount ELSE -l.tax_amount END)::float AS v FROM sales_invoice_line l JOIN sales_invoice s ON s.id = l.invoice_id WHERE s.store_id = $1 AND l.tax_type_code = 'B'`,
        [ids.OPD],
      );
      expect(b.vat).toBeCloseTo(v, 2);
      const cns = await c.finance.get(`/billing/reports/credit-notes?from=${day()}&to=${day()}&storeId=${ids.OPD}`).expect(200);
      expect(cns.body.length).toBeGreaterThanOrEqual(2);
      const csv = await c.finance.get(`/billing/reports/credit-notes?from=${day()}&to=${day()}&format=csv`).expect(200);
      expect(csv.text.split('\r\n')[0]).toContain('original_invoice');
      const status = await c.finance.get('/billing/reports/etims-status').expect(200);
      expect(status.body.overdue).toEqual([]);

      // Something the control unit never accepted shows up as an exception.
      mock.failure = { mode: 'offline' };
      await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', deductStock: false, lines: [{ itemId: (await one(`SELECT item_id FROM etims_item LIMIT 1`)).item_id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 1000 }] }).expect(201);
      mock.failure = null;
      const rec2 = await c.finance.get(`/billing/reports/reconciliation?from=${day()}&to=${day()}&storeId=${ids.OPD}`).expect(200);
      expect(rec2.body.matched).toBe(false);
      expect(rec2.body.exceptions).toEqual([expect.objectContaining({ issue: 'NOT_ACCEPTED' })]);
    });
  });
});

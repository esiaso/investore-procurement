import { createHash } from 'node:crypto';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

const PDF = Buffer.from('%PDF-1.4\n% test document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** Binary GET (PDFs, downloads). */
const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

const upload = (c: Client, fields: Record<string, string>, file: Buffer, filename: string, contentType: string) => {
  let req = c.agent.post(`${API}/attachments`).set('x-csrf-token', c.csrf);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, { filename, contentType });
};

describe('Logistics, quality and assets (acceptance)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const pending = async (docType: string, docId: string) => one(`SELECT * FROM approval_request WHERE document_type = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1`, [docType, docId]);
  const approve = async (docType: string, docId: string, ...users: string[]) => {
    const req = await pending(docType, docId);
    for (const u of users) await c[u].post(`/approvals/${req.id}/approve`, {}).expect(200);
  };
  const runJob = async (name: string) => {
    const r = await c.scm.post(`/jobs/${name}/run`, {}).expect(200);
    expect(r.body.run.status).toBe('SUCCEEDED');
    return r.body.run.result;
  };
  const batchStatus = async (batchId: string) => (await one(`SELECT hold_status FROM batch WHERE id = $1`, [batchId])).hold_status;
  const onHand = async (batchId: string, storeId: string) => Number((await one(`SELECT COALESCE(SUM(on_hand), 0) AS q FROM stock_balance WHERE batch_id = $1 AND store_id = $2`, [batchId, storeId])).q);

  async function drug(opts: { coldChain?: boolean; category?: string } = {}) {
    const g = await c.admin.post('/generics', { innName: `Logisticin ${uniq('g')}`, strength: '10 mg', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
    const it = await c.admin.post('/items', { genericId: g.body.id, categoryId: opts.category ?? ids.antiinf, name: `Logisticin ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 20, taxCategoryId: ids.exempt, isColdChain: opts.coldChain ?? false }).expect(201);
    return { ...(it.body as { id: string; name: string }), genericId: g.body.id as string };
  }
  async function supply(category = ids.supGen, name = 'Logistics supply') {
    const it = await c.admin.post('/items', { categoryId: category, name: `${name} ${uniq('s')}`, baseUomId: ids.pcs, unitPrice: 10, taxCategoryId: ids.exempt, isBatchTracked: false }).expect(201);
    return it.body as { id: string; name: string };
  }
  async function opening(storeId: string, itemId: string, qty: number, batchNo?: string, by = 'scm') {
    await c[by].post('/inventory/receipts', { storeId, type: 'OPENING', lines: [{ itemId, quantity: qty, unitCost: 5, ...(batchNo ? { batchNo, expiryDate: day(400) } : {}) }] }).expect(201);
    return (await one(`SELECT id FROM batch WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1`, [itemId])).id as string;
  }
  /** Approved and sent PO. */
  async function sentPo(itemId: string, quantity: number, unitPrice: number) {
    await c['proc.officer'].post(`/suppliers/${ids.s1}/contract-prices`, { itemId, unitPrice, validFrom: day(-1) }).expect(201);
    const po = await c['proc.officer'].post('/purchase-orders', { supplierId: ids.s1, storeId: ids.MS, departmentId: ids.ipd, lines: [{ itemId, quantity, unitPrice }] }).expect(201);
    await c['proc.officer'].post(`/purchase-orders/${po.body.id}/submit`).expect(200);
    await approve('PO', po.body.id, 'proc.manager');
    await c['proc.officer'].post(`/purchase-orders/${po.body.id}/send`).expect(200);
    return po.body as { id: string; number: string; lines: { id: string }[] };
  }
  /** GRN through inspection (two inspectors) to posting. */
  async function receive(body: object) {
    const g = await c.storekeeper.post('/grns', body).expect(201);
    await c.storekeeper.post(`/grns/${g.body.id}/submit`).expect(200);
    await c.quality.post(`/grns/${g.body.id}/inspect`, { lines: g.body.lines.map((l: { id: string; receivedBaseQty: number }) => ({ lineId: l.id, acceptedQty: l.receivedBaseQty, rejectedQty: 0 })) }).expect(200);
    await c.tender.post(`/grns/${g.body.id}/inspect`, {}).expect(200);
    await c.storekeeper.post(`/grns/${g.body.id}/post`, {}).expect(200);
    return g.body as { id: string; number: string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'scm', 'storekeeper', 'pharmacist', 'pharm.tech', 'quality', 'tender', 'proc.officer', 'proc.manager', 'finance', 'accountant', 'management', 'ward.nurse', 'ward.incharge', 'cashier', 'supplier', 'supplier2']) {
      c[u] = await loggedIn(ctx, u);
    }
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      MP: await idByCode(ctx.ds, 'store', 'MP'),
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      IPD: await idByCode(ctx.ds, 'store', 'IPD-PH'),
      ipd: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      antiinf: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      vacc: await idByCode(ctx.ds, 'item_category', 'DRUG-VACC'),
      supGen: await idByCode(ctx.ds, 'item_category', 'SUP-GEN'),
      equip: await idByCode(ctx.ds, 'item_category', 'EQUIP'),
      svc: await idByCode(ctx.ds, 'item_category', 'SVC'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      s1: (await one(`SELECT id FROM supplier WHERE code = 'SUP0001'`)).id,
    });
  });
  afterAll(() => ctx.close());

  describe('recall', () => {
    let item: Awaited<ReturnType<typeof drug>>;
    let batchId: string;
    let patientId: string;
    let recallId: string;

    beforeAll(async () => {
      item = await drug();
      const batchNo = uniq('RC');
      batchId = await opening(ids.MS, item.id, 200, batchNo);
      // Some goes to the OPD pharmacy…
      const t = await c.pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.OPD, lines: [{ itemId: item.id, quantity: 60 }] }).expect(201);
      await c.storekeeper.post(`/inventory/transfers/${t.body.id}/dispatch`, {}).expect(200);
      await c.pharmacist.post(`/inventory/transfers/${t.body.id}/receive`, {}).expect(200);
      // …some is issued to the medical ward…
      const sr = await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.ipd, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 30 }], submit: true }).expect(201);
      await approve('SR', sr.body.id, 'ward.incharge');
      await c.storekeeper.post(`/store-requisitions/${sr.body.id}/issues`, {}).expect(201);
      // …and some is dispensed to a patient.
      const p = await c.pharmacist.post('/patients', { hospitalNo: uniq('H'), name: 'Recall Patient', dateOfBirth: '1985-03-02', sex: 'F', allergies: [], phone: '0700000001' }).expect(201);
      patientId = p.body.id;
      const rx = await c['pharm.tech'].post('/pharmacy/prescriptions', { patientId, storeId: ids.OPD, prescriber: 'Dr. Test', lines: [{ genericId: item.genericId, dose: '10 mg', frequency: 'OD', quantity: 10 }] }).expect(201);
      await c.pharmacist.post(`/pharmacy/prescriptions/${rx.body.id}/verify`).expect(200);
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.body.id}/dispense`, { lines: [{ prescriptionLineId: rx.body.lines[0].id, itemId: item.id, quantity: 10 }], payments: [{ modeCode: 'CASH', amount: 1000 }] }).expect(201);
    });

    it('a recall notice quarantines the batch in every store and the trace lists every holder, issue and dispense with patients', async () => {
      await c.storekeeper.post('/recalls', { source: 'PPB', noticeDate: day(), classification: 'CLASS_II', itemId: item.id, reason: 'Out of specification' }).expect(403);
      const batchNo = (await one(`SELECT batch_no FROM batch WHERE id = $1`, [batchId])).batch_no;
      const r = await c.quality.post('/recalls', { source: 'PPB', noticeReference: 'PPB/RCL/TEST', noticeDate: day(), classification: 'CLASS_I', itemId: item.id, batchNos: [batchNo], reason: 'Out-of-specification dissolution results' }).expect(201);
      recallId = r.body.id;
      expect(r.body).toMatchObject({ status: 'OPEN', patientLevel: true, batchIds: [batchId] });
      expect(r.body.holds).toEqual([expect.objectContaining({ status: 'OPEN', quantityAtHold: 160 })]);
      expect(await batchStatus(batchId)).toBe('RECALL');

      const trace = await c.quality.get(`/recalls/${recallId}/trace`).expect(200);
      const stores = trace.body.holdings.map((h: { storeId: string; onHand: number }) => [h.storeId, h.onHand]);
      expect(stores).toEqual(expect.arrayContaining([[ids.MS, 110], [ids.OPD, 50]]));
      expect(trace.body.issues).toEqual([expect.objectContaining({ departmentId: ids.ipd, quantity: 30 })]);
      expect(trace.body.dispenses).toEqual([expect.objectContaining({ patientId, quantity: 10, store: expect.any(String) })]);
      expect(trace.body.transfers).toEqual([expect.objectContaining({ quantity: 60 })]);
      expect(trace.body.patients).toEqual([expect.objectContaining({ patientId, name: 'Recall Patient', phone: '0700000001', quantity: 10 })]);
      expect(trace.body.totals).toMatchObject({ onHand: 160, issued: 30, dispensed: 10 });

      // Nothing more leaves: the batch is not available for dispensing or issue.
      const rx = await c['pharm.tech'].post('/pharmacy/prescriptions', { patientId, storeId: ids.OPD, prescriber: 'Dr. Test', lines: [{ genericId: item.genericId, dose: '10 mg', frequency: 'OD', quantity: 1 }] }).expect(201);
      await c.pharmacist.post(`/pharmacy/prescriptions/${rx.body.id}/verify`).expect(200);
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rx.body.id}/dispense`, { lines: [{ prescriptionLineId: rx.body.lines[0].id, itemId: item.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 100 }] }).expect(400);
      // A recall hold is not released by hand.
      await c.quality.post(`/quality/holds/${r.body.holds[0].id}/release`, { note: 'Looks fine to me' }).expect(409);
    });

    it('records returns (patient and ward), shows the dashboard and closes with the stock still unusable', async () => {
      await c.quality.post(`/recalls/${recallId}/returns`, { batchId, source: 'PATIENT', fromId: patientId, fromName: 'Recall Patient', quantity: 6, intoStoreId: ids.OPD, outcome: 'RETURNED' }).expect(201);
      await c.quality.post(`/recalls/${recallId}/returns`, { batchId, source: 'DEPARTMENT', fromId: ids.ipd, fromName: 'Medical ward', quantity: 30, intoStoreId: ids.MS }).expect(201);
      expect(await onHand(batchId, ids.OPD)).toBe(56);
      expect(await onHand(batchId, ids.MS)).toBe(140);
      expect(await batchStatus(batchId)).toBe('RECALL');
      const dash = await c.quality.get('/recalls/dashboard').expect(200);
      expect(dash.body.open.find((x: { id: string }) => x.id === recallId)).toMatchObject({ storesHolding: 2, returned: 36, patients: 1 });
      const closed = await c.quality.post(`/recalls/${recallId}/close`, { outcome: 'Stock quarantined for return to the supplier' }).expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.holds[0].status).toBe('REJECTED');
      expect(await batchStatus(batchId)).toBe('RECALL');
    });
  });

  describe('cold chain excursion → quarantine → review → disposal with certificate', () => {
    let vaccine: Awaited<ReturnType<typeof drug>>;
    let batchId: string;
    let unitId: string;
    let holdId: string;
    let disposalId: string;

    beforeAll(async () => {
      vaccine = await drug({ coldChain: true, category: ids.vacc });
      batchId = await opening(ids.MP, vaccine.id, 40, uniq('VX'), 'pharmacist');
    });

    it('readings out of range open an excursion that quarantines the cold-chain batches in the unit', async () => {
      await c.storekeeper.post('/cold-chain/units', { code: uniq('FR'), name: 'Vaccine fridge', storeId: ids.MS, type: 'FRIDGE' }).expect(403);
      const u = await c.quality.post('/cold-chain/units', { code: uniq('FR'), name: 'Vaccine fridge', storeId: ids.MP, type: 'FRIDGE', loggerSerial: uniq('LOG') }).expect(201);
      unitId = u.body.id;
      const ok = await c.pharmacist.post(`/cold-chain/units/${unitId}/readings`, { readings: [{ recordedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), temperatureC: 5.1 }] }).expect(201);
      expect(ok.body).toMatchObject({ outOfRange: 0, newExcursions: 0, range: { min: 2, max: 8 } });
      expect(await batchStatus(batchId)).toBe('NONE');
      const bad = await c.pharmacist.post(`/cold-chain/units/${unitId}/readings`, { readings: [{ recordedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), temperatureC: 11.4, note: 'Door left open' }] }).expect(201);
      expect(bad.body).toMatchObject({ outOfRange: 1, newExcursions: 1 });
      expect(await batchStatus(batchId)).toBe('QUARANTINE');
      const [exc] = (await c.quality.get(`/cold-chain/excursions?unitId=${unitId}`).expect(200)).body;
      const detail = await c.quality.get(`/cold-chain/excursions/${exc.id}`).expect(200);
      expect(detail.body).toMatchObject({ status: 'OPEN', maxTemperatureC: 11.4, rangeMax: 8 });
      const mine = detail.body.holds.find((h: { batchNo: string }) => h.batchNo.startsWith('VX'));
      expect(mine).toMatchObject({ status: 'OPEN', quantityAtHold: 40 });
      holdId = mine.id;
      // Back in range: the excursion ends; logger CSV import adds readings.
      // Local logger times shortly after the excursion (not fixed clock times: those can be in the future just after midnight).
      const local = (msAgo: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() - msAgo));
      const csv = `Timestamp,Temperature (C)\n${local(100 * 60_000)},4.2\n${local(90 * 60_000)},4.4\n`;
      await c.pharmacist.post('/cold-chain/readings/import', { unitId, csv }).expect(200);
      await c.pharmacist.post(`/cold-chain/units/${unitId}/readings`, { readings: [{ recordedAt: new Date(Date.now() - 3600_000).toISOString(), temperatureC: 4.9 }] }).expect(201);
      expect((await c.quality.get(`/cold-chain/excursions/${exc.id}`).expect(200)).body.endedAt).toBeTruthy();
      await c.quality.post(`/cold-chain/excursions/${exc.id}/review`, { note: 'Stability data does not cover 11 °C for 1 h; reject the vaccine' }).expect(200);
    });

    it('the Quality Officer rejects the held batch, which raises a disposal; committee, approval, write-off, certificate in storage', async () => {
      const rej = await c.quality.post(`/quality/holds/${holdId}/reject`, { note: 'Excursion beyond stability data' }).expect(200);
      expect(rej.body.status).toBe('REJECTED');
      disposalId = rej.body.disposalId;
      expect(disposalId).toBeTruthy();
      let d = await c.quality.get(`/disposals/${disposalId}`).expect(200);
      expect(d.body).toMatchObject({ status: 'DRAFT', method: 'DESTRUCTION', storeId: ids.MP });
      expect(d.body.lines).toEqual([expect.objectContaining({ batchId, quantity: 40 })]);

      const pharmacistId = (await one(`SELECT id FROM app_user WHERE username = 'pharmacist'`)).id;
      const qualityId = (await one(`SELECT id FROM app_user WHERE username = 'quality'`)).id;
      await c.quality.put(`/disposals/${disposalId}/committee`, { members: [{ userId: qualityId, role: 'CHAIR' }, { userId: pharmacistId, role: 'MEMBER' }] }).expect(200);
      await c.quality.post(`/disposals/${disposalId}/sign`, {}).expect(200);
      const early = await c.quality.post(`/disposals/${disposalId}/submit`).expect(400);
      expect(early.body.code).toBe('DISPOSAL_INCOMPLETE');
      await c.pharmacist.post(`/disposals/${disposalId}/sign`, { comment: 'Agree: incinerate' }).expect(200);
      await c.quality.post(`/disposals/${disposalId}/submit`).expect(200);
      await approve('DSL', disposalId, 'scm', 'finance');
      d = await c.quality.get(`/disposals/${disposalId}`).expect(200);
      expect(d.body.status).toBe('APPROVED');
      expect(await onHand(batchId, ids.MP)).toBe(0);
      expect((await one(`SELECT reason_code FROM stock_transaction WHERE batch_id = $1 AND source_doc_type = 'DSL'`, [batchId])).reason_code).toBe('DISPOSAL');

      await c.quality.post(`/disposals/${disposalId}/complete`, { place: 'Licensed incinerator', agent: 'Test Waste Ltd', wasteTransferNote: 'WTN-001' }).expect(200);
      d = await c.quality.get(`/disposals/${disposalId}`).expect(200);
      expect(d.body.status).toBe('COMPLETED');
      expect(d.body.files).toEqual([expect.objectContaining({ category: 'CERTIFICATE', mimeType: 'application/pdf', generated: true })]);
      const cert = await bin(c.quality, `/disposals/${disposalId}/certificate`).expect(200);
      expect((cert.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect(createHash('sha256').update(cert.body as Buffer).digest('hex')).toBe(d.body.files[0].sha256);
    });

    it('a cold-chain delivery received out of range is held on posting', async () => {
      const item = await drug({ coldChain: true, category: ids.vacc });
      const po = await sentPo(item.id, 10, 50);
      const g = await c.storekeeper.post('/grns', { purchaseOrderId: po.id, receiptTemperatureC: 12, lines: [{ poLineId: po.lines[0].id, quantity: 10, batchNo: uniq('RT'), expiryDate: day(300) }] }).expect(201);
      expect(g.body.receiptTemperatureC).toBe(12);
      await c.storekeeper.post(`/grns/${g.body.id}/submit`).expect(200);
      await c.quality.post(`/grns/${g.body.id}/inspect`, { lines: [{ lineId: g.body.lines[0].id, acceptedQty: 10, rejectedQty: 0 }] }).expect(200);
      await c.tender.post(`/grns/${g.body.id}/inspect`, {}).expect(200);
      await c.storekeeper.post(`/grns/${g.body.id}/post`, {}).expect(200);
      const b = (await one(`SELECT batch_id FROM grn_line WHERE grn_id = $1`, [g.body.id])).batch_id;
      expect(await batchStatus(b)).toBe('QUARANTINE');
      const [h] = (await c.quality.get(`/quality/holds?batchId=${b}`).expect(200)).body;
      expect(h).toMatchObject({ reason: 'EXCURSION', sourceType: 'GRN', status: 'OPEN' });
    });
  });

  describe('quality holds and complaints', () => {
    it('holds block use until released; the person who placed a hold cannot decide it', async () => {
      const item = await drug();
      const batchId = await opening(ids.OPD, item.id, 20, uniq('QH'), 'pharmacist');
      const h = await c.quality.post('/quality/holds', { batchId, reason: 'INSPECTION', details: 'Pending visual inspection of a damaged carton' }).expect(201);
      expect(await batchStatus(batchId)).toBe('QUARANTINE');
      await c.quality.post(`/quality/holds/${h.body.id}/release`, { note: 'Inspected and fine' }).expect(403); // placed it
      const p = await c.pharmacist.post('/quality/holds', { batchId, reason: 'INVESTIGATION', details: 'Second check requested by the pharmacist' }).expect(201);
      await c.pharmacist.post(`/quality/holds/${p.body.id}/release`, { note: 'x'.repeat(10) }).expect(403); // no quality.release
      await c.quality.post(`/quality/holds/${p.body.id}/release`, { note: 'Investigated: no defect found' }).expect(200);
      expect(await batchStatus(batchId)).toBe('QUARANTINE'); // the first hold is still open
      const other = await loggedIn(ctx, 'admin');
      await other.post(`/quality/holds/${h.body.id}/release`, { note: 'Inspected and fine' }).expect(200);
      expect(await batchStatus(batchId)).toBe('NONE');
    });

    it('a complaint is logged by dispensing staff, investigated by quality with PPB fields and printed', async () => {
      const item = await drug();
      const batchId = await opening(ids.OPD, item.id, 10, uniq('PQ'), 'pharmacist');
      const r = await c['pharm.tech'].post('/quality/complaints', { itemId: item.id, batchId, storeId: ids.OPD, category: 'QUALITY_DEFECT', description: 'Tablets crumble when pushed from the blister', reportedByName: 'Njeri Technician', holdStock: true, sampleRetained: true }).expect(201);
      expect(r.body).toMatchObject({ status: 'OPEN', ppbReportType: 'PQM', hold: null }); // only quality staff may hold stock
      await c['pharm.tech'].put(`/quality/complaints/${r.body.id}`, { status: 'CLOSED' }).expect(403);
      await c.quality.put(`/quality/complaints/${r.body.id}`, { status: 'CLOSED' }).expect(400); // outcome first
      await c.quality.put(`/quality/complaints/${r.body.id}`, { investigation: 'Moisture ingress in one carton', ppbReference: 'PV-TEST-1', reportedToPpbOn: day(), outcome: 'Carton withdrawn; supplier informed', status: 'CLOSED' }).expect(200);
      const pdf = await bin(c.quality, `/quality/complaints/${r.body.id}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });
  });

  describe('distribution: picking list → pack → dispatch → proof of delivery → transfer receipt', () => {
    it('delivers two stops, one short with a discrepancy reason', async () => {
      const a = await supply();
      const b = await supply();
      const batchA = await opening(ids.MS, a.id, 100);
      await opening(ids.MS, b.id, 100);
      const t1 = await c.pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.OPD, lines: [{ itemId: a.id, quantity: 20 }, { itemId: b.id, quantity: 10 }] }).expect(201);
      const t2 = await c.pharmacist.post('/inventory/transfers', { fromStoreId: ids.MS, toStoreId: ids.IPD, lines: [{ itemId: a.id, quantity: 15 }] }).expect(201);
      const route = await c.storekeeper.post('/distribution/routes', { code: uniq('RT'), name: 'Pharmacies round', fromStoreId: ids.MS, stopStoreIds: [ids.IPD, ids.OPD] }).expect(201);
      const pendingList = await c.storekeeper.get(`/distribution/pending?storeId=${ids.MS}`).expect(200);
      expect(pendingList.body.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([t1.body.id, t2.body.id]));

      const run = await c.storekeeper.post('/distribution/runs', { fromStoreId: ids.MS, routeId: route.body.id, vehicle: 'KCA 123A', driver: 'Test Driver', transferIds: [t1.body.id, t2.body.id] }).expect(201);
      expect(run.body.stops.map((s: { toStoreId: string }) => s.toStoreId)).toEqual([ids.IPD, ids.OPD]); // route order
      await c.storekeeper.post('/distribution/runs', { fromStoreId: ids.MS, transferIds: [t1.body.id] }).expect(409); // already on a run

      const list = await c.storekeeper.get(`/distribution/runs/${run.body.id}/picking-list`).expect(200);
      const lineA = list.body.stops[1].lines.find((l: { itemId: string }) => l.itemId === a.id);
      expect(lineA).toMatchObject({ requested: 20, shortfall: 0, picks: [expect.objectContaining({ batchId: batchA, quantity: 20 })] });
      const [s1, s2] = run.body.stops;
      await c.storekeeper.post(`/distribution/runs/${run.body.id}/dispatch`, {}).expect(409); // not picked yet
      await c.storekeeper.post(`/distribution/runs/${run.body.id}/stops/${s1.id}/pick`, {}).expect(200);
      // Only 8 of item B could be found for the OPD stop.
      const lineB = list.body.stops[1].lines.find((l: { itemId: string }) => l.itemId === b.id);
      await c.storekeeper.post(`/distribution/runs/${run.body.id}/stops/${s2.id}/pick`, { lines: [{ lineId: lineB.lineId, quantity: 8 }] }).expect(200);
      await c.storekeeper.post(`/distribution/runs/${run.body.id}/stops/${s1.id}/pack`, { packages: 1 }).expect(200);
      await c.storekeeper.post(`/distribution/runs/${run.body.id}/stops/${s2.id}/pack`, { packages: 2 }).expect(200);
      const dispatched = await c.storekeeper.post(`/distribution/runs/${run.body.id}/dispatch`, {}).expect(200);
      expect(dispatched.body.status).toBe('DISPATCHED');
      expect((await one(`SELECT status FROM stock_transfer WHERE id = $1`, [t1.body.id])).status).toBe('DISPATCHED');
      const note = await bin(c.storekeeper, `/distribution/runs/${run.body.id}/dispatch-note`).expect(200);
      expect((note.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      // IPD: everything arrived.
      await c.pharmacist.post(`/distribution/runs/${run.body.id}/stops/${s1.id}/deliver`, { receivedByName: 'IPD Pharmacist', signatureName: 'O. Pharmacist' }).expect(200);
      // OPD: one unit of A missing.
      const t1Detail = (await c.pharmacist.get(`/inventory/transfers/${t1.body.id}`).expect(200)).body;
      const allocA = t1Detail.lines.find((l: { itemId: string }) => l.itemId === a.id).allocations[0];
      await c.pharmacist.post(`/distribution/runs/${run.body.id}/stops/${s2.id}/deliver`, { receivedByName: 'OPD Pharmacist', signatureName: 'O. Pharmacist', allocations: [{ allocationId: allocA.id, receivedQty: 19 }] }).expect(400); // reason needed
      const done = await c.pharmacist
        .post(`/distribution/runs/${run.body.id}/stops/${s2.id}/deliver`, { receivedByName: 'OPD Pharmacist', signatureName: 'O. Pharmacist', allocations: [{ allocationId: allocA.id, receivedQty: 19, discrepancyReasonCode: 'TRANSIT_LOSS', discrepancyNotes: 'Carton torn' }] })
        .expect(200);
      expect(done.body.status).toBe('COMPLETED');
      const stop2 = done.body.stops.find((s: { id: string }) => s.id === s2.id);
      expect(stop2).toMatchObject({ status: 'DELIVERED_WITH_DISCREPANCY', receivedByName: 'OPD Pharmacist', signatureName: 'O. Pharmacist' });
      expect(stop2.discrepancies).toEqual([expect.objectContaining({ dispatched: 20, received: 19, reasonCode: 'TRANSIT_LOSS' })]);
      expect((await one(`SELECT status FROM stock_transfer WHERE id = $1`, [t1.body.id])).status).toBe('RECEIVED_WITH_DISCREPANCY');
      expect((await one(`SELECT status FROM stock_transfer WHERE id = $1`, [t2.body.id])).status).toBe('RECEIVED');
      expect(await onHand(batchA, ids.OPD)).toBe(19);
      expect(await onHand(batchA, ids.IPD)).toBe(15);
      expect(await onHand(batchA, ids.MS)).toBe(65);
    });
  });

  describe('inbound shipments, assets from GRNs and supplier lead times', () => {
    let po: Awaited<ReturnType<typeof sentPo>>;
    let shipmentId: string;
    let monitor: { id: string };

    it('tracks a shipment with a date change and a delay, then partial receipts tag assets from the GRN lines', async () => {
      monitor = await supply(ids.equip, 'Patient monitor');
      po = await sentPo(monitor.id, 2, 50_000);
      const s = await c['proc.officer'].post('/shipments', { purchaseOrderId: po.id, shippedOn: day(), expectedOn: day(5), carrier: 'Test Couriers', trackingRef: 'TRK1' }).expect(201);
      shipmentId = s.body.id;
      expect(s.body).toMatchObject({ status: 'IN_TRANSIT', lines: [expect.objectContaining({ quantity: 2, receivedQty: 0 })] });
      await c['proc.officer'].put(`/shipments/${shipmentId}`, { expectedOn: day(-1), reason: 'Customs hold' }).expect(200);
      const r = await runJob('shipments.delays');
      expect(r.delayed).toBeGreaterThanOrEqual(1);
      const late = await c['proc.officer'].get(`/shipments/${shipmentId}`).expect(200);
      expect(late.body).toMatchObject({ status: 'DELAYED', expectedHistory: [expect.objectContaining({ date: day(5), reason: 'Customs hold' })] });

      const g1 = await receive({ purchaseOrderId: po.id, shipmentId, lines: [{ poLineId: po.lines[0].id, quantity: 1 }] });
      expect((await c['proc.officer'].get(`/shipments/${shipmentId}`).expect(200)).body.status).toBe('PARTIALLY_RECEIVED');
      let assets = (await c.scm.get(`/assets?search=Patient monitor`).expect(200)).body.filter((x: { itemId: string }) => x.itemId === monitor.id);
      expect(assets).toEqual([expect.objectContaining({ grnId: g1.id, cost: 50_000, storeId: ids.MS, status: 'ACTIVE', tagNo: expect.stringMatching(/^AST\d+/) })]);
      await receive({ purchaseOrderId: po.id, shipmentId, lines: [{ poLineId: po.lines[0].id, quantity: 1 }] });
      expect((await c['proc.officer'].get(`/shipments/${shipmentId}`).expect(200)).body.status).toBe('RECEIVED');
      assets = (await c.scm.get(`/assets?search=Patient monitor`).expect(200)).body.filter((x: { itemId: string }) => x.itemId === monitor.id);
      expect(assets).toHaveLength(2);
      expect(new Set(assets.map((x: { tagNo: string }) => x.tagNo)).size).toBe(2);

      const lt = await c['proc.officer'].get(`/shipments/lead-times?supplierId=${ids.s1}`).expect(200);
      expect(lt.body).toEqual([expect.objectContaining({ supplierId: ids.s1, orders: expect.any(Number), delayedShipments: expect.any(Number) })]);
      expect(lt.body[0].delayedShipments).toBeGreaterThanOrEqual(1);
      await runJob('suppliers.leadtimes');
      expect((await one(`SELECT observed_lead_time_days FROM supplier WHERE id = $1`, [ids.s1])).observed_lead_time_days).not.toBeNull();
    });

    it('assets move between locations and custodians, log maintenance and raise warranty / maintenance alerts once', async () => {
      const [asset] = (await c.scm.get(`/assets?search=Patient monitor`).expect(200)).body.filter((x: { itemId: string }) => x.itemId === monitor.id);
      await c.storekeeper.put(`/assets/${asset.id}`, { serialNo: 'SN-1' }).expect(403);
      await c.scm.put(`/assets/${asset.id}`, { serialNo: uniq('SN'), warrantyEndsOn: day(30), maintenanceIntervalMonths: 6, nextMaintenanceOn: day(7) }).expect(200);
      const inchargeId = (await one(`SELECT id FROM app_user WHERE username = 'ward.incharge'`)).id;
      const moved = await c.scm.post(`/assets/${asset.id}/move`, { departmentId: ids.ipd, location: 'Ward 3, bay 2', custodianUserId: inchargeId, reason: 'Installed on the medical ward' }).expect(200);
      expect(moved.body).toMatchObject({ departmentId: ids.ipd, storeId: null, custodianName: 'Akinyi Ward Sister' });
      expect(moved.body.movements[0].fromLocation).toMatchObject({ storeId: ids.MS });
      const first = await runJob('assets.alerts');
      expect(first).toMatchObject({ warranty: expect.any(Number), maintenance: expect.any(Number) });
      expect(first.warranty).toBeGreaterThanOrEqual(1);
      expect(first.maintenance).toBeGreaterThanOrEqual(1);
      const again = await runJob('assets.alerts');
      const alerted = await q(`SELECT warranty_alerted_for, maintenance_alerted_for FROM asset WHERE id = $1`, [asset.id]);
      expect(alerted[0].warranty_alerted_for).toBeTruthy();
      expect(again.warranty).toBe(0);
      const maint = await c.scm.post(`/assets/${asset.id}/maintenance`, { kind: 'PREVENTIVE', performedBy: 'Biomedical engineer', performedOn: day() }).expect(200);
      expect(maint.body.lastMaintenanceOn).toBe(day());
      expect(maint.body.nextMaintenanceOn > day(150)).toBe(true);
    });
  });

  describe('service and works orders: completion certificate instead of a GRN, feeding the three-way match', () => {
    it('certifies a maintenance visit and matches the invoice against it', async () => {
      const visit = await supply(ids.svc, 'Autoclave maintenance visit');
      const po = await sentPo(visit.id, 4, 10_000);
      const g = await c.storekeeper.post('/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, quantity: 1 }] }).expect(400);
      expect(g.body.code).toBe('SERVICE_ITEM');
      await c['proc.officer'].post('/service-certificates', { purchaseOrderId: po.id, periodTo: day(), workDone: 'Quarterly service', lines: [{ poLineId: po.lines[0].id, quantity: 1 }] }).expect(403); // no services.certify
      await c.scm.post('/service-certificates', { purchaseOrderId: po.id, periodTo: day(), workDone: 'Quarterly service', lines: [{ poLineId: po.lines[0].id, quantity: 5 }] }).expect(400); // more than ordered
      const cert = await c['ward.incharge'].post('/service-certificates', { purchaseOrderId: po.id, periodFrom: day(-90), periodTo: day(), workDone: 'Quarterly preventive service of the CSSD autoclave', qualityRating: 4, lines: [{ poLineId: po.lines[0].id, quantity: 1 }] }).expect(201);
      expect(cert.body).toMatchObject({ status: 'DRAFT', number: expect.stringMatching(/SCC/) });
      await c.scm.post(`/service-certificates/${cert.body.id}/post`).expect(403); // only the certifier
      await c['ward.incharge'].post(`/service-certificates/${cert.body.id}/post`).expect(200);
      expect((await one(`SELECT received_base_qty::float AS q FROM purchase_order_line WHERE id = $1`, [po.lines[0].id])).q).toBe(1);
      const pdf = await bin(c['ward.incharge'], `/service-certificates/${cert.body.id}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const ok = await c.finance.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SV'), invoiceDate: day(), lines: [{ poLineId: po.lines[0].id, quantity: 1, unitPrice: 10_000 }] }).expect(201);
      expect(ok.body.matchStatus).toBe('MATCHED');
      const over = await c.accountant.post('/invoices', { purchaseOrderId: po.id, supplierInvoiceNo: uniq('SV'), invoiceDate: day(), lines: [{ poLineId: po.lines[0].id, quantity: 2, unitPrice: 10_000 }] }).expect(201);
      expect(over.body.matchStatus).toBe('VARIANCE');
      expect(over.body.variances.map((v: { code: string }) => v.code)).toContain('QTY_EXCEEDS_RECEIVED');
    });
  });

  describe('attachments (object storage)', () => {
    let grnId: string;

    beforeAll(async () => {
      const it = await supply();
      const po = await sentPo(it.id, 3, 10);
      grnId = (await receive({ purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, quantity: 3 }] })).id;
      ids.attachPo = po.id;
    });

    it('stores versioned files with their hash, refuses disguised or disallowed types and respects record access', async () => {
      const v1 = await upload(c.storekeeper, { ownerType: 'GRN', ownerId: grnId, category: 'DELIVERY_NOTE' }, PDF, 'dn-001.pdf', 'application/pdf').expect(201);
      expect(v1.body).toMatchObject({ version: 1, sizeBytes: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex'), mimeType: 'application/pdf', isCurrent: true });
      expect(v1.body.storageKey).toBeUndefined();
      const second = Buffer.concat([PDF, Buffer.from('% revised\n')]);
      const v2 = await upload(c.storekeeper, { ownerType: 'GRN', ownerId: grnId, category: 'DELIVERY_NOTE' }, second, 'dn-001.pdf', 'application/pdf').expect(201);
      expect(v2.body.version).toBe(2);
      const current = await c['proc.officer'].get(`/attachments?ownerType=GRN&ownerId=${grnId}`).expect(200);
      expect(current.body).toEqual([expect.objectContaining({ version: 2, isCurrent: true })]);
      const all = await c['proc.officer'].get(`/attachments?ownerType=GRN&ownerId=${grnId}&versions=true`).expect(200);
      expect(all.body.map((a: { version: number }) => a.version)).toEqual([2, 1]);
      const down = await bin(c['proc.officer'], `/attachments/${v1.body.id}/download`).expect(200);
      expect((down.body as Buffer).equals(PDF)).toBe(true);
      expect(down.headers['content-disposition']).toContain('dn-001.pdf');

      const fake = await upload(c.storekeeper, { ownerType: 'GRN', ownerId: grnId }, Buffer.from('MZ not a pdf'), 'x.pdf', 'application/pdf').expect(400);
      expect(fake.body.code).toBe('FILE_TYPE');
      await upload(c.storekeeper, { ownerType: 'GRN', ownerId: grnId }, Buffer.from('MZ'), 'x.exe', 'application/x-msdownload').expect(400);
      await upload(c.cashier, { ownerType: 'GRN', ownerId: grnId }, PDF, 'x.pdf', 'application/pdf').expect(403);
      await upload(c.storekeeper, { ownerType: 'NOPE', ownerId: grnId }, PDF, 'x.pdf', 'application/pdf').expect(400);
      // The GRN is in the main store: a pharmacist (pharmacy stores only) cannot see its files.
      await c.pharmacist.get(`/attachments?ownerType=GRN&ownerId=${grnId}`).expect(404);
      await bin(c.pharmacist, `/attachments/${v1.body.id}/download`).expect(404);
    });

    it('suppliers upload delivery documents in the portal and only they (and staff) can download them', async () => {
      const sub = await c.supplier.agent
        .post(`${API}/portal/purchase-orders/${ids.attachPo}/documents`)
        .set('x-csrf-token', c.supplier.csrf)
        .field('type', 'DELIVERY_NOTE')
        .field('reference', 'DN-PORTAL-1')
        .field('documentDate', day())
        .attach('file', PDF, { filename: 'portal-dn.pdf', contentType: 'application/pdf' })
        .expect(201);
      const mine = await c.supplier.get('/portal/submissions').expect(200);
      const row = mine.body.find((s: { id: string }) => s.id === sub.body.id);
      expect(row.files).toEqual([expect.objectContaining({ fileName: 'portal-dn.pdf' })]);
      const fileId = row.files[0].id;
      const dl = await bin(c.supplier, `/portal/files/${fileId}`).expect(200);
      expect((dl.body as Buffer).equals(PDF)).toBe(true);
      await bin(c.supplier2, `/portal/files/${fileId}`).expect(404);
      await bin(c['proc.officer'], `/attachments/${fileId}/download`).expect(200);
      await c.supplier.get(`/attachments?ownerType=PORTAL_SUBMISSION&ownerId=${sub.body.id}`).expect(403);
    });
  });

  describe('labels', () => {
    it('prints shelf and batch labels as PDF', async () => {
      const item = await drug();
      const batchId = await opening(ids.MS, item.id, 5, uniq('LB'));
      const shelf = await bin(c.storekeeper, `/labels/shelf?storeId=${ids.MS}&itemIds=${item.id}`).expect(200);
      expect((shelf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const batch = await bin(c.storekeeper, `/labels/batches?batchIds=${batchId}&copies=2`).expect(200);
      expect((batch.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await bin(c.pharmacist, `/labels/shelf?storeId=${ids.MS}`).expect(403); // not their store
    });
  });
});

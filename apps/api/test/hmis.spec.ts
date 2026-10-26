import { sharedMockHmis as mock, seedMockHmis } from '../src/modules/hmis/mock/mock-hmis';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('HMIS integration and patient-level dispensing (mock FHIR HMIS)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  /** Generic + brand with stock (two batches, the earlier-expiring one smaller) at a store. */
  async function drug(storeId: string, opts: { price?: number; cls?: string } = {}) {
    const inn = `Hmisamycin ${uniq('g')}`;
    const g = await c.admin.post('/generics', { innName: inn, strength: '100 mg', dosageForm: 'Tablet', route: 'Oral', therapeuticClass: opts.cls ?? `Class ${uniq('c')}`, controlledSchedule: 'NONE' }).expect(201);
    const it = await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.antiinf, name: `${inn} tabs`, brandName: 'HmisBrand', baseUomId: ids.tab, unitPrice: opts.price ?? 10, taxCategoryId: ids.exempt }).expect(201);
    const early = uniq('E');
    const late = uniq('L');
    await c.scm.post('/inventory/receipts', { storeId, type: 'OPENING', lines: [{ itemId: it.body.id, batchNo: late, expiryDate: day(500), quantity: 200, unitCost: 4 }, { itemId: it.body.id, batchNo: early, expiryDate: day(90), quantity: 20, unitCost: 4 }] }).expect(201);
    const batch = async (no: string) => (await one(`SELECT id FROM batch WHERE item_id = $1 AND batch_no = $2`, [it.body.id, no])).id as string;
    return { genericId: g.body.id as string, itemId: it.body.id as string, inn: inn.toLowerCase(), code: uniq('HM'), early: await batch(early), late: await batch(late) };
  }

  const mapDrug = (code: string, genericId: string) => c.admin.put('/hmis/mappings', { kind: 'DRUG', externalCode: code, localId: genericId, externalDisplay: code }).expect(200);
  /** A patient + visit that only the HMIS knows about. */
  function hmisPatient(cls: 'AMB' | 'IMP', ward?: string, extra: Record<string, unknown> = {}) {
    const pid = uniq('pt').toLowerCase();
    const eid = uniq('enc').toLowerCase();
    const hospitalNo = uniq('HN');
    mock.put({ resourceType: 'Patient', id: pid, identifier: [{ system: 'urn:sil:hospital-no', value: hospitalNo }], name: [{ text: `Hmis ${hospitalNo}` }], gender: 'male', birthDate: '1980-01-01', ...extra });
    mock.put({
      resourceType: 'Encounter',
      id: eid,
      status: 'in-progress',
      class: { code: cls },
      subject: { reference: `Patient/${pid}` },
      ...(ward ? { location: [{ location: { identifier: { value: ward } }, physicalType: { coding: [{ code: 'wa' }] } }, { location: { display: 'B-7' }, physicalType: { coding: [{ code: 'bd' }] } }] } : {}),
    });
    return { pid, eid, hospitalNo };
  }
  const sync = () => c.admin.post('/hmis/sync').expect(200);
  const rxFor = async (hospitalNo: string, storeId: string) => {
    const w = await c.pharmacist.get(`/pharmacy/prescriptions?storeId=${storeId}&search=${hospitalNo}`).expect(200);
    return w.body.items as { id: string; number: string; status: string; encounterId: string; encounter: { class: string; bed: string | null; ward?: unknown }; alerts: { openBlocking: number } | null }[];
  };
  const approve = async (docId: string, user: string) => {
    const req = await one(`SELECT id FROM approval_request WHERE document_type = 'SR' AND document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId]);
    await c[user].post(`/approvals/${req.id}/approve`, {}).expect(200);
  };
  const forPatient = (type: string, pid: string) =>
    mock.all(type).filter((r) => ((r.subject as { reference?: string }) ?? {}).reference === `Patient/${pid}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    mock.reset();
    seedMockHmis(mock);
    for (const u of ['admin', 'scm', 'pharmacist', 'pharm.tech', 'storekeeper', 'ward.nurse', 'ward.incharge', 'surg.incharge']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      IPD: await idByCode(ctx.ds, 'store', 'IPD-PH'),
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      med: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      surg: await idByCode(ctx.ds, 'department', 'IPD-SURG'),
      antiinf: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      supGen: await idByCode(ctx.ds, 'item_category', 'SUP-GEN'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
    });
  });

  afterAll(async () => {
    await q(`UPDATE hmis_connection SET is_active = false`);
    mock.reset();
    await ctx.close();
  });

  it('configures the connection (mock FHIR), tests it, and maps outlets and wards', async () => {
    const body = { name: 'Test HMIS', adapter: 'MOCK', billingMode: 'HMIS', authToken: 'secret-token-1' };
    await c.pharmacist.put('/hmis/connection', body).expect(403);
    await c.admin.put('/hmis/connection', { ...body, adapter: 'FHIR' }).expect(400); // FHIR needs a base URL
    const saved = await c.admin.put('/hmis/connection', body).expect(200);
    expect(saved.body).toMatchObject({ adapter: 'MOCK', billingMode: 'HMIS', hasToken: true });
    expect(saved.body.authTokenEnc).toBeUndefined();
    const stored = await one(`SELECT auth_token_enc FROM hmis_connection`);
    expect(stored.auth_token_enc).toBeTruthy();
    expect(stored.auth_token_enc).not.toContain('secret-token-1');
    const ping = await c.admin.post('/hmis/connection/test').expect(200);
    expect(ping.body).toMatchObject({ ok: true, adapter: 'MOCK' });
    expect(ping.body.detail).toMatch(/FHIR 4\.0\.1/);

    await c.admin.put('/hmis/mappings', { kind: 'LOCATION', externalCode: 'T-OPD', localId: ids.OPD }).expect(200);
    await c.admin.put('/hmis/mappings', { kind: 'LOCATION', externalCode: 'T-IPD', localId: ids.IPD }).expect(200);
    await c.admin.put('/hmis/mappings', { kind: 'WARD', externalCode: 'T-MED', localId: ids.med }).expect(200);
    await c.admin.put('/hmis/mappings', { kind: 'WARD', externalCode: 'T-SURG', localId: ids.surg }).expect(200);
    await c.admin.put('/hmis/mappings', { kind: 'WARD', externalCode: 'T-X', localId: ids.OPD }).expect(400); // not a department
    const maps = await c.pharmacist.get('/hmis/mappings?kind=WARD').expect(200);
    expect(maps.body.map((x: { externalCode: string; localName: string }) => [x.externalCode, x.localName])).toEqual(expect.arrayContaining([['T-MED', 'Medical Ward']]));
  });

  it('finds and imports a patient from the HMIS (demographics and allergies cached; the HMIS is the master)', async () => {
    const found = await c.pharmacist.get('/hmis/patients/search?q=SIL-000103').expect(200);
    expect(found.body).toEqual([expect.objectContaining({ externalId: 'pt-103', hospitalNo: 'SIL-000103', isPregnant: true })]);
    const imported = await c.pharmacist.post('/hmis/patients/import', { externalId: 'pt-103' }).expect(201);
    expect(imported.body).toMatchObject({ externalId: 'pt-103', hospitalNo: 'SIL-000103', allergies: ['sulfonamides'], isPregnant: true });
    await c.pharmacist.post('/hmis/patients/import', { externalId: 'nobody' }).expect(404);
    const log = await c.admin.get('/hmis/messages?direction=IN&type=PATIENT&search=pt-103').expect(200);
    expect(log.body.items[0]).toMatchObject({ status: 'PROCESSED', via: 'IMPORT', localDocNo: 'SIL-000103' });
  });

  describe('orders from the HMIS → worklist → FEFO dispense with interaction check → dispense and charge back (billing in the HMIS)', () => {
    let a: Awaited<ReturnType<typeof drug>>;
    let b: Awaited<ReturnType<typeof drug>>;
    let pt: ReturnType<typeof hmisPatient>;
    let rxId: string;
    let orderIds: string[];

    beforeAll(async () => {
      a = await drug(ids.OPD, { price: 12 });
      b = await drug(ids.OPD);
      await mapDrug(a.code, a.genericId);
      await mapDrug(b.code, b.genericId);
      await c.pharmacist.post('/pharmacy/interactions', { innA: a.inn, innB: b.inn, severity: 'MAJOR', mechanism: 'Test', management: 'Avoid' }).expect(201);
      pt = hmisPatient('AMB');
      orderIds = mock
        .prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', prescriber: 'Dr. HMIS', lines: [{ code: a.code, quantity: 10 }, { code: b.code, quantity: 4 }] })
        .map((r) => r.id!);
    });

    it('a prescription written in the HMIS appears on the outlet worklist with its alerts', async () => {
      const s = await sync();
      expect(s.body.poll).toMatchObject({ processed: expect.any(Number) });
      const rows = await rxFor(pt.hospitalNo, ids.OPD);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'RECEIVED', encounter: expect.objectContaining({ class: 'OPD' }), alerts: expect.objectContaining({ openBlocking: 1 }) });
      rxId = rows[0].id;
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${rxId}`).expect(200)).body;
      expect(rx).toMatchObject({ prescriber: 'Dr. HMIS', encounterRef: pt.eid, supplyMode: 'STANDARD', patient: expect.objectContaining({ externalId: pt.pid, hospitalNo: pt.hospitalNo }) });
      expect(rx.lines.map((l: { externalRef: string; hmisDrugCode: string; quantity: number }) => [l.externalRef, l.hmisDrugCode, l.quantity])).toEqual([
        [orderIds[0], a.code, 10],
        [orderIds[1], b.code, 4],
      ]);
      // Polling again does not duplicate anything.
      await sync();
      expect(await rxFor(pt.hospitalNo, ids.OPD)).toHaveLength(1);
    });

    it('verification is blocked until the pharmacist overrides the interaction; payments are refused (billed in the HMIS)', async () => {
      const blocked = await c.pharmacist.post(`/pharmacy/prescriptions/${rxId}/verify`).expect(409);
      expect(blocked.body.code).toBe('INTERACTION_BLOCKED');
      await c.pharmacist.post(`/pharmacy/alerts/${blocked.body.alerts[0].id}/override`, { reason: 'Prescriber aware; short course with monitoring' }).expect(201);
      await c.pharmacist.post(`/pharmacy/prescriptions/${rxId}/verify`).expect(200);
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${rxId}`).expect(200)).body;
      await c['pharm.tech'].post(`/pharmacy/prescriptions/${rxId}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: a.itemId, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 100 }] }).expect(400);
    });

    it('dispenses FEFO and records the batch per patient; MedicationDispense and ChargeItem appear in the HMIS against the patient; no local invoice', async () => {
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${rxId}`).expect(200)).body;
      const d = await c['pharm.tech']
        .post(`/pharmacy/prescriptions/${rxId}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: a.itemId, quantity: 10 }, { prescriptionLineId: rx.lines[1].id, itemId: b.itemId, quantity: 4 }] })
        .expect(201);
      expect(d.body).toMatchObject({ status: 'DISPENSED', invoiceId: null });
      expect(d.body.invoices).toEqual([]);
      const lines = d.body.dispenses[0].lines as { itemId: string; batchId: string; quantity: number }[];
      expect(lines.filter((l) => l.itemId === a.itemId).map((l) => [l.batchId, l.quantity])).toEqual([[a.early, 10]]);
      expect(d.body.dispenses[0].billingMode).toBe('HMIS');

      // Charges: priced from the price list, posted to the HMIS bill.
      expect(d.body.charges.map((x: { quantity: number; amount: number; status: string }) => [x.quantity, x.status])).toEqual(expect.arrayContaining([[10, 'POSTED'], [4, 'POSTED']]));
      const chargeA = d.body.charges.find((x: { quantity: number }) => x.quantity === 10);
      expect(chargeA.amount).toBe(120);
      expect(chargeA.externalId).toBeTruthy();
      expect(d.body.hmisMessages.every((m: { status: string }) => m.status === 'SENT')).toBe(true);

      const dispensed = forPatient('MedicationDispense', pt.pid);
      expect(dispensed).toHaveLength(2);
      expect(dispensed.find((r) => (r.authorizingPrescription as { reference: string }[])[0].reference === `MedicationRequest/${orderIds[0]}`)).toMatchObject({
        status: 'completed',
        quantity: { value: 10 },
        context: { reference: `Encounter/${pt.eid}` },
        contained: [expect.objectContaining({ batch: expect.objectContaining({ lotNumber: expect.any(String) }) })],
      });
      const billed = forPatient('ChargeItem', pt.pid);
      expect(billed.map((r) => (r.priceOverride as { value: number }).value).sort()).toEqual([120, 40].sort());
      // The batch → patient link for recalls.
      const trace = await c.pharmacist.get(`/inventory/batches/${a.early}/trace`).expect(200);
      expect(JSON.stringify(trace.body)).toContain(pt.hospitalNo);
      // The encounter shows the charges.
      const enc = await c.pharmacist.get(`/hmis/encounters/${rx.encounterId}`).expect(200);
      expect(enc.body.charges).toHaveLength(2);
      expect(enc.body.totals).toMatchObject({ charged: 160, pendingToHmis: 0 });
    });

    it('a return becomes a credit charge against the original and updates the dispense record in the HMIS; stock goes back', async () => {
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${rxId}`).expect(200)).body;
      const before = (await one(`SELECT on_hand::float FROM stock_balance WHERE batch_id = $1 AND store_id = $2`, [a.early, ids.OPD])).on_hand;
      const r = await c['pharm.tech'].post(`/pharmacy/dispenses/${rx.dispenses[0].id}/returns`, { lines: [{ prescriptionLineId: rx.lines[0].id, quantity: 3 }], reason: 'Patient brought back unused' }).expect(201);
      expect((await one(`SELECT on_hand::float FROM stock_balance WHERE batch_id = $1 AND store_id = $2`, [a.early, ids.OPD])).on_hand).toBe(before + 3);
      const credit = r.body.charges.find((x: { quantity: number }) => x.quantity === -3);
      expect(credit).toMatchObject({ amount: -36, status: 'POSTED', reversesId: expect.any(String) });
      const credits = forPatient('ChargeItem', pt.pid).filter((x) => (x.quantity as { value: number }).value < 0);
      expect(credits).toEqual([expect.objectContaining({ partOf: [{ reference: `ChargeItem/${r.body.charges.find((x: { quantity: number }) => x.quantity === 10).externalId}` }] })]);
      const md = forPatient('MedicationDispense', pt.pid).find((x) => (x.authorizingPrescription as { reference: string }[])[0].reference === `MedicationRequest/${orderIds[0]}`)!;
      expect(md).toMatchObject({ quantity: { value: 7 }, meta: { versionId: '2' } });
      expect(forPatient('MedicationDispense', pt.pid)).toHaveLength(2); // updated, not added
      // More than is left cannot be returned.
      await c['pharm.tech'].post(`/pharmacy/dispenses/${rx.dispenses[0].id}/returns`, { lines: [{ prescriptionLineId: rx.lines[0].id, quantity: 8 }], reason: 'Too many' }).expect(400);
    });

    it('a stopped order cancels its undispensed balance', async () => {
      const ord = mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', lines: [{ code: a.code, quantity: 6 }] });
      await sync();
      const open = (await rxFor(pt.hospitalNo, ids.OPD)).find((x) => x.status === 'RECEIVED')!;
      expect(open).toBeTruthy();
      mock.setOrderStatus(ord[0].id!, 'stopped');
      await sync();
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${open.id}`).expect(200)).body;
      expect(rx).toMatchObject({ status: 'CANCELLED' });
      expect(rx.lines[0]).toMatchObject({ cancelledQty: 6 });
    });
  });

  it('receives FHIR pushed with an API key: each version is processed once; repeats are counted, not duplicated', async () => {
    const d = await drug(ids.OPD);
    await mapDrug(d.code, d.genericId);
    const pharmacistId = (await one(`SELECT id FROM app_user WHERE username = 'pharmacist'`)).id;
    const key = (await c.admin.post('/api-clients', { name: 'HMIS push', userId: pharmacistId, scopes: ['hmis'] }).expect(201)).body.apiKey;
    const billingKey = (await c.admin.post('/api-clients', { name: 'Billing only', userId: pharmacistId, scopes: ['billing.invoice'] }).expect(201)).body.apiKey;
    const hn = uniq('HN');
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'push-1', meta: { versionId: '1' }, identifier: [{ system: 'urn:sil:hospital-no', value: hn }], name: [{ text: 'Pushed Patient' }], gender: 'female', birthDate: '1999-09-09' } },
        { resource: { resourceType: 'Encounter', id: 'push-enc-1', meta: { versionId: '1' }, status: 'in-progress', class: { code: 'AMB' }, subject: { reference: 'Patient/push-1' } } },
        {
          resource: {
            resourceType: 'MedicationRequest', id: 'push-mr-1', meta: { versionId: '1' }, status: 'active', subject: { reference: 'Patient/push-1' }, encounter: { reference: 'Encounter/push-enc-1' },
            medicationCodeableConcept: { coding: [{ code: d.code }] }, dosageInstruction: [{ text: '1 tab BD', timing: { code: { text: 'BD' } } }], dispenseRequest: { quantity: { value: 14 }, performer: { identifier: { value: 'T-OPD' } } },
          },
        },
      ],
    };
    const post = (k: string | null, body: unknown) => {
      const r = ctx.app.getHttpServer();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = require('supertest')(r).post(`${API}/integration/hmis/fhir`).set('content-type', 'application/fhir+json');
      return (k ? req.set('x-api-key', k) : req).send(JSON.stringify(body));
    };
    await post(null, bundle).expect(401);
    await post(billingKey, bundle).expect(403);
    const first = await post(key, bundle).expect(200);
    expect(first.body).toMatchObject({ received: 3, processed: 3, failed: 0, duplicates: 0 });
    expect(first.body.results.map((r: { type: string }) => r.type)).toEqual(['PATIENT', 'ENCOUNTER', 'MEDICATION_REQUEST']);
    const again = await post(key, bundle).expect(200);
    expect(again.body).toMatchObject({ received: 3, duplicates: 3 });
    expect(await rxFor(hn, ids.OPD)).toHaveLength(1);
    const msg = await one(`SELECT duplicates, via FROM hmis_message WHERE idempotency_key = 'FHIR:MedicationRequest/push-mr-1/1'`);
    expect(msg).toEqual({ duplicates: 1, via: 'WEBHOOK' });
    // Generic REST events go through the same pipeline.
    const rest = await ctx.app.getHttpServer();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ev = await require('supertest')(rest).post(`${API}/integration/hmis/events`).set('x-api-key', key).send({ type: 'allergy', data: { patientExternalId: 'push-1', substance: 'Latex' } }).expect(200);
    expect(ev.body.results[0]).toMatchObject({ type: 'ALLERGY', status: 'PROCESSED' });
    expect((await one(`SELECT allergies FROM patient WHERE external_id = 'push-1'`)).allergies).toEqual(['latex']);
  });

  it('an unmapped drug code fails visibly on the dashboard and is processed after mapping', async () => {
    const d = await drug(ids.OPD);
    const pt = hmisPatient('AMB');
    mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', lines: [{ code: d.code, display: 'New drug 100 mg', quantity: 5 }] });
    await sync();
    const dash = await c.pharmacist.get('/hmis/dashboard').expect(200);
    expect(dash.body.unmappedDrugs).toEqual(expect.arrayContaining([expect.objectContaining({ code: d.code, display: 'New drug 100 mg' })]));
    const failed = dash.body.failed.find((f: { error: string }) => f.error.includes(d.code));
    expect(failed).toMatchObject({ direction: 'IN', type: 'MEDICATION_REQUEST', status: 'FAILED' });
    await c.pharmacist.post(`/hmis/messages/${failed.id}/reprocess`).expect(403);
    await c.admin.post(`/hmis/messages/${failed.id}/reprocess`).expect(200).expect((r) => expect(r.body.status).toBe('FAILED'));
    await mapDrug(d.code, d.genericId);
    const ok = await c.admin.post(`/hmis/messages/${failed.id}/reprocess`).expect(200);
    expect(ok.body).toMatchObject({ status: 'PROCESSED', localDocType: 'PRESCRIPTION' });
    expect(await rxFor(pt.hospitalNo, ids.OPD)).toHaveLength(1);
    await c.admin.post(`/hmis/messages/${failed.id}/reprocess`).expect(409);
  });

  it('HMIS down: dispense records and charges wait in the retry queue and go out once when it is back', async () => {
    const d = await drug(ids.OPD);
    await mapDrug(d.code, d.genericId);
    const pt = hmisPatient('AMB');
    mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', lines: [{ code: d.code, quantity: 5 }] });
    await sync();
    const [row] = await rxFor(pt.hospitalNo, ids.OPD);
    await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/verify`).expect(200);
    const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${row.id}`).expect(200)).body;
    mock.failure = { mode: 'offline', count: 1000 };
    const res = await c['pharm.tech'].post(`/pharmacy/prescriptions/${row.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: d.itemId, quantity: 5 }] }).expect(201);
    expect(res.body.status).toBe('DISPENSED'); // the pharmacy is never held up by the HMIS
    expect(res.body.charges[0].status).toBe('PENDING');
    const pending = await q(`SELECT status, attempts, error FROM hmis_message WHERE local_doc_id = $1`, [res.body.dispenseId]);
    expect(pending).toHaveLength(2);
    expect(pending.every((m: { status: string; attempts: number; error: string }) => m.status === 'PENDING' && m.attempts >= 1 && /Network error/.test(m.error))).toBe(true);
    // Repeated dispatching while down sends nothing.
    await q(`UPDATE hmis_message SET next_attempt_at = now() WHERE local_doc_id = $1`, [res.body.dispenseId]);
    await sync();
    expect(forPatient('ChargeItem', pt.pid)).toHaveLength(0);

    mock.failure = null;
    await q(`UPDATE hmis_message SET next_attempt_at = now() WHERE local_doc_id = $1`, [res.body.dispenseId]);
    await sync();
    await sync();
    expect(forPatient('ChargeItem', pt.pid)).toHaveLength(1);
    expect(forPatient('MedicationDispense', pt.pid)).toHaveLength(1);
    expect((await c.pharmacist.get(`/pharmacy/prescriptions/${row.id}`).expect(200)).body.charges[0].status).toBe('POSTED');
    // A business rejection fails at once and shows on the dashboard; reprocess resends.
    const d2 = await drug(ids.OPD);
    await mapDrug(d2.code, d2.genericId);
    mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', lines: [{ code: d2.code, quantity: 1 }] });
    await sync();
    const r2 = (await rxFor(pt.hospitalNo, ids.OPD)).find((x) => x.status === 'RECEIVED')!;
    await c.pharmacist.post(`/pharmacy/prescriptions/${r2.id}/verify`).expect(200);
    const rx2 = (await c.pharmacist.get(`/pharmacy/prescriptions/${r2.id}`).expect(200)).body;
    mock.failure = { mode: 'http400', count: 2 };
    const res2 = await c['pharm.tech'].post(`/pharmacy/prescriptions/${r2.id}/dispense`, { lines: [{ prescriptionLineId: rx2.lines[0].id, itemId: d2.itemId, quantity: 1 }] }).expect(201);
    const failed = await q(`SELECT id, status, http_status FROM hmis_message WHERE local_doc_id = $1 ORDER BY created_at`, [res2.body.dispenseId]);
    expect(failed.map((m: { status: string; http_status: number }) => [m.status, m.http_status])).toEqual([['FAILED', 400], ['FAILED', 400]]);
    for (const m of failed) await c.admin.post(`/hmis/messages/${m.id}/reprocess`).expect(200);
    expect((await q(`SELECT status FROM hmis_message WHERE local_doc_id = $1`, [res2.body.dispenseId])).map((m: { status: string }) => m.status)).toEqual(['SENT', 'SENT']);
  });

  it('billing mode LOCAL: the dispense is invoiced here (one charge, invoiced) and only the dispense record goes to the HMIS', async () => {
    await c.admin.put('/hmis/connection', { name: 'Test HMIS', adapter: 'MOCK', billingMode: 'LOCAL' }).expect(200);
    try {
      const d = await drug(ids.OPD, { price: 15 });
      await mapDrug(d.code, d.genericId);
      const pt = hmisPatient('AMB');
      mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-OPD', lines: [{ code: d.code, quantity: 4 }] });
      await sync();
      const [row] = await rxFor(pt.hospitalNo, ids.OPD);
      await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/verify`).expect(200);
      const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${row.id}`).expect(200)).body;
      const res = await c['pharm.tech'].post(`/pharmacy/prescriptions/${row.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: d.itemId, quantity: 4 }], payments: [{ modeCode: 'CASH', amount: 60 }] }).expect(201);
      expect(res.body.invoices).toEqual([expect.objectContaining({ docType: 'INVOICE', totalAmount: 60 })]);
      expect(res.body.charges).toEqual([expect.objectContaining({ quantity: 4, amount: 60, status: 'INVOICED' })]);
      expect(forPatient('MedicationDispense', pt.pid)).toHaveLength(1);
      expect(forPatient('ChargeItem', pt.pid)).toHaveLength(0);
      // Return: credit note here; the charge is reversed as invoiced; the HMIS dispense record is updated.
      const r = await c['pharm.tech'].post(`/pharmacy/dispenses/${res.body.dispenseId}/returns`, { lines: [{ prescriptionLineId: rx.lines[0].id, quantity: 1 }], reason: 'Unused' }).expect(201);
      expect(r.body.charges.find((x: { quantity: number }) => x.quantity === -1)).toMatchObject({ amount: -15, status: 'INVOICED' });
      expect(forPatient('MedicationDispense', pt.pid)[0]).toMatchObject({ quantity: { value: 3 } });
      expect(forPatient('ChargeItem', pt.pid)).toHaveLength(0);
    } finally {
      await c.admin.put('/hmis/connection', { name: 'Test HMIS', adapter: 'MOCK', billingMode: 'HMIS' }).expect(200);
    }
  });

  describe('inpatients: daily supply on the ward round, ward consumables and consumables issued against the admission', () => {
    let d: Awaited<ReturnType<typeof drug>>;
    let pt: ReturnType<typeof hmisPatient>;
    let encounterId: string;

    beforeAll(async () => {
      d = await drug(ids.IPD, { price: 5 });
      await mapDrug(d.code, d.genericId);
      pt = hmisPatient('IMP', 'T-MED');
      mock.prescribe({ patient: pt.pid, encounter: pt.eid, location: 'T-IPD', lines: [{ code: d.code, dose: 2, doseUnit: 'tab', frequency: 'TDS', durationDays: 5, supplyMode: 'DAILY' }] });
      await sync();
      encounterId = (await one(`SELECT id FROM encounter WHERE external_id = $1`, [pt.eid])).id;
    });

    it('the admission is cached with ward and bed; the ward round lists what is due today and dispenses it', async () => {
      const enc = (await c['ward.incharge'].get(`/hmis/encounters/${encounterId}`).expect(200)).body;
      expect(enc).toMatchObject({ class: 'IPD', status: 'ACTIVE', bed: 'B-7', department: expect.objectContaining({ id: ids.med }) });
      const list = await c.pharmacist.get(`/pharmacy/ward-supply?storeId=${ids.IPD}&departmentId=${ids.med}`).expect(200);
      const mine = list.body.patients.find((x: { hospitalNo: string }) => x.hospitalNo === pt.hospitalNo);
      expect(mine).toMatchObject({ ward: 'Medical Ward', bed: 'B-7' });
      expect(mine.lines).toEqual([expect.objectContaining({ dailyQuantity: 6, remaining: 30, givenToday: 0, due: 6, needsVerification: true, supplyMode: 'DAILY' })]);
      const line = mine.lines[0];
      await c['pharm.tech'].get(`/pharmacy/ward-supply?storeId=${ids.IPD}`).expect(403); // not their outlet
      await c.pharmacist.post(`/pharmacy/prescriptions/${line.prescriptionId}/verify`).expect(200);
      const round = await c.pharmacist.post('/pharmacy/ward-supply', { storeId: ids.IPD, lines: [{ prescriptionLineId: line.prescriptionLineId, itemId: d.itemId, quantity: 6 }] }).expect(200);
      expect(round.body).toMatchObject({ dispensed: 1, failed: 0 });
      const after = (await c.pharmacist.get(`/pharmacy/ward-supply?storeId=${ids.IPD}&departmentId=${ids.med}`).expect(200)).body.patients.find((x: { hospitalNo: string }) => x.hospitalNo === pt.hospitalNo);
      expect(after.lines[0]).toMatchObject({ givenToday: 6, due: 0, remaining: 24 });
      expect(forPatient('ChargeItem', pt.pid).map((x) => (x.priceOverride as { value: number }).value)).toEqual([30]);
      // A second round today finds nothing more due; asking for more than is left is refused per prescription.
      const over = await c.pharmacist.post('/pharmacy/ward-supply', { storeId: ids.IPD, lines: [{ prescriptionLineId: line.prescriptionLineId, itemId: d.itemId, quantity: 25 }] }).expect(200);
      expect(over.body).toMatchObject({ dispensed: 0, failed: 1 });
      expect(over.body.results[0].error).toMatch(/only 24 left/);
    });

    it('ward staff charge ward-stock consumables to the admission (own ward only); charges can be reversed', async () => {
      const gloves = (await c.admin.post('/items', { categoryId: ids.supGen, name: `Gloves ${uniq('s')}`, baseUomId: ids.pcs, unitPrice: 20, taxCategoryId: ids.exempt, isBatchTracked: false }).expect(201)).body;
      const body = { encounterId, departmentId: ids.med, storeId: ids.MS, lines: [{ itemId: gloves.id, quantity: 3 }], note: 'Dressing' };
      await c['surg.incharge'].post('/patient-charges/ward-consumption', { ...body }).expect(403); // another ward
      await c.pharmacist.post('/patient-charges/ward-consumption', body).expect(403); // MS is not one of their stores, not their ward
      const charged = await c['ward.nurse'].post('/patient-charges/ward-consumption', body).expect(201);
      expect(charged.body).toEqual([expect.objectContaining({ source: 'WARD_CONSUMPTION', quantity: 3, amount: 60, status: 'POSTED' })]);
      expect(forPatient('ChargeItem', pt.pid).map((x) => (x.priceOverride as { value: number }).value).sort((x, y) => x - y)).toEqual([30, 60]);
      const rev = await c['ward.incharge'].post(`/patient-charges/${charged.body[0].id}/reverse`, { quantity: 1, reason: 'One pair not used' }).expect(201);
      expect(rev.body.map((x: { quantity: number; status: string }) => [x.quantity, x.status])).toEqual([[3, 'POSTED'], [-1, 'POSTED']]);
      await c['ward.incharge'].post(`/patient-charges/${charged.body[0].id}/reverse`, { quantity: 3, reason: 'Too much' }).expect(400);
      const list = await c['ward.incharge'].get(`/patient-charges?encounterId=${encounterId}`).expect(200);
      expect(list.body.total).toBe(3);
    });

    it('consumables requested for the admission are charged when the store issues them', async () => {
      const item = (await c.admin.post('/items', { categoryId: ids.supGen, name: `Cannula ${uniq('s')}`, baseUomId: ids.pcs, unitPrice: 50, taxCategoryId: ids.exempt, isBatchTracked: false }).expect(201)).body;
      await c.scm.post('/inventory/receipts', { storeId: ids.MS, type: 'OPENING', lines: [{ itemId: item.id, quantity: 10, unitCost: 20 }] }).expect(201);
      const sr = await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.med, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 2, encounterId }], submit: true }).expect(201);
      expect(sr.body.lines[0]).toMatchObject({ encounterId, patientRef: `${pt.hospitalNo} / ${pt.eid}` });
      await approve(sr.body.id, 'ward.incharge');
      const iv = await c.storekeeper.post(`/store-requisitions/${sr.body.id}/issues`, {}).expect(201);
      const charges = await q(`SELECT source, quantity::float, amount::float, status FROM patient_charge WHERE source_id = $1`, [iv.body.id]);
      expect(charges).toEqual([{ source: 'ISSUE', quantity: 2, amount: 100, status: 'POSTED' }]);
      expect(forPatient('ChargeItem', pt.pid).map((x) => (x.priceOverride as { value: number }).value).sort((x, y) => x - y)).toEqual([-20, 30, 60, 100]);
      // A closed encounter takes no more requisitions.
      await q(`UPDATE encounter SET status = 'FINISHED' WHERE id = $1`, [encounterId]);
      await c['ward.nurse'].post('/store-requisitions', { departmentId: ids.med, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 1, encounterId }] }).expect(400);
      await c['ward.nurse'].post('/patient-charges/ward-consumption', { encounterId, departmentId: ids.med, storeId: ids.MS, lines: [{ itemId: item.id, quantity: 1 }] }).expect(409);
    });
  });

  it('logs every message in and out, filterable, with the dashboard summarising the queue', async () => {
    const outs = await c.pharmacist.get('/hmis/messages?direction=OUT&type=CHARGE&status=SENT&pageSize=200').expect(200);
    expect(outs.body.total).toBeGreaterThan(5);
    const m = await c.pharmacist.get(`/hmis/messages/${outs.body.items[0].id}`).expect(200);
    expect(m.body).toMatchObject({ direction: 'OUT', type: 'CHARGE', request: expect.objectContaining({ resourceType: 'ChargeItem' }), response: expect.objectContaining({ id: expect.any(String) }), httpStatus: expect.any(Number) });
    await c['ward.nurse'].get('/hmis/messages').expect(200);
    await c.storekeeper.get('/hmis/messages').expect(403);
    const dash = await c.pharmacist.get('/hmis/dashboard').expect(200);
    expect(dash.body.connection).toMatchObject({ adapter: 'MOCK', lastPolledAt: expect.any(String) });
    expect(dash.body.counts).toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'OUT', status: 'SENT' })]));
    const assumptions = await c.pharmacist.get('/hmis/assumptions').expect(200);
    expect(assumptions.body.length).toBeGreaterThan(10);
  });

  it('alerts integration admins once about failed messages', async () => {
    await q(`UPDATE hmis_message SET created_at = created_at - interval '2 hours' WHERE status = 'FAILED'`);
    const run = await c.admin.post('/jobs/hmis.monitor/run', {}).expect(200);
    expect(run.body.run.result).toMatchObject({ overdue: expect.any(Number), alerted: expect.any(Number) });
    const again = await c.admin.post('/jobs/hmis.monitor/run', {}).expect(200);
    expect(again.body.run.result).toMatchObject({ overdue: 0 });
  });
});

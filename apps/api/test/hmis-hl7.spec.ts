import request from 'supertest';
import { mllpTransport } from '../src/modules/hmis/hl7-adapter';
import { readAck } from '../src/modules/hmis/hl7';
import { sharedMockHl7 as peer } from '../src/modules/hmis/mock/mock-hmis';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';
import { seg } from './hl7-fixtures';

const PORT = 20_000 + Math.floor(Math.random() * 20_000);
process.env.HL7_MLLP_PORT = String(PORT);

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('HMIS over HL7 v2 (MLLP and HTTP)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  let key: string;
  let drug: { genericId: string; itemId: string; code: string };
  const pid = uniq('P').toLowerCase();
  const mrn = uniq('MRN');
  const visit = uniq('V');
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const msh = (type: string, ctl: string) => `MSH|^~\\&|HMIS|KNH|SIL-PIS|SIL|20261026101500+0300||${type}|${ctl}|P|2.5.1`;
  const PID = () => `PID|1||${pid}^^^HMIS^PI~${mrn}^^^SIL^MR||Wekesa^Grace||19880203|F`;
  const PV1 = () => seg('PV1', { 1: '1', 2: 'I', 3: 'T7-MED^^B-3', 19: visit });
  const rde = (ctl: string, order: string, code: string, extra: Record<number, string> = {}) =>
    [msh('RDE^O11^RDE_O11', ctl), PID(), PV1(), `ORC|NW|${order}|||||||20261026100000|||KMPDC-1^Ouma^Ken`, seg('RXE', { 2: `${code}^Test drug`, 3: '1', 5: 'tab', 40: 'T7-IPD', 45: 'DAILY', ...extra }), 'TQ1|1||BD|||5^d'].join('\r');
  const http = (body: string, k: string | null = key) => {
    const r = request(ctx.app.getHttpServer()).post(`${API}/integration/hmis/hl7`).set('content-type', 'application/hl7-v2');
    return (k ? r.set('x-api-key', k) : r).send(body);
  };
  const mllp = async (msg: string) => {
    const r = await mllpTransport('127.0.0.1', PORT)(msg, 5000);
    if (r.error) throw new Error(r.error);
    return readAck(r.reply!);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    peer.reset();
    for (const u of ['admin', 'scm', 'pharmacist']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      IPD: await idByCode(ctx.ds, 'store', 'IPD-PH'),
      med: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      cat: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
    });
    const badUrl = await c.admin.put('/hmis/connection', { name: 'HL7 HMIS', adapter: 'HL7', baseUrl: 'http://x', billingMode: 'HMIS' });
    expect(badUrl.status).toBe(400);
    const conn = await c.admin.put('/hmis/connection', { name: 'HL7 HMIS', adapter: 'HL7', baseUrl: 'mllp://mock', billingMode: 'HMIS', pollOrders: true }).expect(200);
    expect(conn.body).toMatchObject({ adapter: 'HL7', pollOrders: false });
    await c.admin.put('/hmis/mappings', { kind: 'WARD', externalCode: 'T7-MED', localId: ids.med }).expect(200);
    await c.admin.put('/hmis/mappings', { kind: 'LOCATION', externalCode: 'T7-IPD', localId: ids.IPD }).expect(200);
    const g = await c.admin.post('/generics', { innName: `Hl7mycin ${uniq('g')}`, strength: '10 mg', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
    const it = await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.cat, name: `Hl7mycin ${uniq('b')}`, baseUomId: ids.tab, unitPrice: 7, taxCategoryId: ids.exempt }).expect(201);
    await c.scm.post('/inventory/receipts', { storeId: ids.IPD, type: 'OPENING', lines: [{ itemId: it.body.id, batchNo: uniq('B'), expiryDate: day(300), quantity: 100, unitCost: 3 }] }).expect(201);
    drug = { genericId: g.body.id, itemId: it.body.id, code: uniq('HL7D') };
    await c.admin.put('/hmis/mappings', { kind: 'DRUG', externalCode: drug.code, localId: drug.genericId }).expect(200);
    const pharmacistId = (await one(`SELECT id FROM app_user WHERE username = 'pharmacist'`)).id;
    key = (await c.admin.post('/api-clients', { name: 'HL7 HMIS', userId: pharmacistId, scopes: ['hmis'] }).expect(201)).body.apiKey;
  });

  afterAll(async () => {
    await q(`UPDATE hmis_connection SET is_active = false`);
    peer.reset();
    await ctx.close();
  });

  it('ADT over HTTP: the patient (with allergies) and the admission are cached; the reply is an ACK', async () => {
    const adt = [msh('ADT^A01^ADT_A01', uniq('A')), PID(), PV1(), 'AL1|1|DA|^Sulfonamides', 'IN1|1|P1|CASHPLAN'].join('\r');
    await http(adt, null).expect(401);
    const res = await http(adt).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/hl7-v2/);
    expect(readAck(res.text)).toMatchObject({ ok: true, code: 'AA' });
    expect(await one(`SELECT hospital_no, name, sex, allergies FROM patient WHERE external_id = $1`, [pid])).toEqual({ hospital_no: mrn, name: 'Grace Wekesa', sex: 'F', allergies: ['sulfonamides'] });
    expect(await one(`SELECT class, bed, department_id FROM encounter WHERE external_id = $1`, [visit])).toEqual({ class: 'IPD', bed: 'B-3', department_id: ids.med });
    expect(readAck((await http('not hl7 at all').expect(200)).text)).toMatchObject({ ok: false, code: 'AR' });
    // Patient search needs a queryable HMIS.
    await c.pharmacist.get('/hmis/patients/search?q=Grace').expect(400);
  });

  it('RDE over MLLP becomes a daily-supply prescription; a resent message is not applied twice; an unmapped code is answered AE', async () => {
    const message = rde(uniq('R'), uniq('ORD'), drug.code);
    expect(await mllp(message)).toMatchObject({ ok: true, code: 'AA' });
    expect(await mllp(message)).toMatchObject({ ok: true }); // resent: recognised by its control id
    const w = await c.pharmacist.get(`/pharmacy/prescriptions?storeId=${ids.IPD}&search=${mrn}`).expect(200);
    expect(w.body.items).toHaveLength(1);
    const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${w.body.items[0].id}`).expect(200)).body;
    expect(rx).toMatchObject({ supplyMode: 'DAILY', prescriber: 'Dr. Ken Ouma', encounter: expect.objectContaining({ externalId: visit }) });
    expect(rx.lines[0]).toMatchObject({ dailyQuantity: 2, quantity: 10, hmisDrugCode: drug.code });
    const bad = await mllp(rde(uniq('R'), uniq('ORD'), 'NO-SUCH-CODE'));
    expect(bad).toMatchObject({ ok: false, code: 'AE', text: expect.stringMatching(/Unmapped drug code NO-SUCH-CODE/) });
    // Logged with the raw message for the dashboard.
    const msg = await one(`SELECT status, via, payload->>'hl7' AS hl7 FROM hmis_message WHERE error LIKE 'Unmapped drug code NO-SUCH-CODE%' ORDER BY created_at DESC LIMIT 1`);
    expect(msg).toMatchObject({ status: 'FAILED', via: 'MLLP', hl7: expect.stringMatching(/^MSH\|/) });
  });

  it('dispensing sends RDS^O13 and DFT^P03 over MLLP; AE is retried, AR fails and shows on the dashboard', async () => {
    const [row] = (await c.pharmacist.get(`/pharmacy/prescriptions?storeId=${ids.IPD}&search=${mrn}`).expect(200)).body.items;
    await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/verify`).expect(200);
    const rx = (await c.pharmacist.get(`/pharmacy/prescriptions/${row.id}`).expect(200)).body;
    const d = await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: drug.itemId, quantity: 2 }] }).expect(201);
    expect(d.body.charges[0]).toMatchObject({ status: 'POSTED', amount: 14 });
    const mine = peer.received.filter((m) => m.includes(pid));
    expect(mine.map((m) => /\|(RDS\^O13|DFT\^P03)/.exec(m)?.[1])).toEqual(['RDS^O13', 'DFT^P03']);
    expect(mine[0]).toContain(`ORC|RE|${rx.lines[0].externalRef}|`);
    expect(mine[1]).toMatch(/FT1\|1\|[^|]+\|[^|]*\|[^|]*\|\|CG\|/);

    peer.failure = { mode: 'AE', count: 1 };
    const d2 = await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: drug.itemId, quantity: 1 }] }).expect(201);
    const after = await q(`SELECT type, status, error FROM hmis_message WHERE local_doc_id = $1 ORDER BY type::text DESC`, [d2.body.dispenseId]);
    expect(after.map((m: { type: string; status: string }) => [m.type, m.status])).toEqual([['MEDICATION_DISPENSE', 'PENDING'], ['CHARGE', 'SENT']]);
    expect(after[0].error).toMatch(/ACK AE/);
    await q(`UPDATE hmis_message SET next_attempt_at = now() WHERE local_doc_id = $1`, [d2.body.dispenseId]);
    await c.admin.post('/hmis/sync').expect(200);
    expect((await one(`SELECT status FROM hmis_message WHERE local_doc_id = $1 AND type = 'MEDICATION_DISPENSE'`, [d2.body.dispenseId])).status).toBe('SENT');

    peer.failure = { mode: 'AR', count: 2 };
    const d3 = await c.pharmacist.post(`/pharmacy/prescriptions/${row.id}/dispense`, { lines: [{ prescriptionLineId: rx.lines[0].id, itemId: drug.itemId, quantity: 1 }] }).expect(201);
    const rejected = await q(`SELECT status FROM hmis_message WHERE local_doc_id = $1`, [d3.body.dispenseId]);
    expect(rejected.map((m: { status: string }) => m.status)).toEqual(['FAILED', 'FAILED']);
    const dash = await c.pharmacist.get('/hmis/dashboard').expect(200);
    expect(dash.body.connection).toMatchObject({ adapter: 'HL7' });
    expect(dash.body.failed.some((f: { error: string }) => /ACK AR/.test(f.error))).toBe(true);
    const ping = await c.admin.post('/hmis/connection/test').expect(200);
    expect(ping.body).toMatchObject({ ok: true, detail: expect.stringMatching(/ACK AA/) });
  });
});

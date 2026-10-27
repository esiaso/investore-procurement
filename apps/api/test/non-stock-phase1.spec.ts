import request from 'supertest';
import { ApprovalActionType } from '@sil/shared';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { API, Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

/** Binary GET (PDFs). */
const bin = (c: Client, path: string) =>
  c.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

type Req = { id: string; number: string; status: string; estimatedTotal: number; lines: { id: string; lineType: string; status: string; purchaseRequisition: { id: string; number: string } | null; storeRequisition: { id: string; number: string } | null }[] };

describe('Non-stock procurement phase 1: approval engine, requisitions → purchase requisitions', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const pending = async (docId: string) => one(`SELECT * FROM approval_request WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId]);
  const approve = (who: string, requestId: string, status = 200) => c[who].post(`/approvals/${requestId}/approve`, {}).expect(status);

  const serviceLine = (over: Record<string, unknown> = {}) => ({ lineType: 'SERVICE', description: 'Service the theatre autoclave', quantity: 1, estimatedUnitCost: 45_000, glAccountId: ids.glRepairs, ...over });
  const goodsLine = (over: Record<string, unknown> = {}) => ({ lineType: 'NON_STOCK_GOODS', description: 'Office chairs, ergonomic', quantity: 4, uomId: ids.each, estimatedUnitCost: 12_500, glAccountId: ids.glFurniture, ...over });

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'ward.nurse', 'ward.incharge', 'surg.nurse', 'surg.incharge', 'mat.nurse', 'proc.officer', 'proc.manager', 'finance', 'accountant', 'finance.manager', 'scm', 'storekeeper']) c[u] = await loggedIn(ctx, u);
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      IPD_MED: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      IPD_SURG: await idByCode(ctx.ds, 'department', 'IPD-SURG'),
      MAT: await idByCode(ctx.ds, 'department', 'MAT'),
      PAED: await idByCode(ctx.ds, 'department', 'PAED'),
      ADMIN: await idByCode(ctx.ds, 'department', 'ADMIN'),
      SVC: await idByCode(ctx.ds, 'item_category', 'SVC'),
      glRepairs: await idByCode(ctx.ds, 'gl_account', '5110'),
      glFurniture: await idByCode(ctx.ds, 'gl_account', '1600'),
    });
    ids.each = (await one(`SELECT id FROM unit_of_measure WHERE code IN ('EA', 'PC', 'EACH') ORDER BY code LIMIT 1`))?.id ?? (await one(`SELECT id FROM unit_of_measure LIMIT 1`)).id;
    ids.stockItem = (await one(`SELECT item_id FROM stock_balance WHERE store_id = $1 AND on_hand > 50 ORDER BY on_hand DESC LIMIT 1`, [ids.MS])).item_id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('finance master data', () => {
    it('everyone reads GL accounts and projects; finance maintains them, currencies and rates', async () => {
      const gl = (await c['ward.nurse'].get('/gl-accounts?search=repairs').expect(200)).body;
      expect(gl.items.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['5100', '5110']));
      await c['ward.nurse'].post('/gl-accounts', { code: '5999', name: 'Sundry', type: 'EXPENSE' }).expect(403);
      const created = (await c.finance.post('/gl-accounts', { code: uniq('59'), name: 'Sundry expenses', type: 'EXPENSE' }).expect(201)).body;
      await c.finance.post('/gl-accounts', { code: created.code, name: 'Again', type: 'EXPENSE' }).expect(409);
      expect((await c['ward.nurse'].get('/projects?active=true').expect(200)).body.map((p: { code: string }) => p.code)).toContain('MAT-WING');
      await c.finance.post('/projects', { code: uniq('PRJ'), name: 'Generator replacement', startsOn: '2026-01-01', endsOn: '2025-12-31' }).expect(400);
      const cur = (await c.finance.get('/currencies').expect(200)).body;
      expect(cur.find((x: { code: string }) => x.code === 'KES')).toMatchObject({ isBase: true, latestRate: 1 });
      expect(cur.find((x: { code: string }) => x.code === 'USD').latestRate.rate).toBeGreaterThan(100);
      await c.finance.put('/exchange-rates', { currencyCode: 'KES', rateDate: '2026-10-01', rate: 1 }).expect(400);
      await c['ward.nurse'].put('/exchange-rates', { currencyCode: 'USD', rateDate: '2026-10-01', rate: 129 }).expect(403);
      await c.finance.put('/exchange-rates', { currencyCode: 'USD', rateDate: '2026-01-02', rate: 128.5, source: 'CBK' }).expect(200);
    });
  });

  describe('staff requisition → store requisition and purchase requisition', () => {
    let req: Req;
    let other: Req;
    let prId: string;

    it('validates lines: stock lines need an item and a store, non-stock lines a description and cost', async () => {
      const base = { departmentId: ids.IPD_MED, justification: 'Ward needs for the quarter' };
      await c['ward.nurse'].post('/staff-requisitions', { ...base, lines: [{ lineType: 'STOCK', quantity: 5 }], storeId: ids.MS }).expect(400);
      await c['ward.nurse'].post('/staff-requisitions', { ...base, lines: [{ lineType: 'STOCK', itemId: ids.stockItem, quantity: 5 }] }).expect(400); // no store
      await c['ward.nurse'].post('/staff-requisitions', { ...base, lines: [{ lineType: 'SERVICE', quantity: 1, estimatedUnitCost: 10 }] }).expect(400); // no description
      await c['ward.nurse'].post('/staff-requisitions', { ...base, lines: [{ lineType: 'SERVICE', description: 'x', quantity: 1 }] }).expect(400); // no cost
      await c.storekeeper.get('/staff-requisitions/queue').expect(403);
    });

    it('a ward raises a mixed requisition; the head of department approves it; stock lines go to the store', async () => {
      const created = (
        await c['ward.nurse']
          .post('/staff-requisitions', {
            departmentId: ids.IPD_MED,
            storeId: ids.MS,
            priority: 'URGENT',
            justification: 'Autoclave out of service; new chairs for the nurses station; gloves',
            lines: [{ lineType: 'STOCK', itemId: ids.stockItem, quantity: 10 }, serviceLine(), goodsLine()],
          })
          .expect(201)
      ).body as Req;
      expect(created.number).toMatch(/^REQ-\d{4}(\/\d{2})?-\d{5}$/);
      expect(created).toMatchObject({ status: 'DRAFT' });
      expect(created.estimatedTotal).toBeGreaterThan(45_000 + 50_000);
      req = (await c['ward.nurse'].post(`/staff-requisitions/${created.id}/submit`).expect(200)).body;
      expect(req.status).toBe('SUBMITTED');
      const ar = await pending(req.id);
      expect(ar).toMatchObject({ status: 'PENDING', document_type: 'REQ' });

      await approve('ward.nurse', ar.id, 403); // own document
      await approve('surg.incharge', ar.id, 403); // head of another department
      expect((await c['ward.incharge'].get('/approvals/inbox').expect(200)).body.map((i: { documentId: string }) => i.documentId)).toContain(req.id);
      await approve('ward.incharge', ar.id);

      req = (await c['ward.nurse'].get(`/staff-requisitions/${req.id}`).expect(200)).body;
      expect(req.status).toBe('PARTLY_CONVERTED');
      const stock = req.lines.find((l) => l.lineType === 'STOCK')!;
      expect(stock).toMatchObject({ status: 'TO_STORE', storeRequisition: { number: expect.stringMatching(/^SR/) } });
      expect(req.lines.filter((l) => l.lineType !== 'STOCK').every((l) => l.status === 'OPEN')).toBe(true);
      const sr = await one(`SELECT status, requested_by FROM store_requisition WHERE id = $1`, [stock.storeRequisition!.id]);
      expect(sr.status).toBe('APPROVED');
      expect((await c.storekeeper.get(`/store-requisitions/${stock.storeRequisition!.id}`).expect(200)).body.lines).toHaveLength(1);
      // The requester was told.
      const told = await q(`SELECT n.title, n.body FROM notification n JOIN app_user u ON u.id = n.user_id WHERE u.username = 'ward.nurse' AND n.title LIKE $1 ORDER BY n.title`, [`${req.number}%`]);
      expect(told).toEqual([
        { title: `${req.number} approved`, body: null },
        { title: `${req.number}: next steps`, body: '1 stock item(s) sent to the store; 2 line(s) passed to procurement' },
      ]);
    });

    it('another department’s approved service line joins the procurement queue', async () => {
      const r = (await c['surg.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_SURG, justification: 'Theatre lights need servicing', lines: [serviceLine({ description: 'Service theatre lights' })], submit: true }).expect(201)).body as Req;
      await approve('surg.incharge', (await pending(r.id)).id);
      other = (await c['surg.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body;
      expect(other.status).toBe('APPROVED');
      const queue = (await c['proc.officer'].get('/staff-requisitions/queue?pageSize=200').expect(200)).body;
      const mine = queue.items.filter((i: { requisitionId: string }) => [req.id, other.id].includes(i.requisitionId));
      expect(mine).toHaveLength(3);
      expect(mine.find((i: { description: string }) => i.description === 'Office chairs, ergonomic')).toMatchObject({ glCode: '1600', department: expect.any(String), estimatedTotal: 50_000 });
    });

    it('procurement consolidates lines from both departments into one purchase requisition', async () => {
      const lineIds = [...req.lines.filter((l) => l.lineType !== 'STOCK').map((l) => l.id), other.lines[0].id];
      await c['ward.nurse'].post('/staff-requisitions/consolidate', { lineIds, departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Quarterly services and furniture' }).expect(403);
      await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: [req.lines.find((l) => l.lineType === 'STOCK')!.id], departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Wrong line' }).expect(400);
      const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds, departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Quarterly services and furniture', sourcingMethod: 'RFQ' }).expect(201)).body;
      prId = pr.id;
      expect(pr).toMatchObject({ status: 'DRAFT', priority: 'URGENT', estimatedTotal: 45_000 + 50_000 + 45_000 });
      expect(pr.lines).toHaveLength(3);
      expect(pr.lines.every((l: { sourceRequisitionLineId: string; itemId: string | null }) => l.sourceRequisitionLineId && l.itemId === null)).toBe(true);
      expect(pr.lines.map((l: { lineType: string }) => l.lineType).sort()).toEqual(['NON_STOCK_GOODS', 'SERVICE', 'SERVICE']);
      // Each line can only be consolidated once.
      await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: [lineIds[0]], departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Again' }).expect(409);
      req = (await c['ward.nurse'].get(`/staff-requisitions/${req.id}`).expect(200)).body;
      expect(req.status).toBe('CONVERTED');
      expect(req.lines.find((l) => l.lineType === 'SERVICE')).toMatchObject({ status: 'ON_PR', purchaseRequisition: { id: prId } });
      // One document chain: REQ → SR and REQ → PR.
      const chain = (await c['proc.officer'].get(`/documents/chain?type=REQ&id=${req.id}`).expect(200)).body;
      expect(chain.nodes.map((n: { type: string }) => n.type)).toEqual(expect.arrayContaining(['REQ', 'SR', 'PR']));
    });

    it('the purchase requisition goes through its own approval; non-stock lines cannot go on a stock RFQ yet', async () => {
      await c['proc.officer'].put(`/requisitions/${prId}`, { departmentId: ids.ADMIN, storeId: ids.MS, justification: 'x', lines: [{ itemId: ids.stockItem, quantity: 1 }] }).expect(409);
      await c['proc.officer'].post(`/requisitions/${prId}/submit`).expect(200);
      const ar = await pending(prId);
      expect(ar.document_type).toBe('PR');
      await approve('proc.manager', ar.id);
      // PR-2 band (100k–1M) needs supply chain approval too.
      await approve('scm', ar.id);
      expect((await c['proc.officer'].get(`/requisitions/${prId}`).expect(200)).body.status).toBe('APPROVED');
      const supplier = await one(`SELECT id FROM supplier WHERE status = 'ACTIVE' LIMIT 1`);
      const rfq = await c['proc.officer'].post('/rfqs', { requisitionId: prId, title: 'Services', closingDate: '2099-01-01', supplierIds: [supplier.id] }).expect(409);
      expect(rfq.body.code).toBe('NON_STOCK_LINES');
    });

    it('a cancelled purchase requisition puts its lines back in the queue', async () => {
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'Printer toner', lines: [goodsLine({ description: 'Printer toner', quantity: 2, estimatedUnitCost: 9_000, glAccountId: undefined })], submit: true }).expect(201)).body as Req;
      await approve('ward.incharge', (await pending(r.id)).id);
      const pr = (await c['proc.officer'].post('/staff-requisitions/consolidate', { lineIds: [r.lines[0].id], departmentId: ids.ADMIN, storeId: ids.MS, justification: 'Toner' }).expect(201)).body;
      expect((await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body.status).toBe('CONVERTED');
      await c['proc.officer'].post(`/requisitions/${pr.id}/cancel`).expect(200);
      const back = (await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body;
      expect(back).toMatchObject({ status: 'APPROVED', lines: [expect.objectContaining({ status: 'OPEN', purchaseRequisition: null })] });
    });

    it('blocks a requisition over a BLOCK budget and prints a PDF with the approvals', async () => {
      const budget = (await c.finance.post('/budgets', { departmentId: ids.IPD_MED, voteHead: uniq('SMALL').replace(/-/g, '_'), amount: 1_000, enforcement: 'BLOCK' }).expect(201)).body;
      await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, budgetId: budget.id, justification: 'Over budget', lines: [serviceLine()], submit: true }).expect(400);
      const pdf = await bin(c['ward.nurse'], `/staff-requisitions/${req.id}/pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await c['surg.nurse'].get(`/staff-requisitions/${req.id}`).expect(403); // another department
      await c['proc.officer'].get(`/staff-requisitions/${req.id}`).expect(200); // procurement sees all
    });
  });

  describe('approval engine', () => {
    const workflow = async (body: Record<string, unknown>) => (await c.admin.post('/approvals/workflows', { documentType: 'REQ', priority: 10, ...body }).expect(201)).body;
    const roleId = async (code: string) => (await one(`SELECT id FROM role WHERE code = $1`, [code])).id as string;

    it('a parallel level needs N different approvers before it moves on', async () => {
      await workflow({ code: uniq('REQ-MAT'), name: 'Maternity: two finance officers', departmentId: ids.MAT, steps: [{ name: 'Finance (2 of the team)', approverType: 'ROLE', roleId: await roleId('FINANCE'), minApprovals: 2 }] });
      const r = (await c['mat.nurse'].post('/staff-requisitions', { departmentId: ids.MAT, justification: 'Delivery beds servicing', lines: [serviceLine()], submit: true }).expect(201)).body;
      const ar = await pending(r.id);
      await approve('finance', ar.id);
      expect((await one(`SELECT status, current_step FROM approval_request WHERE id = $1`, [ar.id])).status).toBe('PENDING');
      await approve('finance', ar.id, 403); // the same person again
      expect((await c.accountant.get('/approvals/inbox').expect(200)).body.find((i: { id: string }) => i.id === ar.id)).toMatchObject({ approvalsAtStep: 1, minApprovals: 2 });
      await approve('accountant', ar.id);
      expect((await c['mat.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body.status).toBe('APPROVED');
      await c.admin.post('/approvals/workflows', { code: uniq('BAD'), name: 'x', documentType: 'REQ', steps: [{ name: 'x', approverType: 'USER', userId: (await one(`SELECT id FROM app_user WHERE username = 'finance'`)).id, minApprovals: 2 }] }).expect(400);
    });

    it('excluded users cannot approve (segregation of duties)', async () => {
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'SoD check', lines: [serviceLine()] }).expect(201)).body;
      const incharge = (await one(`SELECT id FROM app_user WHERE username = 'ward.incharge'`)).id;
      const nurse = (await one(`SELECT id FROM app_user WHERE username = 'ward.nurse'`)).id;
      const svc = ctx.app.get(ApprovalsService);
      await ctx.ds.transaction((m) => svc.start(m, { documentType: 'REQ', documentId: r.id, documentNo: r.number, amount: 45_000, departmentId: ids.IPD_MED, requestedBy: nurse, excludeUserIds: [incharge] }));
      const ar = await pending(r.id);
      expect((await c['ward.incharge'].get('/approvals/inbox').expect(200)).body.find((i: { id: string }) => i.id === ar.id)).toBeUndefined();
      const res = await approve('ward.incharge', ar.id, 403);
      expect(res.body.message).toMatch(/segregation of duties/);
    });

    it('reminds, then escalates a stalled approval to the escalation role', async () => {
      await workflow({
        code: uniq('REQ-PAED'),
        name: 'Paediatrics (no in-charge yet)',
        departmentId: ids.PAED,
        steps: [{ name: 'Head of department', approverType: 'DEPARTMENT_ROLE', roleId: await roleId('WARD_IN_CHARGE'), remindAfterHours: 1, escalateAfterHours: 2, escalateToRoleId: await roleId('SUPPLY_CHAIN_MANAGER') }],
      });
      const r = (await c['proc.officer'].post('/staff-requisitions', { departmentId: ids.PAED, justification: 'Cots repair', lines: [serviceLine()], submit: true }).expect(201)).body;
      const ar = await pending(r.id);
      await approve('scm', ar.id, 403); // not yet escalated
      const svc = ctx.app.get(ApprovalsService);
      await q(`UPDATE approval_request SET step_started_at = now() - interval '90 minutes' WHERE id = $1`, [ar.id]);
      expect(await svc.escalate()).toMatchObject({ reminded: 1 });
      expect(await svc.escalate()).toMatchObject({ reminded: 0, escalated: 0 }); // once per step
      await q(`UPDATE approval_request SET step_started_at = now() - interval '3 hours' WHERE id = $1`, [ar.id]);
      expect(await svc.escalate()).toMatchObject({ escalated: 1 });
      expect((await c.scm.get('/approvals/inbox').expect(200)).body.find((i: { id: string }) => i.id === ar.id)).toMatchObject({ escalated: true });
      await approve('scm', ar.id);
      const history = (await c.admin.get(`/approvals/history?type=REQ&id=${r.id}`).expect(200)).body;
      const actions = history[0].actions.map((a: { action: string; userName: string }) => `${a.action}:${a.userName === 'System' ? 'System' : 'user'}`);
      expect(actions).toEqual(['SUBMIT:user', 'REMIND:System', 'ESCALATE:System', 'APPROVE:user']);
      expect(history[0].actions.at(-1)).toMatchObject({ channel: 'IN_APP', ip: expect.any(String) });
    });

    it('approves once from the emailed link, without signing in', async () => {
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'Link approval', lines: [serviceLine()], submit: true }).expect(201)).body;
      const mail = await one(`SELECT body_text FROM email_outbox WHERE to_address = 'ward.incharge@hospital.example' AND subject = $1 ORDER BY created_at DESC LIMIT 1`, [`Approval needed: ${r.number}`]);
      const token = /\/approve\/([\w-]+)/.exec(mail.body_text)![1];
      const anon = request(ctx.app.getHttpServer());
      const info = (await anon.get(`${API}/approval-links/${token}`).expect(200)).body;
      expect(info).toMatchObject({ documentNo: r.number, approver: 'Akinyi Ward Sister', stepName: 'Head of department' });
      await anon.post(`${API}/approval-links/${token}`).send({ action: ApprovalActionType.REJECT }).expect(400); // comment needed
      const res = (await anon.post(`${API}/approval-links/${token}`).set('user-agent', 'Mail client').send({ action: ApprovalActionType.APPROVE }).expect(200)).body;
      expect(res.status).toBe('APPROVED');
      await anon.post(`${API}/approval-links/${token}`).send({ action: ApprovalActionType.APPROVE }).expect(410);
      await anon.get(`${API}/approval-links/not-a-token`).expect(404);
      const act = await one(`SELECT a.channel, a.user_agent FROM approval_action a JOIN approval_request q ON q.id = a.request_id WHERE q.document_id = $1 AND a.action = 'APPROVE'`, [r.id]);
      expect(act).toMatchObject({ channel: 'EMAIL_LINK', user_agent: 'Mail client' });
      expect((await c['ward.nurse'].get(`/staff-requisitions/${r.id}`).expect(200)).body.status).toBe('APPROVED');
    });

    it('editing a workflow with documents in approval keeps their version', async () => {
      const r = (await c['ward.nurse'].post('/staff-requisitions', { departmentId: ids.IPD_MED, justification: 'Version check', lines: [serviceLine()], submit: true }).expect(201)).body;
      const ar = await pending(r.id);
      const wf = (await c.admin.get('/approvals/workflows').expect(200)).body.find((w: { id: string }) => w.id === ar.workflow_id);
      const edited = (await c.admin.put(`/approvals/workflows/${wf.id}`, { code: wf.code, name: wf.name, documentType: 'REQ', maxAmount: wf.maxAmount, steps: [{ name: 'Finance', approverType: 'ROLE', roleId: await roleId('FINANCE') }] }).expect(200)).body;
      expect(edited.id).not.toBe(wf.id);
      expect(edited.code).toBe(wf.code);
      expect(await one(`SELECT code, is_active FROM approval_workflow WHERE id = $1`, [wf.id])).toMatchObject({ code: `${wf.code}~v1`, is_active: false });
      // The pending document still follows the head-of-department step.
      await approve('ward.incharge', ar.id);
      // Put the default back for the rest of the suite.
      await c.admin.put(`/approvals/workflows/${edited.id}`, { code: wf.code, name: wf.name, documentType: 'REQ', maxAmount: wf.maxAmount, steps: [{ name: 'Head of department', approverType: 'DEPARTMENT_ROLE', roleId: await roleId('WARD_IN_CHARGE') }] }).expect(200);
    });
  });
});

import { StockTxnType, ValuationMethod } from '@sil/shared';
import { addMonths } from '../src/modules/forecasting/forecasting.service';
import { postMovements } from '../src/modules/inventory/posting';
import { financialYearOf } from '../src/modules/numbering/financial-year';
import { SettingsService } from '../src/modules/settings/settings.service';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

const day = (d = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + d * 86_400_000));

describe('Strategic procurement (acceptance)', () => {
  let ctx: TestContext;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  let fy: string;
  const q = async (sql: string, p: unknown[] = []) => ctx.ds.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const pending = async (docType: string, docId: string) =>
    one(`SELECT * FROM approval_request WHERE document_type = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1`, [docType, docId]);
  const approve = async (docType: string, docId: string, ...users: string[]) => {
    const req = await pending(docType, docId);
    for (const u of users) await c[u].post(`/approvals/${req.id}/approve`, {}).expect(200);
    expect((await one(`SELECT status FROM approval_request WHERE id = $1`, [req.id])).status).toBe('APPROVED');
  };
  const setSetting = (key: string, value: unknown) => q(`UPDATE system_setting SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);

  async function supplyItem(price = 50) {
    const it = await c.admin.post('/items', { categoryId: ids.supGen, name: `Strategic test item ${uniq('s')}`, baseUomId: ids.pcs, unitPrice: price, taxCategoryId: ids.exempt, isBatchTracked: false }).expect(201);
    return it.body as { id: string; name: string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const u of ['admin', 'scm', 'proc.officer', 'proc.manager', 'finance', 'management', 'ward.incharge', 'pharmacist', 'tender', 'quality', 'storekeeper', 'cashier', 'supplier', 'supplier2']) {
      c[u] = await loggedIn(ctx, u);
    }
    Object.assign(ids, {
      MS: await idByCode(ctx.ds, 'store', 'MS'),
      OPD: await idByCode(ctx.ds, 'store', 'OPD-PH'),
      ipd: await idByCode(ctx.ds, 'department', 'IPD-MED'),
      pharm: await idByCode(ctx.ds, 'department', 'PHARM'),
      supGen: await idByCode(ctx.ds, 'item_category', 'SUP-GEN'),
      antiinf: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      s1: (await one(`SELECT id FROM supplier WHERE code = 'SUP0001'`)).id,
      s2: (await one(`SELECT id FROM supplier WHERE code = 'SUP0002'`)).id,
      s3: (await one(`SELECT id FROM supplier WHERE code = 'SUP0003'`)).id,
    });
    for (const u of ['tender', 'admin', 'quality', 'storekeeper']) ids[u] = (await one(`SELECT id FROM app_user WHERE username = $1`, [u])).id;
    const settings = ctx.app.get(SettingsService);
    fy = financialYearOf(await settings.today(), await settings.get('finance.fyStartMonth')).label;
    // Two catalogue items of our own so no other suite's prices interfere.
    const a = await supplyItem();
    const b = await supplyItem();
    ids.itemA = a.id;
    ids.itemB = b.id;
    // A vote head per department for this financial year.
    ids.ipdVote = uniq('APP');
    ids.pharmVote = uniq('APP');
    await c.finance.post('/budgets', { departmentId: ids.ipd, voteHead: ids.ipdVote, financialYear: fy, amount: 5_000_000 }).expect(201);
    await c.finance.post('/budgets', { departmentId: ids.pharm, voteHead: ids.pharmVote, financialYear: fy, amount: 5_000_000 }).expect(201);
    // Two more evaluators for the committee (one will declare a conflict).
    await q(
      `INSERT INTO role_permission (role_id, permission_code) SELECT id, 'tenders.evaluate' FROM role WHERE code IN ('QUALITY_OFFICER', 'STOREKEEPER') ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM role_permission WHERE permission_code = 'tenders.evaluate' AND role_id IN (SELECT id FROM role WHERE code IN ('QUALITY_OFFICER', 'STOREKEEPER'))`);
    await setSetting('procurement.ppadaRuleSet', false);
    await ctx.close();
  });

  describe('annual procurement plan', () => {
    let planId: string;

    it('a department prepares its plan on its budget vote head; it goes through approval and is versioned', async () => {
      const lines = [
        { itemId: ids.itemA, quantity: 1000, estimatedUnitCost: 100, voteHead: ids.ipdVote, plannedQuarter: 1 },
        { itemId: ids.itemB, quantity: 1000, estimatedUnitCost: 100, voteHead: ids.ipdVote, plannedQuarter: 2 },
      ];
      // Not on a vote head this department has.
      await c['ward.incharge'].post('/procurement-plans', { financialYear: fy, departmentId: ids.ipd, title: 'x', lines: [{ ...lines[0], voteHead: ids.pharmVote }] }).expect(400);
      // Not another department's plan.
      await c['ward.incharge'].post('/procurement-plans', { financialYear: fy, departmentId: ids.pharm, title: 'x', lines }).expect(403);
      const plan = await c['ward.incharge'].post('/procurement-plans', { financialYear: fy, departmentId: ids.ipd, title: `IPD medical plan ${fy}`, lines }).expect(201);
      planId = plan.body.id;
      expect(plan.body).toMatchObject({ status: 'DRAFT', version: 1, totalEstimate: 200_000 });
      expect(plan.body.lines[0].sourcingMethod).toBe('RFQ'); // recommended for 100,000
      expect(plan.body.budgets).toEqual([expect.objectContaining({ vote_head: ids.ipdVote, planned: 200_000, budget: 5_000_000 })]);
      await c['ward.incharge'].post('/procurement-plans', { financialYear: fy, departmentId: ids.ipd, title: 'again', lines }).expect(409);

      await c['ward.incharge'].post(`/procurement-plans/${planId}/submit`).expect(200);
      await approve('APP', planId, 'proc.manager', 'finance', 'management');
      const approved = await c['ward.incharge'].get(`/procurement-plans/${planId}`).expect(200);
      expect(approved.body.status).toBe('APPROVED');
      expect(approved.body.versions).toEqual([expect.objectContaining({ version: 1 })]);
      await c['ward.incharge'].put(`/procurement-plans/${planId}`, { lines }).expect(409); // approved: revise instead

      // Mid-year revision: version 2 through approval, with the history kept.
      const revised = await c['ward.incharge'].post(`/procurement-plans/${planId}/revise`, { reason: 'Second medical ward opened', lines: [lines[0], { ...lines[1], quantity: 1500 }] }).expect(200);
      expect(revised.body).toMatchObject({ status: 'PENDING_APPROVAL', version: 2, totalEstimate: 250_000 });
      await approve('APP', planId, 'proc.manager', 'finance', 'management');
      const v2 = await c['ward.incharge'].get(`/procurement-plans/${planId}`).expect(200);
      expect(v2.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
      expect(v2.body.approvalHistory.filter((a: { action: string }) => a.action === 'APPROVE')).toHaveLength(6);
    });

    it('approved departmental plans consolidate into the hospital plan', async () => {
      const ph = await c.pharmacist
        .post('/procurement-plans', { financialYear: fy, departmentId: ids.pharm, title: `Pharmacy plan ${fy}`, lines: [{ itemId: ids.itemA, quantity: 500, estimatedUnitCost: 100, voteHead: ids.pharmVote, plannedQuarter: 3 }] })
        .expect(201);
      await c.pharmacist.post(`/procurement-plans/${ph.body.id}/submit`).expect(200);
      await approve('APP', ph.body.id, 'proc.manager', 'finance', 'management');

      await c['ward.incharge'].post('/procurement-plans/consolidate', { financialYear: fy }).expect(403);
      const hospital = await c.scm.post('/procurement-plans/consolidate', { financialYear: fy }).expect(200);
      expect(hospital.body).toMatchObject({ departmentId: null, status: 'DRAFT', totalEstimate: 300_000 });
      const lineA = hospital.body.lines.filter((l: { itemId: string }) => l.itemId === ids.itemA);
      expect(lineA).toHaveLength(2); // same item, different vote heads
      expect(hospital.body.lines.flatMap((l: { sourceDepartmentIds: string[] }) => l.sourceDepartmentIds)).toEqual(expect.arrayContaining([ids.ipd, ids.pharm]));
      for (const id of [planId, ph.body.id]) {
        const p = await c.scm.get(`/procurement-plans/${id}`).expect(200);
        expect(p.body).toMatchObject({ status: 'CONSOLIDATED', consolidatedIntoId: hospital.body.id });
      }
      ids.ipdPlan = planId;
    });
  });

  describe('sourcing methods', () => {
    it('recommends the method for the value and refuses direct procurement without a justification', async () => {
      const rec = await c['proc.officer'].get('/sourcing/recommend?amount=2000000').expect(200);
      expect(rec.body).toMatchObject({ method: expect.objectContaining({ code: 'OPEN_TENDER' }), frameworkAvailable: false });
      const pr = await c['ward.incharge'].post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Urgent', sourcingMethod: 'DIRECT', lines: [{ itemId: ids.itemB, quantity: 10, estimatedUnitPrice: 50 }] }).expect(201);
      const bad = await c['ward.incharge'].post(`/requisitions/${pr.body.id}/submit`).expect(400);
      expect(bad.body.code).toBe('SOURCING_METHOD');
      // Without a method the recommended one is recorded.
      const ok = await c['ward.incharge'].post('/requisitions', { departmentId: ids.ipd, storeId: ids.MS, justification: 'Routine', lines: [{ itemId: ids.itemB, quantity: 10, estimatedUnitPrice: 50 }] }).expect(201);
      const sub = await c['ward.incharge'].post(`/requisitions/${ok.body.id}/submit`).expect(200);
      expect(sub.body.sourcingMethod).toBe('LOW_VALUE');
    });
  });

  describe('tender → evaluation → award → contract → call-offs', () => {
    let tender: { id: string; number: string; lines: { id: string; itemId: string }[] };
    const bid: Record<string, string> = {};
    let crit: Record<string, string>;
    let contractId: string;
    let contractLines: { id: string; itemId: string }[];
    let poId: string;

    it('publishes an open tender and takes sealed bids from the portal and the bid register', async () => {
      const t = await c['proc.manager']
        .post('/tenders', {
          title: 'Supply of strategic test items',
          method: 'OPEN_TENDER',
          departmentId: ids.ipd,
          estimatedValue: 2_000_000,
          closingAt: new Date(Date.now() + 86_400_000).toISOString(),
          technicalWeight: 30,
          technicalPassMark: 50,
          lines: [
            { itemId: ids.itemA, quantity: 1000, specification: 'Spec A' },
            { itemId: ids.itemB, quantity: 1000, specification: 'Spec B' },
          ],
          criteria: [
            { stage: 'PRELIMINARY', name: 'Valid tax compliance certificate' },
            { stage: 'TECHNICAL', name: 'Compliance with specifications', weight: 60, maxScore: 10 },
            { stage: 'TECHNICAL', name: 'Delivery capacity', weight: 40, maxScore: 10 },
          ],
        })
        .expect(201);
      tender = t.body;
      expect(t.body).toMatchObject({ status: 'DRAFT', number: expect.stringMatching(/TND/) });
      crit = Object.fromEntries(t.body.criteria.map((x: { id: string; stage: string; weight: number }) => [x.stage === 'PRELIMINARY' ? 'p1' : x.weight === 60 ? 't1' : 't2', x.id]));
      // Weights must add up to 100; a method below its band is refused.
      await c['proc.manager'].post('/tenders', { ...t.body, title: 'x', criteria: [{ stage: 'TECHNICAL', name: 'a', weight: 50 }], lines: [{ itemId: ids.itemA, quantity: 1 }] }).expect(400);
      // Not visible in the portal while a draft.
      await c.supplier.get(`/portal/tenders/${tender.id}`).expect(404);
      await c['proc.manager'].post(`/tenders/${tender.id}/publish`).expect(200);

      const lineBid = (price: number) => ({ lines: tender.lines.map((l) => ({ tenderLineId: l.id, unitPrice: price })), deliveryDays: 7 });
      const b1 = await c.supplier.post(`/portal/tenders/${tender.id}/bid`, lineBid(100)).expect(201);
      expect(b1.body).toMatchObject({ totalPrice: 200_000, status: 'SUBMITTED' });
      bid.A = b1.body.id;
      bid.B = (await c.supplier2.post(`/portal/tenders/${tender.id}/bid`, lineBid(90)).expect(201)).body.id;
      bid.C = (await c['proc.manager'].post(`/tenders/${tender.id}/bids`, { supplierId: ids.s3, ...lineBid(80) }).expect(201)).body.id;
      await c.supplier.post(`/portal/tenders/${tender.id}/bid`, { lines: [{ tenderLineId: tender.lines[0].id, unitPrice: 1 }] }).expect(400); // every line priced

      // Sealed until opening: staff see who bid, not the prices; suppliers see only their own bid.
      const staff = await c['proc.manager'].get(`/tenders/${tender.id}`).expect(200);
      expect(staff.body.sealed).toBe(true);
      expect(staff.body.bids).toHaveLength(3);
      for (const b of staff.body.bids) {
        expect(b.totalPrice).toBeUndefined();
        expect(b.lines).toBeUndefined();
      }
      const mine = await c.supplier2.get(`/portal/tenders/${tender.id}`).expect(200);
      expect(mine.body.myBid.totalPrice).toBe(180_000);
      expect(JSON.stringify(mine.body)).not.toContain(bid.A);
      await c['proc.manager'].post(`/tenders/${tender.id}/open`, { attendees: ['Bidders present'] }).expect(409); // before closing
    });

    it('refuses late bids; opens the bids with minutes after closing', async () => {
      await q(`UPDATE tender SET closing_at = now() - interval '1 minute' WHERE id = $1`, [tender.id]);
      const late = await c.supplier2.post(`/portal/tenders/${tender.id}/bid`, { lines: tender.lines.map((l) => ({ tenderLineId: l.id, unitPrice: 70 })) }).expect(409);
      expect(late.body.code).toBe('LATE_BID');
      const opened = await c['proc.manager'].post(`/tenders/${tender.id}/open`, { attendees: ['Supplier representatives', 'Internal audit'], minutes: 'Three bids opened and read out.' }).expect(200);
      expect(opened.body).toMatchObject({ status: 'OPENED', sealed: false });
      expect(opened.body.opening.readouts.map((r: { totalPrice: number }) => r.totalPrice).sort()).toEqual([160_000, 180_000, 200_000]);
    });

    it('committee: conflict-of-interest declarations before scoring; a conflicted member cannot score', async () => {
      await c['proc.manager']
        .put(`/tenders/${tender.id}/committee`, { members: [{ userId: ids.tender, role: 'MEMBER' }, { userId: ids.admin, role: 'MEMBER' }] })
        .expect(400); // no chair
      const finUser = (await one(`SELECT id FROM app_user WHERE username = 'finance'`)).id;
      await c['proc.manager'].put(`/tenders/${tender.id}/committee`, { members: [{ userId: ids.tender, role: 'CHAIR' }, { userId: finUser, role: 'MEMBER' }] }).expect(400); // finance cannot evaluate
      await c['proc.manager']
        .put(`/tenders/${tender.id}/committee`, {
          members: [
            { userId: ids.tender, role: 'CHAIR' },
            { userId: ids.admin, role: 'MEMBER' },
            { userId: ids.quality, role: 'MEMBER' },
            { userId: ids.storekeeper, role: 'MEMBER' },
          ],
        })
        .expect(200);

      const s = (criterionId: string, bidId: string, score: number) => ({ criterionId, bidId, score });
      const early = await c.quality.post(`/tenders/${tender.id}/scores`, { scores: [s(crit.p1, bid.A, 1)] }).expect(403);
      expect(early.body.code).toBe('COI_REQUIRED');
      await c.storekeeper.post(`/tenders/${tender.id}/declaration`, { hasConflict: true, declaration: 'My brother works for one of the bidders' }).expect(201);
      await c.storekeeper.post(`/tenders/${tender.id}/scores`, { scores: [s(crit.p1, bid.A, 1)] }).expect(403);
      for (const u of ['tender', 'admin', 'quality']) await c[u].post(`/tenders/${tender.id}/declaration`, { hasConflict: false, declaration: 'I have no conflict of interest' }).expect(201);
      await c.quality.post(`/tenders/${tender.id}/declaration`, { hasConflict: false, declaration: 'Again and again' }).expect(409);

      // Preliminary: A passes, B passes by majority, C fails by majority. Technical for A and B.
      const sheet = (prelimB: number, prelimC: number) => [
        s(crit.p1, bid.A, 1), s(crit.p1, bid.B, prelimB), s(crit.p1, bid.C, prelimC),
        s(crit.t1, bid.A, 9), s(crit.t2, bid.A, 8), s(crit.t1, bid.B, 6), s(crit.t2, bid.B, 5),
      ];
      await c.tender.post(`/tenders/${tender.id}/scores`, { scores: [s(crit.t1, bid.A, 11)] }).expect(400); // above the maximum
      await c.tender.post(`/tenders/${tender.id}/scores`, { scores: sheet(1, 0) }).expect(200);
      await c.admin.post(`/tenders/${tender.id}/scores`, { scores: sheet(1, 0) }).expect(200);
      const partial = await c.tender.post(`/tenders/${tender.id}/recommend`, { report: 'Evaluation report: recommend the top bid' }).expect(400);
      expect(partial.body.code).toBe('EVALUATION_INCOMPLETE');
      const ev = await c.quality.post(`/tenders/${tender.id}/scores`, { scores: sheet(0, 1) }).expect(200);
      expect(ev.body.complete).toBe(true);
      const by = (id: string) => ev.body.bids.find((b: { id: string }) => b.id === id);
      expect(by(bid.C)).toMatchObject({ responsive: false, rank: null });
      expect(by(bid.A)).toMatchObject({ technicalScore: 86, financialScore: 90, combinedScore: 88.8, rank: 1 });
      expect(by(bid.B)).toMatchObject({ technicalScore: 56, financialScore: 100, combinedScore: 86.8, rank: 2 });
      expect(ev.body.members.find((m: { userId: string }) => m.userId === ids.storekeeper).scoring).toBe(false);
    });

    it('recommendation, professional opinion from outside the committee, award approval, award / regret notices', async () => {
      await c.quality.post(`/tenders/${tender.id}/recommend`, { report: 'Evaluation report: recommend the top bid' }).expect(403); // the chair records it
      const rec = await c.tender.post(`/tenders/${tender.id}/recommend`, { report: 'Evaluation report: recommend the top bid' }).expect(200);
      expect(rec.body).toMatchObject({ status: 'RECOMMENDED', recommendedBidId: bid.A });
      // Scores are frozen once the evaluation is locked.
      await expect(q(`UPDATE evaluation_score SET score = 0 WHERE tender_id = $1`, [tender.id])).rejects.toThrow();
      await c.admin.post(`/tenders/${tender.id}/award`, { opinion: 'Professional opinion: concur with the committee' }).expect(403); // committee member
      await c['proc.manager'].post(`/tenders/${tender.id}/award`, { opinion: 'Professional opinion: concur with the committee' }).expect(200);

      await setSetting('procurement.ppadaRuleSet', true); // standstill applies to this award
      await approve('TND', tender.id, 'scm', 'management');
      const awarded = await c['proc.manager'].get(`/tenders/${tender.id}`).expect(200);
      expect(awarded.body).toMatchObject({ status: 'AWARDED', awardedBidId: bid.A });
      expect(awarded.body.standstillUntil).toBeTruthy();
      const bids = Object.fromEntries(awarded.body.bids.map((b: { id: string; status: string }) => [b.id, b.status]));
      expect(bids).toEqual({ [bid.A]: 'AWARDED', [bid.B]: 'REGRET', [bid.C]: 'REGRET' });
      const mails = await q(`SELECT subject FROM email_outbox WHERE source_doc_id = $1 ORDER BY subject`, [tender.id]);
      expect(mails.map((m: { subject: string }) => m.subject)).toEqual(expect.arrayContaining([`Notification of award: ${tender.number}`, `Tender ${tender.number}: outcome`]));
      expect((await c.supplier.get(`/portal/tenders/${tender.id}`).expect(200)).body.result).toBe('AWARDED');
      expect((await c.supplier2.get(`/portal/tenders/${tender.id}`).expect(200)).body.result).toBe('NOT_SUCCESSFUL');
    });

    it('signs the framework agreement after the standstill period', async () => {
      const body = { type: 'FRAMEWORK', startDate: day(), endDate: day(365), supplierSignatory: 'Sales Director', leadTimeDays: 7, security: { securityType: 'BANK_GUARANTEE', reference: 'BG-1', issuer: 'Test Bank', amount: 20_000, expiresOn: day(200) } };
      const early = await c['proc.manager'].post(`/tenders/${tender.id}/contract`, body).expect(409);
      expect(early.body.code).toBe('STANDSTILL');
      await q(`UPDATE tender SET standstill_until = now() - interval '1 minute' WHERE id = $1`, [tender.id]);
      await setSetting('procurement.ppadaRuleSet', false);
      const signed = await c['proc.manager'].post(`/tenders/${tender.id}/contract`, body).expect(201);
      contractId = signed.body.contractId;
      const k = await c['proc.manager'].get(`/contracts/${contractId}`).expect(200);
      expect(k.body).toMatchObject({ status: 'ACTIVE', type: 'FRAMEWORK', supplierId: ids.s1, value: 200_000, calledOffValue: 0, remainingValue: 200_000 });
      expect(k.body.securities).toHaveLength(1);
      contractLines = k.body.lines;
      expect(k.body.lines.map((l: { unitPrice: number; remainingQty: number }) => [l.unitPrice, l.remainingQty])).toEqual([[100, 1000], [100, 1000]]);
      expect((await c['proc.manager'].get(`/tenders/${tender.id}`)).body.status).toBe('CONTRACTED');
      // The framework now covers these items.
      const rec = await c['proc.officer'].get(`/sourcing/recommend?amount=2000000&itemIds=${ids.itemA},${ids.itemB}`).expect(200);
      expect(rec.body).toMatchObject({ method: expect.objectContaining({ code: 'FRAMEWORK' }), frameworkAvailable: true });
    });

    it('call-off orders become purchase orders and draw down the remaining balance', async () => {
      const lineA = contractLines.find((l) => l.itemId === ids.itemA)!;
      await c['proc.officer'].post(`/contracts/${contractId}/call-offs`, { storeId: ids.MS, departmentId: ids.ipd, lines: [{ contractLineId: lineA.id, quantity: 400 }] }).expect(403); // contracts.manage
      const co = await c.scm.post(`/contracts/${contractId}/call-offs`, { storeId: ids.MS, departmentId: ids.ipd, lines: [{ contractLineId: lineA.id, quantity: 400 }] }).expect(201);
      poId = co.body.purchaseOrderId;
      expect(co.body.contract.lines.find((l: { id: string }) => l.id === lineA.id)).toMatchObject({ calledOffQty: 400, remainingQty: 600 });
      expect(co.body.contract).toMatchObject({ calledOffValue: 40_000, remainingValue: 160_000 });
      const po = await c.scm.get(`/purchase-orders/${poId}`).expect(200);
      expect(po.body).toMatchObject({ status: 'DRAFT', supplierId: ids.s1, contractId, source: 'CONTRACT' });
      expect(po.body.lines[0]).toMatchObject({ itemId: ids.itemA, quantity: 400, unitPrice: 100, contractLineId: lineA.id });

      const over = await c.scm.post(`/contracts/${contractId}/call-offs`, { storeId: ids.MS, departmentId: ids.ipd, lines: [{ contractLineId: lineA.id, quantity: 700 }] }).expect(400);
      expect(over.body.code).toBe('CONTRACT_BALANCE');

      // The call-off goes through the normal PO approval and is sent.
      await c.scm.post(`/purchase-orders/${poId}/submit`).expect(200);
      await approve('PO', poId, 'proc.manager');
      await c.scm.post(`/purchase-orders/${poId}/send`).expect(200);
      const k = await c.scm.get(`/contracts/${contractId}`).expect(200);
      expect(k.body.callOffs).toEqual([expect.objectContaining({ id: poId, status: 'SENT' })]);

      // Planned vs procured on the department plan.
      const plan = await c['ward.incharge'].get(`/procurement-plans/${ids.ipdPlan}`).expect(200);
      expect(plan.body.execution.lines.find((l: { lineNo: number }) => l.lineNo === 1)).toMatchObject({ plannedQty: 1000, procuredQty: 400, procuredValue: 40_000, executionRate: 40 });
    });

    it('contract variations need approval before they apply', async () => {
      const lineA = contractLines.find((l) => l.itemId === ids.itemA)!;
      const v = await c.scm.post(`/contracts/${contractId}/variations`, { reason: 'Extra ward opened', changes: { endDate: day(400), lines: [{ contractLineId: lineA.id, quantity: 1500 }] } }).expect(201);
      expect(v.body).toMatchObject({ status: 'PENDING_APPROVAL', number: expect.stringMatching(/CV/) });
      await c.scm.post(`/contracts/${contractId}/variations`, { reason: 'Another change', changes: { endDate: day(500) } }).expect(409);
      let k = await c.scm.get(`/contracts/${contractId}`).expect(200);
      expect(k.body.lines.find((l: { id: string }) => l.id === lineA.id).remainingQty).toBe(600); // not yet
      await approve('CV', v.body.id, 'proc.manager', 'finance');
      k = await c.scm.get(`/contracts/${contractId}`).expect(200);
      expect(k.body.endDate).toBe(day(400));
      expect(k.body.lines.find((l: { id: string }) => l.id === lineA.id)).toMatchObject({ quantity: 1500, remainingQty: 1100 });
      expect(k.body.variations[0].status).toBe('APPROVED');
    });

    describe('supplier portal isolation', () => {
      it("a supplier sees only its own orders; another supplier's records do not exist for it", async () => {
        const mine = await c.supplier.get('/portal/purchase-orders').expect(200);
        expect(mine.body.map((p: { id: string }) => p.id)).toContain(poId);
        const theirs = await c.supplier2.get('/portal/purchase-orders').expect(200);
        expect(theirs.body.map((p: { id: string }) => p.id)).not.toContain(poId);
        await c.supplier2.get(`/portal/purchase-orders/${poId}`).expect(404);
        await c.supplier2.post(`/portal/purchase-orders/${poId}/acknowledge`, {}).expect(404);
        await c.supplier2.post(`/portal/purchase-orders/${poId}/documents`, { type: 'INVOICE', reference: 'X', documentDate: day() }).expect(404);
        const order = await c.supplier.get(`/portal/purchase-orders/${poId}`).expect(200);
        expect(order.body.budgetId).toBeUndefined();
        expect(order.body.committedTotal).toBeUndefined();
        // Another supplier's RFQ is invisible too.
        const [rfq] = await q(`SELECT id FROM rfq WHERE status <> 'DRAFT' AND NOT ($1 = ANY(supplier_ids::uuid[])) LIMIT 1`, [ids.s2]);
        if (rfq) await c.supplier2.get(`/portal/rfqs/${rfq.id}`).expect(404);
      });

      it('suppliers cannot reach staff endpoints; staff cannot use the portal', async () => {
        await c.supplier.get(`/purchase-orders/${poId}`).expect(403);
        await c.supplier.get(`/tenders/${tender.id}`).expect(403);
        await c.supplier.get(`/contracts/${contractId}`).expect(403);
        await c.supplier.get('/procurement/kpis?from=2026-01-01&to=2026-12-31').expect(403);
        await c.scm.get('/portal/purchase-orders').expect(403);
      });

      it('the supplier acknowledges and tracks delivery; receipt is confirmed only by a GRN', async () => {
        const ack = await c.supplier.post(`/portal/purchase-orders/${poId}/acknowledge`, { note: 'Will deliver Monday' }).expect(200);
        expect(ack.body.acknowledgedAt).toBeTruthy();
        await c.supplier.post(`/portal/purchase-orders/${poId}/delivery`, { stage: 'DELIVERED' }).expect(400);
        const disp = await c.supplier.post(`/portal/purchase-orders/${poId}/delivery`, { stage: 'DISPATCHED', reference: 'DN-1', expectedDate: day(3) }).expect(200);
        expect(disp.body.deliveryStage).toBe('DISPATCHED');
        const sub = await c.supplier.post(`/portal/purchase-orders/${poId}/documents`, { type: 'DELIVERY_NOTE', reference: 'DN-1', documentDate: day() }).expect(201);
        const staff = await c['proc.officer'].get('/procurement/portal-submissions').expect(200);
        expect(staff.body.map((s: { id: string }) => s.id)).toContain(sub.body.id);
        expect((await c.supplier2.get('/portal/submissions').expect(200)).body.map((s: { id: string }) => s.id)).not.toContain(sub.body.id);
      });
    });
  });

  describe('demand forecast → suggested order quantities', () => {
    let item: { id: string };

    it('forecasts from back-dated consumption and suggests an order; the suggestion becomes a requisition', async () => {
      const g = await c.admin.post('/generics', { innName: `Forecastin ${uniq('g')}`, strength: '500 mg', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
      item = (await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.antiinf, name: `Forecastin ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 5, taxCategoryId: ids.exempt }).expect(201)).body;
      await c.scm.post('/inventory/receipts', { storeId: ids.MS, type: 'OPENING', lines: [{ itemId: item.id, batchNo: 'F1', expiryDate: day(700), quantity: 260, unitCost: 2 }] }).expect(201);
      await c.scm.put(`/stock-planning/settings/${ids.MS}/${item.id}`, { reorderLevel: 50, maxLevel: 200 }).expect(200);
      const batch = await one(`SELECT id FROM batch WHERE item_id = $1`, [item.id]);
      // 40 a month issued over the last six months.
      const month = day().slice(0, 7);
      for (let k = 6; k >= 1; k--) {
        await ctx.ds.transaction((m) =>
          postMovements(m, [{ txnType: StockTxnType.ISSUE, storeId: ids.MS, binId: null, itemId: item.id, batchId: batch.id, quantity: -40, departmentId: ids.ipd }], {
            sourceDocType: 'TEST',
            effectiveDate: `${addMonths(month, -k)}-15`,
            userId: null,
            permissions: null,
            valuationMethod: ValuationMethod.WAC,
          }),
        );
      }
      await c.storekeeper.post('/forecasting/forecasts/run', { storeId: ids.MS, itemId: item.id }).expect(403);
      const run = await c.scm.post('/forecasting/forecasts/run', { storeId: ids.MS, itemId: item.id, method: 'AMC' }).expect(200);
      expect(run.body.forecasts).toBe(1);
      const [f] = (await c.scm.get(`/forecasting/forecasts?storeId=${ids.MS}&itemId=${item.id}`).expect(200)).body;
      expect(f.history.slice(-6)).toEqual([40, 40, 40, 40, 40, 40]);
      expect(f.method).toBe('AMC');
      expect(f.adjusted[0]).toBe(40);
      expect(f.backtestMape).toBe(0);
      expect(f.position).toBe(20); // 260 − 240
      expect(f.suggestedQty).toBeGreaterThan(0);
      expect(f.suggestedQty).toBe(Math.ceil(f.demandOverCover + f.safetyStock - f.position));

      // A manual adjustment (e.g. a new service) scales the forecast.
      await c.scm.post('/forecasting/adjustments', { itemId: item.id, reasonCode: 'NEW_SERVICE', description: 'New ward', factor: 1.5, fromMonth: month }).expect(201);
      await c.scm.post('/forecasting/forecasts/run', { storeId: ids.MS, itemId: item.id, method: 'AMC' }).expect(200);
      const [adj] = (await c.scm.get(`/forecasting/forecasts?storeId=${ids.MS}&itemId=${item.id}`).expect(200)).body;
      expect(adj.adjusted[0]).toBe(60);
      expect(adj.suggestedQty).toBeGreaterThan(f.suggestedQty);

      const pr = await c.scm.post('/forecasting/forecasts/requisition', { storeId: ids.MS, departmentId: ids.ipd, forecastIds: [adj.id] }).expect(201);
      expect(pr.body.kind).toBe('PR');
      const prLines = (await c.scm.get(`/requisitions/${pr.body.id}`).expect(200)).body.lines;
      expect(prLines).toEqual([expect.objectContaining({ itemId: item.id, quantity: adj.suggestedQty })]);

      const { code } = await one(`SELECT code FROM item WHERE id = $1`, [item.id]);
      const plan = await c.scm.get(`/supply-planning?storeId=${ids.MS}&search=${encodeURIComponent(code)}`).expect(200);
      expect(plan.body.find((r: { itemId: string }) => r.itemId === item.id)).toMatchObject({ available: 20, forecastMonthly: 60, status: 'BELOW_MIN' });
    });

    it('tracks accuracy (MAPE) of the forecast made before a month against its actual consumption', async () => {
      const month = day().slice(0, 7);
      const last = addMonths(month, -1);
      // As if the forecast had been made before last month began.
      await q(`UPDATE demand_forecast SET start_month = $2::text, generated_at = ($2::text || '-01')::date - 1 WHERE store_id = $1 AND item_id = $3 AND is_current`, [ids.MS, last, item.id]);
      const res = await c.scm.post('/forecasting/accuracy/run', { month: last }).expect(200);
      expect(res.body.pairs).toBeGreaterThanOrEqual(1);
      const row = await one(`SELECT forecast_qty::float AS f, actual_qty::float AS a, ape::float AS ape FROM forecast_accuracy WHERE item_id = $1 AND month = $2`, [item.id, last]);
      expect(row).toEqual({ f: 60, a: 40, ape: 50 });
      const acc = await c.scm.get(`/forecasting/accuracy?fromMonth=${last}&toMonth=${last}&storeId=${ids.MS}`).expect(200);
      expect(acc.body.byMethod).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'AMC' })]));
    });
  });

  describe('donor stock', () => {
    it('stock from a no-sale funding source is skipped at the till and reported per donor', async () => {
      const code = uniq('DONOR');
      await c.storekeeper.post('/funding-sources', { code, name: 'Test donor' }).expect(403);
      await c.scm.post('/funding-sources', { code, name: 'Test donor', donor: 'Test Foundation', allowSale: false }).expect(201);
      const g = await c.admin.post('/generics', { innName: `Donorcillin ${uniq('g')}`, strength: '1 g', dosageForm: 'Tablet', route: 'Oral', controlledSchedule: 'NONE' }).expect(201);
      const it = (await c.admin.post('/items', { genericId: g.body.id, categoryId: ids.antiinf, name: `Donorcillin ${uniq('i')}`, baseUomId: ids.tab, unitPrice: 10, taxCategoryId: ids.exempt }).expect(201)).body;
      await c.scm.post('/inventory/receipts', { storeId: ids.OPD, type: 'OPENING', lines: [{ itemId: it.id, batchNo: 'DON', expiryDate: day(100), quantity: 5, unitCost: 4 }, { itemId: it.id, batchNo: 'OWN', expiryDate: day(300), quantity: 3, unitCost: 4 }] }).expect(201);
      await q(`UPDATE batch SET funding_source = $2 WHERE item_id = $1 AND batch_no = 'DON'`, [it.id, code]);

      // The donor batch expires first but is not for sale: FEFO takes the hospital's own batch.
      const sale = await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: it.id, quantity: 3 }], payments: [{ modeCode: 'CASH', amount: 30 }] }).expect(201);
      expect(sale.body.status).toBeDefined();
      const left = await q(`SELECT b.batch_no, sb.on_hand::float AS q FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE sb.item_id = $1 AND sb.store_id = $2 ORDER BY b.batch_no`, [it.id, ids.OPD]);
      expect(left).toEqual([{ batch_no: 'DON', q: 5 }, { batch_no: 'OWN', q: 0 }]);
      const none = await c.cashier.post('/billing/invoices', { storeId: ids.OPD, source: 'OTC', lines: [{ itemId: it.id, quantity: 1 }], payments: [{ modeCode: 'CASH', amount: 10 }] }).expect(400);
      expect(none.body.code).toBe('INSUFFICIENT_STOCK');

      const report = await c.scm.get(`/funding-sources/stock?fundingSource=${code}`).expect(200);
      expect(report.body).toEqual([expect.objectContaining({ funding_source: code, item_id: it.id, on_hand: 5, allow_sale: false })]);
    });
  });

  describe('supplier performance', () => {
    it('computes scorecards and suspends a supplier through the approval workflow', async () => {
      const period = day().slice(0, 7);
      const sc = await c.scm.post('/supplier-performance/scorecards/compute', { period }).expect(200);
      expect(sc.body).toMatchObject({ period, suppliers: expect.any(Number) });
      await c['ward.incharge'].post('/supplier-performance/scorecards/compute', { period }).expect(403);
      const cards = await c.scm.get(`/supplier-performance/scorecards?period=${period}`).expect(200);
      expect(Array.isArray(cards.body)).toBe(true);

      const s = await c['proc.officer'].post('/suppliers', { name: `Sanction test ${uniq('s')}`, kraPin: `P8${String(Date.now()).slice(-8)}Z`, email: 'sanction@test.example' }).expect(201);
      const ca = await c['proc.manager'].post('/supplier-performance/corrective-actions', { supplierId: s.body.id, issue: 'Late deliveries', actionRequired: 'Delivery plan within 14 days', dueDate: day(14) }).expect(201);
      await c['proc.manager'].post(`/supplier-performance/corrective-actions/${ca.body.id}/close`, { outcome: 'Plan received' }).expect(200);
      const req = await c['proc.manager'].post('/supplier-performance/sanctions', { supplierId: s.body.id, type: 'SUSPEND', reason: 'Repeated failure to deliver' }).expect(201);
      expect(req.body.status).toBe('PENDING_APPROVAL');
      expect((await one(`SELECT status FROM supplier WHERE id = $1`, [s.body.id])).status).toBe('ACTIVE');
      await c['proc.manager'].post('/supplier-performance/sanctions', { supplierId: s.body.id, type: 'SUSPEND', reason: 'Second request' }).expect(409);
      await approve('SSN', req.body.id, 'scm', 'management');
      expect((await one(`SELECT status FROM supplier WHERE id = $1`, [s.body.id])).status).toBe('SUSPENDED');
    });
  });

  describe('KPIs', () => {
    it('render for a period: lead times, plan execution, spend under contract, OTIF, forecast accuracy', async () => {
      const from = `${day().slice(0, 7)}-01`;
      const k = await c['proc.manager'].get(`/procurement/kpis?from=${from}&to=${day()}`).expect(200);
      expect(k.body).toMatchObject({
        period: { from, to: day() },
        leadTimes: expect.objectContaining({ orders: expect.any(Number) }),
        planExecution: expect.objectContaining({ financialYear: fy, basis: 'DEPARTMENT_PLANS' }),
        savings: expect.any(Object),
        otif: expect.any(Object),
        forecastAccuracy: expect.any(Object),
      });
      expect(k.body.planExecution.planned).toBe(300_000);
      expect(k.body.planExecution.procured).toBeGreaterThanOrEqual(40_000);
      expect(k.body.spend.underContract).toBeGreaterThanOrEqual(40_000);
      expect(k.body.spend.underContractPercent).toBeGreaterThan(0);
      expect(k.body.spend.byMethod).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'FRAMEWORK' })]));
      expect(k.body.agpo).toBeNull(); // PPADA rule set off
      await c.finance.get(`/procurement/kpis?from=${from}&to=${day()}`).expect(200);
      await c['ward.incharge'].get(`/procurement/kpis?from=${from}&to=${day()}`).expect(403);
    });
  });
});

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { DocumentType, Permissions, PlanStatus, SessionUser } from '@sil/shared';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { ProcurementPlan, ProcurementPlanLine, ProcurementPlanVersion } from './plans.entities';
import { methodProblem, recommendMethod } from './sourcing';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface PlanLineInput {
  itemId?: string | null;
  description?: string;
  categoryId?: string | null;
  quantity: number;
  estimatedUnitCost: number;
  voteHead: string;
  sourcingMethod?: string;
  plannedQuarter: number;
  notes?: string | null;
}

const EDITABLE = [PlanStatus.DRAFT, PlanStatus.RETURNED];

/** Calendar window of a financial year label ("2026" or "2026/27"). */
export function fyWindow(label: string, startMonth: number): { from: string; to: string } {
  const y = Number(label.slice(0, 4));
  const from = `${y}-${String(startMonth).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, startMonth - 1 + 12, 1)).toISOString().slice(0, 10);
  return { from, to: end };
}

/**
 * Annual procurement plans: departmental plans on budget vote heads,
 * approval, consolidation into the hospital plan, mid-year revisions with
 * history, and planned vs procured vs spent.
 */
@Injectable()
export class PlansService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.PROCUREMENT_PLAN, this);
    this.links.registerResolver(DocumentType.PROCUREMENT_PLAN, async (ids) => {
      const rows = await this.ds.getRepository(ProcurementPlan).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: `${r.status} v${r.version}`, date: r.updatedAt.toISOString().slice(0, 10), amount: r.totalEstimate }]));
    });
  }

  private assertDepartment(actor: SessionUser, departmentId: string | null) {
    if (actor.permissions.includes(Permissions.PLANS_CONSOLIDATE)) return;
    if (departmentId === null) throw new ForbiddenException('The hospital plan is prepared by consolidation');
    if (actor.departmentId !== departmentId) throw new ForbiddenException("You can only prepare your own department's plan");
  }

  /** Validates lines and computes totals; the method defaults to the recommended one for the line value. */
  private async buildLines(m: EntityManager, lines: PlanLineInput[], departmentId: string | null, financialYear: string): Promise<Partial<ProcurementPlanLine>[]> {
    if (!lines.length) throw new BadRequestException('A plan needs at least one line');
    const rules = await this.settings.get('procurement.sourcingMethods', m);
    const out: Partial<ProcurementPlanLine>[] = [];
    for (const [i, l] of lines.entries()) {
      let description = l.description?.trim() ?? '';
      let categoryId = l.categoryId ?? null;
      if (l.itemId) {
        const [it] = await m.query(`SELECT name, category_id FROM item WHERE id = $1`, [l.itemId]);
        if (!it) throw new BadRequestException(`Line ${i + 1}: item not found`);
        description ||= it.name;
        categoryId ??= it.category_id;
      }
      if (!description) throw new BadRequestException(`Line ${i + 1}: an item or a description is needed`);
      if (l.plannedQuarter < 1 || l.plannedQuarter > 4) throw new BadRequestException(`Line ${i + 1}: quarter must be 1–4`);
      if (departmentId) {
        const [b] = await m.query(`SELECT id FROM budget WHERE department_id = $1 AND financial_year = $2 AND vote_head = $3 AND is_active`, [departmentId, financialYear, l.voteHead]);
        if (!b) throw new BadRequestException(`Line ${i + 1}: no ${financialYear} budget on vote head ${l.voteHead} for this department`);
      }
      const total = r2(l.quantity * l.estimatedUnitCost);
      const method = l.sourcingMethod ?? recommendMethod(rules, total)?.code;
      if (!method) throw new BadRequestException(`Line ${i + 1}: no sourcing method is configured for ${total}`);
      // Plans may name a method above its band (lines are aggregated later) but not an unknown or disabled one.
      if (!rules.find((r) => r.code === method && r.isActive)) throw new BadRequestException(`Line ${i + 1}: sourcing method ${method} is not enabled`);
      out.push({
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        description: description.slice(0, 300),
        categoryId,
        quantity: r4(l.quantity),
        estimatedUnitCost: l.estimatedUnitCost,
        estimatedTotal: total,
        voteHead: l.voteHead,
        sourcingMethod: method,
        plannedQuarter: l.plannedQuarter,
        notes: l.notes ?? null,
      });
    }
    return out;
  }

  async create(dto: { financialYear: string; departmentId: string; title: string; lines: PlanLineInput[] }, actor: SessionUser) {
    this.assertDepartment(actor, dto.departmentId);
    const id = await this.ds.transaction(async (m) => {
      if (await m.existsBy(ProcurementPlan, { financialYear: dto.financialYear, departmentId: dto.departmentId })) {
        throw new ConflictException('This department already has a plan for that financial year; revise it instead');
      }
      const lines = await this.buildLines(m, dto.lines, dto.departmentId, dto.financialYear);
      const plan = await m.save(
        m.create(ProcurementPlan, {
          number: await this.numbering.next(DocumentType.PROCUREMENT_PLAN, { manager: m }),
          financialYear: dto.financialYear,
          departmentId: dto.departmentId,
          title: dto.title,
          status: PlanStatus.DRAFT,
          totalEstimate: r2(lines.reduce((s, l) => s + l.estimatedTotal!, 0)),
          lines: lines.map((l) => m.create(ProcurementPlanLine, l)),
        }),
      );
      return plan.id;
    });
    return this.get(id);
  }

  async update(id: string, dto: { title?: string; lines: PlanLineInput[] }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const plan = await this.lock(m, id);
      this.assertDepartment(actor, plan.departmentId);
      if (!EDITABLE.includes(plan.status)) throw new ConflictException(`Plan is ${plan.status}; use a revision`);
      await this.replaceLines(m, plan, dto.lines);
      if (dto.title) plan.title = dto.title;
      await m.save(plan);
    });
    return this.get(id);
  }

  private async replaceLines(m: EntityManager, plan: ProcurementPlan, input: PlanLineInput[]) {
    const lines = await this.buildLines(m, input, plan.departmentId, plan.financialYear);
    await m.delete(ProcurementPlanLine, { planId: plan.id });
    await m.save(lines.map((l) => m.create(ProcurementPlanLine, { ...l, planId: plan.id, sourceDepartmentIds: (l as ProcurementPlanLine).sourceDepartmentIds ?? [] })));
    plan.totalEstimate = r2(lines.reduce((s, l) => s + l.estimatedTotal!, 0));
  }

  private async lock(m: EntityManager, id: string) {
    const plan = await m.findOne(ProcurementPlan, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async submit(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const plan = await this.lock(m, id);
      this.assertDepartment(actor, plan.departmentId);
      if (!EDITABLE.includes(plan.status)) throw new ConflictException(`Plan is ${plan.status}`);
      await this.startApproval(m, plan, actor, null);
    });
    return this.get(id);
  }

  private async startApproval(m: EntityManager, plan: ProcurementPlan, actor: SessionUser, revision: string | null) {
    const [dept] = plan.departmentId ? await m.query(`SELECT name FROM department WHERE id = $1`, [plan.departmentId]) : [{ name: 'Hospital plan' }];
    await this.approvals.start(m, {
      documentType: DocumentType.PROCUREMENT_PLAN,
      documentId: plan.id,
      documentNo: plan.version > 1 ? `${plan.number} v${plan.version}` : plan.number,
      amount: plan.totalEstimate,
      departmentId: plan.departmentId,
      requestedBy: actor.id,
      summary: `${dept?.name ?? ''} · FY ${plan.financialYear}${revision ? ` · revision: ${revision}` : ''}`,
      link: `/procurement-plans/${plan.id}`,
    });
    plan.status = PlanStatus.PENDING_APPROVAL;
    await m.save(plan);
  }

  /** Mid-year revision of an approved plan: new version, approval again; the approved version stays in force until then. */
  async revise(id: string, dto: { reason: string; lines: PlanLineInput[] }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const plan = await this.lock(m, id);
      this.assertDepartment(actor, plan.departmentId);
      if (plan.status !== PlanStatus.APPROVED) throw new ConflictException(`Only an approved plan can be revised (this one is ${plan.status})`);
      plan.version += 1;
      plan.revisionReason = dto.reason;
      await this.replaceLines(m, plan, dto.lines);
      await this.startApproval(m, plan, actor, dto.reason);
    });
    return this.get(id);
  }

  async onApproved(m: EntityManager, req: ApprovalRequest, actor: SessionUser): Promise<void> {
    const plan = await m.findOneByOrFail(ProcurementPlan, { id: req.documentId });
    plan.status = PlanStatus.APPROVED;
    plan.wasApproved = true;
    plan.lastComment = null;
    await m.save(plan);
    const lines = await m.find(ProcurementPlanLine, { where: { planId: plan.id }, order: { lineNo: 'ASC' } });
    const { lines: _l, department: _d, ...header } = plan;
    await m.query(
      `INSERT INTO procurement_plan_version (plan_id, version, snapshot, reason, approved_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (plan_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot, approved_by = EXCLUDED.approved_by`,
      [plan.id, plan.version, JSON.stringify({ ...header, lines }), plan.revisionReason, actor.id],
    );
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const plan = await m.findOneByOrFail(ProcurementPlan, { id: req.documentId });
    plan.lastComment = comment;
    if (plan.wasApproved && plan.version > 1) {
      // A rejected revision: the last approved version stays in force.
      const prev = await m.findOne(ProcurementPlanVersion, { where: { planId: plan.id }, order: { version: 'DESC' } });
      if (prev) {
        const snap = prev.snapshot as { lines: ProcurementPlanLine[]; totalEstimate: number; revisionReason: string | null };
        await m.delete(ProcurementPlanLine, { planId: plan.id });
        await m.save(snap.lines.map(({ id: _id, createdAt: _c, updatedAt: _u, ...l }) => m.create(ProcurementPlanLine, { ...l, planId: plan.id })));
        Object.assign(plan, { version: prev.version, totalEstimate: snap.totalEstimate, revisionReason: snap.revisionReason, status: PlanStatus.APPROVED });
        await m.save(plan);
        return;
      }
    }
    plan.status = PlanStatus.REJECTED;
    await m.save(plan);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const plan = await m.findOneByOrFail(ProcurementPlan, { id: req.documentId });
    plan.status = PlanStatus.RETURNED;
    plan.lastComment = comment;
    await m.save(plan);
  }

  /**
   * Hospital plan for a financial year from the approved departmental plans:
   * lines for the same item (or description and category) are added up; the
   * method is re-recommended for the combined value. Departmental plans are
   * marked CONSOLIDATED. The hospital plan then goes for approval.
   */
  async consolidate(financialYear: string, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const plans = await m.find(ProcurementPlan, { where: { financialYear, status: In([PlanStatus.APPROVED, PlanStatus.CONSOLIDATED]) }, relations: { lines: true } });
      const departmental = plans.filter((p) => p.departmentId);
      if (!departmental.length) throw new BadRequestException(`No approved departmental plans for ${financialYear}`);
      const rules = await this.settings.get('procurement.sourcingMethods', m);
      const groups = new Map<string, PlanLineInput & { departments: Set<string>; total: number }>();
      for (const p of departmental) {
        for (const l of p.lines ?? []) {
          const key = l.itemId ?? `${l.description.toLowerCase()}|${l.categoryId ?? ''}`;
          const key2 = `${key}|${l.voteHead}`;
          const g = groups.get(key2) ?? { itemId: l.itemId, description: l.description, categoryId: l.categoryId, quantity: 0, estimatedUnitCost: 0, voteHead: l.voteHead, plannedQuarter: l.plannedQuarter, departments: new Set<string>(), total: 0 };
          g.quantity = r4(g.quantity + l.quantity);
          g.total = r2(g.total + l.estimatedTotal);
          g.plannedQuarter = Math.min(g.plannedQuarter, l.plannedQuarter);
          g.departments.add(p.departmentId!);
          groups.set(key2, g);
        }
      }
      let hospital = await m.findOne(ProcurementPlan, { where: { financialYear, departmentId: IsNull() }, lock: { mode: 'pessimistic_write' } });
      if (hospital && hospital.status === PlanStatus.PENDING_APPROVAL) throw new ConflictException('The hospital plan is awaiting approval');
      if (!hospital) {
        hospital = await m.save(
          m.create(ProcurementPlan, {
            number: await this.numbering.next(DocumentType.PROCUREMENT_PLAN, { manager: m }),
            financialYear,
            departmentId: null,
            title: `Hospital procurement plan ${financialYear}`,
            status: PlanStatus.DRAFT,
          }),
        );
      } else if (hospital.status === PlanStatus.APPROVED) {
        hospital.version += 1;
        hospital.revisionReason = 'Re-consolidated from departmental plans';
      }
      await m.delete(ProcurementPlanLine, { planId: hospital.id });
      let n = 0;
      let total = 0;
      for (const g of groups.values()) {
        const unit = g.quantity ? r4(g.total / g.quantity) : 0;
        const method = recommendMethod(rules, g.total)?.code ?? 'OPEN_TENDER';
        total += g.total;
        await m.save(
          m.create(ProcurementPlanLine, {
            planId: hospital.id,
            lineNo: ++n,
            itemId: g.itemId ?? null,
            description: g.description!,
            categoryId: g.categoryId ?? null,
            quantity: g.quantity,
            estimatedUnitCost: unit,
            estimatedTotal: g.total,
            voteHead: g.voteHead,
            sourcingMethod: method,
            plannedQuarter: g.plannedQuarter,
            sourceDepartmentIds: [...g.departments],
          }),
        );
      }
      hospital.totalEstimate = r2(total);
      if (hospital.status !== PlanStatus.APPROVED) hospital.status = PlanStatus.DRAFT;
      await m.save(hospital);
      for (const p of departmental) {
        p.status = PlanStatus.CONSOLIDATED;
        p.consolidatedIntoId = hospital.id;
        await m.save(p);
        await this.links.link(m, { type: DocumentType.PROCUREMENT_PLAN, id: p.id, no: p.number }, { type: DocumentType.PROCUREMENT_PLAN, id: hospital.id, no: hospital.number });
      }
      if (hospital.status === PlanStatus.APPROVED) await this.startApproval(m, hospital, actor, hospital.revisionReason);
      return hospital.id;
    });
    return this.get(id);
  }

  list(q: { financialYear?: string; departmentId?: string; status?: string }) {
    const where: Record<string, unknown> = {};
    if (q.financialYear) where.financialYear = q.financialYear;
    if (q.departmentId) where.departmentId = q.departmentId;
    if (q.status) where.status = q.status;
    return this.ds.getRepository(ProcurementPlan).find({ where, relations: { department: true }, order: { financialYear: 'DESC', number: 'ASC' } });
  }

  async get(id: string) {
    const plan = await this.ds.getRepository(ProcurementPlan).findOne({ where: { id }, relations: { department: true, lines: { item: true, category: true } }, order: { lines: { lineNo: 'ASC' } } });
    if (!plan) throw new NotFoundException('Plan not found');
    const versions = await this.ds.getRepository(ProcurementPlanVersion).find({ where: { planId: id }, order: { version: 'ASC' } });
    const approvals = await this.ds.query(
      `SELECT r.id, r.document_no, r.status, r.created_at, a.step_name, a.action, a.comment, a.at AS acted_at, u.full_name AS by
         FROM approval_request r LEFT JOIN approval_action a ON a.request_id = r.id LEFT JOIN app_user u ON u.id = a.user_id
        WHERE r.document_type = $1 AND r.document_id = $2 ORDER BY r.created_at, a.at`,
      [DocumentType.PROCUREMENT_PLAN, id],
    );
    return { ...plan, versions: versions.map((v) => ({ version: v.version, reason: v.reason, approvedBy: v.approvedBy, at: v.createdAt })), approvalHistory: approvals, execution: await this.execution(plan), budgets: await this.budgetCheck(plan) };
  }

  /** Planned per vote head vs the department's budget for the year. */
  private async budgetCheck(plan: ProcurementPlan) {
    if (!plan.departmentId) return [];
    return this.ds.query(
      `SELECT l.vote_head, SUM(l.estimated_total)::float AS planned, MAX(b.amount)::float AS budget
         FROM procurement_plan_line l LEFT JOIN budget b ON b.department_id = $2 AND b.financial_year = $3 AND b.vote_head = l.vote_head
        WHERE l.plan_id = $1 GROUP BY l.vote_head ORDER BY l.vote_head`,
      [plan.id, plan.departmentId, plan.financialYear],
    );
  }

  /**
   * Planned vs procured (approved POs of the plan's departments in the
   * financial year, same item) vs spent (approved / paid supplier invoices).
   * Lines without a catalogue item cannot be matched and show nothing procured.
   */
  async execution(plan: ProcurementPlan) {
    const { from, to } = fyWindow(plan.financialYear, await this.settings.get('finance.fyStartMonth'));
    const lines = plan.lines ?? (await this.ds.getRepository(ProcurementPlanLine).find({ where: { planId: plan.id } }));
    const depts = plan.departmentId ? [plan.departmentId] : [...new Set(lines.flatMap((l) => l.sourceDepartmentIds))];
    const itemIds = lines.map((l) => l.itemId).filter(Boolean) as string[];
    const rows: { item_id: string; procured_qty: number; procured_value: number; spent: number }[] = itemIds.length && depts.length
      ? await this.ds.query(
          `SELECT pl.item_id, SUM(pl.quantity * pl.conversion_factor)::float AS procured_qty, SUM(pl.line_total)::float AS procured_value,
                  COALESCE(SUM(inv.spent), 0)::float AS spent
             FROM purchase_order_line pl JOIN purchase_order po ON po.id = pl.purchase_order_id
             LEFT JOIN LATERAL (
               SELECT SUM(il.line_total) AS spent FROM supplier_invoice_line il JOIN supplier_invoice si ON si.id = il.invoice_id
                WHERE il.po_line_id = pl.id AND si.status IN ('APPROVED', 'PAID')) inv ON true
            WHERE pl.item_id = ANY($1::uuid[]) AND po.department_id = ANY($2::uuid[])
              AND po.status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')
              AND po.order_date >= $3::date AND po.order_date < $4::date
            GROUP BY pl.item_id`,
          [itemIds, depts, from, to],
        )
      : [];
    const out = lines.map((l) => {
      const r = l.itemId ? rows.find((x) => x.item_id === l.itemId) : undefined;
      const procuredValue = r ? r2(r.procured_value) : 0;
      return {
        lineId: l.id,
        lineNo: l.lineNo,
        description: l.description,
        plannedQty: l.quantity,
        plannedValue: l.estimatedTotal,
        procuredQty: r ? r4(r.procured_qty) : 0,
        procuredValue,
        spent: r ? r2(r.spent) : 0,
        executionRate: l.estimatedTotal ? r2((100 * procuredValue) / l.estimatedTotal) : null,
      };
    });
    const planned = r2(out.reduce((s, x) => s + x.plannedValue, 0));
    const procured = r2(out.reduce((s, x) => s + x.procuredValue, 0));
    const spent = r2(out.reduce((s, x) => s + x.spent, 0));
    return { lines: out, planned, procured, spent, executionRate: planned ? r2((100 * procured) / planned) : null };
  }

  /** Check a method against the rules (used by requisitions and tenders). */
  async methodProblem(m: EntityManager, code: string, amount: number, justification?: string | null, frameworkAvailable = false) {
    return methodProblem(await this.settings.get('procurement.sourcingMethods', m), code, amount, justification, frameworkAvailable);
  }
}

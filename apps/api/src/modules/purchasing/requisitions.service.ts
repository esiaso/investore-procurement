import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, OPEN_REQUISITION_STATUSES, Paginated, PurchaseLineType, RequisitionPriority, RequisitionStatus, SessionUser } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { BudgetsService } from '../budgets/budgets.service';
import { NumberingService } from '../numbering/numbering.service';
import { methodProblem, recommendMethod } from '../procurement/sourcing';
import { SettingsService } from '../settings/settings.service';
import { releasePurchaseRequisitionLines } from '../staff-requisitions/staff-requisition-status';
import { CreateRequisitionDto, DocListQueryDto } from './purchasing.dto';
import { PurchaseRequisition, PurchaseRequisitionLine } from './purchasing.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class RequisitionsService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly budgets: BudgetsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.PURCHASE_REQUISITION, this);
    this.links.registerResolver(DocumentType.PURCHASE_REQUISITION, async (ids) => {
      const rows = await this.ds.getRepository(PurchaseRequisition).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString(), amount: r.estimatedTotal }]));
    });
  }

  private async buildLines(m: EntityManager, storeId: string, dto: CreateRequisitionDto): Promise<Partial<PurchaseRequisitionLine>[]> {
    const ids = dto.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each item may appear only once');
    const items: { id: string; code: string; unit_price: string; is_active: boolean; last_cost: string | null }[] = await m.query(
      `SELECT i.id, i.code, i.unit_price, i.is_active, c.avg_cost AS last_cost
         FROM item i LEFT JOIN item_store_cost c ON c.item_id = i.id AND c.store_id = $2
        WHERE i.id = ANY($1::uuid[])`,
      [ids, storeId],
    );
    return dto.lines.map((l) => {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) throw new NotFoundException(`Item ${l.itemId} not found`);
      if (!item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
      return {
        itemId: l.itemId,
        quantity: l.quantity,
        estimatedUnitPrice: l.estimatedUnitPrice ?? Number(item.last_cost ?? item.unit_price),
        notes: l.notes ?? null,
      };
    });
  }

  private async validateHeader(m: EntityManager, dto: CreateRequisitionDto) {
    const [dept] = await m.query(`SELECT id FROM department WHERE id = $1 AND is_active`, [dto.departmentId]);
    if (!dept) throw new BadRequestException('Department not found or inactive');
    const [store] = await m.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
    if (!store) throw new BadRequestException('Store not found or inactive');
    if (dto.budgetId) {
      const [b] = await m.query(`SELECT department_id FROM budget WHERE id = $1 AND is_active`, [dto.budgetId]);
      if (!b) throw new BadRequestException('Budget not found');
      if (b.department_id !== dto.departmentId) throw new BadRequestException('Budget belongs to another department');
    }
  }

  async create(dto: CreateRequisitionDto, actor: SessionUser): Promise<PurchaseRequisition> {
    const id = await this.ds.transaction(async (m) => {
      await this.validateHeader(m, dto);
      const lines = await this.buildLines(m, dto.storeId, dto);
      const pr = await m.save(
        m.create(PurchaseRequisition, {
          number: await this.numbering.next(DocumentType.PURCHASE_REQUISITION, { storeId: dto.storeId, manager: m }),
          departmentId: dto.departmentId,
          storeId: dto.storeId,
          budgetId: dto.budgetId ?? null,
          priority: dto.priority ?? RequisitionPriority.ROUTINE,
          requiredBy: dto.requiredBy ?? null,
          justification: dto.justification,
          sourcingMethod: dto.sourcingMethod ?? null,
          sourcingJustification: dto.sourcingJustification ?? null,
          requestedBy: actor.id,
          status: RequisitionStatus.DRAFT,
          estimatedTotal: round2(lines.reduce((s, l) => s + l.quantity! * l.estimatedUnitPrice!, 0)),
          lines: lines.map((l) => m.create(PurchaseRequisitionLine, l)),
        }),
      );
      return pr.id;
    });
    return this.get(id);
  }

  /** Only the requester may edit, and only while draft or returned. */
  async update(id: string, dto: CreateRequisitionDto, actor: SessionUser): Promise<PurchaseRequisition> {
    await this.ds.transaction(async (m) => {
      const pr = await this.lock(m, id);
      if (pr.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can edit this requisition');
      if (![RequisitionStatus.DRAFT, RequisitionStatus.RETURNED].includes(pr.status)) throw new ConflictException(`Requisition is ${pr.status}`);
      const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM purchase_requisition_line WHERE requisition_id = $1 AND source_requisition_line_id IS NOT NULL`, [id]);
      if (n) throw new ConflictException('This requisition was consolidated from staff requisitions: cancel it (the lines go back to the queue) and consolidate again');
      await this.validateHeader(m, dto);
      const lines = await this.buildLines(m, dto.storeId, dto);
      await m.delete(PurchaseRequisitionLine, { requisitionId: id });
      Object.assign(pr, {
        departmentId: dto.departmentId,
        storeId: dto.storeId,
        budgetId: dto.budgetId ?? null,
        priority: dto.priority ?? pr.priority,
        requiredBy: dto.requiredBy ?? null,
        justification: dto.justification,
        sourcingMethod: dto.sourcingMethod ?? null,
        sourcingJustification: dto.sourcingJustification ?? null,
        estimatedTotal: round2(lines.reduce((s, l) => s + l.quantity! * l.estimatedUnitPrice!, 0)),
      });
      await m.save(pr);
      await m.save(lines.map((l) => m.create(PurchaseRequisitionLine, { ...l, requisitionId: id })));
    });
    return this.get(id);
  }

  /**
   * Sourcing method against the configured value bands (procurement.sourcingMethods).
   * Without one, the recommended method is recorded (a framework agreement when
   * one covers every item).
   */
  private async checkSourcing(m: EntityManager, pr: PurchaseRequisition) {
    const rules = await this.settings.get('procurement.sourcingMethods', m);
    const today = await this.settings.today(m);
    const [cov] = await m.query(
      `SELECT (SELECT count(DISTINCT item_id) FROM purchase_requisition_line WHERE requisition_id = $1)::int AS items,
              (SELECT count(DISTINCT l.item_id) FROM purchase_requisition_line l
                WHERE l.requisition_id = $1 AND EXISTS (SELECT 1 FROM contract_line cl JOIN contract c ON c.id = cl.contract_id
                  WHERE cl.item_id = l.item_id AND c.type = 'FRAMEWORK' AND c.status = 'ACTIVE' AND c.start_date <= $2 AND c.end_date >= $2))::int AS covered`,
      [pr.id, today],
    );
    const framework = cov.items > 0 && cov.items === cov.covered;
    if (!pr.sourcingMethod) {
      pr.sourcingMethod = recommendMethod(rules, pr.estimatedTotal, framework)?.code ?? null;
      return;
    }
    const problem = methodProblem(rules, pr.sourcingMethod, pr.estimatedTotal, pr.sourcingJustification, framework);
    if (problem) throw new BadRequestException({ code: 'SOURCING_METHOD', message: problem });
  }

  async submit(id: string, actor: SessionUser): Promise<PurchaseRequisition & { budgetWarning?: string | null }> {
    let budgetWarning: string | null = null;
    await this.ds.transaction(async (m) => {
      const pr = await this.lock(m, id);
      if (pr.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can submit this requisition');
      if (![RequisitionStatus.DRAFT, RequisitionStatus.RETURNED].includes(pr.status)) throw new ConflictException(`Requisition is ${pr.status}`);
      await this.checkSourcing(m, pr);
      if (pr.budgetId) {
        const check = await this.budgets.check(m, pr.budgetId, pr.estimatedTotal);
        if (check.blocked) throw new BadRequestException({ message: check.message, code: 'BUDGET_EXCEEDED' });
        budgetWarning = check.message;
      }
      const categories: { category_id: string }[] = await m.query(
        `SELECT DISTINCT COALESCE(l.category_id, i.category_id) AS category_id FROM purchase_requisition_line l LEFT JOIN item i ON i.id = l.item_id
          WHERE l.requisition_id = $1 AND COALESCE(l.category_id, i.category_id) IS NOT NULL`,
        [id],
      );
      await this.approvals.start(m, {
        documentType: DocumentType.PURCHASE_REQUISITION,
        documentId: pr.id,
        documentNo: pr.number,
        amount: pr.estimatedTotal,
        departmentId: pr.departmentId,
        itemCategoryIds: categories.map((c) => c.category_id),
        requestedBy: pr.requestedBy,
        summary: `${pr.priority.toLowerCase()} · ${pr.justification.slice(0, 120)}`,
        link: `/requisitions/${pr.id}`,
      });
      pr.status = RequisitionStatus.PENDING_APPROVAL;
      await m.save(pr);
    });
    return { ...(await this.get(id)), budgetWarning };
  }

  async cancel(id: string, actor: SessionUser): Promise<PurchaseRequisition> {
    await this.ds.transaction(async (m) => {
      const pr = await this.lock(m, id);
      if (pr.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can cancel this requisition');
      if (![RequisitionStatus.DRAFT, RequisitionStatus.RETURNED, RequisitionStatus.PENDING_APPROVAL].includes(pr.status)) {
        throw new ConflictException(`Requisition is ${pr.status}`);
      }
      await this.approvals.cancelPending(m, DocumentType.PURCHASE_REQUISITION, id, actor.id);
      pr.status = RequisitionStatus.CANCELLED;
      await m.save(pr);
      // Staff requisition lines it was consolidated from go back to the procurement queue.
      await releasePurchaseRequisitionLines(m, id);
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ approval callbacks

  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const pr = await m.findOneByOrFail(PurchaseRequisition, { id: req.documentId });
    pr.status = RequisitionStatus.APPROVED;
    await m.save(pr);
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const pr = await m.findOneByOrFail(PurchaseRequisition, { id: req.documentId });
    pr.status = RequisitionStatus.REJECTED;
    pr.lastComment = comment;
    await m.save(pr);
    await releasePurchaseRequisitionLines(m, pr.id);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const pr = await m.findOneByOrFail(PurchaseRequisition, { id: req.documentId });
    pr.status = RequisitionStatus.RETURNED;
    pr.lastComment = comment;
    await m.save(pr);
  }

  /**
   * Records base quantities put on (or taken off) POs and moves the PR on:
   * nothing ordered → APPROVED / RFQ_ISSUED; part → PARTIALLY_FULFILLED; all →
   * CLOSED (stock) or LPO_RAISED (non-stock: closed once delivered to the users).
   */
  async recordOrdered(m: EntityManager, lineQty: { requisitionLineId: string; baseQty: number }[]): Promise<void> {
    const touched = new Set<string>();
    for (const l of lineQty) {
      const line = await m.findOneBy(PurchaseRequisitionLine, { id: l.requisitionLineId });
      if (!line) continue;
      line.orderedQty = Math.max(0, Math.round((line.orderedQty + l.baseQty) * 10_000) / 10_000);
      await m.save(line);
      touched.add(line.requisitionId);
    }
    for (const prId of touched) await this.refreshOrderStatus(m, prId);
  }

  async refreshOrderStatus(m: EntityManager, prId: string): Promise<RequisitionStatus> {
    const pr = await m.findOneByOrFail(PurchaseRequisition, { id: prId });
    if (![...OPEN_REQUISITION_STATUSES, RequisitionStatus.LPO_RAISED, RequisitionStatus.CLOSED].includes(pr.status)) return pr.status;
    const lines = await m.find(PurchaseRequisitionLine, { where: { requisitionId: prId } });
    const all = lines.every((l) => l.orderedQty >= l.quantity);
    const any = lines.some((l) => l.orderedQty > 0);
    const [rfq] = await m.query(`SELECT 1 FROM rfq WHERE requisition_id = $1 AND status <> 'CANCELLED' LIMIT 1`, [prId]);
    pr.status = all
      ? lines.some((l) => l.lineType !== PurchaseLineType.STOCK)
        ? RequisitionStatus.LPO_RAISED
        : RequisitionStatus.CLOSED
      : any
        ? RequisitionStatus.PARTIALLY_FULFILLED
        : rfq
          ? RequisitionStatus.RFQ_ISSUED
          : RequisitionStatus.APPROVED;
    await m.save(pr);
    return pr.status;
  }

  private async lock(m: EntityManager, id: string): Promise<PurchaseRequisition> {
    const pr = await m.findOne(PurchaseRequisition, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!pr) throw new NotFoundException('Requisition not found');
    return pr;
  }

  async get(id: string): Promise<PurchaseRequisition> {
    const pr = await this.ds.getRepository(PurchaseRequisition).findOne({
      where: { id },
      relations: { department: true, store: true, lines: { item: { baseUom: true }, uom: true } },
    });
    if (!pr) throw new NotFoundException('Requisition not found');
    return pr;
  }

  async list(q: DocListQueryDto): Promise<Paginated<PurchaseRequisition>> {
    const qb = this.ds
      .getRepository(PurchaseRequisition)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.department', 'department')
      .leftJoinAndSelect('r.store', 'store')
      .orderBy('r.createdAt', 'DESC');
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.departmentId) qb.andWhere('r.department_id = :d', { d: q.departmentId });
    if (q.search) qb.andWhere('(r.number ILIKE :q OR r.justification ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  AttachmentOwner,
  DocumentType,
  NotificationCategory,
  Paginated,
  Permissions,
  PurchaseLineType,
  RequisitionPriority,
  RequisitionStatus,
  SessionUser,
  StaffRequisitionLineStatus,
  StaffRequisitionStatus,
} from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { BudgetsService } from '../budgets/budgets.service';
import { AttachmentsService } from '../files/attachments.service';
import { FinanceService } from '../finance/finance.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { PurchaseRequisition, PurchaseRequisitionLine } from '../purchasing/purchasing.entities';
import { SettingsService } from '../settings/settings.service';
import { StoreRequisitionsService } from '../stores/store-requisitions.service';
import { renderStaffRequisitionHtml } from './staff-requisition-pdf';
import { IN_PROCUREMENT, refreshStaffRequisitionStatus } from './staff-requisition-status';
import { ConsolidateDto, QueueQueryDto, StaffRequisitionDto, StaffRequisitionQueryDto } from './staff-requisitions.dto';
import { StaffRequisition, StaffRequisitionLine } from './staff-requisitions.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const EDITABLE = [StaffRequisitionStatus.DRAFT, StaffRequisitionStatus.RETURNED];

@Injectable()
export class StaffRequisitionsService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly budgets: BudgetsService,
    private readonly finance: FinanceService,
    private readonly settings: SettingsService,
    private readonly storeRequisitions: StoreRequisitionsService,
    private readonly attachments: AttachmentsService,
    private readonly pdf: PdfService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.STAFF_REQUISITION, this);
    this.links.registerResolver(DocumentType.STAFF_REQUISITION, async (ids) => {
      const rows = await this.ds.getRepository(StaffRequisition).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString(), amount: r.estimatedTotal }]));
    });
    this.attachments.registerOwner(AttachmentOwner.STAFF_REQUISITION, {
      read: [Permissions.STAFF_REQUISITION_CREATE, Permissions.STAFF_REQUISITION_READ_ALL],
      write: [Permissions.STAFF_REQUISITION_CREATE],
      visible: async (m, id, actor) => {
        const r = await m.findOneBy(StaffRequisition, { id });
        return !!r && (!actor || this.canSee(r, actor));
      },
    });
  }

  // ------------------------------------------------------------------ access

  private canSee(r: StaffRequisition, actor: SessionUser): boolean {
    return r.requestedBy === actor.id || actor.permissions.includes(Permissions.STAFF_REQUISITION_READ_ALL) || (!!actor.departmentId && actor.departmentId === r.departmentId);
  }

  /** The requester, their department, procurement / finance, or anyone the approval is waiting for. */
  private async assertCanSee(r: StaffRequisition, actor: SessionUser) {
    if (this.canSee(r, actor)) return;
    const [acted] = await this.ds.query(
      `SELECT 1 FROM approval_request q JOIN approval_action a ON a.request_id = q.id WHERE q.document_type = $1 AND q.document_id = $2 AND a.user_id = $3 LIMIT 1`,
      [DocumentType.STAFF_REQUISITION, r.id, actor.id],
    );
    if (acted) return;
    const inbox: { documentId: string }[] = await this.approvals.inbox(actor);
    if (inbox.some((i) => i.documentId === r.id)) return;
    throw new ForbiddenException('You cannot see this requisition');
  }

  // ------------------------------------------------------------------ building

  private async buildLines(m: EntityManager, dto: StaffRequisitionDto): Promise<Partial<StaffRequisitionLine>[]> {
    const today = await this.settings.today(m);
    const requireGl = await this.settings.get('requisitions.requireGlAccount', m);
    const stock = dto.lines.filter((l) => l.lineType === PurchaseLineType.STOCK);
    if (stock.length && !dto.storeId) throw new BadRequestException('Choose the store that issues the stock items');
    if (dto.storeId) {
      const [store] = await m.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
      if (!store) throw new BadRequestException('Store not found or inactive');
    }
    const itemIds = dto.lines.map((l) => l.itemId).filter((x): x is string => !!x);
    const items: { id: string; code: string; name: string; is_active: boolean; category_id: string; base_uom_id: string; cost: string }[] = itemIds.length
      ? await m.query(
          `SELECT i.id, i.code, i.name, i.is_active, i.category_id, i.base_uom_id, COALESCE(c.avg_cost, i.unit_price) AS cost
             FROM item i LEFT JOIN item_store_cost c ON c.item_id = i.id AND c.store_id = $2 WHERE i.id = ANY($1::uuid[])`,
          [itemIds, dto.storeId ?? null],
        )
      : [];
    const stockItems = stock.map((l) => l.itemId);
    if (new Set(stockItems).size !== stockItems.length) throw new BadRequestException('Each stock item may appear only once');
    const out: Partial<StaffRequisitionLine>[] = [];
    for (const [i, l] of dto.lines.entries()) {
      const item = l.itemId ? items.find((x) => x.id === l.itemId) : null;
      if (l.itemId && !item) throw new NotFoundException(`Item ${l.itemId} not found`);
      if (item && !item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
      const n = i + 1;
      if (l.lineType === PurchaseLineType.STOCK) {
        if (!item) throw new BadRequestException(`Line ${n}: a stock line needs a catalog item`);
        out.push({
          lineNo: n,
          lineType: l.lineType,
          itemId: item.id,
          description: (l.description?.trim() || item.name).slice(0, 500),
          categoryId: item.category_id,
          quantity: l.quantity,
          uomId: item.base_uom_id,
          estimatedUnitCost: l.estimatedUnitCost ?? round2(Number(item.cost)),
          glAccountId: null,
          notes: l.notes ?? null,
        });
        continue;
      }
      const description = l.description?.trim() || item?.name;
      if (!description) throw new BadRequestException(`Line ${n}: describe what is needed`);
      if (l.estimatedUnitCost === undefined) throw new BadRequestException(`Line ${n}: give an estimated unit cost`);
      if (l.glAccountId) await this.finance.assertGlAccount(m, l.glAccountId);
      else if (requireGl) throw new BadRequestException(`Line ${n}: choose the GL account it is charged to`);
      if (l.categoryId) {
        const [c] = await m.query(`SELECT id FROM item_category WHERE id = $1`, [l.categoryId]);
        if (!c) throw new BadRequestException(`Line ${n}: category not found`);
      }
      if (l.uomId) {
        const [u] = await m.query(`SELECT id FROM unit_of_measure WHERE id = $1`, [l.uomId]);
        if (!u) throw new BadRequestException(`Line ${n}: unit not found`);
      }
      out.push({
        lineNo: n,
        lineType: l.lineType,
        itemId: item?.id ?? null,
        description: description.slice(0, 500),
        categoryId: l.categoryId ?? item?.category_id ?? null,
        quantity: l.quantity,
        uomId: l.uomId ?? item?.base_uom_id ?? null,
        estimatedUnitCost: l.estimatedUnitCost,
        glAccountId: l.glAccountId ?? null,
        notes: l.notes ?? null,
      });
    }
    if (dto.projectId) await this.finance.assertProject(m, dto.projectId, today);
    return out;
  }

  private async validateHeader(m: EntityManager, dto: StaffRequisitionDto) {
    const [dept] = await m.query(`SELECT id FROM department WHERE id = $1 AND is_active`, [dto.departmentId]);
    if (!dept) throw new BadRequestException('Department not found or inactive');
    if (dto.budgetId) {
      const [b] = await m.query(`SELECT department_id FROM budget WHERE id = $1 AND is_active`, [dto.budgetId]);
      if (!b) throw new BadRequestException('Budget not found');
      if (b.department_id !== dto.departmentId) throw new BadRequestException('The budget belongs to another department');
    }
  }

  private header(dto: StaffRequisitionDto, actor: SessionUser, lines: Partial<StaffRequisitionLine>[]) {
    return {
      departmentId: dto.departmentId,
      onBehalfOfDepartment: dto.departmentId !== actor.departmentId,
      projectId: dto.projectId ?? null,
      storeId: dto.storeId ?? null,
      budgetId: dto.budgetId ?? null,
      priority: dto.priority ?? RequisitionPriority.ROUTINE,
      requiredBy: dto.requiredBy ?? null,
      justification: dto.justification.trim(),
      estimatedTotal: round2(lines.reduce((s, l) => s + l.quantity! * l.estimatedUnitCost!, 0)),
    };
  }

  async create(dto: StaffRequisitionDto, actor: SessionUser) {
    const result = await this.ds.transaction(async (m) => {
      await this.validateHeader(m, dto);
      const lines = await this.buildLines(m, dto);
      const r = await m.save(
        m.create(StaffRequisition, {
          number: await this.numbering.next(DocumentType.STAFF_REQUISITION, { manager: m }),
          requestedBy: actor.id,
          status: StaffRequisitionStatus.DRAFT,
          ...this.header(dto, actor, lines),
          lines: lines.map((l) => m.create(StaffRequisitionLine, l)),
        }),
      );
      const warning = dto.submit ? await this.startApproval(m, r) : null;
      return { id: r.id, warning };
    });
    return { ...(await this.get(result.id, actor)), budgetWarning: result.warning };
  }

  /** Requester only, while draft or returned for amendment. */
  async update(id: string, dto: StaffRequisitionDto, actor: SessionUser) {
    const warning = await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can edit this requisition');
      if (!EDITABLE.includes(r.status)) throw new ConflictException(`Requisition is ${r.status}`);
      await this.validateHeader(m, dto);
      const lines = await this.buildLines(m, dto);
      await m.delete(StaffRequisitionLine, { requisitionId: id });
      Object.assign(r, this.header(dto, actor, lines));
      await m.save(r);
      await m.save(lines.map((l) => m.create(StaffRequisitionLine, { ...l, requisitionId: id })));
      return dto.submit ? this.startApproval(m, r) : null;
    });
    return { ...(await this.get(id, actor)), budgetWarning: warning };
  }

  async submit(id: string, actor: SessionUser) {
    const warning = await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can submit this requisition');
      if (!EDITABLE.includes(r.status)) throw new ConflictException(`Requisition is ${r.status}`);
      return this.startApproval(m, r);
    });
    return { ...(await this.get(id, actor)), budgetWarning: warning };
  }

  /** Budget check (warn or block, per the budget's enforcement), then the approval matrix. */
  private async startApproval(m: EntityManager, r: StaffRequisition): Promise<string | null> {
    let warning: string | null = null;
    if (r.budgetId) {
      const check = await this.budgets.check(m, r.budgetId, r.estimatedTotal);
      if (check.blocked) throw new BadRequestException({ message: check.message, code: 'BUDGET_EXCEEDED' });
      warning = check.message;
    }
    const lines = await m.find(StaffRequisitionLine, { where: { requisitionId: r.id } });
    await this.approvals.start(m, {
      documentType: DocumentType.STAFF_REQUISITION,
      documentId: r.id,
      documentNo: r.number,
      amount: r.estimatedTotal,
      departmentId: r.departmentId,
      itemCategoryIds: [...new Set(lines.map((l) => l.categoryId).filter((x): x is string => !!x))],
      requestedBy: r.requestedBy,
      summary: `${r.priority.toLowerCase()} · ${lines.length} line(s) · ${r.justification.slice(0, 100)}`,
      link: `/staff-requisitions/${r.id}`,
    });
    r.status = StaffRequisitionStatus.SUBMITTED;
    r.submittedAt = new Date();
    r.lastComment = null;
    await m.save(r);
    return warning;
  }

  async cancel(id: string, reason: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.requestedBy !== actor.id && !actor.permissions.includes(Permissions.STAFF_REQUISITION_READ_ALL)) throw new ForbiddenException('Only the requester can cancel this requisition');
      if (![...EDITABLE, StaffRequisitionStatus.SUBMITTED, StaffRequisitionStatus.APPROVED].includes(r.status)) {
        throw new ConflictException(r.status === StaffRequisitionStatus.PARTLY_CONVERTED ? 'Part of it is already with the store or procurement' : `Requisition is ${r.status}`);
      }
      const routed = await m.count(StaffRequisitionLine, { where: { requisitionId: id, status: In([StaffRequisitionLineStatus.TO_STORE, StaffRequisitionLineStatus.ON_PR]) } });
      if (routed) throw new ConflictException('Part of it is already with the store or procurement');
      await this.approvals.cancelPending(m, DocumentType.STAFF_REQUISITION, id, actor.id);
      await m.update(StaffRequisitionLine, { requisitionId: id }, { status: StaffRequisitionLineStatus.CANCELLED });
      r.status = StaffRequisitionStatus.CANCELLED;
      r.lastComment = reason;
      await m.save(r);
    });
    return this.get(id, actor);
  }

  // ------------------------------------------------------------------ approval callbacks

  /**
   * Approved: stock lines become an internal store requisition (already
   * approved, stock reserved, the store told); non-stock lines join the
   * procurement queue.
   */
  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const r = await m.findOneByOrFail(StaffRequisition, { id: req.documentId });
    r.status = StaffRequisitionStatus.APPROVED;
    r.approvedAt = new Date();
    r.lastComment = null;
    await m.save(r);
    const lines = await m.find(StaffRequisitionLine, { where: { requisitionId: r.id }, order: { lineNo: 'ASC' } });
    const stock = lines.filter((l) => l.lineType === PurchaseLineType.STOCK && l.status === StaffRequisitionLineStatus.OPEN);
    if (stock.length) {
      const sr = await this.storeRequisitions.createApproved(m, {
        departmentId: r.departmentId,
        storeId: r.storeId!,
        priority: r.priority,
        requiredBy: r.requiredBy,
        notes: `From ${r.number}: ${r.justification}`.slice(0, 1000),
        requestedBy: r.requestedBy,
        lines: stock.map((l) => ({ itemId: l.itemId!, quantity: l.quantity, notes: l.notes })),
      });
      const srLines: { id: string; line_no: number }[] = await m.query(`SELECT id, line_no FROM store_requisition_line WHERE requisition_id = $1`, [sr.id]);
      for (const [i, l] of stock.entries()) {
        l.status = StaffRequisitionLineStatus.TO_STORE;
        l.storeRequisitionLineId = srLines.find((x) => x.line_no === i + 1)?.id ?? null;
      }
      await m.save(stock);
      r.storeRequisitionId = sr.id;
      await m.save(r);
      await this.links.link(m, { type: DocumentType.STAFF_REQUISITION, id: r.id, no: r.number }, { type: DocumentType.STORE_REQUISITION, id: sr.id, no: sr.number });
    }
    const status = await refreshStaffRequisitionStatus(m, r.id);
    const toBuy = lines.filter((l) => l.lineType !== PurchaseLineType.STOCK).length;
    // (The approval engine already says "approved"; this says where it went.)
    await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.REQUISITIONS, {
      title: `${r.number}: next steps`,
      body: [stock.length ? `${stock.length} stock item(s) sent to the store` : null, toBuy ? `${toBuy} line(s) passed to procurement` : null].filter(Boolean).join('; '),
      link: `/staff-requisitions/${r.id}`,
    });
    if (toBuy) {
      // Tell procurement there is something to buy.
      const desk: { user_id: string }[] = await m.query(
        `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
        [Permissions.PURCHASING_CONSOLIDATE],
      );
      await this.notifications.notify(m, desk.map((d) => d.user_id), { title: `To buy: ${r.number}`, body: `${toBuy} non-stock line(s) approved (${status.toLowerCase()})`, link: '/procurement-queue' });
    }
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const r = await m.findOneByOrFail(StaffRequisition, { id: req.documentId });
    r.status = StaffRequisitionStatus.REJECTED;
    r.lastComment = comment;
    await m.save(r);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const r = await m.findOneByOrFail(StaffRequisition, { id: req.documentId });
    r.status = StaffRequisitionStatus.RETURNED;
    r.lastComment = comment;
    await m.save(r);
  }

  // ------------------------------------------------------------------ procurement queue and consolidation

  /** Approved non-stock lines not yet on a purchase requisition. */
  async queue(q: QueueQueryDto) {
    const params: unknown[] = [IN_PROCUREMENT];
    const where = [`r.status = ANY($1::staff_requisition_status[])`, `l.status = 'OPEN'`, `l.line_type <> 'STOCK'`];
    if (q.departmentId) where.push(`r.department_id = $${params.push(q.departmentId)}`);
    if (q.lineType) where.push(`l.line_type = $${params.push(q.lineType)}`);
    if (q.search) where.push(`(l.description ILIKE $${params.push(likeTerm(q.search))} OR r.number ILIKE $${params.length})`);
    const from = `FROM staff_requisition_line l JOIN staff_requisition r ON r.id = l.requisition_id JOIN department d ON d.id = r.department_id
      JOIN app_user u ON u.id = r.requested_by LEFT JOIN gl_account g ON g.id = l.gl_account_id LEFT JOIN unit_of_measure uom ON uom.id = l.uom_id
      LEFT JOIN item_category c ON c.id = l.category_id LEFT JOIN project p ON p.id = r.project_id WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const items = await this.ds.query(
      `SELECT l.id, l.line_type AS "lineType", l.description, l.quantity::float AS quantity, uom.code AS uom, l.estimated_unit_cost::float AS "estimatedUnitCost",
              ROUND(l.quantity * l.estimated_unit_cost, 2)::float AS "estimatedTotal", c.name AS category, g.code AS "glCode", g.name AS "glName",
              r.id AS "requisitionId", r.number AS "requisitionNo", r.priority, r.required_by AS "requiredBy", r.approved_at AS "approvedAt",
              d.id AS "departmentId", d.name AS department, u.full_name AS "requestedBy", p.code AS project
         ${from} ORDER BY r.priority DESC, r.approved_at, l.line_no LIMIT $${params.push(q.pageSize)} OFFSET $${params.push((q.page - 1) * q.pageSize)}`,
      params,
    );
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /**
   * One purchase requisition (DRAFT, for procurement to submit) from approved
   * non-stock lines of any departments; each PR line keeps its source line.
   */
  async consolidate(dto: ConsolidateDto, actor: SessionUser) {
    const prId = await this.ds.transaction(async (m) => {
      const ids = [...new Set(dto.lineIds)];
      const lines: (StaffRequisitionLine & { requisition: StaffRequisition })[] = (await m
        .getRepository(StaffRequisitionLine)
        .createQueryBuilder('l')
        .innerJoinAndSelect('l.requisition', 'r')
        .where('l.id IN (:...ids)', { ids })
        .setLock('pessimistic_write', undefined, ['l'])
        .getMany()) as never;
      if (lines.length !== ids.length) throw new NotFoundException('A requisition line was not found');
      for (const l of lines) {
        if (l.lineType === PurchaseLineType.STOCK) throw new BadRequestException(`${l.requisition.number} line ${l.lineNo} is a stock line (it goes to the store)`);
        if (!IN_PROCUREMENT.includes(l.requisition.status)) throw new ConflictException(`${l.requisition.number} is ${l.requisition.status}`);
        if (l.status !== StaffRequisitionLineStatus.OPEN) throw new ConflictException(`${l.requisition.number} line ${l.lineNo} is already ${l.status}`);
      }
      const [dept] = await m.query(`SELECT id FROM department WHERE id = $1 AND is_active`, [dto.departmentId]);
      if (!dept) throw new BadRequestException('Department not found or inactive');
      const [store] = await m.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
      if (!store) throw new BadRequestException('Store not found or inactive');
      if (dto.suggestedSupplierIds?.length) {
        const found: { id: string }[] = await m.query(`SELECT id FROM supplier WHERE id = ANY($1::uuid[])`, [dto.suggestedSupplierIds]);
        if (found.length !== new Set(dto.suggestedSupplierIds).size) throw new BadRequestException('A suggested supplier was not found');
      }
      const ordered = [...lines].sort((a, b) => a.requisition.number.localeCompare(b.requisition.number) || a.lineNo - b.lineNo);
      const pr = await m.save(
        m.create(PurchaseRequisition, {
          number: await this.numbering.next(DocumentType.PURCHASE_REQUISITION, { storeId: dto.storeId, manager: m }),
          departmentId: dto.departmentId,
          storeId: dto.storeId,
          budgetId: dto.budgetId ?? null,
          priority: dto.priority ?? ordered.reduce<RequisitionPriority>((p, l) => (rank(l.requisition.priority) > rank(p) ? l.requisition.priority : p), RequisitionPriority.ROUTINE),
          requiredBy: dto.requiredBy ?? ordered.map((l) => l.requisition.requiredBy).filter((x): x is string => !!x).sort()[0] ?? null,
          justification: dto.justification.trim(),
          sourcingMethod: dto.sourcingMethod ?? null,
          sourcingJustification: dto.sourcingJustification ?? null,
          suggestedSupplierIds: [...new Set(dto.suggestedSupplierIds ?? [])],
          requestedBy: actor.id,
          status: RequisitionStatus.DRAFT,
          estimatedTotal: round2(ordered.reduce((s, l) => s + l.quantity * l.estimatedUnitCost, 0)),
          lines: ordered.map((l) =>
            m.create(PurchaseRequisitionLine, {
              lineType: l.lineType,
              itemId: l.itemId,
              description: l.description,
              categoryId: l.categoryId,
              uomId: l.uomId,
              glAccountId: l.glAccountId,
              projectId: l.requisition.projectId,
              sourceRequisitionLineId: l.id,
              quantity: l.quantity,
              estimatedUnitPrice: l.estimatedUnitCost,
              notes: `${l.requisition.number}/${l.lineNo}${l.notes ? ` · ${l.notes}` : ''}`.slice(0, 500),
            }),
          ),
        }),
      );
      const prLines = await m.find(PurchaseRequisitionLine, { where: { requisitionId: pr.id } });
      for (const l of ordered) {
        await m.update(StaffRequisitionLine, { id: l.id }, { status: StaffRequisitionLineStatus.ON_PR, prLineId: prLines.find((p) => p.sourceRequisitionLineId === l.id)!.id });
      }
      const reqs = [...new Map(ordered.map((l) => [l.requisition.id, l.requisition])).values()];
      for (const r of reqs) {
        await refreshStaffRequisitionStatus(m, r.id);
        await this.links.link(m, { type: DocumentType.STAFF_REQUISITION, id: r.id, no: r.number }, { type: DocumentType.PURCHASE_REQUISITION, id: pr.id, no: pr.number });
        await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.REQUISITIONS, {
          title: `${r.number}: with procurement on ${pr.number}`,
          body: `${ordered.filter((l) => l.requisition.id === r.id).length} line(s) are being bought`,
          link: `/staff-requisitions/${r.id}`,
        });
      }
      return pr.id;
    });
    return this.ds.getRepository(PurchaseRequisition).findOneOrFail({ where: { id: prId }, relations: { lines: true, department: true, store: true } });
  }

  // ------------------------------------------------------------------ reading

  private async lock(m: EntityManager, id: string): Promise<StaffRequisition> {
    const r = await m.findOne(StaffRequisition, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Requisition not found');
    return r;
  }

  async get(id: string, actor: SessionUser) {
    const r = await this.ds.getRepository(StaffRequisition).findOne({
      where: { id },
      relations: { department: true, project: true, store: true, lines: { item: true, uom: true, category: true, glAccount: true } },
    });
    if (!r) throw new NotFoundException('Requisition not found');
    await this.assertCanSee(r, actor);
    r.lines?.sort((a, b) => a.lineNo - b.lineNo);
    const [who] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [r.requestedBy]);
    // Where each line went: its PR (and number) or store requisition.
    const routes: { line_id: string; pr_id: string | null; pr_no: string | null; pr_status: string | null; sr_id: string | null; sr_no: string | null }[] = await this.ds.query(
      `SELECT sl.id AS line_id, pr.id AS pr_id, pr.number AS pr_no, pr.status AS pr_status, sr.id AS sr_id, sr.number AS sr_no
         FROM staff_requisition_line sl
         LEFT JOIN purchase_requisition_line pl ON pl.id = sl.pr_line_id LEFT JOIN purchase_requisition pr ON pr.id = pl.requisition_id
         LEFT JOIN store_requisition_line srl ON srl.id = sl.store_requisition_line_id LEFT JOIN store_requisition sr ON sr.id = srl.requisition_id
        WHERE sl.requisition_id = $1`,
      [id],
    );
    return {
      ...r,
      requestedByName: who?.full_name ?? null,
      lines: r.lines?.map((l) => {
        const route = routes.find((x) => x.line_id === l.id);
        return { ...l, purchaseRequisition: route?.pr_id ? { id: route.pr_id, number: route.pr_no, status: route.pr_status } : null, storeRequisition: route?.sr_id ? { id: route.sr_id, number: route.sr_no } : null };
      }),
    };
  }

  async list(q: StaffRequisitionQueryDto, actor: SessionUser): Promise<Paginated<StaffRequisition & { requestedByName: string }>> {
    const scope = q.scope ?? 'mine';
    if (scope === 'all' && !actor.permissions.includes(Permissions.STAFF_REQUISITION_READ_ALL)) throw new ForbiddenException('You cannot see every department’s requisitions');
    const qb = this.ds
      .getRepository(StaffRequisition)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.department', 'department')
      .orderBy('r.createdAt', 'DESC');
    if (scope === 'mine') qb.andWhere('r.requested_by = :me', { me: actor.id });
    if (scope === 'department') {
      if (!actor.departmentId) throw new BadRequestException('You do not belong to a department');
      qb.andWhere('r.department_id = :dep', { dep: actor.departmentId });
    }
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.departmentId) qb.andWhere('r.department_id = :d', { d: q.departmentId });
    if (q.search) qb.andWhere('(r.number ILIKE :q OR r.justification ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    const names: { id: string; full_name: string }[] = items.length ? await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [items.map((i) => i.requestedBy)]) : [];
    return { items: items.map((i) => ({ ...i, requestedByName: names.find((n) => n.id === i.requestedBy)?.full_name ?? '' })), total, page: q.page, pageSize: q.pageSize };
  }

  /** Printable requisition with the approval signatures. */
  async renderPdf(id: string, actor: SessionUser): Promise<Buffer> {
    const r = await this.get(id, actor);
    const history = await this.approvals.history(DocumentType.STAFF_REQUISITION, id);
    const approvals = history.flatMap((h) => h.actions.filter((a) => a.action === 'APPROVE').map((a) => ({ step: a.stepName ?? '', name: a.userName ?? '', at: a.at })));
    const [facility] = await this.ds.query(`SELECT name FROM facility ORDER BY created_at LIMIT 1`);
    return this.pdf.render(renderStaffRequisitionHtml(r, approvals, facility?.name ?? 'Hospital', await this.settings.get('locale.currency')));
  }
}

const rank = (p: RequisitionPriority) => [RequisitionPriority.ROUTINE, RequisitionPriority.URGENT, RequisitionPriority.EMERGENCY].indexOf(p);

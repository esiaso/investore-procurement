import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, Paginated, Permissions, RequisitionPriority, SessionUser, StoreRequisitionStatus } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { assertCanSee, assertOwnDepartment, scopeClause } from './access';
import { outstanding, ReservationsService } from './reservations.service';
import { CancelLinesDto, CreateStoreRequisitionDto, StoreRequisitionQueryDto } from './stores.dto';
import { StoreRequisition, StoreRequisitionLine } from './stores.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

const EDITABLE = [StoreRequisitionStatus.DRAFT, StoreRequisitionStatus.RETURNED];
/** Statuses in which stock can be issued. */
export const ISSUABLE = [StoreRequisitionStatus.APPROVED, StoreRequisitionStatus.PARTIALLY_ISSUED];

/**
 * Internal (S11-style) requisitions from a department to a store or pharmacy:
 * DRAFT → PENDING_APPROVAL (department in-charge via the approval engine,
 * requester ≠ approver) → APPROVED (stock reserved, FEFO) → PARTIALLY_ISSUED
 * (the rest stays on back-order) → ISSUED, or CLOSED when a back-order is cancelled.
 */
@Injectable()
export class StoreRequisitionsService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly reservations: ReservationsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.STORE_REQUISITION, this);
    this.links.registerResolver(DocumentType.STORE_REQUISITION, async (ids) => {
      const rows = await this.ds.getRepository(StoreRequisition).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString(), amount: r.estimatedValue }]));
    });
  }

  private async validate(m: EntityManager, dto: CreateStoreRequisitionDto, actor: SessionUser) {
    assertOwnDepartment(actor, dto.departmentId);
    const [dept] = await m.query(`SELECT id FROM department WHERE id = $1 AND is_active`, [dto.departmentId]);
    if (!dept) throw new BadRequestException('Department not found or inactive');
    const [store] = await m.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
    if (!store) throw new BadRequestException('Store not found or inactive');
    const ids = dto.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each item may appear only once');
    const items: { id: string; code: string; is_active: boolean; cost: string }[] = await m.query(
      `SELECT i.id, i.code, i.is_active, COALESCE(c.avg_cost, i.unit_price) AS cost
         FROM item i LEFT JOIN item_store_cost c ON c.item_id = i.id AND c.store_id = $2
        WHERE i.id = ANY($1::uuid[])`,
      [ids, dto.storeId],
    );
    let value = 0;
    for (const l of dto.lines) {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) throw new NotFoundException(`Item ${l.itemId} not found`);
      if (!item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
      value += l.quantity * Number(item.cost);
    }
    return round2(value);
  }

  private lineEntities(m: EntityManager, dto: CreateStoreRequisitionDto) {
    return dto.lines.map((l, i) =>
      m.create(StoreRequisitionLine, {
        lineNo: i + 1,
        itemId: l.itemId,
        requestedQty: l.quantity,
        patientRef: l.patientRef?.trim() || null,
        notes: l.notes ?? null,
      }),
    );
  }

  async create(dto: CreateStoreRequisitionDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const value = await this.validate(m, dto, actor);
      const sr = await m.save(
        m.create(StoreRequisition, {
          number: await this.numbering.next(DocumentType.STORE_REQUISITION, { storeId: dto.storeId, manager: m }),
          departmentId: dto.departmentId,
          storeId: dto.storeId,
          priority: dto.priority ?? RequisitionPriority.ROUTINE,
          requiredBy: dto.requiredBy ?? null,
          notes: dto.notes ?? null,
          requestedBy: actor.id,
          estimatedValue: value,
          status: StoreRequisitionStatus.DRAFT,
          lines: this.lineEntities(m, dto),
        }),
      );
      if (dto.submit) await this.startApproval(m, sr);
      return sr.id;
    });
    return this.get(id, actor);
  }

  /** Requester only, while draft or returned. */
  async update(id: string, dto: CreateStoreRequisitionDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const sr = await this.lock(m, id);
      if (sr.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can edit this requisition');
      if (!EDITABLE.includes(sr.status)) throw new ConflictException(`Requisition is ${sr.status}`);
      if (dto.storeId !== sr.storeId) throw new BadRequestException('The issuing store cannot be changed; cancel and raise a new requisition');
      const value = await this.validate(m, dto, actor);
      await m.delete(StoreRequisitionLine, { requisitionId: id });
      Object.assign(sr, {
        departmentId: dto.departmentId,
        priority: dto.priority ?? sr.priority,
        requiredBy: dto.requiredBy ?? null,
        notes: dto.notes ?? null,
        estimatedValue: value,
      });
      await m.save(sr);
      await m.save(this.lineEntities(m, dto).map((l) => Object.assign(l, { requisitionId: id })));
      if (dto.submit) await this.startApproval(m, sr);
    });
    return this.get(id, actor);
  }

  async submit(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const sr = await this.lock(m, id);
      if (sr.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can submit this requisition');
      if (!EDITABLE.includes(sr.status)) throw new ConflictException(`Requisition is ${sr.status}`);
      await this.startApproval(m, sr);
    });
    return this.get(id, actor);
  }

  private async startApproval(m: EntityManager, sr: StoreRequisition) {
    const categories: { category_id: string }[] = await m.query(
      `SELECT DISTINCT i.category_id FROM store_requisition_line l JOIN item i ON i.id = l.item_id WHERE l.requisition_id = $1`,
      [sr.id],
    );
    const [store] = await m.query(`SELECT name FROM store WHERE id = $1`, [sr.storeId]);
    await this.approvals.start(m, {
      documentType: DocumentType.STORE_REQUISITION,
      documentId: sr.id,
      documentNo: sr.number,
      amount: sr.estimatedValue,
      departmentId: sr.departmentId,
      itemCategoryIds: categories.map((c) => c.category_id),
      requestedBy: sr.requestedBy,
      summary: `${sr.priority.toLowerCase()} · from ${store?.name ?? 'store'}`,
      link: `/store-requisitions/${sr.id}`,
    });
    sr.status = StoreRequisitionStatus.PENDING_APPROVAL;
    await m.save(sr);
  }

  /** Before anything is issued: the requester, or the issuing store. */
  async cancel(id: string, reason: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const sr = await this.lock(m, id);
      this.assertRequesterOrStore(sr, actor);
      const allowed = [...EDITABLE, StoreRequisitionStatus.PENDING_APPROVAL, StoreRequisitionStatus.APPROVED];
      if (!allowed.includes(sr.status)) {
        throw new ConflictException(
          sr.status === StoreRequisitionStatus.PARTIALLY_ISSUED ? 'Stock has been issued: cancel the back-order instead' : `Requisition is ${sr.status}`,
        );
      }
      await this.approvals.cancelPending(m, DocumentType.STORE_REQUISITION, id, actor.id);
      await this.reservations.release(m, id);
      sr.status = StoreRequisitionStatus.CANCELLED;
      sr.lastComment = reason;
      await m.save(sr);
    });
    return this.get(id, actor);
  }

  /** Cancels the outstanding quantity (back-order) of some or all lines and releases its reservations. */
  async cancelBackorders(id: string, dto: CancelLinesDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const sr = await this.lock(m, id);
      this.assertRequesterOrStore(sr, actor);
      if (!ISSUABLE.includes(sr.status)) throw new ConflictException(`Requisition is ${sr.status}`);
      const lines = await m.find(StoreRequisitionLine, { where: { requisitionId: id } });
      const targets = dto.lineIds?.length ? lines.filter((l) => dto.lineIds!.includes(l.id)) : lines;
      if (dto.lineIds?.length && targets.length !== dto.lineIds.length) throw new BadRequestException('A line is not on this requisition');
      const open = targets.filter((l) => outstanding(l) > 0);
      if (!open.length) throw new BadRequestException('Nothing outstanding to cancel');
      await this.reservations.release(m, id, open.map((l) => l.id));
      for (const l of open) {
        l.cancelledQty = round4(l.cancelledQty + outstanding(l));
        l.cancelReason = dto.reason;
      }
      await m.save(open);
      await this.refreshStatus(m, sr);
      await this.notifications.notify(m, [sr.requestedBy].filter((u) => u !== actor.id), {
        title: `${sr.number}: back-order cancelled`,
        body: dto.reason,
        link: `/store-requisitions/${sr.id}`,
      });
    });
    return this.get(id, actor);
  }

  /** Re-plans reservations (e.g. after new stock arrived for a back-order). */
  async refreshReservations(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const sr = await this.lock(m, id);
      StoreScope.assert(sr.storeId);
      if (!ISSUABLE.includes(sr.status)) throw new ConflictException(`Requisition is ${sr.status}`);
      await this.reservations.release(m, id);
      await this.reservations.reserve(m, sr, await this.settings.today(m));
    });
    return this.get(id, actor);
  }

  private assertRequesterOrStore(sr: StoreRequisition, actor: SessionUser) {
    const isStore = actor.permissions.includes(Permissions.INVENTORY_ISSUE) && StoreScope.allows(actor.storeIds, sr.storeId);
    if (sr.requestedBy !== actor.id && !isStore) throw new ForbiddenException('Only the requester or the issuing store can do this');
  }

  /** Status from the line quantities (after an issue or a back-order cancellation). */
  async refreshStatus(m: EntityManager, sr: StoreRequisition): Promise<StoreRequisitionStatus> {
    const lines = await m.find(StoreRequisitionLine, { where: { requisitionId: sr.id } });
    const issued = lines.some((l) => l.issuedQty > 0);
    const open = lines.some((l) => outstanding(l) > 0);
    const cancelled = lines.some((l) => l.cancelledQty > 0);
    sr.status = open
      ? issued
        ? StoreRequisitionStatus.PARTIALLY_ISSUED
        : StoreRequisitionStatus.APPROVED
      : cancelled
        ? issued
          ? StoreRequisitionStatus.CLOSED
          : StoreRequisitionStatus.CANCELLED
        : StoreRequisitionStatus.ISSUED;
    await m.save(sr);
    return sr.status;
  }

  // ------------------------------------------------------------------ approval callbacks

  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const sr = await m.findOneByOrFail(StoreRequisition, { id: req.documentId });
    sr.status = StoreRequisitionStatus.APPROVED;
    sr.approvedAt = new Date();
    sr.lastComment = null;
    await m.save(sr);
    if (await this.settings.get('inventory.reserveOnApproval', m)) {
      await this.reservations.reserve(m, sr, await this.settings.today(m));
    }
    // Tell the issuing store there is work.
    const storeUsers: { user_id: string }[] = await m.query(
      `SELECT DISTINCT us.user_id FROM user_store us
         JOIN user_role ur ON ur.user_id = us.user_id
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $2
         JOIN app_user u ON u.id = us.user_id AND u.is_active
        WHERE us.store_id = $1`,
      [sr.storeId, Permissions.INVENTORY_ISSUE],
    );
    await this.notifications.notify(m, storeUsers.map((u) => u.user_id), {
      title: `To issue: ${sr.number}`,
      body: `${sr.priority.toLowerCase()} requisition approved`,
      link: `/store-requisitions/${sr.id}`,
    });
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const sr = await m.findOneByOrFail(StoreRequisition, { id: req.documentId });
    sr.status = StoreRequisitionStatus.REJECTED;
    sr.lastComment = comment;
    await m.save(sr);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const sr = await m.findOneByOrFail(StoreRequisition, { id: req.documentId });
    sr.status = StoreRequisitionStatus.RETURNED;
    sr.lastComment = comment;
    await m.save(sr);
  }

  // ------------------------------------------------------------------ queries

  async lock(m: EntityManager, id: string): Promise<StoreRequisition> {
    const sr = await m.findOne(StoreRequisition, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!sr) throw new NotFoundException('Requisition not found');
    return sr;
  }

  /** With per-line outstanding, reserved and currently available (usable, unreserved) stock. */
  async get(id: string, actor: SessionUser) {
    const sr = await this.ds.getRepository(StoreRequisition).findOne({
      where: { id },
      relations: { department: true, store: true, lines: { item: { baseUom: true } } },
      order: { lines: { lineNo: 'ASC' } },
    });
    if (!sr) throw new NotFoundException('Requisition not found');
    assertCanSee(actor, sr, 'Requisition');
    const today = await this.settings.today();
    const itemIds = (sr.lines ?? []).map((l) => l.itemId);
    const available: { item_id: string; q: number }[] = itemIds.length
      ? await this.ds.query(
          `SELECT sb.item_id, COALESCE(SUM(sb.on_hand - sb.reserved), 0)::float AS q
             FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
            WHERE sb.store_id = $1 AND sb.item_id = ANY($2::uuid[]) AND b.hold_status = 'NONE'
              AND NOT COALESCE(bn.is_quarantine, false) AND (b.expiry_date IS NULL OR b.expiry_date > $3::date)
            GROUP BY sb.item_id`,
          [sr.storeId, itemIds, today],
        )
      : [];
    const reservations = await this.reservations.forRequisition(this.ds.manager, id);
    const [requester] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [sr.requestedBy]);
    const issues = await this.ds.query(
      `SELECT id, number, to_char(issue_date, 'YYYY-MM-DD') AS "issueDate", total_value::float AS "totalValue"
         FROM issue_voucher WHERE requisition_id = $1 ORDER BY created_at`,
      [id],
    );
    return {
      ...sr,
      requestedByName: requester?.full_name ?? null,
      issues,
      lines: (sr.lines ?? []).map((l) => {
        const held = reservations.filter((r: { requisitionLineId: string }) => r.requisitionLineId === l.id);
        return {
          ...l,
          outstandingQty: outstanding(l),
          reservedQty: round4(held.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0)),
          reservations: held,
          availableQty: available.find((a) => a.item_id === l.itemId)?.q ?? 0,
        };
      }),
    };
  }

  async list(q: StoreRequisitionQueryDto, actor: SessionUser): Promise<Paginated<StoreRequisition>> {
    const qb = this.ds
      .getRepository(StoreRequisition)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.department', 'department')
      .leftJoinAndSelect('r.store', 'store')
      .orderBy('r.createdAt', 'DESC');
    const scope = scopeClause(actor, 'r');
    if (scope) qb.andWhere(scope.sql, scope.params);
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.open) qb.andWhere(`r.status IN (:...open)`, { open: ISSUABLE });
    if (q.storeId) qb.andWhere('r.store_id = :s', { s: q.storeId });
    if (q.departmentId) qb.andWhere('r.department_id = :d', { d: q.departmentId });
    if (q.search) qb.andWhere('(r.number ILIKE :q OR r.notes ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Lines still owed to departments after a partial issue. */
  async backorders(q: StoreRequisitionQueryDto, actor: SessionUser) {
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = [`r.status = 'PARTIALLY_ISSUED'`, `l.requested_qty - l.issued_qty - l.cancelled_qty > 0`];
    if (actor.storeIds !== null) {
      where.push(`(r.store_id = ANY(${p(actor.storeIds)}::uuid[]) OR r.department_id = ${p(actor.departmentId ?? null)})`);
    }
    if (q.storeId) where.push(`r.store_id = ${p(q.storeId)}`);
    if (q.departmentId) where.push(`r.department_id = ${p(q.departmentId)}`);
    if (q.search) where.push(`(r.number ILIKE ${p(likeTerm(q.search))} OR i.name ILIKE ${p(likeTerm(q.search))})`);
    const today = p(await this.settings.today());
    return this.ds.query(
      `SELECT l.id AS "lineId", r.id AS "requisitionId", r.number, r.priority, to_char(r.required_by, 'YYYY-MM-DD') AS "requiredBy",
              d.name AS "department", s.id AS "storeId", s.name AS "store", i.id AS "itemId", i.code AS "itemCode", i.name AS "itemName", u.code AS uom,
              l.requested_qty::float AS "requestedQty", l.issued_qty::float AS "issuedQty",
              (l.requested_qty - l.issued_qty - l.cancelled_qty)::float AS "outstandingQty",
              COALESCE((SELECT SUM(x.quantity) FROM stock_reservation x WHERE x.requisition_line_id = l.id AND x.released_at IS NULL), 0)::float AS "reservedQty",
              COALESCE((SELECT SUM(sb.on_hand - sb.reserved) FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
                         WHERE sb.store_id = r.store_id AND sb.item_id = l.item_id AND b.hold_status = 'NONE' AND NOT COALESCE(bn.is_quarantine, false)
                           AND (b.expiry_date IS NULL OR b.expiry_date > ${today}::date)), 0)::float AS "availableQty",
              (CURRENT_DATE - r.approved_at::date) AS "ageDays"
         FROM store_requisition_line l
         JOIN store_requisition r ON r.id = l.requisition_id
         JOIN department d ON d.id = r.department_id
         JOIN store s ON s.id = r.store_id
         JOIN item i ON i.id = l.item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.priority DESC, r.approved_at
        LIMIT 500`,
      params,
    );
  }
}

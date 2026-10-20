import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { ContractStatus, ContractType, DocumentType, NotificationCategory, Permissions, PurchaseOrderSource, SessionUser, VariationStatus } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { UnitsService } from '../catalog/units.service';
import { NumberingService } from '../numbering/numbering.service';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { SettingsService } from '../settings/settings.service';
import { Contract, ContractLine, ContractMilestone, ContractVariation, PerformanceSecurity } from './contracts.entities';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface ContractInput {
  title: string;
  supplierId: string;
  type: ContractType;
  startDate: string;
  endDate: string;
  value: number;
  deliveryTerms?: string | null;
  paymentTermsDays?: number | null;
  leadTimeDays?: number | null;
  lines: { itemId: string; unitPrice: number; quantity?: number | null; brand?: string | null }[];
}

/** Base units ordered against each contract line (POs that are not cancelled / rejected). */
export async function calledOff(m: EntityManager, lineIds: string[]): Promise<Map<string, number>> {
  if (!lineIds.length) return new Map();
  const rows: { id: string; q: number }[] = await m.query(
    `SELECT l.contract_line_id AS id, SUM(l.quantity * l.conversion_factor)::float AS q
       FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id
      WHERE l.contract_line_id = ANY($1::uuid[]) AND po.status NOT IN ('CANCELLED', 'REJECTED')
      GROUP BY l.contract_line_id`,
    [lineIds],
  );
  return new Map(rows.map((r) => [r.id, r4(r.q)]));
}

/**
 * Contracts and framework agreements: agreed prices and quantities, validity,
 * performance securities, milestones, call-off orders (→ purchase orders) with
 * remaining balances, variations through approval, expiry alerts.
 */
@Injectable()
export class ContractsService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly orders: PurchaseOrdersService,
    private readonly units: UnitsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.CONTRACT_VARIATION, this);
    for (const type of [DocumentType.CONTRACT, DocumentType.CONTRACT_VARIATION]) {
      this.links.registerResolver(type, async (ids) => {
        const rows = type === DocumentType.CONTRACT ? await this.ds.getRepository(Contract).findBy({ id: In(ids) }) : await this.ds.getRepository(ContractVariation).findBy({ id: In(ids) });
        return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString().slice(0, 10), amount: 'value' in r ? r.value : r.valueChange }]));
      });
    }
  }

  private async lock(m: EntityManager, id: string) {
    const c = await m.findOne(Contract, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!c) throw new NotFoundException('Contract not found');
    return c;
  }

  /** A contract made outside the tender module (e.g. direct procurement or an RFQ framework). Starts as DRAFT. */
  async create(dto: ContractInput) {
    if (dto.endDate < dto.startDate) throw new BadRequestException('End date before start date');
    if (!dto.lines.length) throw new BadRequestException('A contract needs at least one item');
    const id = await this.ds.transaction(async (m) => {
      const c = await m.save(
        m.create(Contract, {
          number: await this.numbering.next(DocumentType.CONTRACT, { manager: m }),
          ...dto,
          deliveryTerms: dto.deliveryTerms ?? null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          leadTimeDays: dto.leadTimeDays ?? null,
          status: ContractStatus.DRAFT,
          lines: dto.lines.map((l) => m.create(ContractLine, { itemId: l.itemId, unitPrice: l.unitPrice, quantity: l.quantity ?? null, brand: l.brand ?? null })),
        }),
      );
      return c.id;
    });
    return this.get(id);
  }

  async sign(id: string, dto: { supplierSignatory: string }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.status !== ContractStatus.DRAFT) throw new ConflictException(`Contract is ${c.status}`);
      const overlap = await m.query(
        `SELECT c.number FROM contract c JOIN contract_line l ON l.contract_id = c.id
          WHERE c.status = 'ACTIVE' AND c.supplier_id = $1 AND c.id <> $2 AND c.start_date <= $4 AND c.end_date >= $3
            AND l.item_id IN (SELECT item_id FROM contract_line WHERE contract_id = $2) LIMIT 1`,
        [c.supplierId, c.id, c.startDate, c.endDate],
      );
      if (overlap.length) throw new ConflictException(`Contract ${overlap[0].number} already covers some of these items for this supplier in that period`);
      Object.assign(c, { status: ContractStatus.ACTIVE, signedAt: new Date(), signedBy: actor.id, supplierSignatory: dto.supplierSignatory });
      await m.save(c);
    });
    return this.get(id);
  }

  async terminate(id: string, reason: string) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.status !== ContractStatus.ACTIVE) throw new ConflictException(`Contract is ${c.status}`);
      Object.assign(c, { status: ContractStatus.TERMINATED, terminationReason: reason });
      await m.save(c);
    });
    return this.get(id);
  }

  list(q: { status?: string; supplierId?: string; type?: string; search?: string }) {
    const qb = this.ds.getRepository(Contract).createQueryBuilder('c').leftJoinAndSelect('c.supplier', 'supplier').orderBy('c.endDate', 'ASC').take(500);
    if (q.status) qb.andWhere('c.status = :s', { s: q.status });
    if (q.supplierId) qb.andWhere('c.supplier_id = :sup', { sup: q.supplierId });
    if (q.type) qb.andWhere('c.type = :t', { t: q.type });
    if (q.search) qb.andWhere('(c.number ILIKE :q OR c.title ILIKE :q OR supplier.name ILIKE :q)', { q: `%${q.search}%` });
    return qb.getMany();
  }

  async get(id: string, m: EntityManager = this.ds.manager) {
    const c = await m.findOne(Contract, { where: { id }, relations: { supplier: true, lines: { item: { baseUom: true } } } });
    if (!c) throw new NotFoundException('Contract not found');
    const used = await calledOff(m, (c.lines ?? []).map((l) => l.id));
    const securities = await m.find(PerformanceSecurity, { where: { contractId: id }, order: { expiresOn: 'ASC' } });
    const milestones = await m.find(ContractMilestone, { where: { contractId: id }, order: { dueDate: 'ASC' } });
    const variations = await m.find(ContractVariation, { where: { contractId: id }, order: { createdAt: 'ASC' } });
    const callOffs = await m.query(
      `SELECT DISTINCT po.id, po.number, po.status, po.order_date AS "orderDate", po.total::float AS total, s.name AS store
         FROM purchase_order po JOIN store s ON s.id = po.store_id
        WHERE po.contract_id = $1 OR po.id IN (SELECT purchase_order_id FROM purchase_order_line WHERE contract_line_id = ANY($2::uuid[]))
        ORDER BY po.order_date`,
      [id, (c.lines ?? []).map((l) => l.id)],
    );
    const lines = (c.lines ?? []).map((l) => {
      const q = used.get(l.id) ?? 0;
      return { ...l, calledOffQty: q, remainingQty: l.quantity === null ? null : r4(l.quantity - q), calledOffValue: r2(q * l.unitPrice) };
    });
    const calledOffValue = r2(lines.reduce((s, l) => s + l.calledOffValue, 0));
    return { ...c, lines, securities, milestones, variations, callOffs, calledOffValue, remainingValue: r2(c.value - calledOffValue) };
  }

  /**
   * Call-off order: a draft PO at the contract prices (converted to the
   * ordering unit) for quantities within the remaining balances.
   */
  async callOff(id: string, dto: { storeId: string; departmentId: string; budgetId?: string | null; expectedDelivery?: string | null; notes?: string | null; lines: { contractLineId: string; quantity: number; uomId?: string | null }[] }, actor: SessionUser) {
    StoreScope.assert(dto.storeId);
    const poId = await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.status !== ContractStatus.ACTIVE) throw new ConflictException(`Contract is ${c.status}`);
      const today = await this.settings.today(m);
      if (today < c.startDate || today > c.endDate) throw new ConflictException(`The contract is valid ${c.startDate} to ${c.endDate}`);
      const cLines = await m.find(ContractLine, { where: { contractId: id } });
      const used = await calledOff(m, cLines.map((l) => l.id));
      let value = 0;
      const draft = [];
      for (const l of dto.lines) {
        const cl = cLines.find((x) => x.id === l.contractLineId);
        if (!cl) throw new BadRequestException('A line is not on this contract');
        const factor = l.uomId ? await this.units.factorToBase(cl.itemId, l.uomId) : 1;
        const base = r4(l.quantity * factor);
        const left = cl.quantity === null ? Infinity : r4(cl.quantity - (used.get(cl.id) ?? 0));
        if (base > left) throw new BadRequestException({ code: 'CONTRACT_BALANCE', message: `Only ${left} base units remain on the contract for this item` });
        used.set(cl.id, r4((used.get(cl.id) ?? 0) + base));
        value += base * cl.unitPrice;
        draft.push({ itemId: cl.itemId, uomId: l.uomId ?? null, quantity: l.quantity, unitPrice: r4(cl.unitPrice * factor), contractLineId: cl.id });
      }
      const allUsed = await calledOff(m, cLines.map((l) => l.id));
      const already = cLines.reduce((s, l) => s + (allUsed.get(l.id) ?? 0) * l.unitPrice, 0);
      if (r2(already + value) > c.value) throw new BadRequestException({ code: 'CONTRACT_CEILING', message: `This call-off would exceed the contract value of ${c.value}` });
      const po = await this.orders.createDraft(
        m,
        {
          supplierId: c.supplierId,
          storeId: dto.storeId,
          departmentId: dto.departmentId,
          budgetId: dto.budgetId ?? null,
          source: PurchaseOrderSource.CONTRACT,
          contractId: c.id,
          expectedDelivery: dto.expectedDelivery ?? (c.leadTimeDays ? new Date(Date.parse(`${today}T00:00:00Z`) + c.leadTimeDays * 86_400_000).toISOString().slice(0, 10) : null),
          notes: dto.notes ?? `Call-off against ${c.number}`,
        },
        draft,
        actor,
      );
      await this.links.link(m, { type: DocumentType.CONTRACT, id: c.id, no: c.number }, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number });
      return po.id;
    });
    return { purchaseOrderId: poId, contract: await this.get(id) };
  }

  async addSecurity(id: string, dto: { securityType: string; reference: string; issuer: string; amount: number; expiresOn: string }) {
    if (!(await this.ds.getRepository(Contract).existsBy({ id }))) throw new NotFoundException('Contract not found');
    return this.ds.getRepository(PerformanceSecurity).save(this.ds.getRepository(PerformanceSecurity).create({ ...dto, contractId: id }));
  }

  async releaseSecurity(id: string, securityId: string) {
    const repo = this.ds.getRepository(PerformanceSecurity);
    const s = await repo.findOneBy({ id: securityId, contractId: id });
    if (!s) throw new NotFoundException('Security not found');
    s.releasedOn = await this.settings.today();
    return repo.save(s);
  }

  async addMilestone(id: string, dto: { description: string; dueDate: string; notes?: string }) {
    return this.ds.getRepository(ContractMilestone).save(this.ds.getRepository(ContractMilestone).create({ ...dto, notes: dto.notes ?? null, contractId: id }));
  }

  async completeMilestone(id: string, milestoneId: string, notes?: string) {
    const repo = this.ds.getRepository(ContractMilestone);
    const ms = await repo.findOneBy({ id: milestoneId, contractId: id });
    if (!ms) throw new NotFoundException('Milestone not found');
    Object.assign(ms, { completedOn: await this.settings.today(), notes: notes ?? ms.notes });
    return repo.save(ms);
  }

  // ------------------------------------------------------------------ variations

  async createVariation(id: string, dto: { reason: string; changes: ContractVariation['changes'] }, actor: SessionUser) {
    const variationId = await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.status !== ContractStatus.ACTIVE) throw new ConflictException(`Contract is ${c.status}`);
      if (await m.existsBy(ContractVariation, { contractId: id, status: VariationStatus.PENDING_APPROVAL })) throw new ConflictException('A variation is already awaiting approval');
      const ch = dto.changes;
      if (!ch.endDate && ch.value === undefined && !ch.lines?.length) throw new BadRequestException('Nothing to change');
      if (ch.endDate && ch.endDate < c.startDate) throw new BadRequestException('End date before start date');
      const v = await m.save(
        m.create(ContractVariation, {
          number: await this.numbering.next(DocumentType.CONTRACT_VARIATION, { manager: m }),
          contractId: id,
          reason: dto.reason,
          changes: ch,
          valueChange: ch.value !== undefined ? r2(ch.value - c.value) : 0,
          status: VariationStatus.PENDING_APPROVAL,
        }),
      );
      await this.approvals.start(m, {
        documentType: DocumentType.CONTRACT_VARIATION,
        documentId: v.id,
        documentNo: v.number,
        amount: Math.abs(v.valueChange),
        requestedBy: actor.id,
        summary: `${c.number}: ${dto.reason}`.slice(0, 300),
        link: `/contracts/${c.id}`,
      });
      await this.links.link(m, { type: DocumentType.CONTRACT, id: c.id, no: c.number }, { type: DocumentType.CONTRACT_VARIATION, id: v.id, no: v.number });
      return v.id;
    });
    return this.ds.getRepository(ContractVariation).findOneByOrFail({ id: variationId });
  }

  /** Applies the approved variation to the contract. */
  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const v = await m.findOneByOrFail(ContractVariation, { id: req.documentId });
    const c = await this.lock(m, v.contractId);
    const ch = v.changes;
    if (ch.endDate) c.endDate = ch.endDate;
    if (ch.value !== undefined) c.value = ch.value;
    if (ch.endDate) c.alertedDays = [];
    await m.save(c);
    for (const l of ch.lines ?? []) {
      if (l.contractLineId) {
        const line = await m.findOneBy(ContractLine, { id: l.contractLineId, contractId: c.id });
        if (!line) throw new BadRequestException('A varied line is not on the contract');
        if (l.unitPrice !== undefined) line.unitPrice = l.unitPrice;
        if (l.quantity !== undefined) {
          const used = (await calledOff(m, [line.id])).get(line.id) ?? 0;
          if (l.quantity !== null && l.quantity < used) throw new BadRequestException(`Cannot reduce below the ${used} already called off`);
          line.quantity = l.quantity;
        }
        await m.save(line);
      } else if (l.itemId && l.unitPrice !== undefined) {
        await m.save(m.create(ContractLine, { contractId: c.id, itemId: l.itemId, unitPrice: l.unitPrice, quantity: l.quantity ?? null }));
      }
    }
    v.status = VariationStatus.APPROVED;
    await m.save(v);
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(ContractVariation, req.documentId, { status: VariationStatus.REJECTED, lastComment: comment });
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(ContractVariation, req.documentId, { status: VariationStatus.RETURNED, lastComment: comment });
  }

  // ------------------------------------------------------------------ alerts

  /**
   * Job contracts.alerts: contracts ending and performance securities expiring
   * within the configured thresholds (once per threshold), and contracts past
   * their end date marked EXPIRED.
   */
  async alerts(): Promise<{ expired: number; contractAlerts: number; securityAlerts: number }> {
    const today = await this.settings.today();
    const contractDays = [...(await this.settings.get('contracts.expiryAlertDays'))].sort((a, b) => a - b);
    const securityDays = [...(await this.settings.get('contracts.securityAlertDays'))].sort((a, b) => a - b);
    const res = await this.ds.query(`UPDATE contract SET status = 'EXPIRED', updated_at = now() WHERE status = 'ACTIVE' AND end_date < $1::date RETURNING id`, [today]);
    const expired = (Array.isArray(res[0]) ? res[0] : res).length;
    const users: { id: string }[] = await this.ds.query(
      `SELECT DISTINCT ur.user_id AS id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
      [Permissions.CONTRACTS_MANAGE],
    );
    const ids = users.map((u) => u.id);
    let contractAlerts = 0;
    let securityAlerts = 0;
    const daysLeft = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    await this.ds.transaction(async (m) => {
      for (const c of await m.find(Contract, { where: { status: ContractStatus.ACTIVE }, relations: { supplier: true } })) {
        const left = daysLeft(c.endDate);
        const due = contractDays.find((d) => left <= d && !c.alertedDays.includes(d));
        if (due === undefined) continue;
        c.alertedDays = [...new Set([...c.alertedDays, ...contractDays.filter((d) => left <= d)])];
        await m.save(c);
        await this.notifications.dispatch(m, ids, NotificationCategory.CONTRACTS, {
          title: `Contract ${c.number} ends in ${left} day(s)`,
          body: `${c.title} with ${c.supplier?.name ?? ''} ends on ${c.endDate}. Renew, re-tender or let it lapse.`,
          link: `/contracts/${c.id}`,
          emailText: `Contract ${c.number} (${c.title}, ${c.supplier?.name ?? ''}) ends on ${c.endDate} — ${left} day(s) left.`,
        });
        contractAlerts++;
      }
      const secs = await m.query(`SELECT s.*, c.number, c.id AS cid FROM performance_security s JOIN contract c ON c.id = s.contract_id WHERE s.released_on IS NULL AND c.status = 'ACTIVE'`);
      for (const s of secs) {
        const left = daysLeft(String(s.expires_on instanceof Date ? s.expires_on.toISOString().slice(0, 10) : s.expires_on).slice(0, 10));
        const alerted: number[] = s.alerted_days ?? [];
        const due = securityDays.find((d) => left <= d && !alerted.includes(d));
        if (due === undefined) continue;
        await m.query(`UPDATE performance_security SET alerted_days = $2 WHERE id = $1`, [s.id, [...new Set([...alerted, ...securityDays.filter((d) => left <= d)])]]);
        await this.notifications.dispatch(m, ids, NotificationCategory.CONTRACTS, {
          title: `Performance security ${s.reference} (${s.number}) expires in ${left} day(s)`,
          body: `Ask the supplier to extend the ${s.security_type} from ${s.issuer}.`,
          link: `/contracts/${s.cid}`,
          emailText: `Performance security ${s.reference} for contract ${s.number} expires in ${left} day(s).`,
        });
        securityAlerts++;
      }
    });
    return { expired, contractAlerts, securityAlerts };
  }

  /** Active framework agreements covering all the items (for the sourcing recommendation). */
  async frameworkCovers(m: EntityManager, itemIds: string[], on: string): Promise<boolean> {
    if (!itemIds.length) return false;
    const [r] = await m.query(
      `SELECT count(DISTINCT l.item_id)::int AS n FROM contract_line l JOIN contract c ON c.id = l.contract_id
        WHERE c.type = 'FRAMEWORK' AND c.status = 'ACTIVE' AND c.start_date <= $2 AND c.end_date >= $2 AND l.item_id = ANY($1::uuid[])`,
      [itemIds, on],
    );
    return r.n === new Set(itemIds).size;
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  BudgetEntryType,
  DocumentType,
  Paginated,
  PurchaseOrderSource,
  OPEN_REQUISITION_STATUSES,
  PurchaseLineType,
  PurchaseOrderStatus,
  SessionUser,
} from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { BudgetsService } from '../budgets/budgets.service';
import { FinanceService } from '../finance/finance.service';
import { JobsService } from '../jobs/jobs.service';
import { UnitsService } from '../catalog/units.service';
import { MailService } from '../mail/mail.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { TaxService } from '../tax/tax.service';
import { renderPurchaseOrderHtml } from './po-pdf';
import { AmendPurchaseOrderDto, CreatePurchaseOrderDto, DocListQueryDto } from './purchasing.dto';
import { PurchaseOrder, PurchaseOrderLine, PurchaseOrderVersion, PurchaseRequisition, PurchaseRequisitionLine } from './purchasing.entities';
import { notifyRequesters } from './requester-notices';
import { RequisitionsService } from './requisitions.service';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface DraftLine {
  /** Stock lines: the catalog item. Non-stock lines: optional. */
  itemId?: string | null;
  lineType?: PurchaseLineType;
  /** Non-stock lines: what is bought. */
  description?: string | null;
  glAccountId?: string | null;
  /** Non-stock lines: tax category (default purchasing.nonStockTaxCategory). */
  taxCategoryId?: string | null;
  /** Default: purchasing.whtRates for the line type. */
  whtRatePercent?: number | null;
  uomId?: string | null;
  quantity: number;
  unitPrice: number;
  requisitionLineId?: string | null;
  rfqLineId?: string | null;
  contractLineId?: string | null;
}

export interface DraftHeader {
  supplierId: string;
  storeId: string;
  departmentId: string;
  budgetId: string | null;
  source: PurchaseOrderSource;
  requisitionId?: string | null;
  rfqId?: string | null;
  expectedDelivery?: string | null;
  notes?: string | null;
  contractId?: string | null;
  /** Default: the base currency. */
  currency?: string | null;
  deliveryAddress?: string | null;
  terms?: string | null;
  expiresOn?: string | null;
}

const OPEN_FOR_RECEIPT = [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED];

@Injectable()
export class PurchaseOrdersService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly budgets: BudgetsService,
    private readonly suppliers: SuppliersService,
    private readonly units: UnitsService,
    private readonly tax: TaxService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly pdf: PdfService,
    private readonly requisitions: RequisitionsService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.PURCHASE_ORDER, this);
    this.jobs.register('purchasing.expireOrders', 'Expire LPOs / LSOs past their validity with nothing received or invoiced', () => this.expireOrders());
    this.mail.registerAttachment('PO_PDF', (id) => this.renderPdf(id));
    this.links.registerResolver(DocumentType.PURCHASE_ORDER, async (ids) => {
      const rows = await this.ds.getRepository(PurchaseOrder).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.orderDate, amount: r.total }]));
    });
  }

  // ------------------------------------------------------------------ building

  async buildLine(m: EntityManager, l: DraftLine, lineNo: number, onDate: string): Promise<Partial<PurchaseOrderLine>> {
    const type = l.lineType ?? PurchaseLineType.STOCK;
    if (type !== PurchaseLineType.STOCK) return this.buildNonStockLine(m, { ...l, lineType: type }, lineNo, onDate);
    if (!l.itemId) throw new BadRequestException(`Line ${lineNo}: a stock line needs an item`);
    const [item] = await m.query(`SELECT id, code, base_uom_id, tax_category_id, is_active FROM item WHERE id = $1`, [l.itemId]);
    if (!item) throw new NotFoundException(`Item ${l.itemId} not found`);
    if (!item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
    const uomId = l.uomId ?? item.base_uom_id;
    const factor = uomId === item.base_uom_id ? 1 : await this.units.factorToBase(item.id, uomId);
    const rate = await this.tax.rateFor(item.tax_category_id, onDate);
    const subtotal = round2(l.quantity * l.unitPrice);
    const lineTax = round2((subtotal * rate) / 100);
    return {
      lineNo,
      lineType: PurchaseLineType.STOCK,
      itemId: item.id,
      uomId,
      conversionFactor: factor,
      quantity: round4(l.quantity),
      unitPrice: l.unitPrice,
      taxCategoryId: item.tax_category_id,
      taxRatePercent: rate,
      lineSubtotal: subtotal,
      lineTax,
      lineTotal: round2(subtotal + lineTax),
      requisitionLineId: l.requisitionLineId ?? null,
      rfqLineId: l.rfqLineId ?? null,
      contractLineId: l.contractLineId ?? null,
    };
  }

  /**
   * A goods / service / capital line not held in stock: quantity in its own
   * unit (factor 1), tax from the line's category (default
   * purchasing.nonStockTaxCategory), withholding tax by line type.
   */
  private async buildNonStockLine(m: EntityManager, l: DraftLine & { lineType: PurchaseLineType }, lineNo: number, onDate: string): Promise<Partial<PurchaseOrderLine>> {
    let description = l.description?.trim() || null;
    if (l.itemId) {
      const [item] = await m.query(`SELECT name, is_active FROM item WHERE id = $1`, [l.itemId]);
      if (!item) throw new NotFoundException(`Item ${l.itemId} not found`);
      description = description ?? item.name;
    }
    if (!description) throw new BadRequestException(`Line ${lineNo}: describe what is ordered`);
    let taxCategoryId = l.taxCategoryId ?? null;
    if (!taxCategoryId) {
      const code = await this.settings.get('purchasing.nonStockTaxCategory', m);
      const [t] = await m.query(`SELECT id FROM tax_category WHERE code = $1`, [code]);
      if (!t) throw new BadRequestException(`Tax category ${code} (purchasing.nonStockTaxCategory) not found`);
      taxCategoryId = t.id;
    }
    let uomId = l.uomId ?? null;
    if (!uomId) {
      const units = await this.settings.get('purchasing.nonStockUom', m);
      const code = units[l.lineType] ?? units.default ?? 'PCS';
      const [u] = await m.query(`SELECT id FROM unit_of_measure WHERE code = $1`, [code]);
      if (!u) throw new BadRequestException(`Unit ${code} (purchasing.nonStockUom) not found`);
      uomId = u.id;
    }
    const rate = await this.tax.rateFor(taxCategoryId!, onDate);
    const wht = l.whtRatePercent ?? (await this.settings.get('purchasing.whtRates', m))[l.lineType] ?? 0;
    const subtotal = round2(l.quantity * l.unitPrice);
    const lineTax = round2((subtotal * rate) / 100);
    return {
      lineNo,
      lineType: l.lineType,
      itemId: l.itemId ?? null,
      description: description.slice(0, 500),
      glAccountId: l.glAccountId ?? null,
      uomId: uomId!,
      conversionFactor: 1,
      quantity: round4(l.quantity),
      unitPrice: l.unitPrice,
      taxCategoryId: taxCategoryId!,
      taxRatePercent: rate,
      lineSubtotal: subtotal,
      lineTax,
      lineTotal: round2(subtotal + lineTax),
      whtRatePercent: wht,
      // Withholding tax is on the amount before VAT.
      whtAmount: round2((subtotal * wht) / 100),
      requisitionLineId: l.requisitionLineId ?? null,
      rfqLineId: l.rfqLineId ?? null,
      contractLineId: null,
    };
  }

  private totals(lines: Partial<PurchaseOrderLine>[]) {
    const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal!, 0));
    const taxTotal = round2(lines.reduce((s, l) => s + l.lineTax!, 0));
    const whtTotal = round2(lines.reduce((s, l) => s + (l.whtAmount ?? 0), 0));
    return { subtotal, taxTotal, total: round2(subtotal + taxTotal), whtTotal };
  }

  /** Total in the base currency at the order's rate (approval bands and budget). */
  private baseTotal(total: number, rate: number) {
    return round2(total * rate);
  }

  private async assertSupplier(m: EntityManager, supplierId: string, onDate: string) {
    const problems = await this.suppliers.eligibility(m, supplierId, onDate);
    if (problems.length) throw new BadRequestException({ message: problems.join('; '), code: 'SUPPLIER_NOT_ELIGIBLE' });
  }

  /** Creates a draft PO (used by direct creation and by RFQ awards). */
  async createDraft(m: EntityManager, header: DraftHeader, lines: DraftLine[], actor: SessionUser): Promise<PurchaseOrder> {
    const today = await this.settings.today(m);
    await this.assertSupplier(m, header.supplierId, today);
    const built: Partial<PurchaseOrderLine>[] = [];
    for (const [i, l] of lines.entries()) built.push(await this.buildLine(m, l, i + 1, today));
    const [supplier] = await m.query(`SELECT payment_terms_days, observed_lead_time_days FROM supplier WHERE id = $1`, [header.supplierId]);
    // No date given: the supplier's observed lead time (shipment history) sets it.
    const defaultExpected = supplier?.observed_lead_time_days != null ? new Date(Date.parse(`${today}T00:00:00Z`) + supplier.observed_lead_time_days * 86_400_000).toISOString().slice(0, 10) : null;
    const base = await this.settings.get('locale.currency', m);
    const currency = header.currency ?? base;
    const exchangeRate = await this.finance.rateOn(m, currency, today);
    const totals = this.totals(built);
    const nonStock = built.some((l) => l.lineType && l.lineType !== PurchaseLineType.STOCK);
    const validity = await this.settings.get('purchasing.lpoValidityDays', m);
    const po = await m.save(
      m.create(PurchaseOrder, {
        number: await this.numbering.next(DocumentType.PURCHASE_ORDER, { storeId: header.storeId, date: today, manager: m }),
        ...header,
        requisitionId: header.requisitionId ?? null,
        rfqId: header.rfqId ?? null,
        contractId: header.contractId ?? null,
        expectedDelivery: header.expectedDelivery ?? defaultExpected,
        notes: header.notes ?? null,
        orderDate: today,
        currency,
        exchangeRate,
        paymentTermsDays: supplier?.payment_terms_days ?? null,
        deliveryAddress: header.deliveryAddress ?? null,
        // LPO / LSO terms and validity (non-stock orders, or when given).
        terms: header.terms ?? (nonStock ? await this.settings.get('purchasing.lpoTerms', m) : null),
        expiresOn: header.expiresOn ?? (nonStock ? addDays(today, validity) : null),
        status: PurchaseOrderStatus.DRAFT,
        createdByUser: actor.id,
        ...totals,
        baseTotal: this.baseTotal(totals.total, exchangeRate),
        lines: built.map((l) => m.create(PurchaseOrderLine, l)),
      }),
    );
    const prLines = built.filter((l) => l.requisitionLineId).map((l) => ({ requisitionLineId: l.requisitionLineId!, baseQty: round4(l.quantity! * l.conversionFactor!) }));
    if (prLines.length) await this.requisitions.recordOrdered(m, prLines);
    if (header.requisitionId) {
      const [pr] = await m.query(`SELECT number FROM purchase_requisition WHERE id = $1`, [header.requisitionId]);
      await this.links.link(m, { type: DocumentType.PURCHASE_REQUISITION, id: header.requisitionId, no: pr.number }, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number });
    }
    return po;
  }

  /** From an approved requisition (prices from the line, the contract list, or the PR estimate). */
  async create(dto: CreatePurchaseOrderDto, actor: SessionUser): Promise<PurchaseOrder> {
    const id = await this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      if (dto.requisitionId) {
        const pr = await m.findOne(PurchaseRequisition, { where: { id: dto.requisitionId }, lock: { mode: 'pessimistic_write' } });
        if (!pr) throw new NotFoundException('Requisition not found');
        if (!OPEN_REQUISITION_STATUSES.includes(pr.status)) throw new ConflictException(`Requisition is ${pr.status}; it must be approved`);
        const prLines = await m.find(PurchaseRequisitionLine, { where: { requisitionId: pr.id } });
        const lines: DraftLine[] = [];
        for (const l of dto.lines) {
          const prLine = prLines.find((p) => p.id === l.requisitionLineId);
          if (!prLine) throw new BadRequestException('Each line must reference a line of the requisition');
          if (prLine.lineType !== PurchaseLineType.STOCK) {
            // Direct LPO / LSO for a non-stock line: quantity in the line's unit, price from the order or the estimate.
            const remainingNs = round4(prLine.quantity - prLine.orderedQty);
            const qty = l.quantity ?? remainingNs;
            if (qty > remainingNs) throw new BadRequestException(`Ordering more than the remaining ${remainingNs} requested`);
            lines.push({
              lineType: prLine.lineType,
              itemId: prLine.itemId,
              description: prLine.description,
              glAccountId: prLine.glAccountId,
              uomId: prLine.uomId,
              taxCategoryId: l.taxCategoryId ?? null,
              whtRatePercent: l.whtRatePercent ?? null,
              quantity: qty,
              unitPrice: l.unitPrice ?? prLine.estimatedUnitPrice,
              requisitionLineId: prLine.id,
            });
            continue;
          }
          const itemId = prLine.itemId!;
          const remaining = round4(prLine.quantity - prLine.orderedQty);
          const uomId = l.uomId ?? null;
          const factor = uomId ? await this.units.factorToBase(itemId, uomId) : 1;
          const quantity = l.quantity ?? round4(remaining / factor);
          if (round4(quantity * factor) > remaining) throw new BadRequestException(`Ordering more than the remaining ${remaining} base units requested`);
          const contract = await this.suppliers.priceOn(m, dto.supplierId, itemId, today);
          const unitPrice = l.unitPrice ?? (contract ? round4(contract.unitPrice * factor) : round4(prLine.estimatedUnitPrice * factor));
          // Priced from a contract: the order counts against that contract line's balance.
          lines.push({ itemId, uomId, quantity, unitPrice, requisitionLineId: prLine.id, contractLineId: l.unitPrice === undefined ? (contract?.contractLineId ?? null) : null });
        }
        const po = await this.createDraft(
          m,
          {
            supplierId: dto.supplierId,
            storeId: pr.storeId,
            departmentId: pr.departmentId,
            budgetId: dto.budgetId ?? pr.budgetId,
            source: PurchaseOrderSource.REQUISITION,
            requisitionId: pr.id,
            expectedDelivery: dto.expectedDelivery,
            notes: dto.notes,
            currency: dto.currency ?? null,
            deliveryAddress: dto.deliveryAddress ?? null,
            terms: dto.terms ?? null,
            expiresOn: dto.expiresOn ?? null,
          },
          lines,
          actor,
        );
        return po.id;
      }
      // Contract-price order (no requisition).
      if (!dto.storeId || !dto.departmentId) throw new BadRequestException('storeId and departmentId are required without a requisition');
      const lines: DraftLine[] = [];
      for (const l of dto.lines) {
        if (!l.itemId || !l.quantity) throw new BadRequestException('itemId and quantity are required');
        const contract = await this.suppliers.priceOn(m, dto.supplierId, l.itemId, today);
        if (!contract) throw new BadRequestException(`No contract price for this supplier and item on ${today}`);
        const factor = l.uomId ? await this.units.factorToBase(l.itemId, l.uomId) : 1;
        lines.push({ itemId: l.itemId, uomId: l.uomId ?? null, quantity: l.quantity, unitPrice: round4(contract.unitPrice * factor), contractLineId: contract.contractLineId });
      }
      const po = await this.createDraft(
        m,
        {
          supplierId: dto.supplierId,
          storeId: dto.storeId,
          departmentId: dto.departmentId,
          budgetId: dto.budgetId ?? null,
          source: PurchaseOrderSource.CONTRACT,
          expectedDelivery: dto.expectedDelivery,
          notes: dto.notes,
        },
        lines,
        actor,
      );
      return po.id;
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ approval

  async submit(id: string, actor: SessionUser): Promise<PurchaseOrder & { budgetWarning?: string | null }> {
    let budgetWarning: string | null = null;
    await this.ds.transaction(async (m) => {
      const po = await this.lock(m, id);
      if (![PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.RETURNED].includes(po.status)) throw new ConflictException(`PO is ${po.status}`);
      await this.assertSupplier(m, po.supplierId, await this.settings.today(m));
      budgetWarning = await this.startApproval(m, po, actor);
      po.status = PurchaseOrderStatus.PENDING_APPROVAL;
      await m.save(po);
    });
    return { ...(await this.get(id)), budgetWarning };
  }

  private async startApproval(m: EntityManager, po: PurchaseOrder, actor: SessionUser): Promise<string | null> {
    let warning: string | null = null;
    const delta = round2(this.baseTotal(po.total, po.exchangeRate) - po.committedTotal);
    if (po.budgetId && delta > 0) {
      const check = await this.budgets.check(m, po.budgetId, delta);
      if (check.blocked) throw new BadRequestException({ message: check.message, code: 'BUDGET_EXCEEDED' });
      warning = check.message;
    }
    const categories: { category_id: string }[] = await m.query(
      `SELECT DISTINCT COALESCE(i.category_id, prl.category_id) AS category_id FROM purchase_order_line l
         LEFT JOIN item i ON i.id = l.item_id LEFT JOIN purchase_requisition_line prl ON prl.id = l.requisition_line_id
        WHERE l.purchase_order_id = $1 AND COALESCE(i.category_id, prl.category_id) IS NOT NULL`,
      [po.id],
    );
    const [supplier] = await m.query(`SELECT name FROM supplier WHERE id = $1`, [po.supplierId]);
    await this.approvals.start(m, {
      documentType: DocumentType.PURCHASE_ORDER,
      documentId: po.id,
      documentNo: po.version > 1 ? `${po.number} v${po.version}` : po.number,
      // Bands are in the base currency.
      amount: this.baseTotal(po.total, po.exchangeRate),
      currency: po.currency,
      departmentId: po.departmentId,
      itemCategoryIds: categories.map((c) => c.category_id),
      requestedBy: actor.id,
      summary: `${supplier?.name ?? ''}${po.version > 1 ? ' · amendment' : ''}`,
      link: `/purchase-orders/${po.id}`,
    });
    return warning;
  }

  /** Commits (or releases) the budget for the approved total; BLOCK budgets stop the approval. */
  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const po = await m.findOneByOrFail(PurchaseOrder, { id: req.documentId });
    const baseTotal = this.baseTotal(po.total, po.exchangeRate);
    const delta = round2(baseTotal - po.committedTotal);
    if (po.budgetId && delta !== 0) {
      if (delta > 0) {
        const check = await this.budgets.check(m, po.budgetId, delta);
        if (check.blocked) throw new BadRequestException({ message: check.message, code: 'BUDGET_EXCEEDED' });
      }
      await this.budgets.entry(m, po.budgetId, delta > 0 ? BudgetEntryType.COMMITMENT : BudgetEntryType.RELEASE, delta, {
        type: DocumentType.PURCHASE_ORDER,
        id: po.id,
        no: po.number,
      });
    }
    po.committedTotal = baseTotal;
    po.baseTotal = baseTotal;
    // An approved amendment of a PO already sent or part-received keeps its delivery status.
    const previous = await this.previousStatus(m, po);
    po.status = previous && previous !== PurchaseOrderStatus.APPROVED ? previous : PurchaseOrderStatus.APPROVED;
    await m.save(po);
    await this.snapshot(m, po, null, req.requestedBy);
    if (po.status === PurchaseOrderStatus.APPROVED && (await this.settings.get('purchasing.autoSendOnApproval', m))) {
      await this.sendIn(m, po).catch(() => undefined); // no supplier email: it stays APPROVED for sending by hand
    }
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const po = await m.findOneByOrFail(PurchaseOrder, { id: req.documentId });
    if (po.version > 1) {
      await this.restoreVersion(m, po, po.version - 1, comment);
      return;
    }
    po.status = PurchaseOrderStatus.REJECTED;
    po.lastComment = comment;
    await m.save(po);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const po = await m.findOneByOrFail(PurchaseOrder, { id: req.documentId });
    po.status = PurchaseOrderStatus.RETURNED;
    po.lastComment = comment;
    await m.save(po);
  }

  // ------------------------------------------------------------------ versions & amendments

  private async previousStatus(m: EntityManager, po: PurchaseOrder): Promise<PurchaseOrderStatus | null> {
    if (po.version <= 1) return null;
    const prev = await m.findOneBy(PurchaseOrderVersion, { purchaseOrderId: po.id, version: po.version - 1 });
    return (prev?.snapshot.status as PurchaseOrderStatus) ?? null;
  }

  private async snapshot(m: EntityManager, po: PurchaseOrder, reason: string | null, userId: string | null): Promise<void> {
    const lines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id }, order: { lineNo: 'ASC' } });
    const { lines: _l, supplier: _s, store: _st, department: _d, ...header } = po;
    await m.query(
      `INSERT INTO purchase_order_version (purchase_order_id, version, snapshot, change_reason, changed_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (purchase_order_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
      [po.id, po.version, JSON.stringify({ ...header, lines }), reason, userId],
    );
  }

  private async restoreVersion(m: EntityManager, po: PurchaseOrder, version: number, comment: string): Promise<void> {
    const v = await m.findOneByOrFail(PurchaseOrderVersion, { purchaseOrderId: po.id, version });
    const snap = v.snapshot as Record<string, unknown> & { lines: PurchaseOrderLine[] };
    await m.delete(PurchaseOrderLine, { purchaseOrderId: po.id });
    await m.save(snap.lines.map((l) => m.create(PurchaseOrderLine, { ...l, purchaseOrderId: po.id })));
    Object.assign(po, {
      version,
      status: snap.status,
      subtotal: snap.subtotal,
      taxTotal: snap.taxTotal,
      total: snap.total,
      expectedDelivery: snap.expectedDelivery,
      notes: snap.notes,
      lastComment: `Amendment rejected: ${comment}`,
    });
    await m.save(po);
    await m.delete(PurchaseOrderVersion, { purchaseOrderId: po.id, version: version + 1 });
  }

  /** Amends an approved PO: new version, re-approval, history kept. */
  async amend(id: string, dto: AmendPurchaseOrderDto, actor: SessionUser): Promise<PurchaseOrder> {
    await this.ds.transaction(async (m) => {
      const po = await this.lock(m, id);
      if (!OPEN_FOR_RECEIPT.includes(po.status)) throw new ConflictException(`A ${po.status} purchase order cannot be amended`);
      await this.snapshot(m, po, null, null); // make sure the current version is recorded
      const today = await this.settings.today(m);
      const existing = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: id } });
      const built: Partial<PurchaseOrderLine>[] = [];
      for (const [i, l] of dto.lines.entries()) {
        const old = l.lineId ? existing.find((e) => e.id === l.lineId) : undefined;
        if (l.lineId && !old) throw new BadRequestException(`Line ${l.lineId} is not on this PO`);
        const itemId = old?.itemId ?? l.itemId;
        const nonStock = old && old.lineType !== PurchaseLineType.STOCK;
        if (!itemId && !nonStock) throw new BadRequestException('New lines need an item');
        const line = await this.buildLine(
          m,
          nonStock
            ? { lineType: old.lineType, itemId: old.itemId, description: old.description, glAccountId: old.glAccountId, taxCategoryId: old.taxCategoryId, whtRatePercent: old.whtRatePercent, uomId: old.uomId, quantity: l.quantity, unitPrice: l.unitPrice, requisitionLineId: old.requisitionLineId, rfqLineId: old.rfqLineId }
            : { itemId, uomId: old?.uomId ?? l.uomId, quantity: l.quantity, unitPrice: l.unitPrice, requisitionLineId: old?.requisitionLineId, rfqLineId: old?.rfqLineId, contractLineId: old?.contractLineId },
          i + 1,
          today,
        );
        if (old && round4(l.quantity * line.conversionFactor!) < old.receivedBaseQty) {
          throw new BadRequestException(`Line ${old.lineNo}: cannot order less than already received`);
        }
        built.push({ ...line, id: old?.id, receivedBaseQty: old?.receivedBaseQty ?? 0 });
      }
      for (const e of existing) {
        if (e.receivedBaseQty > 0 && !built.some((b) => b.id === e.id)) throw new BadRequestException(`Line ${e.lineNo} has receipts and cannot be removed`);
      }
      await m.delete(PurchaseOrderLine, { purchaseOrderId: id, id: In(existing.filter((e) => !built.some((b) => b.id === e.id)).map((e) => e.id).concat(['00000000-0000-0000-0000-000000000000'])) });
      for (const b of built) await m.save(m.create(PurchaseOrderLine, { ...b, purchaseOrderId: id }));
      const totals = this.totals(built);
      Object.assign(po, {
        ...totals,
        baseTotal: this.baseTotal(totals.total, po.exchangeRate),
        version: po.version + 1,
        expectedDelivery: dto.expectedDelivery !== undefined ? dto.expectedDelivery : po.expectedDelivery,
        notes: dto.notes ?? po.notes,
        status: PurchaseOrderStatus.PENDING_APPROVAL,
      });
      await m.save(po);
      await this.snapshot(m, po, dto.reason, actor.id);
      await this.startApproval(m, po, actor);
    });
    return this.get(id);
  }

  versions(id: string) {
    return this.ds.getRepository(PurchaseOrderVersion).find({ where: { purchaseOrderId: id }, order: { version: 'ASC' } });
  }

  // ------------------------------------------------------------------ sending, cancelling, closing

  async send(id: string, _actor: SessionUser): Promise<PurchaseOrder> {
    await this.ds.transaction(async (m) => {
      const po = await this.lock(m, id);
      if (po.status !== PurchaseOrderStatus.APPROVED && po.status !== PurchaseOrderStatus.SENT) {
        throw new ConflictException(`PO is ${po.status}; only approved orders can be sent`);
      }
      await this.sendIn(m, po);
    });
    return this.get(id);
  }

  /** LPO for goods, LSO when every line is a service. */
  private async kind(m: EntityManager, poId: string): Promise<{ short: string; long: string }> {
    const [r] = await m.query(`SELECT bool_and(line_type = 'SERVICE') AS services, bool_or(line_type <> 'STOCK') AS non_stock FROM purchase_order_line WHERE purchase_order_id = $1`, [poId]);
    if (r?.services) return { short: 'LSO', long: 'Local service order' };
    return r?.non_stock ? { short: 'LPO', long: 'Local purchase order' } : { short: 'PO', long: 'Purchase order' };
  }

  /** Emails the order (PDF attached) to the supplier and marks it sent. */
  private async sendIn(m: EntityManager, po: PurchaseOrder): Promise<void> {
      const [s] = await m.query(
        `SELECT s.name, COALESCE(s.email, (SELECT email FROM supplier_contact c WHERE c.supplier_id = s.id AND c.email IS NOT NULL ORDER BY c.is_primary DESC LIMIT 1)) AS email
           FROM supplier s WHERE s.id = $1`,
        [po.supplierId],
      );
      if (!s?.email) throw new BadRequestException('The supplier has no email address');
      const [facility] = await m.query(`SELECT name FROM facility ORDER BY created_at LIMIT 1`);
      const kind = await this.kind(m, po.id);
      await this.mail.enqueue(m, {
        to: s.email,
        subject: `${kind.long} ${po.number}${po.version > 1 ? ` (version ${po.version})` : ''} from ${facility?.name ?? 'the hospital'}`,
        text: `Dear ${s.name},\n\nPlease find attached ${kind.long.toLowerCase()} ${po.number}.${po.expiresOn ? ` It is valid until ${po.expiresOn}.` : ''} Kindly confirm receipt and the expected delivery date.\n\nRegards,\nProcurement`,
        attachments: [{ kind: 'PO_PDF', id: po.id, filename: `${po.number.replace(/\//g, '-')}.pdf` }],
        doc: { type: DocumentType.PURCHASE_ORDER, id: po.id },
      });
      if (po.status === PurchaseOrderStatus.APPROVED) po.status = PurchaseOrderStatus.SENT;
      const first = !po.sentAt;
      po.sentAt = new Date();
      await m.save(po);
      if (first) {
        await notifyRequesters(m, this.notifications, { poId: po.id }, (r) => ({ title: `${r.number}: ${kind.short} issued`, body: `${kind.long} ${po.number} was sent to ${s.name}${po.expectedDelivery ? `; delivery expected ${po.expectedDelivery}` : ''}` }));
      }
  }

  /**
   * Job purchasing.expireOrders: approved / sent orders past their validity
   * with nothing received expire; the open commitment is released and the
   * requisition quantities given back.
   */
  async expireOrders() {
    const today = await this.settings.today();
    const due: { id: string }[] = await this.ds.query(
      `SELECT po.id FROM purchase_order po WHERE po.status IN ('APPROVED', 'SENT') AND po.expires_on < $1::date
          AND NOT EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.purchase_order_id = po.id AND l.received_base_qty > 0)
          AND NOT EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.purchase_order_id = po.id AND i.status NOT IN ('CANCELLED', 'REJECTED'))`,
      [today],
    );
    for (const d of due) {
      await this.ds.transaction(async (m) => {
        const po = await this.lock(m, d.id);
        await this.releaseOpenCommitment(m, po);
        await this.giveBackRequisition(m, po);
        po.status = PurchaseOrderStatus.EXPIRED;
        po.lastComment = `Expired on ${po.expiresOn} with nothing received or invoiced`;
        await m.save(po);
        if (po.createdByUser) await this.notifications.notify(m, [po.createdByUser], { title: `${po.number} expired`, body: 'Nothing was received before its expiry date', link: `/purchase-orders/${po.id}` });
      });
    }
    return { expired: due.length };
  }

  /** The order's quantities go back to its requisition lines (cancelled or expired order). */
  private async giveBackRequisition(m: EntityManager, po: PurchaseOrder): Promise<void> {
    const lines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
    const back = lines.filter((l) => l.requisitionLineId).map((l) => ({ requisitionLineId: l.requisitionLineId!, baseQty: -round4(l.quantity * l.conversionFactor) }));
    if (back.length) await this.requisitions.recordOrdered(m, back);
  }

  async cancel(id: string, reason: string, actor: SessionUser): Promise<PurchaseOrder> {
    await this.ds.transaction(async (m) => {
      const po = await this.lock(m, id);
      const received = await m.query(`SELECT 1 FROM goods_received_note WHERE purchase_order_id = $1 AND status <> 'CANCELLED' LIMIT 1`, [id]);
      if (received.length) throw new ConflictException('Goods have been received against this PO; close it instead');
      if ([PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.CLOSED, PurchaseOrderStatus.RECEIVED].includes(po.status)) {
        throw new ConflictException(`PO is ${po.status}`);
      }
      await this.approvals.cancelPending(m, DocumentType.PURCHASE_ORDER, id, actor.id);
      await this.releaseOpenCommitment(m, po);
      // Give the requisition quantities back (its status follows).
      await this.giveBackRequisition(m, po);
      po.status = PurchaseOrderStatus.CANCELLED;
      po.cancellationReason = reason;
      await m.save(po);
    });
    return this.get(id);
  }

  /** Closes a PO that will not be delivered in full; the open commitment is released. */
  async close(id: string, reason: string): Promise<PurchaseOrder> {
    await this.ds.transaction(async (m) => {
      const po = await this.lock(m, id);
      if (![...OPEN_FOR_RECEIPT, PurchaseOrderStatus.RECEIVED].includes(po.status)) throw new ConflictException(`PO is ${po.status}`);
      await this.releaseOpenCommitment(m, po);
      po.status = PurchaseOrderStatus.CLOSED;
      po.cancellationReason = reason;
      await m.save(po);
    });
    return this.get(id);
  }

  private async releaseOpenCommitment(m: EntityManager, po: PurchaseOrder): Promise<void> {
    if (!po.budgetId) return;
    const open = await this.budgets.openCommitment(m, po.budgetId, DocumentType.PURCHASE_ORDER, po.id);
    if (open > 0) await this.budgets.entry(m, po.budgetId, BudgetEntryType.RELEASE, -open, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number });
  }

  // ------------------------------------------------------------------ receipts (called by GRN posting)

  /** Adds accepted base quantities to PO lines and updates the PO status. */
  async applyReceipt(m: EntityManager, poId: string, received: { poLineId: string; baseQty: number }[]): Promise<void> {
    const po = await m.findOne(PurchaseOrder, { where: { id: poId }, lock: { mode: 'pessimistic_write' } });
    if (!po) throw new NotFoundException('PO not found');
    const lines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: poId } });
    for (const r of received) {
      const line = lines.find((l) => l.id === r.poLineId);
      if (!line) continue;
      line.receivedBaseQty = round4(line.receivedBaseQty + r.baseQty);
      await m.save(line);
    }
    const complete = lines.every((l) => l.receivedBaseQty >= round4(l.quantity * l.conversionFactor));
    const any = lines.some((l) => l.receivedBaseQty > 0);
    if (po.status !== PurchaseOrderStatus.CLOSED) {
      po.status = complete ? PurchaseOrderStatus.RECEIVED : any ? PurchaseOrderStatus.PARTIALLY_RECEIVED : po.status;
      await m.save(po);
    }
  }

  isOpenForReceipt(status: PurchaseOrderStatus): boolean {
    return OPEN_FOR_RECEIPT.includes(status);
  }

  // ------------------------------------------------------------------ PDF

  async renderPdf(id: string): Promise<Buffer> {
    const po = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email, kra_pin FROM facility ORDER BY created_at LIMIT 1`);
    const history = await this.approvals.history(DocumentType.PURCHASE_ORDER, id);
    const stamps = history
      .filter((r) => r.status === 'APPROVED')
      .flatMap((r) => r.actions.filter((a) => a.action === 'APPROVE').map((a) => ({ step: a.stepName ?? '', name: a.userName ?? '', at: a.at, onBehalfOf: a.onBehalfOfName })));
    const html = renderPurchaseOrderHtml(po, facility, stamps, await this.kind(this.ds.manager, id), {
      dateFormat: await this.settings.get('locale.dateFormat'),
      timezone: await this.settings.get('locale.timezone'),
    });
    return this.pdf.render(html);
  }

  // ------------------------------------------------------------------ queries

  private async lock(m: EntityManager, id: string): Promise<PurchaseOrder> {
    const po = await m.findOne(PurchaseOrder, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async get(id: string): Promise<PurchaseOrder> {
    const po = await this.ds.getRepository(PurchaseOrder).findOne({
      where: { id },
      relations: { supplier: true, store: true, department: true, lines: { item: { baseUom: true }, uom: true } },
      order: { lines: { lineNo: 'ASC' } },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async list(q: DocListQueryDto): Promise<Paginated<PurchaseOrder>> {
    const qb = this.ds
      .getRepository(PurchaseOrder)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.supplier', 'supplier')
      .leftJoinAndSelect('p.store', 'store')
      .orderBy('p.createdAt', 'DESC');
    if (q.status) qb.andWhere('p.status = :st', { st: q.status });
    if (q.supplierId) qb.andWhere('p.supplier_id = :s', { s: q.supplierId });
    if (q.storeId) qb.andWhere('p.store_id = :store', { store: q.storeId });
    if (q.search) qb.andWhere('(p.number ILIKE :q OR supplier.name ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async assertNotCreatorOrApprover(poId: string, actor: SessionUser, what: string): Promise<void> {
    const approvers = await this.approvals.approvedBy(DocumentType.PURCHASE_ORDER, poId);
    if (approvers.includes(actor.id)) throw new ForbiddenException(`You approved this purchase order and cannot ${what}`);
  }
}

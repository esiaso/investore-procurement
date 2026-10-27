import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { BudgetEntryType, DocumentType, EtimsStatus, InvoiceStatus, MatchStatus, Paginated, PurchaseOrderStatus, SessionUser } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { BudgetsService } from '../budgets/budgets.service';
import { EtimsService } from '../etims/etims.service';
import { FinanceService } from '../finance/finance.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { MatchLineInput, threeWayMatch } from './matching';
import { CreateInvoiceDto, DocListQueryDto, PayInvoiceDto } from './purchasing.dto';
import { PaymentVoucher, PurchaseOrder, PurchaseOrderLine, SupplierInvoice, SupplierInvoiceLine } from './purchasing.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Invoices that count towards the order being fully invoiced. */
const APPROVED_INVOICE = [InvoiceStatus.APPROVED, InvoiceStatus.SCHEDULED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.PAID];

const INVOICEABLE = [PurchaseOrderStatus.SENT, PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CLOSED];

@Injectable()
export class InvoicesService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly budgets: BudgetsService,
    private readonly settings: SettingsService,
    private readonly etims: EtimsService,
    private readonly finance: FinanceService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.SUPPLIER_INVOICE, this);
    this.links.registerResolver(DocumentType.SUPPLIER_INVOICE, async (ids) => {
      const rows = await this.ds.getRepository(SupplierInvoice).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: `${r.status} · ${r.matchStatus}`, date: r.invoiceDate, amount: r.total }]));
    });
    this.links.registerResolver(DocumentType.PAYMENT_VOUCHER, async (ids) => {
      const rows = await this.ds.getRepository(PaymentVoucher).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: 'PAID', date: r.paidOn, amount: r.amount }]));
    });
  }

  /** Recomputes the three-way match for an invoice (status/variances are stored on it). */
  async match(m: EntityManager, invoice: SupplierInvoice): Promise<void> {
    const lines = await m.find(SupplierInvoiceLine, { where: { invoiceId: invoice.id } });
    const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: invoice.purchaseOrderId }, relations: { item: true } });
    const previous: { po_line_id: string; q: string }[] = await m.query(
      `SELECT l.po_line_id, SUM(l.quantity) AS q FROM supplier_invoice_line l JOIN supplier_invoice i ON i.id = l.invoice_id
        WHERE i.purchase_order_id = $1 AND i.id <> $2 AND i.status NOT IN ('REJECTED', 'CANCELLED') GROUP BY l.po_line_id`,
      [invoice.purchaseOrderId, invoice.id],
    );
    const inputs: MatchLineInput[] = lines.map((l) => {
      const pl = poLines.find((p) => p.id === l.poLineId)!;
      return {
        poLineId: l.poLineId,
        label: `Line ${pl.lineNo} ${pl.item?.name ?? pl.description ?? ''}`,
        orderedQty: pl.quantity,
        receivedQty: round4(pl.receivedBaseQty / pl.conversionFactor),
        previouslyInvoicedQty: Number(previous.find((p) => p.po_line_id === l.poLineId)?.q ?? 0),
        invoicedQty: l.quantity,
        poUnitPrice: pl.unitPrice,
        invoiceUnitPrice: l.unitPrice,
      };
    });
    const variances = threeWayMatch(inputs, {
      quantityPct: await this.settings.get('purchasing.matchQtyTolerancePct', m),
      pricePct: await this.settings.get('purchasing.matchPriceTolerancePct', m),
      priceAbs: await this.settings.get('purchasing.matchPriceToleranceAbs', m),
    });
    // Fourth leg: the supplier's sale must be on KRA eTIMS.
    if (invoice.etimsStatus === EtimsStatus.NOT_ON_ETIMS) {
      const reverse = await this.etims.reverseInvoiceCheck(m, invoice.id);
      variances.push({
        poLineId: '',
        code: 'NOT_ON_ETIMS',
        message: `Invoice ${invoice.supplierInvoiceNo} is not on KRA eTIMS for this supplier's PIN${reverse.note ? `. ${reverse.note}` : ' — ask the supplier to transmit it'}`,
      });
    }
    invoice.variances = variances;
    invoice.matchStatus = variances.length ? MatchStatus.VARIANCE : MatchStatus.MATCHED;
    await m.save(invoice);
  }

  async create(dto: CreateInvoiceDto, actor: SessionUser): Promise<SupplierInvoice> {
    const id = await this.ds.transaction(async (m) => {
      const po = await m.findOneBy(PurchaseOrder, { id: dto.purchaseOrderId });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!INVOICEABLE.includes(po.status)) throw new ConflictException(`PO is ${po.status}; it cannot be invoiced`);
      const dup = await m.findOneBy(SupplierInvoice, { supplierId: po.supplierId, supplierInvoiceNo: dto.supplierInvoiceNo.trim() });
      if (dup) throw new ConflictException(`Invoice ${dto.supplierInvoiceNo} from this supplier is already captured (${dup.number})`);
      const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
      const lines = dto.lines.map((l) => {
        const pl = poLines.find((p) => p.id === l.poLineId);
        if (!pl) throw new BadRequestException('Invoice lines must reference lines of the PO');
        const amount = round2(l.quantity * l.unitPrice);
        const taxAmount = l.taxAmount ?? round2((amount * pl.taxRatePercent) / 100);
        // Withholding tax at the order line's rate, on the amount before VAT.
        const whtAmount = round2((amount * (pl.whtRatePercent ?? 0)) / 100);
        return m.create(SupplierInvoiceLine, { poLineId: pl.id, quantity: l.quantity, unitPrice: l.unitPrice, taxAmount, lineTotal: round2(amount + taxAmount), whtAmount });
      });
      const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
      const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
      // Invoiced in the order currency, at the rate on the invoice date.
      const exchangeRate = await this.finance.rateOn(m, po.currency, dto.invoiceDate);
      const inv = await m.save(
        m.create(SupplierInvoice, {
          number: await this.numbering.next(DocumentType.SUPPLIER_INVOICE, { date: dto.invoiceDate, manager: m }),
          supplierId: po.supplierId,
          supplierInvoiceNo: dto.supplierInvoiceNo.trim(),
          purchaseOrderId: po.id,
          invoiceDate: dto.invoiceDate,
          dueDate: dto.dueDate ?? null,
          etimsInvoiceNo: dto.etimsInvoiceNo ?? null,
          etimsStatus: EtimsStatus.NOT_CHECKED,
          capturedBy: actor.id,
          subtotal,
          taxTotal,
          total: round2(subtotal + taxTotal),
          currency: po.currency,
          exchangeRate,
          baseTotal: round2((subtotal + taxTotal) * exchangeRate),
          whtTotal: round2(lines.reduce((s, l) => s + l.whtAmount, 0)),
          status: InvoiceStatus.CAPTURED,
          lines,
        }),
      );
      await this.match(m, inv);
      await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.SUPPLIER_INVOICE, id: inv.id, no: inv.number });
      const grns: { id: string; number: string }[] = await m.query(
        `SELECT id, number FROM goods_received_note WHERE purchase_order_id = $1 AND status = 'POSTED'`,
        [po.id],
      );
      for (const g of grns) {
        await this.links.link(m, { type: DocumentType.GOODS_RECEIVED_NOTE, id: g.id, no: g.number }, { type: DocumentType.SUPPLIER_INVOICE, id: inv.id, no: inv.number });
      }
      return inv.id;
    });
    await this.verifyOnEtims(id);
    return this.get(id);
  }

  /** Looks the invoice up among the supplier sales on eTIMS (fetching the latest first), then re-matches. */
  private async verifyOnEtims(id: string) {
    const status = await this.etims.verifySupplierInvoice(id);
    if (status === EtimsStatus.NOT_CHECKED) return;
    await this.ds.transaction(async (m) => this.match(m, await this.lock(m, id)));
  }

  /** Re-runs the match (e.g. after more goods were received). */
  async rematch(id: string): Promise<SupplierInvoice> {
    const current = await this.ds.getRepository(SupplierInvoice).findOneBy({ id });
    if (current && current.etimsStatus !== EtimsStatus.VERIFIED) await this.etims.verifySupplierInvoice(id);
    await this.ds.transaction(async (m) => {
      const inv = await this.lock(m, id);
      if (![InvoiceStatus.CAPTURED, InvoiceStatus.RETURNED].includes(inv.status)) throw new ConflictException(`Invoice is ${inv.status}`);
      await this.match(m, inv);
    });
    return this.get(id);
  }

  async submit(id: string, actor: SessionUser): Promise<SupplierInvoice> {
    await this.ds.transaction(async (m) => {
      const inv = await this.lock(m, id);
      if (![InvoiceStatus.CAPTURED, InvoiceStatus.RETURNED].includes(inv.status)) throw new ConflictException(`Invoice is ${inv.status}`);
      await this.match(m, inv);
      const [po] = await m.query(`SELECT department_id FROM purchase_order WHERE id = $1`, [inv.purchaseOrderId]);
      const [s] = await m.query(`SELECT name FROM supplier WHERE id = $1`, [inv.supplierId]);
      // Optionally, a clean three-way match needs no approval; exceptions always do.
      if (inv.matchStatus === MatchStatus.MATCHED && (await this.settings.get('purchasing.autoApproveMatchedInvoices', m))) {
        inv.lastComment = 'Approved automatically: matches the order and the receipts within tolerance';
        await m.save(inv);
        await this.approve(m, inv.id);
        return;
      }
      await this.approvals.start(m, {
        documentType: DocumentType.SUPPLIER_INVOICE,
        documentId: inv.id,
        documentNo: inv.number,
        amount: inv.baseTotal,
        currency: inv.currency,
        departmentId: po?.department_id,
        requestedBy: actor.id,
        summary: `${s?.name ?? ''} ${inv.supplierInvoiceNo} · ${inv.matchStatus === MatchStatus.MATCHED ? 'matched' : `${inv.variances.length} variance(s)`}`,
        link: `/invoices/${inv.id}`,
      });
      inv.status = InvoiceStatus.PENDING_APPROVAL;
      await m.save(inv);
    });
    return this.get(id);
  }

  /** Approved: the spend becomes actual and the matching commitment is released. */
  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    await this.approve(m, req.documentId);
  }

  /** Approved for payment: the spend (base currency) becomes actual, the commitment is released and the order may become INVOICED. */
  private async approve(m: EntityManager, id: string): Promise<void> {
    const inv = await m.findOneByOrFail(SupplierInvoice, { id });
    const po = await m.findOneByOrFail(PurchaseOrder, { id: inv.purchaseOrderId });
    const value = inv.baseTotal || inv.total;
    if (po.budgetId) {
      const doc = { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number };
      const open = await this.budgets.openCommitment(m, po.budgetId, DocumentType.PURCHASE_ORDER, po.id);
      const release = Math.min(open, value);
      if (release > 0) await this.budgets.entry(m, po.budgetId, BudgetEntryType.RELEASE, -release, doc);
      await this.budgets.entry(m, po.budgetId, BudgetEntryType.ACTUAL, value, { type: DocumentType.SUPPLIER_INVOICE, id: inv.id, no: inv.number });
    }
    inv.status = InvoiceStatus.APPROVED;
    await m.save(inv);
    await this.refreshOrderInvoiced(m, po);
  }

  /** A fully received order whose every line is covered by approved invoices is INVOICED. */
  private async refreshOrderInvoiced(m: EntityManager, po: PurchaseOrder): Promise<void> {
    if (po.status !== PurchaseOrderStatus.RECEIVED) return;
    const [{ open }] = await m.query(
      `SELECT COUNT(*)::int AS open FROM purchase_order_line l
        WHERE l.purchase_order_id = $1 AND l.quantity > COALESCE((SELECT SUM(il.quantity) FROM supplier_invoice_line il JOIN supplier_invoice i ON i.id = il.invoice_id
                                                                   WHERE il.po_line_id = l.id AND i.status = ANY($2::invoice_status[])), 0)`,
      [po.id, APPROVED_INVOICE],
    );
    if (open) return;
    po.status = PurchaseOrderStatus.INVOICED;
    await m.save(po);
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const inv = await m.findOneByOrFail(SupplierInvoice, { id: req.documentId });
    inv.status = InvoiceStatus.REJECTED;
    inv.lastComment = comment;
    await m.save(inv);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const inv = await m.findOneByOrFail(SupplierInvoice, { id: req.documentId });
    inv.status = InvoiceStatus.RETURNED;
    inv.lastComment = comment;
    await m.save(inv);
  }

  /** Records payment (simple voucher for now). */
  async pay(id: string, dto: PayInvoiceDto): Promise<SupplierInvoice> {
    await this.ds.transaction(async (m) => {
      const inv = await this.lock(m, id);
      if (inv.status !== InvoiceStatus.APPROVED) throw new ConflictException(`Invoice is ${inv.status}; only approved invoices can be paid`);
      const pv = await m.save(
        m.create(PaymentVoucher, {
          number: await this.numbering.next(DocumentType.PAYMENT_VOUCHER, { date: dto.paidOn, manager: m }),
          invoiceId: inv.id,
          amount: inv.total,
          paidOn: dto.paidOn,
          paymentReference: dto.paymentReference,
          method: dto.method,
        }),
      );
      await this.links.link(m, { type: DocumentType.SUPPLIER_INVOICE, id: inv.id, no: inv.number }, { type: DocumentType.PAYMENT_VOUCHER, id: pv.id, no: pv.number });
      inv.status = InvoiceStatus.PAID;
      await m.save(inv);
    });
    return this.get(id);
  }

  async cancel(id: string, actor: SessionUser): Promise<SupplierInvoice> {
    await this.ds.transaction(async (m) => {
      const inv = await this.lock(m, id);
      if (![InvoiceStatus.CAPTURED, InvoiceStatus.RETURNED, InvoiceStatus.PENDING_APPROVAL].includes(inv.status)) throw new ConflictException(`Invoice is ${inv.status}`);
      await this.approvals.cancelPending(m, DocumentType.SUPPLIER_INVOICE, id, actor.id);
      inv.status = InvoiceStatus.CANCELLED;
      await m.save(inv);
    });
    return this.get(id);
  }

  /** Side-by-side PO / received / invoiced figures for the match view. */
  async matchView(id: string) {
    const inv = await this.get(id);
    const poLines = await this.ds.getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: inv.purchaseOrderId }, relations: { item: true, uom: true }, order: { lineNo: 'ASC' } });
    const invoiced: { po_line_id: string; q: string }[] = await this.ds.query(
      `SELECT l.po_line_id, SUM(l.quantity) AS q FROM supplier_invoice_line l JOIN supplier_invoice i ON i.id = l.invoice_id
        WHERE i.purchase_order_id = $1 AND i.status NOT IN ('REJECTED', 'CANCELLED') GROUP BY l.po_line_id`,
      [inv.purchaseOrderId],
    );
    return {
      invoice: inv,
      lines: poLines.map((pl) => {
        const il = inv.lines?.find((l) => l.poLineId === pl.id);
        return {
          poLineId: pl.id,
          lineNo: pl.lineNo,
          item: pl.item?.name ?? pl.description,
          uom: pl.uom?.code,
          orderedQty: pl.quantity,
          poUnitPrice: pl.unitPrice,
          receivedQty: round4(pl.receivedBaseQty / pl.conversionFactor),
          invoicedToDate: Number(invoiced.find((x) => x.po_line_id === pl.id)?.q ?? 0),
          thisInvoiceQty: il?.quantity ?? 0,
          thisInvoicePrice: il?.unitPrice ?? null,
          variances: inv.variances.filter((v) => v.poLineId === pl.id),
        };
      }),
    };
  }

  private async lock(m: EntityManager, id: string): Promise<SupplierInvoice> {
    const inv = await m.findOne(SupplierInvoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async get(id: string): Promise<SupplierInvoice> {
    const inv = await this.ds.getRepository(SupplierInvoice).findOne({
      where: { id },
      relations: { supplier: true, purchaseOrder: true, lines: { poLine: { item: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async list(q: DocListQueryDto): Promise<Paginated<SupplierInvoice>> {
    const qb = this.ds
      .getRepository(SupplierInvoice)
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.supplier', 'supplier')
      .leftJoinAndSelect('i.purchaseOrder', 'po')
      .orderBy('i.createdAt', 'DESC');
    if (q.status) qb.andWhere('i.status = :st', { st: q.status });
    if (q.supplierId) qb.andWhere('i.supplier_id = :s', { s: q.supplierId });
    if (q.purchaseOrderId) qb.andWhere('i.purchase_order_id = :po', { po: q.purchaseOrderId });
    if (q.search) qb.andWhere('(i.number ILIKE :q OR i.supplier_invoice_no ILIKE :q OR supplier.name ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

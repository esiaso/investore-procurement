import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { DataSource, EntityManager, In } from 'typeorm';
import { PdfService } from '../mail/pdf.service';
import { renderReceiptHtml } from './receipt';
import { DocumentType, EtimsSyncStatus, Paginated, Permissions, SalesDocType, SalesInvoiceStatus, SalesSource, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { DocumentLinksService } from '../approvals/document-links.service';
import { EtimsService } from '../etims/etims.service';
import { InventoryService } from '../inventory/inventory.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { TaxService } from '../tax/tax.service';
import { Payer, PaymentMode, PriceList, PriceListItem, SalesInvoice, SalesInvoiceLine, SalesPayment } from './billing.entities';
import { CreateCreditNoteDto, CreateSaleDto, InvoiceQueryDto, PaymentDto } from './billing.dto';
import { Allocation, returnStock, takeStock } from './dispense-stock';
import { computeLine, inclusivePrice, KRA_PIN, round2, splitPayer, summarise } from './tax-calc';

export interface InvoiceLineInput {
  itemId: string;
  quantity: number;
  unitPrice?: number;
  discountPercent?: number;
  description?: string;
  sourceLineId?: string | null;
  allocations?: Allocation[];
}

export interface InvoiceInput {
  /** Pre-allocated id and number (when stock movements were posted first). */
  id?: string;
  number?: string;
  storeId: string;
  source: SalesSource;
  sourceId?: string | null;
  patientId?: string | null;
  customerName?: string | null;
  customerPin?: string | null;
  customerPhone?: string | null;
  payerId?: string | null;
  priceListId?: string | null;
  lines: InvoiceLineInput[];
  payments?: PaymentDto[];
  externalRef?: string | null;
  notes?: string | null;
}

/**
 * Sales invoices for pharmacy dispenses, OTC sales, patient-chargeable
 * consumables and HMIS charges, with VAT per line from the tax tables, payer
 * split and payments; credit notes for returns and refunds. Every issued
 * document is queued for eTIMS in the same transaction.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly tax: TaxService,
    private readonly settings: SettingsService,
    private readonly etims: EtimsService,
    private readonly inventory: InventoryService,
    private readonly links: DocumentLinksService,
    private readonly pdf: PdfService,
  ) {}

  // ------------------------------------------------------------------ prices

  async defaultPriceList(m: EntityManager): Promise<PriceList> {
    const code = await this.settings.get('billing.defaultPriceListCode', m);
    const list = (await m.findOneBy(PriceList, { code, isActive: true })) ?? (await m.findOneBy(PriceList, { isDefault: true, isActive: true }));
    if (!list) throw new BadRequestException('No default price list is configured');
    return list;
  }

  /** VAT-inclusive unit price of an item on a list: explicit price, else the item price ± the list adjustment. */
  async priceFor(m: EntityManager, list: PriceList, itemId: string): Promise<{ price: number; taxCategoryId: string; ratePercent: number; name: string }> {
    const [it] = await m.query(`SELECT name, unit_price, tax_category_id FROM item WHERE id = $1`, [itemId]);
    if (!it) throw new NotFoundException(`Item ${itemId} not found`);
    const rate = await this.tax.rateFor(it.tax_category_id, await this.settings.today(m));
    const explicit = await m.findOneBy(PriceListItem, { priceListId: list.id, itemId });
    return { price: explicit ? explicit.price : inclusivePrice(Number(it.unit_price), list.adjustPercent, rate), taxCategoryId: it.tax_category_id, ratePercent: rate, name: it.name };
  }

  private async taxTypeCode(m: EntityManager, taxCategoryId: string): Promise<string> {
    const [r] = await m.query(
      `SELECT mp.etims_code FROM tax_category t LEFT JOIN etims_code_mapping mp ON mp.kind = 'TAX_CATEGORY' AND mp.local_key = t.code WHERE t.id = $1`,
      [taxCategoryId],
    );
    if (!r?.etims_code) {
      const [t] = await m.query(`SELECT code FROM tax_category WHERE id = $1`, [taxCategoryId]);
      throw new BadRequestException({ code: 'ETIMS_MAPPING_MISSING', message: `Tax category ${t?.code} has no eTIMS tax type mapping` });
    }
    return r.etims_code;
  }

  // ------------------------------------------------------------------ invoices

  /** Creates and issues an invoice in the caller's transaction; returns it with the eTIMS outbox id. */
  async createInvoice(m: EntityManager, input: InvoiceInput, actor: SessionUser): Promise<{ invoice: SalesInvoice; outboxId: string | null; change: number }> {
    if (!input.lines.length) throw new BadRequestException('An invoice needs at least one line');
    if (input.customerPin && !KRA_PIN.test(input.customerPin)) throw new BadRequestException('Buyer KRA PIN is not valid (e.g. P051234567X)');
    if (input.externalRef) {
      const dup = await m.findOneBy(SalesInvoice, { externalRef: input.externalRef });
      if (dup) throw new ConflictException({ code: 'DUPLICATE_EXTERNAL_REF', message: `Already invoiced as ${dup.number}`, invoiceId: dup.id });
    }
    await this.etims.assertInvoiceable(m, input.storeId, input.lines.map((l) => l.itemId));
    const payer = input.payerId ? await m.findOneBy(Payer, { id: input.payerId, isActive: true }) : null;
    if (input.payerId && !payer) throw new BadRequestException('Payer not found or inactive');
    const list = input.priceListId
      ? await m.findOneByOrFail(PriceList, { id: input.priceListId })
      : payer?.priceListId
        ? await m.findOneByOrFail(PriceList, { id: payer.priceListId })
        : await this.defaultPriceList(m);

    const lines: Partial<SalesInvoiceLine>[] = [];
    for (const [i, l] of input.lines.entries()) {
      const p = await this.priceFor(m, list, l.itemId);
      const taxTypeCode = await this.taxTypeCode(m, p.taxCategoryId);
      const unitPrice = l.unitPrice ?? p.price;
      const amounts = computeLine({ quantity: l.quantity, unitPrice, discountPercent: l.discountPercent ?? 0, taxRatePercent: p.ratePercent, taxTypeCode });
      const split = splitPayer(amounts.grossAmount, payer ? payer.coPayPercent : null);
      lines.push({
        lineNo: i + 1,
        itemId: l.itemId,
        description: (l.description ?? p.name).slice(0, 200),
        quantity: l.quantity,
        unitPrice,
        discountPercent: l.discountPercent ?? 0,
        discountAmount: amounts.discountAmount,
        taxCategoryId: p.taxCategoryId,
        taxTypeCode,
        taxRatePercent: p.ratePercent,
        grossAmount: amounts.grossAmount,
        taxAmount: amounts.taxAmount,
        netAmount: amounts.netAmount,
        patientShare: split.patientShare,
        payerShare: split.payerShare,
        sourceLineId: l.sourceLineId ?? null,
        allocations: l.allocations ?? [],
      });
    }
    const sum = summarise(lines as (SalesInvoiceLine & { taxTypeCode: string })[]);
    const payerAmount = round2(lines.reduce((s, l) => s + l.payerShare!, 0));
    const patientAmount = round2(sum.totalAmount - payerAmount);
    const { payments, change } = await this.settlePayments(m, input.payments ?? [], patientAmount, payer, payerAmount);

    const invoice = await m.save(
      m.create(SalesInvoice, {
        ...(input.id ? { id: input.id } : {}),
        number: input.number ?? (await this.numbering.next(DocumentType.SALES_INVOICE, { storeId: input.storeId, manager: m })),
        docType: SalesDocType.INVOICE,
        status: SalesInvoiceStatus.ISSUED,
        source: input.source,
        sourceId: input.sourceId ?? null,
        externalRef: input.externalRef ?? null,
        storeId: input.storeId,
        patientId: input.patientId ?? null,
        customerName: input.customerName ?? null,
        customerPin: input.customerPin ?? null,
        customerPhone: input.customerPhone ?? null,
        payerId: payer?.id ?? null,
        priceListId: list.id,
        issuedAt: new Date(),
        taxSummary: sum.buckets,
        totalNet: sum.totalNet,
        totalTax: sum.totalTax,
        totalAmount: sum.totalAmount,
        discountAmount: sum.discountAmount,
        payerAmount,
        patientAmount,
        paidAmount: round2(payments.reduce((s, p) => s + p.amount!, 0)),
        notes: input.notes ?? null,
        lines: lines.map((l) => m.create(SalesInvoiceLine, l)),
        payments: payments.map((p) => m.create(SalesPayment, p)),
      }),
    );
    const ob = await this.etims.queueSale(m, invoice.id, actor);
    return { invoice, outboxId: ob?.id ?? null, change };
  }

  /**
   * Payments for the patient's share (cash change is returned, not recorded)
   * plus the payer's share on the payer's credit mode. An unpaid patient share
   * is left on account (billing.patientCreditMode).
   */
  private async settlePayments(m: EntityManager, given: PaymentDto[], patientAmount: number, payer: Payer | null, payerAmount: number) {
    const modes = new Map((await m.find(PaymentMode, { where: { isActive: true } })).map((x) => [x.code, x]));
    const out: Partial<SalesPayment>[] = [];
    let due = patientAmount;
    let change = 0;
    for (const p of given) {
      const mode = modes.get(p.modeCode);
      if (!mode) throw new BadRequestException(`Unknown payment mode ${p.modeCode}`);
      if (mode.requiresReference && !p.reference?.trim()) throw new BadRequestException(`${mode.name} needs a reference (e.g. M-Pesa code)`);
      if (p.amount <= 0) continue;
      const amount = round2(Math.min(p.amount, due));
      if (p.amount > due) change = round2(change + p.amount - due);
      if (amount <= 0) continue;
      out.push({ modeCode: mode.code, etimsPaymentTypeCode: mode.etimsPaymentTypeCode, amount, reference: p.reference?.trim() || null });
      due = round2(due - amount);
    }
    if (due > 0) {
      const credit = modes.get(await this.settings.get('billing.patientCreditMode', m));
      if (!credit) throw new BadRequestException(`Payment of ${due} is missing`);
      out.push({ modeCode: credit.code, etimsPaymentTypeCode: credit.etimsPaymentTypeCode, amount: due, reference: null });
    }
    if (payer && payerAmount > 0) {
      const mode = [...modes.values()].find((x) => x.code === payer.type) ?? modes.get('INSURANCE');
      if (!mode) throw new BadRequestException(`No payment mode for ${payer.type}`);
      out.push({ modeCode: mode.code, etimsPaymentTypeCode: mode.etimsPaymentTypeCode, amount: payerAmount, reference: payer.code, payerId: payer.id });
    }
    return { payments: out, change };
  }

  /** OTC sale, consumables or HMIS charge (POST /billing/invoices and the integration API). */
  async sell(dto: CreateSaleDto, actor: SessionUser) {
    StoreScope.assert(dto.storeId);
    const deduct = dto.deductStock ?? dto.source !== SalesSource.HMIS;
    const result = await this.ds.transaction(async (m) => {
      // Number the invoice first so its stock movements point at it.
      const id = randomUUID();
      const number = await this.numbering.next(DocumentType.SALES_INVOICE, { storeId: dto.storeId, manager: m });
      let allocations = new Map<string, Allocation[]>();
      if (deduct) {
        const ctx = await this.inventory.postingContext(actor, { type: DocumentType.SALES_INVOICE, id, number }, undefined, null, m);
        ({ allocations } = await takeStock(m, ctx, dto.storeId, dto.lines.map((l, i) => ({ key: String(i), itemId: l.itemId, quantity: l.quantity }))));
      }
      return this.createInvoice(
        m,
        {
          id,
          number,
          storeId: dto.storeId,
          source: dto.source,
          patientId: dto.customer?.patientId ?? null,
          customerName: dto.customer?.name ?? null,
          customerPin: dto.customer?.kraPin ?? null,
          customerPhone: dto.customer?.phone ?? null,
          payerId: dto.customer?.payerId ?? null,
          priceListId: dto.priceListId ?? null,
          externalRef: dto.externalRef ?? null,
          notes: dto.notes ?? null,
          payments: dto.payments,
          lines: dto.lines.map((l, i) => ({ ...l, allocations: allocations.get(String(i)) ?? [] })),
        },
        actor,
      );
    });
    if (result.outboxId) await this.etims.trySendNow(result.outboxId);
    return { ...(await this.get(result.invoice.id)), change: result.change };
  }

  /**
   * Credit note for returns / refunds against an issued invoice. `inTx` runs in
   * the same transaction (e.g. the pharmacy updating its dispense records).
   */
  async creditNote(invoiceId: string, dto: CreateCreditNoteDto, actor: SessionUser, inTx?: (m: EntityManager, cn: SalesInvoice) => Promise<void>) {
    const r = await this.ds.transaction(async (m) => {
      const orig = await m.findOne(SalesInvoice, { where: { id: invoiceId }, relations: { lines: true, payments: true }, lock: { mode: 'pessimistic_write' } });
      if (!orig) throw new NotFoundException('Invoice not found');
      if (orig.docType !== SalesDocType.INVOICE) throw new BadRequestException('Credit notes are raised against invoices');
      StoreScope.assert(orig.storeId);
      const credited: { original_line_id: string; q: number }[] = await m.query(
        `SELECT l.original_line_id, SUM(l.quantity)::float AS q FROM sales_invoice_line l JOIN sales_invoice s ON s.id = l.invoice_id
          WHERE s.original_invoice_id = $1 AND s.status = 'ISSUED' GROUP BY l.original_line_id`,
        [orig.id],
      );
      const left = (lineId: string, qty: number) => Math.round((qty - (credited.find((c) => c.original_line_id === lineId)?.q ?? 0)) * 10_000) / 10_000;
      const wanted = dto.lines?.length
        ? dto.lines
        : (orig.lines ?? []).map((l) => ({ invoiceLineId: l.id, quantity: left(l.id, l.quantity) })).filter((l) => l.quantity > 0);
      if (!wanted.length) throw new BadRequestException('Nothing left to credit on this invoice');
      const lines: Partial<SalesInvoiceLine>[] = [];
      const restock: { itemId: string; allocations: Allocation[]; quantity: number }[] = [];
      for (const [i, w] of wanted.entries()) {
        const ol = (orig.lines ?? []).find((l) => l.id === w.invoiceLineId);
        if (!ol) throw new BadRequestException('A line is not on this invoice');
        if (w.quantity > left(ol.id, ol.quantity)) throw new BadRequestException(`Only ${left(ol.id, ol.quantity)} of ${ol.description} can still be credited`);
        const amounts = computeLine({ quantity: w.quantity, unitPrice: ol.unitPrice, discountPercent: ol.discountPercent, taxRatePercent: ol.taxRatePercent, taxTypeCode: ol.taxTypeCode });
        const ratio = ol.grossAmount ? amounts.grossAmount / ol.grossAmount : 0;
        lines.push({
          lineNo: i + 1,
          itemId: ol.itemId,
          description: ol.description,
          quantity: w.quantity,
          unitPrice: ol.unitPrice,
          discountPercent: ol.discountPercent,
          discountAmount: amounts.discountAmount,
          taxCategoryId: ol.taxCategoryId,
          taxTypeCode: ol.taxTypeCode,
          taxRatePercent: ol.taxRatePercent,
          grossAmount: amounts.grossAmount,
          taxAmount: amounts.taxAmount,
          netAmount: amounts.netAmount,
          payerShare: round2(ol.payerShare * ratio),
          patientShare: round2(amounts.grossAmount - round2(ol.payerShare * ratio)),
          originalLineId: ol.id,
          sourceLineId: ol.sourceLineId,
          allocations: [],
        });
        if (dto.restock && ol.allocations?.length) restock.push({ itemId: ol.itemId, allocations: ol.allocations, quantity: w.quantity });
      }
      const sum = summarise(lines as (SalesInvoiceLine & { taxTypeCode: string })[]);
      const payerAmount = round2(lines.reduce((s, l) => s + l.payerShare!, 0));
      const main = [...(orig.payments ?? [])].sort((a, b) => b.amount - a.amount)[0];
      const cn = await m.save(
        m.create(SalesInvoice, {
          number: await this.numbering.next(DocumentType.CREDIT_NOTE, { storeId: orig.storeId, manager: m }),
          docType: SalesDocType.CREDIT_NOTE,
          originalInvoiceId: orig.id,
          creditReasonCode: dto.reasonCode ?? '06',
          status: SalesInvoiceStatus.ISSUED,
          source: SalesSource.RETURN,
          sourceId: orig.sourceId,
          storeId: orig.storeId,
          patientId: orig.patientId,
          customerName: orig.customerName,
          customerPin: orig.customerPin,
          customerPhone: orig.customerPhone,
          payerId: orig.payerId,
          priceListId: orig.priceListId,
          issuedAt: new Date(),
          taxSummary: sum.buckets,
          totalNet: sum.totalNet,
          totalTax: sum.totalTax,
          totalAmount: sum.totalAmount,
          discountAmount: sum.discountAmount,
          payerAmount,
          patientAmount: round2(sum.totalAmount - payerAmount),
          paidAmount: sum.totalAmount,
          notes: dto.reason,
          lines: lines.map((l) => m.create(SalesInvoiceLine, l)),
          payments: main ? [m.create(SalesPayment, { modeCode: main.modeCode, etimsPaymentTypeCode: main.etimsPaymentTypeCode, amount: sum.totalAmount, reference: `Refund of ${orig.number}` })] : [],
        }),
      );
      if (restock.length) {
        const ctx = await this.inventory.postingContext(actor, { type: DocumentType.CREDIT_NOTE, id: cn.id, number: cn.number }, undefined, null, m);
        await returnStock(m, ctx, orig.storeId, restock);
      }
      await this.links.link(m, { type: 'SI', id: orig.id, no: orig.number }, { type: 'CN', id: cn.id, no: cn.number });
      if (inTx) await inTx(m, cn);
      const ob = await this.etims.queueSale(m, cn.id, actor);
      return { cn, outboxId: ob?.id ?? null };
    });
    if (r.outboxId) await this.etims.trySendNow(r.outboxId);
    return this.get(r.cn.id);
  }

  async get(id: string, actor?: SessionUser) {
    const inv = await this.ds.getRepository(SalesInvoice).findOne({
      where: { id },
      relations: { lines: { item: { baseUom: true } }, payments: true, payer: true, store: true, originalInvoice: true },
      order: { lines: { lineNo: 'ASC' } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (actor && !actor.permissions.includes(Permissions.BILLING_READ) && !actor.permissions.includes(Permissions.PHARMACY_READ)) throw new ForbiddenException();
    StoreScope.assert(inv.storeId);
    const credits = inv.docType === SalesDocType.INVOICE ? await this.ds.getRepository(SalesInvoice).find({ where: { originalInvoiceId: id }, order: { createdAt: 'ASC' } }) : [];
    return { ...inv, creditNotes: credits.map((c) => ({ id: c.id, number: c.number, totalAmount: c.totalAmount, etimsStatus: c.etimsStatus })) };
  }

  async list(q: InvoiceQueryDto): Promise<Paginated<SalesInvoice>> {
    const qb = this.ds.getRepository(SalesInvoice).createQueryBuilder('s').leftJoinAndSelect('s.store', 'store').leftJoinAndSelect('s.payer', 'payer').orderBy('s.createdAt', 'DESC');
    StoreScope.apply(qb, 's.store_id');
    if (q.storeId) qb.andWhere('s.store_id = :st', { st: q.storeId });
    if (q.docType) qb.andWhere('s.doc_type = :dt', { dt: q.docType });
    if (q.etimsStatus) qb.andWhere('s.etims_status = :es', { es: q.etimsStatus });
    if (q.source) qb.andWhere('s.source = :src', { src: q.source });
    if (q.patientId) qb.andWhere('s.patient_id = :p', { p: q.patientId });
    if (q.from) qb.andWhere(`s.issued_at >= :from::date`, { from: q.from });
    if (q.to) qb.andWhere(`s.issued_at < (:to::date + 1)`, { to: q.to });
    if (q.search) qb.andWhere('(s.number ILIKE :q OR s.customer_name ILIKE :q OR s.cu_invoice_no ILIKE :q)', { q: `%${q.search}%` });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Thermal (80 mm) or A4 receipt / invoice PDF. `copy` marks reprints as COPY (TIS spec). */
  async receiptPdf(id: string, layout: 'THERMAL' | 'A4', copy: boolean): Promise<{ number: string; pdf: Buffer }> {
    const inv = await this.get(id);
    const [seller] = await this.ds.query(
      `SELECT f.name, f.address, f.phone, f.kra_pin, s.name AS outlet FROM store s JOIN facility f ON f.id = s.facility_id WHERE s.id = $1`,
      [inv.storeId],
    );
    const config = await this.etims.configForStore(this.ds.manager, inv.storeId);
    const qr = inv.etimsStatus === EtimsSyncStatus.ACCEPTED && config ? await QRCode.toDataURL(await this.etims.qrUrl(inv, config), { margin: 1, width: 240 }) : null;
    const modes = await this.paymentModes();
    const html = renderReceiptHtml(
      {
        invoice: inv as unknown as SalesInvoice & { lines: SalesInvoiceLine[]; payments: SalesPayment[] },
        seller: { name: seller?.name ?? '', address: seller?.address ?? null, phone: seller?.phone ?? null, kraPin: config?.kraPin ?? seller?.kra_pin ?? null, outlet: seller?.outlet ?? '' },
        cuId: config?.cuId ?? null,
        qrDataUrl: qr,
        paymentNames: Object.fromEntries(modes.map((x) => [x.code, x.name])),
        currency: await this.settings.get('locale.currency'),
        dateFormat: await this.settings.get('locale.dateFormat'),
        timezone: await this.settings.get('locale.timezone'),
        label: copy ? 'COPY' : null,
      },
      layout,
    );
    return { number: inv.number, pdf: await this.pdf.render(html, layout === 'THERMAL' ? { width: '80mm' } : undefined) };
  }

  /** The QR link (for tests and the receipt preview). */
  async qrFor(id: string) {
    const inv = await this.get(id);
    const config = await this.etims.configForStore(this.ds.manager, inv.storeId);
    return config && inv.rcptSign ? this.etims.qrUrl(inv, config) : null;
  }

  // ------------------------------------------------------------------ configuration

  priceLists() {
    return this.ds.getRepository(PriceList).find({ order: { code: 'ASC' } });
  }

  async savePriceList(id: string | null, dto: Partial<PriceList>) {
    const repo = this.ds.getRepository(PriceList);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Price list not found');
    return repo.save(Object.assign(row, dto));
  }

  async setPrice(priceListId: string, itemId: string, price: number) {
    const repo = this.ds.getRepository(PriceListItem);
    const row = (await repo.findOneBy({ priceListId, itemId })) ?? repo.create({ priceListId, itemId });
    row.price = price;
    return repo.save(row);
  }

  priceListItems(priceListId: string) {
    return this.ds.getRepository(PriceListItem).find({ where: { priceListId }, relations: { item: true }, order: { createdAt: 'DESC' }, take: 1000 });
  }

  payers() {
    return this.ds.getRepository(Payer).find({ order: { name: 'ASC' } });
  }

  async savePayer(id: string | null, dto: Partial<Payer>) {
    const repo = this.ds.getRepository(Payer);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Payer not found');
    return repo.save(Object.assign(row, dto));
  }

  paymentModes() {
    return this.ds.getRepository(PaymentMode).find({ order: { code: 'ASC' } });
  }

  async setPaymentModeCode(code: string, etimsPaymentTypeCode: string) {
    const repo = this.ds.getRepository(PaymentMode);
    const row = await repo.findOneBy({ code });
    if (!row) throw new NotFoundException('Payment mode not found');
    row.etimsPaymentTypeCode = etimsPaymentTypeCode;
    return repo.save(row);
  }

  /** Invoices for a set of ids (reports). */
  findByIds(ids: string[]) {
    return this.ds.getRepository(SalesInvoice).findBy({ id: In(ids) });
  }

  pendingStatus(): EtimsSyncStatus[] {
    return [EtimsSyncStatus.PENDING, EtimsSyncStatus.SENT, EtimsSyncStatus.FAILED];
  }
}

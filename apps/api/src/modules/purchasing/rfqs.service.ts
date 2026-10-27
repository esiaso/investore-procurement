import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, Paginated, PurchaseOrderSource, RequisitionStatus, RfqStatus, SessionUser } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { DocumentLinksService } from '../approvals/document-links.service';
import { MailService } from '../mail/mail.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { RequisitionsService } from './requisitions.service';
import { AwardRfqDto, CreateRfqDto, DocListQueryDto, RecordQuotationDto } from './purchasing.dto';
import { PurchaseRequisition, PurchaseRequisitionLine, Quotation, QuotationLine, Rfq, RfqLine } from './purchasing.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ComparisonQuote {
  quotationId: string;
  quotationLineId: string;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  lineTotal: number;
  deliveryDays: number | null;
  compliant: boolean;
  offeredBrand: string | null;
  rank: number;
  lowestCompliant: boolean;
}

/** Ranks quotes for one line: compliant first, then price, then delivery time. */
export function rankQuotes<T extends { unitPrice: number; compliant: boolean; deliveryDays: number | null }>(quotes: T[]): (T & { rank: number; lowestCompliant: boolean })[] {
  const sorted = [...quotes].sort(
    (a, b) => Number(b.compliant) - Number(a.compliant) || a.unitPrice - b.unitPrice || (a.deliveryDays ?? 9999) - (b.deliveryDays ?? 9999),
  );
  const lowest = sorted.find((q) => q.compliant);
  return sorted.map((q, i) => ({ ...q, rank: i + 1, lowestCompliant: q === lowest }));
}

@Injectable()
export class RfqsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly links: DocumentLinksService,
    private readonly mail: MailService,
    private readonly suppliers: SuppliersService,
    private readonly settings: SettingsService,
    private readonly orders: PurchaseOrdersService,
    private readonly requisitions: RequisitionsService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.RFQ, async (ids) => {
      const rows = await this.ds.getRepository(Rfq).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.closingDate }]));
    });
  }

  async create(dto: CreateRfqDto): Promise<Rfq> {
    const id = await this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      if (dto.closingDate < today) throw new BadRequestException('Closing date is in the past');
      for (const s of dto.supplierIds) {
        const problems = await this.suppliers.eligibility(m, s, today);
        if (problems.length) throw new BadRequestException({ message: problems.join('; '), code: 'SUPPLIER_NOT_ELIGIBLE' });
      }
      let lines: Partial<RfqLine>[];
      let pr: PurchaseRequisition | null = null;
      if (dto.requisitionId) {
        pr = await m.findOneBy(PurchaseRequisition, { id: dto.requisitionId });
        if (!pr) throw new NotFoundException('Requisition not found');
        if (pr.status !== RequisitionStatus.APPROVED) throw new ConflictException(`Requisition is ${pr.status}; it must be approved`);
        await this.requisitions.assertStockOnly(m, pr.id);
        const prLines = await m.find(PurchaseRequisitionLine, { where: { requisitionId: pr.id } });
        lines = prLines
          .filter((l) => l.quantity > l.orderedQty)
          .map((l) => ({ requisitionLineId: l.id, itemId: l.itemId!, quantity: Math.round((l.quantity - l.orderedQty) * 10_000) / 10_000 }));
        if (!lines.length) throw new BadRequestException('Everything on this requisition is already ordered');
      } else {
        if (!dto.lines?.length) throw new BadRequestException('Give lines or a requisition');
        lines = dto.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity }));
      }
      const rfq = await m.save(
        m.create(Rfq, {
          number: await this.numbering.next(DocumentType.RFQ, { manager: m }),
          requisitionId: pr?.id ?? null,
          title: dto.title,
          closingDate: dto.closingDate,
          supplierIds: [...new Set(dto.supplierIds)],
          status: RfqStatus.DRAFT,
          lines: lines.map((l) => m.create(RfqLine, l)),
        }),
      );
      if (pr) await this.links.link(m, { type: DocumentType.PURCHASE_REQUISITION, id: pr.id, no: pr.number }, { type: DocumentType.RFQ, id: rfq.id, no: rfq.number });
      return rfq.id;
    });
    return this.get(id);
  }

  /** Invites the suppliers by email (queued). */
  async send(id: string): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status !== RfqStatus.DRAFT) throw new ConflictException(`RFQ is ${rfq.status}`);
      const lines = await m.find(RfqLine, { where: { rfqId: id }, relations: { item: { baseUom: true } } });
      const body = lines.map((l, i) => `${i + 1}. ${l.item?.name} — ${l.quantity} ${l.item?.baseUom?.code ?? ''}`).join('\n');
      const suppliers: { id: string; name: string; email: string | null }[] = await m.query(
        `SELECT id, name, email FROM supplier WHERE id = ANY($1::uuid[])`,
        [rfq.supplierIds],
      );
      for (const s of suppliers) {
        if (!s.email) continue;
        await this.mail.enqueue(m, {
          to: s.email,
          subject: `Request for quotation ${rfq.number}: ${rfq.title}`,
          text: `Dear ${s.name},\n\nPlease quote for the following by ${rfq.closingDate} (prices per base unit, excl. VAT, with delivery time):\n\n${body}\n\nRegards,\nProcurement`,
          doc: { type: DocumentType.RFQ, id: rfq.id },
        });
      }
      rfq.status = RfqStatus.SENT;
      await m.save(rfq);
    });
    return this.get(id);
  }

  async recordQuotation(id: string, dto: RecordQuotationDto): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (![RfqStatus.SENT, RfqStatus.EVALUATION].includes(rfq.status)) throw new ConflictException(`RFQ is ${rfq.status}`);
      if (!rfq.supplierIds.includes(dto.supplierId)) throw new BadRequestException('This supplier was not invited to quote');
      const rfqLines = await m.find(RfqLine, { where: { rfqId: id } });
      for (const l of dto.lines) if (!rfqLines.some((r) => r.id === l.rfqLineId)) throw new BadRequestException('Quote line does not belong to this RFQ');
      const existing = await m.findOneBy(Quotation, { rfqId: id, supplierId: dto.supplierId });
      if (existing) await m.remove(existing);
      await m.save(
        m.create(Quotation, {
          rfqId: id,
          supplierId: dto.supplierId,
          supplierReference: dto.supplierReference ?? null,
          validUntil: dto.validUntil ?? null,
          deliveryDays: dto.deliveryDays ?? null,
          compliant: dto.compliant ?? true,
          complianceNotes: dto.complianceNotes ?? null,
          lines: dto.lines.map((l) =>
            m.create(QuotationLine, { rfqLineId: l.rfqLineId, unitPrice: l.unitPrice, quantityOffered: l.quantityOffered ?? null, offeredBrand: l.offeredBrand ?? null }),
          ),
        }),
      );
      rfq.status = RfqStatus.EVALUATION;
      await m.save(rfq);
    });
    return this.get(id);
  }

  /** Comparative analysis: per line, quotes ranked (compliance, price, delivery); per supplier totals. */
  async comparison(id: string) {
    const rfq = await this.get(id);
    const quotations = await this.ds.getRepository(Quotation).find({ where: { rfqId: id }, relations: { supplier: true, lines: true } });
    const lines = (rfq.lines ?? []).map((line) => {
      const quotes = quotations.flatMap((q) =>
        (q.lines ?? [])
          .filter((ql) => ql.rfqLineId === line.id)
          .map((ql) => ({
            quotationId: q.id,
            quotationLineId: ql.id,
            supplierId: q.supplierId,
            supplierName: q.supplier?.name ?? '',
            unitPrice: ql.unitPrice,
            lineTotal: round2(ql.unitPrice * line.quantity),
            deliveryDays: q.deliveryDays,
            compliant: q.compliant,
            offeredBrand: ql.offeredBrand,
          })),
      );
      return { rfqLineId: line.id, itemId: line.itemId, itemName: line.item?.name, quantity: line.quantity, awardedQuotationLineId: line.awardedQuotationLineId, quotes: rankQuotes(quotes) as ComparisonQuote[] };
    });
    const suppliers = quotations.map((q) => ({
      supplierId: q.supplierId,
      supplierName: q.supplier?.name,
      compliant: q.compliant,
      complianceNotes: q.complianceNotes,
      deliveryDays: q.deliveryDays,
      validUntil: q.validUntil,
      linesQuoted: q.lines?.length ?? 0,
      total: round2((q.lines ?? []).reduce((s, ql) => s + ql.unitPrice * (rfq.lines!.find((l) => l.id === ql.rfqLineId)?.quantity ?? 0), 0)),
      lowestOnLines: lines.filter((l) => l.quotes.find((x) => x.lowestCompliant)?.supplierId === q.supplierId).length,
    }));
    return { rfq, lines, suppliers };
  }

  /** Awards lines and creates one draft PO per winning supplier. */
  async award(id: string, dto: AwardRfqDto, actor: SessionUser) {
    const comparison = await this.comparison(id);
    const poIds = await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status !== RfqStatus.EVALUATION) throw new ConflictException(`RFQ is ${rfq.status}; record quotations first`);
      let deviates = false;
      const winners = new Map<string, { rfqLine: RfqLine; quote: ComparisonQuote }[]>();
      const rfqLines = await m.find(RfqLine, { where: { rfqId: id } });
      for (const a of dto.awards) {
        const line = comparison.lines.find((l) => l.rfqLineId === a.rfqLineId);
        const quote = line?.quotes.find((q) => q.quotationLineId === a.quotationLineId);
        if (!line || !quote) throw new BadRequestException('Award does not match a quote on this RFQ');
        if (!quote.lowestCompliant) deviates = true;
        const rfqLine = rfqLines.find((l) => l.id === a.rfqLineId)!;
        rfqLine.awardedQuotationLineId = quote.quotationLineId;
        rfqLine.awardJustification = quote.lowestCompliant ? null : (dto.justification ?? null);
        await m.save(rfqLine);
        winners.set(quote.supplierId, [...(winners.get(quote.supplierId) ?? []), { rfqLine, quote }]);
      }
      if (deviates && !dto.justification?.trim()) {
        throw new BadRequestException({ message: 'Justify awarding to other than the lowest compliant quote', code: 'JUSTIFICATION_REQUIRED' });
      }
      const pr = rfq.requisitionId ? await m.findOneByOrFail(PurchaseRequisition, { id: rfq.requisitionId }) : null;
      if (!pr) throw new BadRequestException('Awarding to purchase orders needs an RFQ raised from a requisition');
      const ids: string[] = [];
      for (const [supplierId, awarded] of winners) {
        const po = await this.orders.createDraft(
          m,
          {
            supplierId,
            storeId: pr.storeId,
            departmentId: pr.departmentId,
            budgetId: pr.budgetId,
            source: PurchaseOrderSource.RFQ,
            requisitionId: pr.id,
            rfqId: rfq.id,
            expectedDelivery: dto.expectedDelivery ?? null,
          },
          awarded.map(({ rfqLine, quote }) => ({
            itemId: rfqLine.itemId,
            quantity: rfqLine.quantity,
            unitPrice: quote.unitPrice,
            requisitionLineId: rfqLine.requisitionLineId,
            rfqLineId: rfqLine.id,
          })),
          actor,
        );
        await this.links.link(m, { type: DocumentType.RFQ, id: rfq.id, no: rfq.number }, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number });
        ids.push(po.id);
      }
      rfq.status = RfqStatus.AWARDED;
      rfq.awardJustification = dto.justification ?? null;
      await m.save(rfq);
      return ids;
    });
    return { rfq: await this.get(id), purchaseOrderIds: poIds };
  }

  async cancel(id: string): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status === RfqStatus.AWARDED) throw new ConflictException('An awarded RFQ cannot be cancelled');
      rfq.status = RfqStatus.CANCELLED;
      await m.save(rfq);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<Rfq> {
    const rfq = await m.findOne(Rfq, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return rfq;
  }

  async get(id: string): Promise<Rfq> {
    const rfq = await this.ds.getRepository(Rfq).findOne({ where: { id }, relations: { lines: { item: { baseUom: true } }, requisition: true } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return rfq;
  }

  async list(q: DocListQueryDto): Promise<Paginated<Rfq>> {
    const qb = this.ds.getRepository(Rfq).createQueryBuilder('r').orderBy('r.createdAt', 'DESC');
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.search) qb.andWhere('(r.number ILIKE :q OR r.title ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

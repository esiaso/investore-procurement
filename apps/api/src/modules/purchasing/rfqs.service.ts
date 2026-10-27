import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, OPEN_REQUISITION_STATUSES, Paginated, PurchaseLineType, PurchaseOrderSource, RfqStatus, SessionUser } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { DocumentLinksService } from '../approvals/document-links.service';
import { FinanceService } from '../finance/finance.service';
import { MailService } from '../mail/mail.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { RequisitionsService } from './requisitions.service';
import { AwardRfqDto, CreateRfqDto, DocListQueryDto, EvaluateDto, EvaluationSetupDto, RecordQuotationDto, ScoreDto, SendRfqDto } from './purchasing.dto';
import { PurchaseRequisition, PurchaseRequisitionLine, Quotation, QuotationLine, Rfq, RfqEvaluationScore, RfqLine } from './purchasing.entities';
import { renderRfqHtml } from './rfq-pdf';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ComparisonQuote {
  quotationId: string;
  quotationLineId: string;
  supplierId: string;
  supplierName: string;
  /** Per unit in the base currency (ranking). */
  unitPrice: number;
  /** As quoted (in `currency`). */
  quotedUnitPrice?: number;
  currency?: string | null;
  lineTotal: number;
  deliveryDays: number | null;
  compliant: boolean;
  offeredBrand: string | null;
  rank: number;
  lowestCompliant: boolean;
}

/**
 * Scores quotations: financial = lowest compliant total ÷ this total × 100
 * (quotations covering every line); technical = the committee's average;
 * combined = technical × weight + financial × (100 − weight). The recommended
 * one is the best combined score among compliant quotations at or above the
 * pass mark (price only when the weight is 0).
 */
export function evaluateQuotations<T extends { compliant: boolean; total: number; linesQuoted: number; scores: { technicalScore: number }[] }>(
  quotations: T[],
  opts: { technicalWeight: number; passMark: number; allLines: number },
): (T & { technicalScore: number | null; financialScore: number | null; combinedScore: number | null; passes: boolean; rank: number | null; recommended: boolean })[] {
  const complete = quotations.filter((q) => q.compliant && q.linesQuoted >= opts.allLines && q.total > 0);
  const lowest = complete.length ? Math.min(...complete.map((q) => q.total)) : 0;
  const w = opts.technicalWeight / 100;
  const scored = quotations.map((q) => {
    const technical = q.scores.length ? round2(q.scores.reduce((s, x) => s + Number(x.technicalScore), 0) / q.scores.length) : null;
    const financial = complete.includes(q) ? round2((lowest / q.total) * 100) : null;
    const passes = q.compliant && (w === 0 || (technical !== null && technical >= opts.passMark));
    const combined = financial === null ? null : w === 0 ? financial : technical === null ? null : round2(technical * w + financial * (1 - w));
    return { ...q, technicalScore: technical, financialScore: financial, combinedScore: combined, passes };
  });
  const ranked = scored.filter((q) => q.passes && q.combinedScore !== null).sort((a, b) => b.combinedScore! - a.combinedScore! || a.total - b.total);
  return scored.map((q) => {
    const i = ranked.indexOf(q);
    return { ...q, rank: i < 0 ? null : i + 1, recommended: i === 0 };
  });
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
    private readonly finance: FinanceService,
    private readonly pdf: PdfService,
  ) {}

  onModuleInit() {
    this.mail.registerAttachment('RFQ_PDF', (id) => this.renderPdf(id));
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
        if (!OPEN_REQUISITION_STATUSES.includes(pr.status)) throw new ConflictException(`Requisition is ${pr.status}; it must be approved`);
        const prLines = await m.find(PurchaseRequisitionLine, { where: { requisitionId: pr.id } });
        lines = prLines
          .filter((l) => l.quantity > l.orderedQty)
          .map((l) => ({
            requisitionLineId: l.id,
            lineType: l.lineType,
            itemId: l.itemId,
            description: l.description,
            uomId: l.uomId,
            glAccountId: l.glAccountId,
            quantity: Math.round((l.quantity - l.orderedQty) * 10_000) / 10_000,
          }));
        if (!lines.length) throw new BadRequestException('Everything on this requisition is already ordered');
      } else {
        if (!dto.lines?.length) throw new BadRequestException('Give lines or a requisition');
        lines = dto.lines.map((l) => ({ lineType: PurchaseLineType.STOCK, itemId: l.itemId, quantity: l.quantity }));
      }
      const rfq = await m.save(
        m.create(Rfq, {
          number: await this.numbering.next(DocumentType.RFQ, { manager: m }),
          requisitionId: pr?.id ?? null,
          title: dto.title,
          closingDate: dto.closingDate,
          supplierIds: [...new Set(dto.supplierIds)],
          status: RfqStatus.DRAFT,
          passMark: await this.settings.get('purchasing.rfqPassMark', m),
          lines: lines.map((l) => m.create(RfqLine, l)),
        }),
      );
      if (pr) {
        await this.links.link(m, { type: DocumentType.PURCHASE_REQUISITION, id: pr.id, no: pr.number }, { type: DocumentType.RFQ, id: rfq.id, no: rfq.number });
        await this.requisitions.refreshOrderStatus(m, pr.id);
      }
      return rfq.id;
    });
    return this.get(id);
  }

  /**
   * Invites the suppliers by email with the RFQ attached (PDF). At least
   * purchasing.rfqMinSuppliers suppliers, or a justification for fewer.
   */
  async send(id: string, dto: SendRfqDto = {}): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status !== RfqStatus.DRAFT) throw new ConflictException(`RFQ is ${rfq.status}`);
      const min = await this.settings.get('purchasing.rfqMinSuppliers', m);
      if (rfq.supplierIds.length < min) {
        if (!dto.fewerSuppliersJustification?.trim()) throw new BadRequestException({ code: 'MIN_SUPPLIERS', message: `Invite at least ${min} suppliers, or justify inviting ${rfq.supplierIds.length}` });
        rfq.fewerSuppliersJustification = dto.fewerSuppliersJustification.trim();
      }
      const lines = await m.find(RfqLine, { where: { rfqId: id }, relations: { item: { baseUom: true }, uom: true } });
      const body = lines.map((l, i) => `${i + 1}. ${l.item?.name ?? l.description} — ${l.quantity} ${l.uom?.code ?? l.item?.baseUom?.code ?? ''}`).join('\n');
      const suppliers: { id: string; name: string; email: string | null }[] = await m.query(
        `SELECT id, name, email FROM supplier WHERE id = ANY($1::uuid[])`,
        [rfq.supplierIds],
      );
      for (const s of suppliers) {
        if (!s.email) continue;
        await this.mail.enqueue(m, {
          to: s.email,
          subject: `Request for quotation ${rfq.number}: ${rfq.title}`,
          text: `Dear ${s.name},\n\nPlease quote for the following by ${rfq.closingDate} (unit prices excl. VAT, delivery time, payment terms and validity; the RFQ is attached):\n\n${body}\n\nYou can also quote in the supplier portal.\n\nRegards,\nProcurement`,
          attachments: [{ kind: 'RFQ_PDF', id: rfq.id, filename: `${rfq.number.replace(/\//g, '-')}.pdf` }],
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
      if (dto.currency) await this.finance.rateOn(m, dto.currency, await this.settings.today(m)); // must have a rate
      await m.save(
        m.create(Quotation, {
          rfqId: id,
          supplierId: dto.supplierId,
          supplierReference: dto.supplierReference ?? null,
          validUntil: dto.validUntil ?? null,
          deliveryDays: dto.deliveryDays ?? null,
          compliant: dto.compliant ?? true,
          complianceNotes: dto.complianceNotes ?? null,
          currency: dto.currency && dto.currency !== (await this.settings.get('locale.currency', m)) ? dto.currency : null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          notes: dto.notes ?? null,
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

  /**
   * Comparative analysis: per line, quotes ranked (compliance, price in the base
   * currency, delivery); per supplier totals, payment terms, and — when a
   * committee scores the RFQ — technical, financial and combined scores.
   */
  async comparison(id: string) {
    const rfq = await this.get(id);
    const quotations = await this.ds.getRepository(Quotation).find({ where: { rfqId: id }, relations: { supplier: true, lines: true } });
    const today = await this.settings.today();
    const rates = new Map<string, number>();
    for (const q of quotations) if (q.currency && !rates.has(q.currency)) rates.set(q.currency, await this.finance.rateOn(this.ds.manager, q.currency, today));
    const inBase = (q: Quotation, price: number) => round2(price * (q.currency ? rates.get(q.currency)! : 1) * 10_000) / 10_000;
    const lines = (rfq.lines ?? []).map((line) => {
      const quotes = quotations.flatMap((q) =>
        (q.lines ?? [])
          .filter((ql) => ql.rfqLineId === line.id)
          .map((ql) => ({
            quotationId: q.id,
            quotationLineId: ql.id,
            supplierId: q.supplierId,
            supplierName: q.supplier?.name ?? '',
            // Ranked in the base currency; quoted price and currency kept for display.
            unitPrice: inBase(q, ql.unitPrice),
            quotedUnitPrice: ql.unitPrice,
            currency: q.currency,
            lineTotal: round2(inBase(q, ql.unitPrice) * line.quantity),
            deliveryDays: q.deliveryDays,
            compliant: q.compliant,
            offeredBrand: ql.offeredBrand,
          })),
      );
      return { rfqLineId: line.id, itemId: line.itemId, itemName: line.item?.name ?? line.description, lineType: line.lineType, quantity: line.quantity, uom: line.uom?.code ?? line.item?.baseUom?.code ?? null, awardedQuotationLineId: line.awardedQuotationLineId, quotes: rankQuotes(quotes) as ComparisonQuote[] };
    });
    const scores = await this.ds.getRepository(RfqEvaluationScore).find({ where: { rfqId: id } });
    const base = quotations.map((q) => ({
      quotationId: q.id,
      supplierId: q.supplierId,
      supplierName: q.supplier?.name,
      compliant: q.compliant,
      complianceNotes: q.complianceNotes,
      deliveryDays: q.deliveryDays,
      validUntil: q.validUntil,
      paymentTermsDays: q.paymentTermsDays,
      currency: q.currency,
      linesQuoted: q.lines?.length ?? 0,
      quotedTotal: round2((q.lines ?? []).reduce((s, ql) => s + ql.unitPrice * (rfq.lines!.find((l) => l.id === ql.rfqLineId)?.quantity ?? 0), 0)),
      total: round2((q.lines ?? []).reduce((s, ql) => s + inBase(q, ql.unitPrice) * (rfq.lines!.find((l) => l.id === ql.rfqLineId)?.quantity ?? 0), 0)),
      lowestOnLines: lines.filter((l) => l.quotes.find((x) => x.lowestCompliant)?.supplierId === q.supplierId).length,
      scores: scores.filter((x) => x.quotationId === q.id).map((x) => ({ memberId: x.memberId, technicalScore: x.technicalScore, comment: x.comment })),
    }));
    const suppliers = evaluateQuotations(base, { technicalWeight: rfq.technicalWeight, passMark: rfq.passMark, allLines: rfq.lines?.length ?? 0 });
    return { rfq, lines, suppliers };
  }

  // ------------------------------------------------------------------ closing and evaluation

  /** Bidding closes: no more quotations; the committee can score. */
  async close(id: string): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (![RfqStatus.SENT, RfqStatus.EVALUATION].includes(rfq.status)) throw new ConflictException(`RFQ is ${rfq.status}`);
      const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM quotation WHERE rfq_id = $1`, [id]);
      if (!n) throw new BadRequestException('No quotation has been received');
      rfq.status = RfqStatus.CLOSED;
      rfq.closedAt = new Date();
      await m.save(rfq);
    });
    return this.get(id);
  }

  /** Weights, pass mark and the evaluation committee (before scoring starts). */
  async setupEvaluation(id: string, dto: EvaluationSetupDto): Promise<Rfq> {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if ([RfqStatus.EVALUATED, RfqStatus.AWARDED, RfqStatus.CANCELLED].includes(rfq.status)) throw new ConflictException(`RFQ is ${rfq.status}`);
      const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM rfq_evaluation_score WHERE rfq_id = $1`, [id]);
      if (n) throw new ConflictException('Scoring has started; the evaluation set-up is fixed');
      if (dto.technicalWeight > 0 && !dto.committeeUserIds.length) throw new BadRequestException('A technical evaluation needs a committee');
      const users: { id: string }[] = dto.committeeUserIds.length ? await m.query(`SELECT id FROM app_user WHERE id = ANY($1::uuid[]) AND is_active`, [dto.committeeUserIds]) : [];
      if (users.length !== new Set(dto.committeeUserIds).size) throw new BadRequestException('A committee member was not found or is inactive');
      Object.assign(rfq, { technicalWeight: dto.technicalWeight, passMark: dto.passMark ?? rfq.passMark, committeeUserIds: [...new Set(dto.committeeUserIds)] });
      await m.save(rfq);
    });
    return this.get(id);
  }

  /** A committee member's technical score of a compliant quotation (bidding must be closed). */
  async score(id: string, dto: ScoreDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status !== RfqStatus.CLOSED) throw new ConflictException(rfq.status === RfqStatus.EVALUATED ? 'The evaluation is complete' : 'Close bidding before scoring');
      if (!rfq.committeeUserIds.includes(actor.id)) throw new ForbiddenException('You are not on the evaluation committee');
      const q = await m.findOneBy(Quotation, { id: dto.quotationId, rfqId: id });
      if (!q) throw new NotFoundException('Quotation not found on this RFQ');
      if (!q.compliant) throw new BadRequestException('Non-compliant quotations are not scored');
      const repo = m.getRepository(RfqEvaluationScore);
      const row = (await repo.findOneBy({ quotationId: q.id, memberId: actor.id })) ?? repo.create({ rfqId: id, quotationId: q.id, memberId: actor.id });
      Object.assign(row, { technicalScore: dto.technicalScore, comment: dto.comment ?? null });
      await repo.save(row);
    });
    return this.comparison(id);
  }

  /**
   * Completes the evaluation: every member has scored every compliant
   * quotation (when there is a technical part); the recommended supplier is the
   * best combined score among those passing the mark.
   */
  async evaluate(id: string, dto: EvaluateDto, actor: SessionUser) {
    const cmp = await this.comparison(id);
    await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (rfq.status !== RfqStatus.CLOSED) throw new ConflictException(`RFQ is ${rfq.status}; close bidding first`);
      if (rfq.technicalWeight > 0) {
        const missing = cmp.suppliers.filter((s) => s.compliant && s.scores.length < rfq.committeeUserIds.length);
        if (missing.length) throw new BadRequestException(`Waiting for committee scores on: ${missing.map((s) => s.supplierName).join(', ')}`);
      }
      const best = cmp.suppliers.find((s) => s.recommended);
      Object.assign(rfq, { status: RfqStatus.EVALUATED, recommendation: dto.recommendation.trim(), recommendedSupplierId: best?.supplierId ?? null, evaluatedAt: new Date(), evaluatedBy: actor.id });
      await m.save(rfq);
    });
    return this.comparison(id);
  }

  /** Printable RFQ (attached to the invitation emails). */
  async renderPdf(id: string): Promise<Buffer> {
    const rfq = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email, kra_pin FROM facility ORDER BY created_at LIMIT 1`);
    return this.pdf.render(renderRfqHtml(rfq, facility));
  }

  /** Awards lines and creates one draft PO per winning supplier. */
  async award(id: string, dto: AwardRfqDto, actor: SessionUser) {
    const comparison = await this.comparison(id);
    const poIds = await this.ds.transaction(async (m) => {
      const rfq = await this.lock(m, id);
      if (![RfqStatus.EVALUATION, RfqStatus.CLOSED, RfqStatus.EVALUATED].includes(rfq.status)) throw new ConflictException(`RFQ is ${rfq.status}; record quotations first`);
      if (rfq.technicalWeight > 0 && rfq.status !== RfqStatus.EVALUATED) throw new ConflictException('Complete the evaluation (committee scores and recommendation) before awarding');
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
        const quotation = await m.findOneByOrFail(Quotation, { rfqId: rfq.id, supplierId });
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
            // The order is in the quotation's currency at its quoted prices.
            currency: quotation.currency,
            deliveryAddress: dto.deliveryAddress ?? null,
          },
          awarded.map(({ rfqLine, quote }) => ({
            lineType: rfqLine.lineType,
            itemId: rfqLine.itemId,
            description: rfqLine.description,
            uomId: rfqLine.lineType === PurchaseLineType.STOCK ? undefined : rfqLine.uomId,
            glAccountId: rfqLine.glAccountId,
            quantity: rfqLine.quantity,
            unitPrice: quote.quotedUnitPrice ?? quote.unitPrice,
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
      if (rfq.requisitionId) await this.requisitions.refreshOrderStatus(m, rfq.requisitionId);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<Rfq> {
    const rfq = await m.findOne(Rfq, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return rfq;
  }

  async get(id: string): Promise<Rfq> {
    const rfq = await this.ds.getRepository(Rfq).findOne({ where: { id }, relations: { lines: { item: { baseUom: true }, uom: true }, requisition: true } });
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

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AttachmentOwner, BidStatus, DeliveryStage, RfqStatus, SessionUser, SourcingMethod, SupplierSubmissionType, TenderStatus } from '@sil/shared';
import { AttachmentsService } from '../files/attachments.service';
import { RfqsService } from '../purchasing/rfqs.service';
import { PurchaseOrder, PurchaseOrderLine, Quotation, Rfq } from '../purchasing/purchasing.entities';
import { AgenciesService } from './agencies.service';
import { SupplierSubmission } from './agencies.entities';
import { Bid, Tender, TenderClarification } from './tenders.entities';
import { BidInput, TendersService } from './tenders.service';

const VISIBLE_PO = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

/**
 * Supplier portal. Every call is scoped to the supplier the user is linked
 * to; other suppliers' records look like they do not exist (404).
 */
@Injectable()
export class PortalService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rfqs: RfqsService,
    private readonly tenders: TendersService,
    private readonly agencies: AgenciesService,
    private readonly attachments: AttachmentsService,
  ) {}

  supplierOf(actor: SessionUser): string {
    if (!actor.supplierId) throw new ForbiddenException('Your account is not linked to a supplier');
    return actor.supplierId;
  }

  async me(actor: SessionUser) {
    const sid = this.supplierOf(actor);
    const [s] = await this.ds.query(
      `SELECT id, code, name, kra_pin AS "kraPin", email, phone, status, status_reason AS "statusReason", prequalification_status AS "prequalificationStatus",
              prequalified_until AS "prequalifiedUntil", payment_terms_days AS "paymentTermsDays", bank_account_masked AS "bankAccount"
         FROM supplier WHERE id = $1`,
      [sid],
    );
    const documents = await this.ds.query(`SELECT document_type AS "documentType", reference, issued_on AS "issuedOn", expires_on AS "expiresOn" FROM supplier_document WHERE supplier_id = $1 ORDER BY document_type`, [sid]);
    const [counts] = await this.ds.query(
      `SELECT (SELECT count(*)::int FROM rfq WHERE $1 = ANY(supplier_ids::uuid[]) AND status = 'SENT') AS rfqs,
              (SELECT count(*)::int FROM tender WHERE status = 'PUBLISHED' AND (method = 'OPEN_TENDER' OR $1 = ANY(invited_supplier_ids))) AS tenders,
              (SELECT count(*)::int FROM purchase_order WHERE supplier_id = $1 AND status = 'SENT' AND acknowledged_at IS NULL) AS "unacknowledgedOrders"`,
      [sid],
    );
    return { supplier: s, documents, counts };
  }

  // ------------------------------------------------------------------ RFQs

  async rfqList(actor: SessionUser) {
    const sid = this.supplierOf(actor);
    const rows = await this.ds
      .getRepository(Rfq)
      .createQueryBuilder('r')
      .where(':sid = ANY(r.supplier_ids::uuid[])', { sid })
      .andWhere('r.status IN (:...st)', { st: [RfqStatus.SENT, RfqStatus.EVALUATION, RfqStatus.AWARDED] })
      .orderBy('r.closingDate', 'DESC')
      .getMany();
    const mine = rows.length ? await this.ds.getRepository(Quotation).find({ where: { supplierId: sid, rfqId: In(rows.map((r) => r.id)) } }) : [];
    return rows.map((r) => ({ id: r.id, number: r.number, title: r.title, closingDate: r.closingDate, status: r.status, quoted: mine.some((q) => q.rfqId === r.id) }));
  }

  async rfq(actor: SessionUser, id: string) {
    const sid = this.supplierOf(actor);
    const rfq = await this.ds.getRepository(Rfq).findOne({ where: { id }, relations: { lines: { item: { baseUom: true } } } });
    if (!rfq || !rfq.supplierIds.includes(sid) || rfq.status === RfqStatus.DRAFT || rfq.status === RfqStatus.CANCELLED) throw new NotFoundException('RFQ not found');
    const quotation = await this.ds.getRepository(Quotation).findOne({ where: { rfqId: id, supplierId: sid }, relations: { lines: true } });
    const awardedToMe = rfq.status === RfqStatus.AWARDED && quotation ? (rfq.lines ?? []).filter((l) => quotation.lines?.some((ql) => ql.id === l.awardedQuotationLineId)).map((l) => l.id) : [];
    return {
      id: rfq.id,
      number: rfq.number,
      title: rfq.title,
      closingDate: rfq.closingDate,
      status: rfq.status,
      lines: (rfq.lines ?? []).map((l) => ({ id: l.id, itemId: l.itemId, item: l.item?.name, uom: l.item?.baseUom?.code, quantity: l.quantity })),
      quotation,
      awardedLineIds: awardedToMe,
    };
  }

  async submitQuotation(actor: SessionUser, id: string, dto: { supplierReference?: string; validUntil?: string | null; deliveryDays?: number; lines: { rfqLineId: string; unitPrice: number; quantityOffered?: number; offeredBrand?: string }[] }) {
    const sid = this.supplierOf(actor);
    const rfq = await this.ds.getRepository(Rfq).findOneBy({ id });
    if (!rfq || !rfq.supplierIds.includes(sid)) throw new NotFoundException('RFQ not found');
    if (rfq.status !== RfqStatus.SENT) throw new BadRequestException('This RFQ is no longer accepting quotations');
    const today = new Date().toISOString().slice(0, 10);
    if (rfq.closingDate < today) throw new BadRequestException('The RFQ has closed');
    // Compliance is the buyer's judgement, not the supplier's.
    await this.rfqs.recordQuotation(id, { supplierId: sid, supplierReference: dto.supplierReference, validUntil: dto.validUntil ?? null, deliveryDays: dto.deliveryDays, lines: dto.lines } as never);
    return this.rfq(actor, id);
  }

  // ------------------------------------------------------------------ tenders

  /** Open tenders, and restricted tenders / RFPs the supplier is invited to (plus any it bid for). */
  async tenderList(actor: SessionUser) {
    const sid = this.supplierOf(actor);
    const rows = await this.ds
      .getRepository(Tender)
      .createQueryBuilder('t')
      .where(`t.status <> 'DRAFT'`)
      .andWhere(
        `((t.method = :open AND t.status = 'PUBLISHED') OR :sid = ANY(t.invited_supplier_ids) OR EXISTS (SELECT 1 FROM bid b WHERE b.tender_id = t.id AND b.supplier_id = :sid))`,
        { open: SourcingMethod.OPEN_TENDER, sid },
      )
      .orderBy('t.closingAt', 'DESC')
      .getMany();
    const bids = rows.length ? await this.ds.getRepository(Bid).find({ where: { supplierId: sid, tenderId: In(rows.map((r) => r.id)) } }) : [];
    return rows.map((t) => {
      const b = bids.find((x) => x.tenderId === t.id);
      return { id: t.id, number: t.number, title: t.title, method: t.method, status: t.status, closingAt: t.closingAt, myBid: b ? { status: b.status, submittedAt: b.submittedAt, totalPrice: b.totalPrice } : null };
    });
  }

  async tender(actor: SessionUser, id: string) {
    const sid = this.supplierOf(actor);
    const t = await this.ds.getRepository(Tender).findOne({ where: { id }, relations: { lines: { item: true } }, order: { lines: { lineNo: 'ASC' } } });
    const invited = t && (t.method === SourcingMethod.OPEN_TENDER || t.invitedSupplierIds.includes(sid));
    const bid = t ? await this.ds.getRepository(Bid).findOne({ where: { tenderId: id, supplierId: sid }, relations: { lines: true } }) : null;
    if (!t || t.status === TenderStatus.DRAFT || (!invited && !bid)) throw new NotFoundException('Tender not found');
    // Public questions and answers (who asked is not shown), only once answered.
    const clarifications = await this.ds.getRepository(TenderClarification).find({ where: { tenderId: id }, order: { createdAt: 'ASC' } });
    const result = [TenderStatus.AWARDED, TenderStatus.CONTRACTED].includes(t.status) && bid ? (bid.status === BidStatus.AWARDED ? 'AWARDED' : 'NOT_SUCCESSFUL') : null;
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      description: t.description,
      method: t.method,
      status: t.status,
      closingAt: t.closingAt,
      bidSecurityAmount: t.bidSecurityAmount,
      bidValidityDays: t.bidValidityDays,
      lines: (t.lines ?? []).map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, quantity: l.quantity, specification: l.specification })),
      clarifications: clarifications.filter((c) => c.answer || c.supplierId === sid).map((c) => ({ id: c.id, question: c.question, answer: c.answer, isAddendum: c.isAddendum, mine: c.supplierId === sid, answeredAt: c.answeredAt })),
      myBid: bid,
      result,
    };
  }

  async requestDocuments(actor: SessionUser, id: string) {
    await this.tender(actor, id);
    return this.tenders.issueDocument(id, this.supplierOf(actor), 0, actor);
  }

  async askClarification(actor: SessionUser, id: string, question: string) {
    await this.tender(actor, id);
    const c = await this.tenders.askClarification(id, this.supplierOf(actor), question);
    return { id: c.id, question: c.question };
  }

  async submitBid(actor: SessionUser, id: string, dto: BidInput) {
    await this.tender(actor, id);
    const bid = await this.tenders.submitBid(id, this.supplierOf(actor), dto, actor, true);
    return { id: bid.id, submittedAt: bid.submittedAt, totalPrice: bid.totalPrice, status: bid.status };
  }

  async withdrawBid(actor: SessionUser, id: string) {
    await this.tender(actor, id);
    await this.tenders.withdrawBid(id, this.supplierOf(actor));
  }

  // ------------------------------------------------------------------ purchase orders

  async orders(actor: SessionUser) {
    const sid = this.supplierOf(actor);
    return this.ds.getRepository(PurchaseOrder).find({
      where: { supplierId: sid, status: In(VISIBLE_PO) as never },
      relations: { store: true },
      order: { orderDate: 'DESC' },
      take: 500,
      select: { id: true, number: true, version: true, status: true, orderDate: true, expectedDelivery: true, total: true, currency: true, acknowledgedAt: true, deliveryStage: true, store: { id: true, name: true } },
    });
  }

  private async ownOrder(actor: SessionUser, id: string) {
    const sid = this.supplierOf(actor);
    const po = await this.ds.getRepository(PurchaseOrder).findOne({ where: { id }, relations: { store: true } });
    if (!po || po.supplierId !== sid || !VISIBLE_PO.includes(po.status)) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async order(actor: SessionUser, id: string) {
    const po = await this.ownOrder(actor, id);
    const lines = await this.ds.getRepository(PurchaseOrderLine).find({ where: { purchaseOrderId: id }, relations: { item: true, uom: true }, order: { lineNo: 'ASC' } });
    const deliveries = await this.agencies.deliveries(id);
    const { committedTotal: _c, budgetId: _b, departmentId: _d, createdByUser: _u, lastComment: _l, ...safe } = po;
    return {
      ...safe,
      lines: lines.map((l) => ({ lineNo: l.lineNo, item: l.item?.name, uom: l.uom?.code, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, receivedBaseQty: l.receivedBaseQty, conversionFactor: l.conversionFactor })),
      deliveries,
    };
  }

  async acknowledge(actor: SessionUser, id: string, note?: string) {
    await this.ownOrder(actor, id);
    await this.agencies.track(id, { stage: DeliveryStage.ACKNOWLEDGED, note }, actor, true);
    return this.order(actor, id);
  }

  async trackDelivery(actor: SessionUser, id: string, dto: { stage: DeliveryStage; reference?: string; expectedDate?: string; note?: string }) {
    await this.ownOrder(actor, id);
    if (dto.stage === DeliveryStage.DELIVERED) throw new BadRequestException('Delivery is confirmed by the hospital’s goods received note');
    await this.agencies.track(id, dto, actor, true);
    return this.order(actor, id);
  }

  /** Delivery note or invoice metadata against an order (files arrive with object storage). */
  /** Delivery note or invoice against an order, optionally with the scanned document (stored in object storage). */
  async submitDocument(
    actor: SessionUser,
    id: string,
    dto: { type: SupplierSubmissionType; reference: string; documentDate: string; amount?: number; fileName?: string; notes?: string },
    file?: { originalname: string; mimetype: string; buffer: Buffer },
  ) {
    const po = await this.ownOrder(actor, id);
    if (file) await this.attachments.validate({ mimeType: file.mimetype, body: file.buffer, fileName: file.originalname });
    return this.ds.transaction(async (m) => {
      const row = await m.save(
        m.create(SupplierSubmission, { supplierId: po.supplierId, type: dto.type, purchaseOrderId: id, reference: dto.reference, documentDate: dto.documentDate, amount: dto.amount ?? null, fileName: file?.originalname ?? dto.fileName ?? null, notes: dto.notes ?? null, submittedBy: actor.id }),
      );
      if (file) {
        await this.attachments.attach(m, { ownerType: AttachmentOwner.PORTAL_SUBMISSION, ownerId: row.id, category: dto.type, fileName: file.originalname, mimeType: file.mimetype, body: file.buffer }, actor.id, false);
      }
      return row;
    });
  }

  async submissions(actor: SessionUser) {
    const rows = await this.ds.getRepository(SupplierSubmission).find({ where: { supplierId: this.supplierOf(actor) }, order: { createdAt: 'DESC' }, take: 500 });
    const files: { owner_id: string; id: string; file_name: string }[] = rows.length
      ? await this.ds.query(`SELECT owner_id, id, file_name FROM attachment WHERE owner_type = $1 AND is_current AND owner_id = ANY($2::uuid[])`, [AttachmentOwner.PORTAL_SUBMISSION, rows.map((r) => r.id)])
      : [];
    return rows.map((r) => ({ ...r, files: files.filter((f) => f.owner_id === r.id).map((f) => ({ id: f.id, fileName: f.file_name })) }));
  }

  /** Documents the hospital issued for a tender the supplier can see. */
  async tenderFiles(actor: SessionUser, id: string) {
    await this.tender(actor, id);
    return this.attachments.list(AttachmentOwner.TENDER, id, null);
  }

  /** Downloads a tender document or one of the supplier's own submissions; anything else is 404. */
  async download(actor: SessionUser, attachmentId: string) {
    const a = await this.attachments.get(attachmentId);
    if (!a) throw new NotFoundException('File not found');
    if (a.ownerType === AttachmentOwner.TENDER) {
      await this.tender(actor, a.ownerId);
    } else if (a.ownerType === AttachmentOwner.PORTAL_SUBMISSION) {
      const own = await this.ds.getRepository(SupplierSubmission).existsBy({ id: a.ownerId, supplierId: this.supplierOf(actor) });
      if (!own) throw new NotFoundException('File not found');
    } else {
      throw new NotFoundException('File not found');
    }
    return this.attachments.download(attachmentId, null);
  }

  /** Invoices and their payment status. */
  async payments(actor: SessionUser) {
    const sid = this.supplierOf(actor);
    return this.ds.query(
      `SELECT si.number, si.supplier_invoice_no AS "invoiceNo", si.invoice_date AS "invoiceDate", si.due_date AS "dueDate", si.total::float AS total,
              si.status, po.number AS "purchaseOrder", pv.paid_on AS "paidOn", pv.amount::float AS "paidAmount", pv.payment_reference AS "paymentReference"
         FROM supplier_invoice si JOIN purchase_order po ON po.id = si.purchase_order_id
         LEFT JOIN payment_voucher pv ON pv.invoice_id = si.id
        WHERE si.supplier_id = $1 AND si.status <> 'CANCELLED'
        ORDER BY si.invoice_date DESC LIMIT 500`,
      [sid],
    );
  }

  /** Staff: portal submissions to process. */
  staffSubmissions(status?: string) {
    return this.ds.query(
      `SELECT ss.*, s.name AS supplier, po.number AS "purchaseOrder" FROM supplier_submission ss JOIN supplier s ON s.id = ss.supplier_id JOIN purchase_order po ON po.id = ss.purchase_order_id
        ${status ? 'WHERE ss.status = $1' : ''} ORDER BY ss.created_at DESC LIMIT 500`,
      status ? [status] : [],
    );
  }

  async reviewSubmission(id: string, dto: { status: 'CAPTURED' | 'REJECTED'; note?: string }) {
    const repo = this.ds.getRepository(SupplierSubmission);
    const row = await repo.findOneBy({ id });
    if (!row) throw new NotFoundException('Submission not found');
    Object.assign(row, { status: dto.status, reviewNote: dto.note ?? null });
    return repo.save(row);
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AttachmentOwner, CertificateStatus, DocumentType, NotificationCategory, Permissions, PurchaseLineType, SessionUser, StaffRequisitionLineStatus } from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { AttachmentsService } from '../files/attachments.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { PurchaseOrder, PurchaseOrderLine } from '../purchasing/purchasing.entities';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { sourceRequisitions } from '../purchasing/requester-notices';
import { SettingsService } from '../settings/settings.service';
import { refreshStaffRequisitionStatus } from '../staff-requisitions/staff-requisition-status';
import { StaffRequisitionLine } from '../staff-requisitions/staff-requisitions.entities';
import { ServiceCertificate, ServiceCertificateLine } from './logistics.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

type CertificateInput = {
  purchaseOrderId: string;
  periodFrom?: string | null;
  periodTo: string;
  workDone: string;
  qualityRating?: number | null;
  lines: { poLineId: string; quantity: number; rejectedQty?: number; rejectionReason?: string | null; remarks?: string | null }[];
};

/** A staff requisition behind a certificate, and who may sign for it. */
type Source = { requisitionId: string; number: string; requestedBy: string; departmentId: string };

/**
 * Completion certificates for service and works orders (maintenance
 * contracts, consultancies, repairs) and receipts of non-stock goods. Posting
 * one counts the accepted quantities as received, so the supplier's invoice
 * is three-way matched against it exactly like goods against a GRN. Nothing
 * here touches stock.
 *
 * When the order was bought for staff requisitions, the requesting user or
 * their department signs it off (accept / reject) instead of the certifying
 * officer posting it.
 */
@Injectable()
export class ServiceCertificatesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly orders: PurchaseOrdersService,
    private readonly links: DocumentLinksService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
    private readonly pdf: PdfService,
    private readonly notifications: NotificationsService,
  ) {}

  register() {
    this.attachments.registerOwner(AttachmentOwner.SERVICE_CERTIFICATE, {
      read: [Permissions.PURCHASING_READ, Permissions.STAFF_REQUISITION_CREATE],
      write: [Permissions.SERVICES_CERTIFY, Permissions.PURCHASING_RECEIVE],
      visible: async (m, id, actor) => {
        const [c] = await m.query(`SELECT id FROM service_certificate WHERE id = $1`, [id]);
        return !!c && (!actor || (await this.canSee(m, id, actor)));
      },
    });
  }

  /**
   * Lines a certificate can cover: non-stock lines (services, goods not held
   * in stock, capital items expensed) and stock items in the service categories.
   */
  private async serviceLines(m: EntityManager, poId: string) {
    const codes = await this.settings.get('services.categoryCodes', m);
    const lines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: poId }, relations: { item: { category: true } } });
    return lines.filter((l) => l.lineType !== PurchaseLineType.STOCK || codes.includes(l.item?.category?.code ?? ''));
  }

  /** Staff requisitions the certificate's order lines were bought for. */
  private async sources(m: EntityManager, poLineIds: string[]): Promise<Source[]> {
    if (!poLineIds.length) return [];
    return m.query(
      `SELECT DISTINCT sr.id AS "requisitionId", sr.number, sr.requested_by AS "requestedBy", sr.department_id AS "departmentId"
         FROM purchase_order_line ol JOIN purchase_requisition_line pl ON pl.id = ol.requisition_line_id
         JOIN staff_requisition_line sl ON sl.pr_line_id = pl.id JOIN staff_requisition sr ON sr.id = sl.requisition_id
        WHERE ol.id = ANY($1::uuid[])`,
      [poLineIds],
    );
  }

  /** The requester, or someone in the requesting department who may certify. */
  private canSign(sources: Source[], actor: SessionUser): boolean {
    return sources.some((s) => s.requestedBy === actor.id || (actor.departmentId === s.departmentId && actor.permissions.includes(Permissions.SERVICES_CERTIFY)));
  }

  private async canSee(m: EntityManager, id: string, actor: SessionUser): Promise<boolean> {
    if (actor.permissions.includes(Permissions.PURCHASING_READ)) return true;
    const lines = await m.find(ServiceCertificateLine, { where: { certificateId: id } });
    return this.canSign(await this.sources(m, lines.map((l) => l.poLineId)), actor);
  }

  async create(dto: CertificateInput, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const po = await m.findOneBy(PurchaseOrder, { id: dto.purchaseOrderId });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po.status}`);
      // The person certifying must not have raised or approved the order.
      if (po.createdByUser === actor.id) throw new ForbiddenException('You raised this order and cannot certify it');
      await this.orders.assertNotCreatorOrApprover(po.id, actor, 'certify it');
      const service = await this.serviceLines(m, po.id);
      if (!service.length) throw new BadRequestException('This order has no service or non-stock lines; receive goods with a GRN');
      for (const l of dto.lines) {
        const pl = service.find((s) => s.id === l.poLineId);
        if (!pl) throw new BadRequestException('A line is not a service or non-stock line of this order');
        const rejected = l.rejectedQty ?? 0;
        if (l.quantity + rejected <= 0) throw new BadRequestException(`Line ${pl.lineNo}: give an accepted or rejected quantity`);
        if (rejected > 0 && !l.rejectionReason?.trim()) throw new BadRequestException(`Line ${pl.lineNo}: give the reason for the rejected quantity`);
        const pending: { q: number }[] = await m.query(
          `SELECT COALESCE(SUM(cl.quantity), 0)::float AS q FROM service_certificate_line cl JOIN service_certificate c ON c.id = cl.certificate_id WHERE cl.po_line_id = $1 AND c.status = 'DRAFT'`,
          [pl.id],
        );
        const remaining = round4(pl.quantity - pl.receivedBaseQty / pl.conversionFactor - pending[0].q);
        if (l.quantity > remaining + 1e-9) throw new BadRequestException(`Line ${pl.lineNo}: at most ${remaining} can still be accepted`);
      }
      const c = await m.save(
        m.create(ServiceCertificate, {
          number: await this.numbering.next(DocumentType.SERVICE_CERTIFICATE, { manager: m }),
          purchaseOrderId: po.id,
          supplierId: po.supplierId,
          periodFrom: dto.periodFrom ?? null,
          periodTo: dto.periodTo,
          workDone: dto.workDone,
          qualityRating: dto.qualityRating ?? null,
          certifiedBy: actor.id,
          status: CertificateStatus.DRAFT,
          lines: dto.lines.map((l) =>
            m.create(ServiceCertificateLine, { poLineId: l.poLineId, quantity: l.quantity, rejectedQty: l.rejectedQty ?? 0, rejectionReason: l.rejectionReason?.trim() || null, remarks: l.remarks ?? null }),
          ),
        }),
      );
      await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.SERVICE_CERTIFICATE, id: c.id, no: c.number });
      // Bought for staff requisitions: the requesters sign it off.
      const sources = await this.sources(m, dto.lines.map((l) => l.poLineId));
      for (const s of sources) {
        await this.links.link(m, { type: DocumentType.STAFF_REQUISITION, id: s.requisitionId, no: s.number }, { type: DocumentType.SERVICE_CERTIFICATE, id: c.id, no: c.number });
      }
      const signers = sources.map((s) => s.requestedBy).filter((u) => u !== actor.id);
      if (signers.length) {
        await this.notifications.dispatch(m, signers, NotificationCategory.REQUISITIONS, {
          title: `${c.number}: please confirm what was delivered`,
          body: `The supplier's delivery on ${po.number} is waiting for your acceptance`,
          link: `/service-certificates/${c.id}`,
        });
      }
      return c.id;
    });
    return this.get(id);
  }

  /** Counts the accepted quantities as received on the order. */
  private async receive(m: EntityManager, c: ServiceCertificate): Promise<ServiceCertificateLine[]> {
    const po = await m.findOne(PurchaseOrder, { where: { id: c.purchaseOrderId }, lock: { mode: 'pessimistic_write' } });
    if (!po || !this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po?.status}`);
    const lines = await m.find(ServiceCertificateLine, { where: { certificateId: c.id } });
    const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
    await this.orders.applyReceipt(
      m,
      po.id,
      lines.filter((l) => l.quantity > 0).map((l) => ({ poLineId: l.poLineId, baseQty: round4(l.quantity * poLines.find((p) => p.id === l.poLineId)!.conversionFactor) })),
    );
    c.status = CertificateStatus.POSTED;
    c.postedAt = new Date();
    return lines;
  }

  /** Posts a certificate for an order not bought for staff requisitions (the certifying officer). */
  async post(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.certifiedBy !== actor.id) throw new ForbiddenException('Only the certifying officer can post this certificate');
      const lines = await m.find(ServiceCertificateLine, { where: { certificateId: id } });
      if ((await this.sources(m, lines.map((l) => l.poLineId))).length) {
        throw new ConflictException({ code: 'ACCEPTANCE_REQUIRED', message: 'This order was bought for staff requisitions: the requester or their department accepts it' });
      }
      await this.receive(m, c);
      await m.save(c);
    });
    return this.get(id);
  }

  /**
   * The requester (or someone in their department who may certify) signs the
   * delivery off: the accepted quantities count as received, the requisition
   * lines are updated, and services accepted by the requester themself count
   * as delivered to them.
   */
  async accept(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      const lines = await m.find(ServiceCertificateLine, { where: { certificateId: id } });
      const sources = await this.sources(m, lines.map((l) => l.poLineId));
      if (!sources.length) throw new ConflictException('This certificate is posted by the certifying officer');
      if (!this.canSign(sources, actor)) throw new ForbiddenException('Only the requester or their department can accept this delivery');
      const po = await m.findOneByOrFail(PurchaseOrder, { id: c.purchaseOrderId });
      if (po.createdByUser === actor.id) throw new ForbiddenException('You raised this order and cannot accept it');
      await this.orders.assertNotCreatorOrApprover(po.id, actor, 'accept it');
      await this.receive(m, c);
      c.acceptedBy = actor.id;
      await m.save(c);
      await this.updateRequisitionLines(m, c, lines, sources, actor);
    });
    return this.get(id);
  }

  /** The requesting department refuses the delivery: nothing is received. */
  async reject(id: string, reason: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      const lines = await m.find(ServiceCertificateLine, { where: { certificateId: id } });
      if (!this.canSign(await this.sources(m, lines.map((l) => l.poLineId)), actor)) throw new ForbiddenException('Only the requester or their department can reject this delivery');
      c.status = CertificateStatus.REJECTED;
      c.rejectionReason = reason;
      c.acceptedBy = actor.id;
      await m.save(c);
      await this.notifications.notify(m, [c.certifiedBy], { title: `${c.number} was rejected`, body: reason, link: `/service-certificates/${c.id}` });
    });
    return this.get(id);
  }

  private async updateRequisitionLines(m: EntityManager, c: ServiceCertificate, lines: ServiceCertificateLine[], sources: Source[], actor: SessionUser) {
    const touched = new Set<string>();
    const goodsFor = new Map<string, number>();
    for (const l of lines.filter((x) => x.quantity > 0)) {
      const rows: { id: string }[] = await m.query(
        `SELECT sl.id FROM purchase_order_line ol JOIN purchase_requisition_line pl ON pl.id = ol.requisition_line_id
           JOIN staff_requisition_line sl ON sl.pr_line_id = pl.id WHERE ol.id = $1`,
        [l.poLineId],
      );
      for (const { id } of rows) {
        const sl = await m.findOne(StaffRequisitionLine, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!sl) continue;
        const req = sources.find((s) => s.requisitionId === sl.requisitionId)!;
        sl.receivedQty = round4(Math.min(sl.quantity, sl.receivedQty + l.quantity));
        // A service accepted by the person who asked for it has reached them.
        if (sl.lineType === PurchaseLineType.SERVICE && req.requestedBy === actor.id) {
          sl.deliveredQty = sl.receivedQty;
          sl.notes = `Accepted by the requester on ${c.number}`;
        } else {
          goodsFor.set(req.requisitionId, (goodsFor.get(req.requisitionId) ?? 0) + 1);
        }
        if (sl.deliveredQty >= sl.quantity - 1e-9) sl.status = StaffRequisitionLineStatus.DELIVERED;
        await m.save(sl);
        touched.add(sl.requisitionId);
      }
    }
    for (const reqId of touched) await refreshStaffRequisitionStatus(m, reqId);
    // Goods (and services signed for by a colleague) wait to be handed over.
    for (const s of sources.filter((x) => goodsFor.has(x.requisitionId))) {
      await this.notifications.dispatch(m, [s.requestedBy], NotificationCategory.REQUISITIONS, {
        title: `${s.number}: received from the supplier`,
        body: `${goodsFor.get(s.requisitionId)} line(s) accepted on ${c.number}; you will be told when they are ready for collection`,
        link: `/staff-requisitions/${s.requisitionId}`,
      });
    }
  }

  async cancel(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await this.lock(m, id);
      if (c.certifiedBy !== actor.id) throw new ForbiddenException('Only the certifying officer can cancel this certificate');
      c.status = CertificateStatus.CANCELLED;
      await m.save(c);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<ServiceCertificate> {
    const c = await m.findOne(ServiceCertificate, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!c) throw new NotFoundException('Certificate not found');
    if (c.status !== CertificateStatus.DRAFT) throw new ConflictException(`Certificate is ${c.status}`);
    return c;
  }

  async get(id: string, actor?: SessionUser) {
    const c = await this.ds.getRepository(ServiceCertificate).findOne({ where: { id }, relations: { supplier: true, purchaseOrder: true, lines: true } });
    if (!c) throw new NotFoundException('Certificate not found');
    if (actor && !(await this.canSee(this.ds.manager, id, actor))) throw new ForbiddenException('You cannot see this certificate');
    const poLines: { id: string; line_no: number; item: string; line_type: PurchaseLineType; quantity: number; unit_price: number; uom: string }[] = await this.ds.query(
      `SELECT l.id, l.line_no, COALESCE(i.name, l.description) AS item, l.line_type, l.quantity::float AS quantity, l.unit_price::float AS unit_price, u.code AS uom
         FROM purchase_order_line l LEFT JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = l.uom_id WHERE l.id = ANY($1::uuid[])`,
      [(c.lines ?? []).map((l) => l.poLineId)],
    );
    const sources = await this.sources(this.ds.manager, (c.lines ?? []).map((l) => l.poLineId));
    const users: { id: string; full_name: string }[] = await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [[c.certifiedBy, c.acceptedBy].filter(Boolean)]);
    const name = (u: string | null) => users.find((x) => x.id === u)?.full_name ?? null;
    const lines = (c.lines ?? []).map((l) => {
      const p = poLines.find((x) => x.id === l.poLineId);
      return { ...l, lineNo: p?.line_no, item: p?.item, lineType: p?.line_type, ordered: p?.quantity, unitPrice: p?.unit_price, uom: p?.uom, value: p ? Math.round(l.quantity * p.unit_price * 100) / 100 : null };
    });
    return {
      ...c,
      kind: certificateKind(lines.map((l) => l.lineType)),
      certifiedByName: name(c.certifiedBy),
      acceptedByName: name(c.acceptedBy),
      /** Staff requisitions it was bought for: their requester / department signs it off. */
      requisitions: sources.map((s) => ({ id: s.requisitionId, number: s.number })),
      canSign: actor ? c.status === CertificateStatus.DRAFT && sources.length > 0 && this.canSign(sources, actor) : undefined,
      lines,
    };
  }

  list(q: { status?: string; purchaseOrderId?: string; supplierId?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.purchaseOrderId) where.purchaseOrderId = q.purchaseOrderId;
    if (q.supplierId) where.supplierId = q.supplierId;
    return this.ds.getRepository(ServiceCertificate).find({ where, relations: { supplier: true, purchaseOrder: true }, order: { createdAt: 'DESC' }, take: 500 });
  }

  /** Draft certificates the user can sign off (their requisitions or department). */
  async awaitingMe(actor: SessionUser) {
    return this.ds.query(
      `SELECT DISTINCT c.id, c.number, c.created_at AS "createdAt", po.number AS "orderNumber", s.name AS supplier, sr.number AS "requisitionNumber"
         FROM service_certificate c JOIN service_certificate_line cl ON cl.certificate_id = c.id
         JOIN purchase_order po ON po.id = c.purchase_order_id JOIN supplier s ON s.id = c.supplier_id
         JOIN purchase_order_line ol ON ol.id = cl.po_line_id JOIN purchase_requisition_line pl ON pl.id = ol.requisition_line_id
         JOIN staff_requisition_line sl ON sl.pr_line_id = pl.id JOIN staff_requisition sr ON sr.id = sl.requisition_id
        WHERE c.status = 'DRAFT' AND (sr.requested_by = $1 OR (sr.department_id = $2 AND $3))
        ORDER BY c.created_at`,
      [actor.id, actor.departmentId ?? null, actor.permissions.includes(Permissions.SERVICES_CERTIFY)],
    );
  }

  /** Open orders with service or non-stock lines the user could certify. */
  async openServiceOrders() {
    const codes = await this.settings.get('services.categoryCodes');
    return this.ds.query(
      `SELECT DISTINCT po.id, po.number, po.status, s.name AS supplier, po.order_date AS "orderDate"
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN purchase_order_line l ON l.purchase_order_id = po.id
         LEFT JOIN item i ON i.id = l.item_id LEFT JOIN item_category c ON c.id = i.category_id
        WHERE (l.line_type <> 'STOCK' OR c.code = ANY($1::text[])) AND po.status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') ORDER BY po.order_date DESC`,
      [codes],
    );
  }

  async renderPdf(id: string, actor?: SessionUser): Promise<{ number: string; pdf: Buffer }> {
    const c = await this.get(id, actor);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const cur = c.purchaseOrder?.currency ?? (await this.settings.get('locale.currency'));
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const rejected = c.lines.some((l) => l.rejectedQty > 0);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">${esc(c.kind.toUpperCase())}</h1>
      <div class="grid"><div class="box">Certificate: <b>${esc(c.number)}</b><br>Order: ${esc(c.purchaseOrder?.number)}<br>Supplier: ${esc(c.supplier?.name)}${c.requisitions.length ? `<br>Requisition: ${esc(c.requisitions.map((r) => r.number).join(', '))}` : ''}</div>
      <div class="box">Period: ${d(c.periodFrom) || '—'} to ${d(c.periodTo)}<br>Status: ${esc(c.status)}${c.qualityRating ? `<br>Rating: ${c.qualityRating}/5` : ''}</div></div>
      <p><b>Work done / inspection notes:</b> ${esc(c.workDone)}</p>
      <table><thead><tr><th>Line</th><th>Goods / service</th><th class="r">Ordered</th><th class="r">Accepted</th>${rejected ? '<th class="r">Rejected</th>' : ''}<th>Unit</th><th class="r">Value</th><th>Remarks</th></tr></thead>
      <tbody>${c.lines
        .map(
          (l) =>
            `<tr><td>${l.lineNo}</td><td>${esc(l.item)}</td><td class="r">${l.ordered}</td><td class="r">${l.quantity}</td>${rejected ? `<td class="r">${l.rejectedQty || ''}</td>` : ''}<td>${esc(l.uom)}</td><td class="r">${l.value === null ? '' : money(l.value, cur)}</td><td>${esc([l.rejectionReason, l.remarks].filter(Boolean).join('; '))}</td></tr>`,
        )
        .join('')}</tbody></table>
      <p>I certify that the goods / services above were delivered to the required standard${rejected ? ', except the quantities rejected' : ''}.</p>
      ${c.rejectionReason ? `<p><b>Rejected:</b> ${esc(c.rejectionReason)}</p>` : ''}
      <div class="signs"><div class="sign">Recorded by: ${esc(c.certifiedByName)}<br>Signature &amp; date</div><div class="sign">${c.requisitions.length ? 'Accepted by (requesting department)' : 'Head of department'}: ${esc(c.acceptedByName ?? '')}<br>${c.postedAt && c.acceptedByName ? `Signed in the system ${d(c.postedAt)}` : 'Name, signature &amp; date'}</div><div class="sign">Supplier's representative<br>Name, signature &amp; date</div></div>
    </body></html>`;
    return { number: c.number, pdf: await this.pdf.render(html) };
  }
}

/** What the certificate is called on screen and in print. */
export function certificateKind(lineTypes: (PurchaseLineType | undefined)[]): string {
  const nonStock = lineTypes.filter((t) => t && t !== PurchaseLineType.STOCK);
  if (!nonStock.length) return 'Service / works completion certificate';
  return nonStock.every((t) => t === PurchaseLineType.SERVICE) && nonStock.length === lineTypes.length ? 'Service acceptance certificate' : 'Goods received note (non-stock)';
}

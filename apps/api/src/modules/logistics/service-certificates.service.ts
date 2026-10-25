import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AttachmentOwner, CertificateStatus, DocumentType, Permissions, SessionUser } from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import { DocumentLinksService } from '../approvals/document-links.service';
import { AttachmentsService } from '../files/attachments.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { PurchaseOrder, PurchaseOrderLine } from '../purchasing/purchasing.entities';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { SettingsService } from '../settings/settings.service';
import { ServiceCertificate, ServiceCertificateLine } from './logistics.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Completion certificates for service and works orders (maintenance
 * contracts, consultancies, repairs). Posting one counts the certified
 * quantities as received, so the supplier's invoice is three-way matched
 * against it exactly like goods against a GRN.
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
  ) {}

  register() {
    this.attachments.registerOwner(AttachmentOwner.SERVICE_CERTIFICATE, {
      read: [Permissions.PURCHASING_READ],
      write: [Permissions.SERVICES_CERTIFY],
      visible: async (m, id) => (await m.query(`SELECT 1 FROM service_certificate WHERE id = $1`, [id])).length > 0,
    });
  }

  /** Service lines of a PO (items in the service categories) with what is still to certify. */
  private async serviceLines(m: EntityManager, poId: string) {
    const codes = await this.settings.get('services.categoryCodes', m);
    const lines: (PurchaseOrderLine & { category_code?: string })[] = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: poId }, relations: { item: { category: true } } });
    return lines.filter((l) => codes.includes(l.item?.category?.code ?? ''));
  }

  async create(dto: { purchaseOrderId: string; periodFrom?: string | null; periodTo: string; workDone: string; qualityRating?: number | null; lines: { poLineId: string; quantity: number; remarks?: string | null }[] }, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const po = await m.findOneBy(PurchaseOrder, { id: dto.purchaseOrderId });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po.status}`);
      // The person certifying must not have raised or approved the order.
      if (po.createdByUser === actor.id) throw new ForbiddenException('You raised this order and cannot certify it');
      await this.orders.assertNotCreatorOrApprover(po.id, actor, 'certify it');
      const service = await this.serviceLines(m, po.id);
      if (!service.length) throw new BadRequestException('This order has no service lines; receive goods with a GRN');
      for (const l of dto.lines) {
        const pl = service.find((s) => s.id === l.poLineId);
        if (!pl) throw new BadRequestException('A line is not a service line of this order');
        const pending: { q: number }[] = await m.query(
          `SELECT COALESCE(SUM(cl.quantity), 0)::float AS q FROM service_certificate_line cl JOIN service_certificate c ON c.id = cl.certificate_id WHERE cl.po_line_id = $1 AND c.status = 'DRAFT'`,
          [pl.id],
        );
        const remaining = round4(pl.quantity - pl.receivedBaseQty / pl.conversionFactor - pending[0].q);
        if (l.quantity <= 0 || l.quantity > remaining + 1e-9) throw new BadRequestException(`Line ${pl.lineNo}: at most ${remaining} can still be certified`);
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
          lines: dto.lines.map((l) => m.create(ServiceCertificateLine, { poLineId: l.poLineId, quantity: l.quantity, remarks: l.remarks ?? null })),
        }),
      );
      await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.SERVICE_CERTIFICATE, id: c.id, no: c.number });
      return c.id;
    });
    return this.get(id);
  }

  /** Posts the certificate: certified quantities count as received on the order. */
  async post(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await m.findOne(ServiceCertificate, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw new NotFoundException('Certificate not found');
      if (c.status !== CertificateStatus.DRAFT) throw new ConflictException(`Certificate is ${c.status}`);
      if (c.certifiedBy !== actor.id) throw new ForbiddenException('Only the certifying officer can post this certificate');
      const po = await m.findOne(PurchaseOrder, { where: { id: c.purchaseOrderId }, lock: { mode: 'pessimistic_write' } });
      if (!po || !this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po?.status}`);
      const lines = await m.find(ServiceCertificateLine, { where: { certificateId: id } });
      const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
      await this.orders.applyReceipt(
        m,
        po.id,
        lines.map((l) => ({ poLineId: l.poLineId, baseQty: round4(l.quantity * poLines.find((p) => p.id === l.poLineId)!.conversionFactor) })),
      );
      Object.assign(c, { status: CertificateStatus.POSTED, postedAt: new Date() });
      await m.save(c);
    });
    return this.get(id);
  }

  async cancel(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await m.findOne(ServiceCertificate, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw new NotFoundException('Certificate not found');
      if (c.status !== CertificateStatus.DRAFT) throw new ConflictException(`Certificate is ${c.status}`);
      if (c.certifiedBy !== actor.id) throw new ForbiddenException('Only the certifying officer can cancel this certificate');
      c.status = CertificateStatus.CANCELLED;
      await m.save(c);
    });
    return this.get(id);
  }

  async get(id: string) {
    const c = await this.ds.getRepository(ServiceCertificate).findOne({ where: { id }, relations: { supplier: true, purchaseOrder: true, lines: true } });
    if (!c) throw new NotFoundException('Certificate not found');
    const poLines: { id: string; line_no: number; item: string; quantity: number; unit_price: number; uom: string }[] = await this.ds.query(
      `SELECT l.id, l.line_no, i.name AS item, l.quantity::float AS quantity, l.unit_price::float AS unit_price, u.code AS uom FROM purchase_order_line l JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = l.uom_id WHERE l.id = ANY($1::uuid[])`,
      [(c.lines ?? []).map((l) => l.poLineId)],
    );
    const [who] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [c.certifiedBy]);
    return {
      ...c,
      certifiedByName: who?.full_name ?? null,
      lines: (c.lines ?? []).map((l) => {
        const p = poLines.find((x) => x.id === l.poLineId);
        return { ...l, lineNo: p?.line_no, item: p?.item, ordered: p?.quantity, unitPrice: p?.unit_price, uom: p?.uom, value: p ? Math.round(l.quantity * p.unit_price * 100) / 100 : null };
      }),
    };
  }

  list(q: { status?: string; purchaseOrderId?: string; supplierId?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.purchaseOrderId) where.purchaseOrderId = q.purchaseOrderId;
    if (q.supplierId) where.supplierId = q.supplierId;
    return this.ds.getRepository(ServiceCertificate).find({ where, relations: { supplier: true, purchaseOrder: true }, order: { createdAt: 'DESC' }, take: 500 });
  }

  /** Open service orders the user could certify. */
  async openServiceOrders() {
    const codes = await this.settings.get('services.categoryCodes');
    return this.ds.query(
      `SELECT DISTINCT po.id, po.number, po.status, s.name AS supplier, po.order_date AS "orderDate"
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN purchase_order_line l ON l.purchase_order_id = po.id
         JOIN item i ON i.id = l.item_id JOIN item_category c ON c.id = i.category_id
        WHERE c.code = ANY($1::text[]) AND po.status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') ORDER BY po.order_date DESC`,
      [codes],
    );
  }

  async renderPdf(id: string): Promise<{ number: string; pdf: Buffer }> {
    const c = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const cur = await this.settings.get('locale.currency');
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">SERVICE / WORKS COMPLETION CERTIFICATE</h1>
      <div class="grid"><div class="box">Certificate: <b>${esc(c.number)}</b><br>Order: ${esc(c.purchaseOrder?.number)}<br>Supplier: ${esc(c.supplier?.name)}</div>
      <div class="box">Period: ${d(c.periodFrom) || '—'} to ${d(c.periodTo)}<br>Status: ${esc(c.status)}${c.qualityRating ? `<br>Rating: ${c.qualityRating}/5` : ''}</div></div>
      <p><b>Work done:</b> ${esc(c.workDone)}</p>
      <table><thead><tr><th>Line</th><th>Service</th><th class="r">Ordered</th><th class="r">Certified</th><th>Unit</th><th class="r">Value</th><th>Remarks</th></tr></thead>
      <tbody>${c.lines.map((l) => `<tr><td>${l.lineNo}</td><td>${esc(l.item)}</td><td class="r">${l.ordered}</td><td class="r">${l.quantity}</td><td>${esc(l.uom)}</td><td class="r">${l.value === null ? '' : money(l.value, cur)}</td><td>${esc(l.remarks ?? '')}</td></tr>`).join('')}</tbody></table>
      <p>I certify that the services / works above were delivered to the required standard.</p>
      <div class="signs"><div class="sign">Certified by: ${esc(c.certifiedByName)}<br>Signature &amp; date</div><div class="sign">Head of department<br>Name, signature &amp; date</div><div class="sign">Supplier's representative<br>Name, signature &amp; date</div></div>
    </body></html>`;
    return { number: c.number, pdf: await this.pdf.render(html) };
  }
}

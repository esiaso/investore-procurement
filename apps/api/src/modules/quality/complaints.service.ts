import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ComplaintCategory, ComplaintStatus, DocumentType, HoldReason, SessionUser } from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead } from '../../common/html';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { HoldsService } from './holds.service';
import { QualityComplaint } from './quality.entities';

export interface ComplaintInput {
  itemId: string;
  batchId?: string | null;
  supplierId?: string | null;
  storeId?: string | null;
  category: ComplaintCategory;
  description: string;
  reportedByName: string;
  reportedOn?: string;
  patientId?: string | null;
  severity?: string;
  sampleRetained?: boolean;
  holdStock?: boolean;
}

/** PPB report type implied by the category: adverse reactions are pharmacovigilance (ADR), the rest product quality (PQM). */
export const ppbReportTypeFor = (c: ComplaintCategory) => (c === ComplaintCategory.ADVERSE_REACTION ? 'ADR' : 'PQM');

@Injectable()
export class ComplaintsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly holds: HoldsService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
  ) {}

  async create(dto: ComplaintInput, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      let supplierId = dto.supplierId ?? null;
      if (dto.batchId) {
        const [b] = await m.query(`SELECT item_id FROM batch WHERE id = $1`, [dto.batchId]);
        if (!b) throw new NotFoundException('Batch not found');
        if (b.item_id !== dto.itemId) throw new BadRequestException('The batch belongs to another item');
        // Supplier of the batch from its receipt, when not given.
        if (!supplierId) {
          const [g] = await m.query(`SELECT g.supplier_id FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id WHERE gl.batch_id = $1 ORDER BY g.posted_at DESC LIMIT 1`, [dto.batchId]);
          supplierId = g?.supplier_id ?? null;
        }
      }
      if (dto.holdStock && !dto.batchId) throw new BadRequestException('Choose the batch to hold');
      const c = await m.save(
        m.create(QualityComplaint, {
          number: await this.numbering.next(DocumentType.QUALITY_COMPLAINT, { manager: m }),
          itemId: dto.itemId,
          batchId: dto.batchId ?? null,
          supplierId,
          storeId: dto.storeId ?? null,
          category: dto.category,
          description: dto.description,
          reportedByName: dto.reportedByName,
          reportedOn: dto.reportedOn ?? (await this.settings.today(m)),
          patientId: dto.patientId ?? null,
          severity: dto.severity ?? 'MODERATE',
          sampleRetained: dto.sampleRetained ?? false,
          ppbReportType: ppbReportTypeFor(dto.category),
          status: ComplaintStatus.OPEN,
        }),
      );
      if (dto.holdStock && dto.batchId) {
        const hold = await this.holds.place(m, { batchId: dto.batchId, storeId: dto.storeId ?? null, reason: HoldReason.COMPLAINT, details: `Complaint ${c.number}: ${dto.description}`, sourceType: 'COMPLAINT', sourceId: c.id }, actor.id);
        c.holdId = hold.id;
        await m.save(c);
      }
      return c.id;
    });
    return this.get(id);
  }

  async update(id: string, dto: Partial<Pick<QualityComplaint, 'investigation' | 'outcome' | 'ppbReportType' | 'ppbReference' | 'reportedToPpbOn' | 'severity' | 'status'>>) {
    const repo = this.ds.getRepository(QualityComplaint);
    const c = await repo.findOneBy({ id });
    if (!c) throw new NotFoundException('Complaint not found');
    if (c.status === ComplaintStatus.CLOSED) throw new ConflictException('The complaint is closed');
    if (dto.status === ComplaintStatus.CLOSED && !(dto.outcome ?? c.outcome)) throw new BadRequestException('Record the outcome before closing');
    Object.assign(c, dto);
    await repo.save(c);
    return this.get(id);
  }

  async get(id: string) {
    const c = await this.ds.getRepository(QualityComplaint).findOne({ where: { id }, relations: { item: true, batch: true, supplier: true } });
    if (!c) throw new NotFoundException('Complaint not found');
    const [patient] = c.patientId ? await this.ds.query(`SELECT hospital_no AS "hospitalNo", name FROM patient WHERE id = $1`, [c.patientId]) : [];
    const [hold] = c.holdId ? await this.ds.query(`SELECT id, number, status FROM quality_hold WHERE id = $1`, [c.holdId]) : [];
    return { ...c, patient: patient ?? null, hold: hold ?? null };
  }

  list(q: { status?: string; supplierId?: string; itemId?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.itemId) where.itemId = q.itemId;
    return this.ds.getRepository(QualityComplaint).find({ where, relations: { item: true, batch: true, supplier: true }, order: { createdAt: 'DESC' }, take: 1000 });
  }

  /** Printable report with the fields of the PPB poor-quality / adverse-reaction report forms. */
  async renderPdf(id: string): Promise<{ number: string; pdf: Buffer }> {
    const c = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const row = (k: string, v: unknown) => `<tr><th style="width:35%;text-align:left">${esc(k)}</th><td>${esc(v === null || v === undefined || v === '' ? '—' : String(v))}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">${c.ppbReportType === 'ADR' ? 'SUSPECTED ADVERSE DRUG REACTION REPORT' : 'POOR-QUALITY MEDICINAL PRODUCT REPORT'}</h1>
      <p>For submission to the Pharmacy and Poisons Board (PPB) pharmacovigilance system. Internal reference <b>${esc(c.number)}</b>.</p>
      <table>
        ${row('Reported on', d(c.reportedOn))}
        ${row('Reported by', c.reportedByName)}
        ${row('Category', c.category.replace(/_/g, ' ').toLowerCase())}
        ${row('Severity', c.severity)}
        ${row('Product', c.item?.name)}
        ${row('Manufacturer', c.item?.manufacturer)}
        ${row('PPB registration no.', c.item?.ppbRegNo)}
        ${row('Batch / lot no.', c.batch?.batchNo)}
        ${row('Manufacture date', d(c.batch?.manufactureDate))}
        ${row('Expiry date', d(c.batch?.expiryDate))}
        ${row('Supplier', c.supplier?.name)}
        ${row('Patient (hospital no.)', c.patient ? `${c.patient.hospitalNo}` : null)}
        ${row('Sample retained', c.sampleRetained ? 'Yes' : 'No')}
        ${row('Stock quarantined', c.hold ? `${c.hold.number} (${c.hold.status})` : 'No')}
      </table>
      <h3>Description of the problem</h3><p style="white-space:pre-wrap">${esc(c.description)}</p>
      <h3>Investigation</h3><p style="white-space:pre-wrap">${esc(c.investigation ?? '—')}</p>
      <h3>Outcome / action taken</h3><p style="white-space:pre-wrap">${esc(c.outcome ?? '—')}</p>
      <table>${row('PPB reference', c.ppbReference)}${row('Sent to PPB on', d(c.reportedToPpbOn))}</table>
      <div class="signs"><div class="sign">Reporter<br>Name, signature &amp; date</div><div class="sign">Pharmacist / Quality Officer<br>Name, signature &amp; date</div></div>
    </body></html>`;
    return { number: c.number, pdf: await this.pdf.render(html) };
  }
}

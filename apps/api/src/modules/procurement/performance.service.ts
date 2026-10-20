import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CorrectiveActionStatus, DocumentType, SanctionType, SessionUser, SupplierStatus, VariationStatus } from '@sil/shared';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { CorrectiveAction, SupplierSanction, SupplierScorecard } from './performance.entities';

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? r2((100 * num) / den) : null);

export interface ScoreRates {
  onTimeRate: number | null;
  inFullRate: number | null;
  qualityRejectRate: number | null;
  priceComplianceRate: number | null;
  documentComplianceRate: number | null;
}

/**
 * Weighted overall score 0–100. Quality counts as 100 − reject rate. Dimensions
 * with nothing to measure are left out and the remaining weights rescaled.
 */
export function overallScore(r: ScoreRates, w: { onTime: number; inFull: number; quality: number; price: number; documents: number }): number | null {
  const parts: [number | null, number][] = [
    [r.onTimeRate, w.onTime],
    [r.inFullRate, w.inFull],
    [r.qualityRejectRate === null ? null : 100 - r.qualityRejectRate, w.quality],
    [r.priceComplianceRate, w.price],
    [r.documentComplianceRate, w.documents],
  ];
  const used = parts.filter(([v, wt]) => v !== null && wt > 0) as [number, number][];
  const total = used.reduce((s, [, wt]) => s + wt, 0);
  return total ? r2(used.reduce((s, [v, wt]) => s + v * wt, 0) / total) : null;
}

const monthEnd = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Supplier scorecards, corrective actions, suspension / blacklisting workflow. */
@Injectable()
export class PerformanceService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
    private readonly links: DocumentLinksService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.SUPPLIER_SANCTION, this);
    this.links.registerResolver(DocumentType.SUPPLIER_SANCTION, async (ids) => {
      const rows = await this.ds.getRepository(SupplierSanction).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: `${r.type} · ${r.status}`, date: r.effectiveFrom, amount: null }]));
    });
  }

  /** Rates of one supplier for one month. */
  async rates(m: EntityManager, supplierId: string, period: string, today: string) {
    const from = `${period}-01`;
    const to = monthEnd(period);
    const until = to < today ? to : today;
    // Orders due in the month (by the expected delivery date, up to today).
    const [ord] = await m.query(
      `WITH due AS (
         SELECT po.id, po.expected_delivery FROM purchase_order po
          WHERE po.supplier_id = $1 AND po.expected_delivery BETWEEN $2::date AND $3::date
            AND po.status IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'APPROVED')
       ), rec AS (
         SELECT d.id,
                EXISTS (SELECT 1 FROM goods_received_note g WHERE g.purchase_order_id = d.id AND g.status = 'POSTED' AND g.received_date <= d.expected_delivery) AS on_time,
                NOT EXISTS (
                  SELECT 1 FROM purchase_order_line pl
                   WHERE pl.purchase_order_id = d.id
                     AND COALESCE((SELECT SUM(gl.accepted_base_qty) FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id
                                    WHERE gl.po_line_id = pl.id AND g.status = 'POSTED' AND g.received_date <= d.expected_delivery), 0)
                         < pl.quantity * pl.conversion_factor) AS in_full
           FROM due d)
       SELECT count(*)::int AS due, count(*) FILTER (WHERE on_time)::int AS on_time, count(*) FILTER (WHERE in_full)::int AS in_full,
              count(*) FILTER (WHERE on_time AND in_full)::int AS otif
         FROM rec`,
      [supplierId, from, until],
    );
    const [q] = await m.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(gl.accepted_base_qty), 0)::float AS accepted, COALESCE(SUM(gl.rejected_base_qty), 0)::float AS rejected
         FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id
        WHERE g.supplier_id = $1 AND g.status = 'POSTED' AND g.received_date BETWEEN $2::date AND $3::date`,
      [supplierId, from, to],
    );
    const tol = await this.settings.get('purchasing.matchPriceTolerancePct', m);
    const [p] = await m.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE il.unit_price <= pl.unit_price * (1 + $4::numeric / 100) + 0.0001)::int AS ok
         FROM supplier_invoice_line il JOIN supplier_invoice si ON si.id = il.invoice_id JOIN purchase_order_line pl ON pl.id = il.po_line_id
        WHERE si.supplier_id = $1 AND si.invoice_date BETWEEN $2::date AND $3::date AND si.status <> 'CANCELLED'`,
      [supplierId, from, to, tol],
    );
    const required = await this.settings.get('suppliers.requiredDocumentTypes', m);
    const [d] = required.length
      ? await m.query(
          `SELECT count(DISTINCT document_type)::int AS ok FROM supplier_document
            WHERE supplier_id = $1 AND document_type = ANY($2::text[]) AND (expires_on IS NULL OR expires_on >= $3::date)`,
          [supplierId, required, to],
        )
      : [{ ok: 0 }];
    const rates: ScoreRates = {
      onTimeRate: pct(ord.on_time, ord.due),
      inFullRate: pct(ord.in_full, ord.due),
      qualityRejectRate: pct(q.rejected, q.accepted + q.rejected),
      priceComplianceRate: pct(p.ok, p.n),
      documentComplianceRate: required.length ? pct(d.ok, required.length) : null,
    };
    return { rates, ordersDue: ord.due as number, otifRate: pct(ord.otif, ord.due), grnLines: q.n as number, invoiceLines: p.n as number };
  }

  /**
   * Computes the scorecard of every supplier with activity (or documents) for a
   * month; opens a corrective action when the score is below the threshold.
   */
  async compute(period: string, actor?: SessionUser): Promise<{ period: string; suppliers: number; actions: number }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('Period is YYYY-MM');
    return this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      const weights = await this.settings.get('suppliers.scorecardWeights', m);
      const threshold = await this.settings.get('suppliers.scorecardActionThreshold', m);
      const suppliers: { id: string; name: string }[] = await m.query(
        `SELECT DISTINCT s.id, s.name FROM supplier s
          WHERE EXISTS (SELECT 1 FROM purchase_order po WHERE po.supplier_id = s.id AND po.expected_delivery BETWEEN ($1 || '-01')::date AND $2::date)
             OR EXISTS (SELECT 1 FROM goods_received_note g WHERE g.supplier_id = s.id AND g.received_date BETWEEN ($1 || '-01')::date AND $2::date)
             OR EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.supplier_id = s.id AND i.invoice_date BETWEEN ($1 || '-01')::date AND $2::date)`,
        [period, monthEnd(period)],
      );
      let actions = 0;
      for (const s of suppliers) {
        const r = await this.rates(m, s.id, period, today);
        const overall = overallScore(r.rates, weights);
        await m.query(
          `INSERT INTO supplier_scorecard (supplier_id, period, orders_due, grn_lines, invoice_lines, on_time_rate, in_full_rate, otif_rate,
                                           quality_reject_rate, price_compliance_rate, document_compliance_rate, overall_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (supplier_id, period) DO UPDATE SET orders_due = EXCLUDED.orders_due, grn_lines = EXCLUDED.grn_lines, invoice_lines = EXCLUDED.invoice_lines,
             on_time_rate = EXCLUDED.on_time_rate, in_full_rate = EXCLUDED.in_full_rate, otif_rate = EXCLUDED.otif_rate,
             quality_reject_rate = EXCLUDED.quality_reject_rate, price_compliance_rate = EXCLUDED.price_compliance_rate,
             document_compliance_rate = EXCLUDED.document_compliance_rate, overall_score = EXCLUDED.overall_score, computed_at = now()`,
          [s.id, period, r.ordersDue, r.grnLines, r.invoiceLines, r.rates.onTimeRate, r.rates.inFullRate, r.otifRate, r.rates.qualityRejectRate, r.rates.priceComplianceRate, r.rates.documentComplianceRate, overall],
        );
        if (overall !== null && overall < threshold) {
          const card = await m.findOneByOrFail(SupplierScorecard, { supplierId: s.id, period });
          if (!(await m.existsBy(CorrectiveAction, { scorecardId: card.id }))) {
            await m.save(
              m.create(CorrectiveAction, {
                supplierId: s.id,
                scorecardId: card.id,
                issue: `Scorecard ${period}: overall ${overall} below ${threshold} (on time ${r.rates.onTimeRate ?? '–'}%, in full ${r.rates.inFullRate ?? '–'}%, rejects ${r.rates.qualityRejectRate ?? '–'}%, price ${r.rates.priceComplianceRate ?? '–'}%, documents ${r.rates.documentComplianceRate ?? '–'}%)`,
                actionRequired: 'Agree an improvement plan with the supplier',
                raisedBy: actor?.id ?? null,
              }),
            );
            actions++;
          }
        }
      }
      return { period, suppliers: suppliers.length, actions };
    });
  }

  scorecards(q: { supplierId?: string; period?: string }) {
    const where: Record<string, unknown> = {};
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.period) where.period = q.period;
    return this.ds.getRepository(SupplierScorecard).find({ where, relations: { supplier: true }, order: { period: 'DESC', overallScore: 'ASC' }, take: 1000 });
  }

  // ------------------------------------------------------------------ corrective actions

  correctiveActions(q: { supplierId?: string; status?: string }) {
    const where: Record<string, unknown> = {};
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.status) where.status = q.status;
    return this.ds.getRepository(CorrectiveAction).find({ where, relations: { supplier: true }, order: { createdAt: 'DESC' }, take: 500 });
  }

  async addCorrectiveAction(dto: { supplierId: string; issue: string; actionRequired: string; dueDate?: string }, actor: SessionUser) {
    const repo = this.ds.getRepository(CorrectiveAction);
    return repo.save(repo.create({ ...dto, dueDate: dto.dueDate ?? null, raisedBy: actor.id }));
  }

  async closeCorrectiveAction(id: string, outcome: string) {
    const repo = this.ds.getRepository(CorrectiveAction);
    const a = await repo.findOneBy({ id });
    if (!a) throw new NotFoundException('Corrective action not found');
    if (a.status === CorrectiveActionStatus.CLOSED) throw new ConflictException('Already closed');
    Object.assign(a, { status: CorrectiveActionStatus.CLOSED, closedAt: new Date(), outcome });
    return repo.save(a);
  }

  // ------------------------------------------------------------------ sanctions

  async requestSanction(dto: { supplierId: string; type: SanctionType; reason: string; effectiveFrom?: string; effectiveTo?: string | null }, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const [s] = await m.query(`SELECT id, name, status FROM supplier WHERE id = $1`, [dto.supplierId]);
      if (!s) throw new NotFoundException('Supplier not found');
      if (dto.type === SanctionType.REINSTATE && s.status === SupplierStatus.ACTIVE) throw new ConflictException('Supplier is already active');
      if (dto.type !== SanctionType.REINSTATE && s.status === SupplierStatus.BLACKLISTED) throw new ConflictException('Supplier is blacklisted');
      if (dto.type === SanctionType.BLACKLIST && dto.effectiveTo) throw new BadRequestException('Blacklisting has no end date');
      if (await m.existsBy(SupplierSanction, { supplierId: dto.supplierId, status: VariationStatus.PENDING_APPROVAL })) throw new ConflictException('A sanction request is already pending for this supplier');
      const today = await this.settings.today(m);
      const row = await m.save(
        m.create(SupplierSanction, {
          number: await this.numbering.next(DocumentType.SUPPLIER_SANCTION, { manager: m }),
          supplierId: dto.supplierId,
          type: dto.type,
          reason: dto.reason,
          effectiveFrom: dto.effectiveFrom ?? today,
          effectiveTo: dto.effectiveTo ?? null,
          status: VariationStatus.PENDING_APPROVAL,
          requestedBy: actor.id,
        }),
      );
      await this.approvals.start(m, {
        documentType: DocumentType.SUPPLIER_SANCTION,
        documentId: row.id,
        documentNo: row.number,
        amount: 0,
        requestedBy: actor.id,
        summary: `${dto.type} ${s.name}: ${dto.reason}`.slice(0, 300),
        link: `/suppliers`,
      });
      return row.id;
    });
    return this.ds.getRepository(SupplierSanction).findOneByOrFail({ id });
  }

  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const s = await m.findOneByOrFail(SupplierSanction, { id: req.documentId });
    s.status = VariationStatus.APPROVED;
    await m.save(s);
    const today = await this.settings.today(m);
    if (s.effectiveFrom <= today) await this.apply(m, s);
  }

  private async apply(m: EntityManager, s: SupplierSanction) {
    const status = s.type === SanctionType.SUSPEND ? SupplierStatus.SUSPENDED : s.type === SanctionType.BLACKLIST ? SupplierStatus.BLACKLISTED : SupplierStatus.ACTIVE;
    await m.query(`UPDATE supplier SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1`, [s.supplierId, status, `${s.number}: ${s.reason}`.slice(0, 500)]);
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(SupplierSanction, req.documentId, { status: VariationStatus.REJECTED, lastComment: comment });
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(SupplierSanction, req.documentId, { status: VariationStatus.RETURNED, lastComment: comment });
  }

  /** Job: applies approved sanctions that start today and lifts suspensions that ended. */
  async applyDue(): Promise<{ applied: number; lifted: number }> {
    return this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      const due = await m.query(
        `SELECT s.id FROM supplier_sanction s JOIN supplier sup ON sup.id = s.supplier_id
          WHERE s.status = 'APPROVED' AND NOT s.lifted AND s.effective_from <= $1::date
            AND sup.status::text <> CASE s.type WHEN 'SUSPEND' THEN 'SUSPENDED' WHEN 'BLACKLIST' THEN 'BLACKLISTED' ELSE 'ACTIVE' END
            AND (s.effective_to IS NULL OR s.effective_to >= $1::date)`,
        [today],
      );
      for (const d of due) await this.apply(m, await m.findOneByOrFail(SupplierSanction, { id: d.id }));
      const ended: SupplierSanction[] = await m
        .getRepository(SupplierSanction)
        .createQueryBuilder('s')
        .where(`s.status = 'APPROVED' AND s.type = 'SUSPEND' AND NOT s.lifted AND s.effective_to < :t`, { t: today })
        .getMany();
      for (const s of ended) {
        await m.query(`UPDATE supplier SET status = 'ACTIVE', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'SUSPENDED'`, [s.supplierId, `Suspension ${s.number} ended`]);
        s.lifted = true;
        await m.save(s);
      }
      return { applied: due.length, lifted: ended.length };
    });
  }

  sanctions(supplierId?: string) {
    return this.ds.getRepository(SupplierSanction).find({ where: supplierId ? { supplierId } : {}, relations: { supplier: true }, order: { createdAt: 'DESC' }, take: 500 });
  }
}

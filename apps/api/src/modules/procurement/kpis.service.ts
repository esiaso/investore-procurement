import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PlanStatus } from '@sil/shared';
import { financialYearOf } from '../numbering/financial-year';
import { SettingsService } from '../settings/settings.service';
import { ProcurementPlan } from './plans.entities';
import { PlansService } from './plans.service';

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const PO_COMMITTED = `('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')`;

/** Procurement KPIs for a period (dates are order / receipt dates, VAT exclusive unless stated). */
@Injectable()
export class KpisService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly plans: PlansService,
  ) {}

  async kpis(q: { from: string; to: string }) {
    const p = [q.from, q.to];
    // Lead times: PR approved → PO created; PO approved → first posted GRN.
    const [lead] = await this.ds.query(
      `WITH pr_ap AS (
         SELECT r.document_id, MAX(r.updated_at) AS at FROM approval_request r WHERE r.document_type = 'PR' AND r.status = 'APPROVED' GROUP BY r.document_id
       ), po_ap AS (
         SELECT r.document_id, MIN(r.updated_at) AS at FROM approval_request r WHERE r.document_type = 'PO' AND r.status = 'APPROVED' GROUP BY r.document_id
       ), first_grn AS (
         SELECT g.purchase_order_id, MIN(g.posted_at) AS at FROM goods_received_note g WHERE g.status = 'POSTED' GROUP BY g.purchase_order_id
       )
       SELECT round(avg(extract(epoch FROM po.created_at - pr_ap.at) / 86400) FILTER (WHERE pr_ap.at IS NOT NULL)::numeric, 1)::float AS pr_to_po_days,
              round(avg(extract(epoch FROM fg.at - po_ap.at) / 86400) FILTER (WHERE fg.at IS NOT NULL AND po_ap.at IS NOT NULL)::numeric, 1)::float AS po_to_grn_days,
              round(avg(extract(epoch FROM fg.at - pr_ap.at) / 86400) FILTER (WHERE fg.at IS NOT NULL AND pr_ap.at IS NOT NULL)::numeric, 1)::float AS pr_to_grn_days,
              count(*)::int AS orders
         FROM purchase_order po LEFT JOIN pr_ap ON pr_ap.document_id = po.requisition_id
         LEFT JOIN po_ap ON po_ap.document_id = po.id LEFT JOIN first_grn fg ON fg.purchase_order_id = po.id
        WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}`,
      p,
    );
    // Spend (approved POs in the period).
    const [spend] = await this.ds.query(
      `SELECT COALESCE(SUM(po.subtotal), 0)::float AS total,
              COALESCE(SUM(po.subtotal) FILTER (WHERE po.contract_id IS NOT NULL OR EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.purchase_order_id = po.id AND l.contract_line_id IS NOT NULL)), 0)::float AS under_contract
         FROM purchase_order po WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}`,
      p,
    );
    const bySupplier = await this.ds.query(
      `SELECT s.name AS supplier, SUM(po.subtotal)::float AS spend, count(*)::int AS orders
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
        WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}
        GROUP BY s.name ORDER BY 2 DESC LIMIT 15`,
      p,
    );
    const byCategory = await this.ds.query(
      `SELECT c.name AS category, SUM(l.line_subtotal)::float AS spend
         FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id JOIN item i ON i.id = l.item_id JOIN item_category c ON c.id = i.category_id
        WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}
        GROUP BY c.name ORDER BY 2 DESC`,
      p,
    );
    const byMethod = await this.ds.query(
      `SELECT CASE WHEN po.contract_id IS NOT NULL THEN COALESCE(CASE WHEN c.type = 'FRAMEWORK' THEN 'FRAMEWORK' END, t.method, 'CONTRACT')
                   WHEN po.rfq_id IS NOT NULL THEN 'RFQ'
                   WHEN po.source = 'ORDER_CYCLE' THEN 'ORDER_CYCLE'
                   ELSE COALESCE(pr.sourcing_method, 'UNSPECIFIED') END AS method,
              SUM(po.subtotal)::float AS spend, count(*)::int AS orders
         FROM purchase_order po LEFT JOIN contract c ON c.id = po.contract_id LEFT JOIN tender t ON t.id = c.tender_id
         LEFT JOIN purchase_requisition pr ON pr.id = po.requisition_id
        WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}
        GROUP BY 1 ORDER BY 2 DESC`,
      p,
    );
    // Savings vs the requisition estimate (lines ordered from requisitions).
    const [savings] = await this.ds.query(
      `SELECT COALESCE(SUM(rl.estimated_unit_price * l.quantity * l.conversion_factor), 0)::float AS estimate, COALESCE(SUM(l.line_subtotal), 0)::float AS ordered
         FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id JOIN purchase_requisition_line rl ON rl.id = l.requisition_line_id
        WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED}`,
      p,
    );
    // OTIF over orders due in the period.
    const [otif] = await this.ds.query(
      `WITH due AS (
         SELECT po.id, po.expected_delivery FROM purchase_order po
          WHERE po.expected_delivery BETWEEN $1::date AND LEAST($2::date, CURRENT_DATE) AND po.status IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'APPROVED')
       )
       SELECT count(*)::int AS due,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM goods_received_note g WHERE g.purchase_order_id = d.id AND g.status = 'POSTED' AND g.received_date <= d.expected_delivery)
                AND NOT EXISTS (SELECT 1 FROM purchase_order_line pl WHERE pl.purchase_order_id = d.id
                  AND COALESCE((SELECT SUM(gl.accepted_base_qty) FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id
                                 WHERE gl.po_line_id = pl.id AND g.status = 'POSTED' AND g.received_date <= d.expected_delivery), 0) < pl.quantity * pl.conversion_factor))::int AS otif
         FROM due d`,
      p,
    );
    const [acc] = await this.ds.query(
      `SELECT round(avg(ape), 2)::float AS mape, count(*)::int AS pairs FROM forecast_accuracy WHERE month BETWEEN to_char($1::date, 'YYYY-MM') AND to_char($2::date, 'YYYY-MM') AND ape IS NOT NULL`,
      p,
    );
    // Plan execution for the financial year containing the end of the period.
    const fy = financialYearOf(q.to, await this.settings.get('finance.fyStartMonth')).label;
    const planRows = await this.ds.getRepository(ProcurementPlan).find({ where: { financialYear: fy }, relations: { lines: true } });
    const hospital = planRows.find((x) => !x.departmentId && x.status === PlanStatus.APPROVED);
    const used = hospital ? [hospital] : planRows.filter((x) => x.departmentId && [PlanStatus.APPROVED, PlanStatus.CONSOLIDATED].includes(x.status));
    let planned = 0;
    let procured = 0;
    for (const plan of used) {
      const e = await this.plans.execution(plan);
      planned += e.planned;
      procured += e.procured;
    }
    const ppada = await this.settings.get('procurement.ppadaRuleSet');
    const agpo = ppada
      ? await this.ds.query(
          `SELECT COALESCE(s.agpo_category::text, 'NONE') AS category, SUM(po.subtotal)::float AS spend
             FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
            WHERE po.order_date BETWEEN $1::date AND $2::date AND po.status IN ${PO_COMMITTED} GROUP BY 1 ORDER BY 2 DESC`,
          p,
        )
      : null;
    const pct = (a: number, b: number) => (b > 0 ? r2((100 * a) / b) : null);
    return {
      period: q,
      leadTimes: { prToPoDays: lead.pr_to_po_days, poToGrnDays: lead.po_to_grn_days, prToGrnDays: lead.pr_to_grn_days, orders: lead.orders },
      planExecution: { financialYear: fy, planned: r2(planned), procured: r2(procured), rate: pct(procured, planned), basis: hospital ? 'HOSPITAL_PLAN' : 'DEPARTMENT_PLANS' },
      savings: { estimate: r2(savings.estimate), ordered: r2(savings.ordered), saved: r2(savings.estimate - savings.ordered), percent: pct(savings.estimate - savings.ordered, savings.estimate) },
      spend: { total: r2(spend.total), underContract: r2(spend.under_contract), underContractPercent: pct(spend.under_contract, spend.total), bySupplier, byCategory, byMethod },
      otif: { ordersDue: otif.due, otif: otif.otif, percent: pct(otif.otif, otif.due) },
      forecastAccuracy: { mape: acc.mape, pairs: acc.pairs },
      agpo,
    };
  }

  /** Optional PPADA rule set: award report in the PPRA style (tenders awarded and contracts signed in the period). */
  async ppraReport(q: { from: string; to: string }) {
    return this.ds.query(
      `SELECT t.number AS tender, t.title, t.method, t.estimated_value::float AS estimate, t.awarded_at::date AS awarded_on,
              s.name AS supplier, s.kra_pin, s.agpo_category, b.total_price::float AS award_value,
              (SELECT count(*)::int FROM bid x WHERE x.tender_id = t.id AND x.status <> 'WITHDRAWN') AS bids,
              c.number AS contract, c.start_date, c.end_date
         FROM tender t JOIN bid b ON b.id = t.awarded_bid_id JOIN supplier s ON s.id = b.supplier_id LEFT JOIN contract c ON c.id = t.contract_id
        WHERE t.awarded_at::date BETWEEN $1::date AND $2::date ORDER BY t.awarded_at`,
      [q.from, q.to],
    );
  }
}

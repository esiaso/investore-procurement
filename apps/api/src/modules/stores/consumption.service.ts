import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SessionUser } from '@sil/shared';
import { SettingsService } from '../settings/settings.service';
import { ConsumptionQueryDto } from './stores.dto';

export interface ConsumptionRow {
  key: string;
  label: string;
  departmentCode?: string | null;
  costCentre?: string | null;
  department?: string | null;
  period?: string | null;
  itemCode?: string | null;
  uom?: string | null;
  patientRef?: string | null;
  issuedQty: number | null;
  returnedQty: number | null;
  netQty: number | null;
  issuedValue: number;
  returnedValue: number;
  netValue: number;
  movements: number;
}

/**
 * Departmental consumption from the stock ledger: issues to a department
 * (ISSUE) less returns from it (RETURN_IN), at the cost posted. Quantities are
 * only meaningful (and only reported) when grouped by item.
 */
@Injectable()
export class ConsumptionService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async report(q: ConsumptionQueryDto, actor: SessionUser) {
    if (q.to < q.from) throw new BadRequestException('"to" is before "from"');
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = [
      `t.txn_type IN ('ISSUE', 'RETURN_IN')`,
      `t.department_id IS NOT NULL`,
      `t.effective_date BETWEEN ${p(q.from)}::date AND ${p(q.to)}::date`,
    ];
    // Without store.all: the user's own department, plus stores they work in.
    if (actor.storeIds !== null) {
      where.push(`(t.department_id = ${p(actor.departmentId ?? null)} OR t.store_id = ANY(${p(actor.storeIds)}::uuid[]))`);
    }
    if (q.departmentId) where.push(`t.department_id = ${p(q.departmentId)}`);
    if (q.storeId) where.push(`t.store_id = ${p(q.storeId)}`);
    if (q.itemId) where.push(`t.item_id = ${p(q.itemId)}`);
    if (q.categoryId) where.push(`i.category_id = ${p(q.categoryId)}`);
    if (q.patientRef) where.push(`t.patient_ref ILIKE ${p(q.patientRef.trim())}`);

    const groupBy = q.groupBy ?? 'department';
    const dims = {
      department: {
        select: `d.id::text AS key, d.name AS label, d.code AS "departmentCode", d.cost_centre_code AS "costCentre", d.name AS department`,
        group: 'd.id, d.name, d.code, d.cost_centre_code',
        order: 'd.name',
      },
      period: {
        select: `to_char(t.effective_date, 'YYYY-MM') || '|' || d.id AS key, to_char(t.effective_date, 'YYYY-MM') AS period,
                 to_char(t.effective_date, 'YYYY-MM') || ' · ' || d.name AS label, d.code AS "departmentCode", d.cost_centre_code AS "costCentre", d.name AS department`,
        group: `to_char(t.effective_date, 'YYYY-MM'), d.id, d.name, d.code, d.cost_centre_code`,
        order: `to_char(t.effective_date, 'YYYY-MM'), d.name`,
      },
      item: {
        select: `i.id::text AS key, i.name AS label, i.code AS "itemCode", u.code AS uom`,
        group: 'i.id, i.name, i.code, u.code',
        order: 'i.name',
      },
      patient: {
        select: `COALESCE(t.patient_ref, '') || '|' || d.id AS key, COALESCE(t.patient_ref, '(no patient reference)') AS label,
                 t.patient_ref AS "patientRef", d.name AS department, d.cost_centre_code AS "costCentre"`,
        group: 't.patient_ref, d.id, d.name, d.cost_centre_code',
        order: 't.patient_ref NULLS LAST, d.name',
      },
    }[groupBy];
    const withQty = groupBy === 'item';
    const rows: ConsumptionRow[] = await this.ds.query(
      `SELECT ${dims.select},
              ${withQty ? `SUM(-t.quantity) FILTER (WHERE t.txn_type = 'ISSUE')::float` : 'NULL::float'} AS "issuedQty",
              ${withQty ? `SUM(t.quantity) FILTER (WHERE t.txn_type = 'RETURN_IN')::float` : 'NULL::float'} AS "returnedQty",
              ${withQty ? `SUM(-t.quantity)::float` : 'NULL::float'} AS "netQty",
              ROUND(COALESCE(SUM(-t.value_delta) FILTER (WHERE t.txn_type = 'ISSUE'), 0), 2)::float AS "issuedValue",
              ROUND(COALESCE(SUM(t.value_delta) FILTER (WHERE t.txn_type = 'RETURN_IN'), 0), 2)::float AS "returnedValue",
              ROUND(SUM(-t.value_delta), 2)::float AS "netValue",
              COUNT(*)::int AS movements
         FROM stock_transaction t
         JOIN department d ON d.id = t.department_id
         JOIN item i ON i.id = t.item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
        WHERE ${where.join(' AND ')}
        GROUP BY ${dims.group}
        ORDER BY ${dims.order}
        LIMIT 10000`,
      params,
    );
    const total = (k: 'issuedValue' | 'returnedValue' | 'netValue') => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
    return {
      from: q.from,
      to: q.to,
      groupBy,
      currency: await this.settings.get('locale.currency'),
      rows: rows.map((r) => ({ ...r, returnedQty: withQty ? (r.returnedQty ?? 0) : null, issuedQty: withQty ? (r.issuedQty ?? 0) : null })),
      totals: { issuedValue: total('issuedValue'), returnedValue: total('returnedValue'), netValue: total('netValue') },
    };
  }

  toCsv(report: Awaited<ReturnType<ConsumptionService['report']>>): string {
    const cols: [string, (r: ConsumptionRow) => unknown][] = {
      department: [
        ['Department', (r: ConsumptionRow) => r.department],
        ['Code', (r: ConsumptionRow) => r.departmentCode],
        ['Cost centre', (r: ConsumptionRow) => r.costCentre],
      ],
      period: [
        ['Period', (r: ConsumptionRow) => r.period],
        ['Department', (r: ConsumptionRow) => r.department],
        ['Cost centre', (r: ConsumptionRow) => r.costCentre],
      ],
      item: [
        ['Item code', (r: ConsumptionRow) => r.itemCode],
        ['Item', (r: ConsumptionRow) => r.label],
        ['Unit', (r: ConsumptionRow) => r.uom],
        ['Issued qty', (r: ConsumptionRow) => r.issuedQty],
        ['Returned qty', (r: ConsumptionRow) => r.returnedQty],
        ['Net qty', (r: ConsumptionRow) => r.netQty],
      ],
      patient: [
        ['Patient reference', (r: ConsumptionRow) => r.patientRef],
        ['Department', (r: ConsumptionRow) => r.department],
        ['Cost centre', (r: ConsumptionRow) => r.costCentre],
      ],
    }[report.groupBy] as [string, (r: ConsumptionRow) => unknown][];
    const all: [string, (r: ConsumptionRow) => unknown][] = [
      ...cols,
      [`Issued value (${report.currency})`, (r) => r.issuedValue],
      [`Returned value (${report.currency})`, (r) => r.returnedValue],
      [`Net value (${report.currency})`, (r) => r.netValue],
      ['Movements', (r) => r.movements],
    ];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Quote when needed; neutralise spreadsheet formulas.
      const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [all.map(([h]) => cell(h)).join(',')];
    for (const r of report.rows) lines.push(all.map(([, f]) => cell(f(r))).join(','));
    return `${lines.join('\r\n')}\r\n`;
  }
}

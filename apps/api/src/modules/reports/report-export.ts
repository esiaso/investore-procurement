import ExcelJS from 'exceljs';
import { toCsv } from '../../common/csv';
import type { ReportColumn } from './report-types';

export interface RenderedReport {
  title: string;
  facility: string;
  /** Filters in words, e.g. ["Period: 2026-10-01 to 2026-10-31", "Store: Main store"]. */
  criteria: string[];
  generatedAt: string;
  generatedBy: string | null;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  notes?: string[];
  landscape?: boolean;
}

const fmt = (v: unknown, type: ReportColumn['type']): string => {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'qty' || type === 'number') return Number(v).toLocaleString('en-KE', { maximumFractionDigits: 4 });
  if (type === 'percent') return `${Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 })}%`;
  if (type === 'datetime') return (v instanceof Date ? v.toISOString() : String(v)).replace('T', ' ').slice(0, 16);
  if (type === 'date') return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  return String(v);
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** CSV with column labels as the header row (and the totals as a last row). */
export function reportCsv(r: RenderedReport): string {
  const rows = [...r.rows, ...(r.totals ? [{ ...r.totals, [r.columns[0].key]: 'Total' }] : [])];
  return toCsv(rows.map((row) => Object.fromEntries(r.columns.map((c) => [c.label, row[c.key] ?? '']))).concat(rows.length ? [] : [Object.fromEntries(r.columns.map((c) => [c.label, '']))]));
}

export async function reportXlsx(r: RenderedReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = r.facility;
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { pageSetup: { orientation: r.landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.addRow([r.facility]).font = { bold: true };
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  for (const c of r.criteria) ws.addRow([c]);
  ws.addRow([`Generated ${r.generatedAt}${r.generatedBy ? ` by ${r.generatedBy}` : ''}`]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } }));
  const first = header.number + 1;
  for (const row of r.rows) {
    ws.addRow(
      r.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return null;
        if (['money', 'qty', 'number', 'percent'].includes(c.type)) return Number(v);
        if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T00:00:00Z`);
        if (c.type === 'datetime') return v instanceof Date ? v : new Date(String(v));
        return String(v);
      }),
    );
  }
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals![c.key] === undefined || r.totals![c.key] === null ? null : Number(r.totals![c.key]))));
    t.font = { bold: true };
  }
  r.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    column.width = Math.min(48, Math.max(10, c.label.length + 2, ...r.rows.slice(0, 200).map((row) => fmt(row[c.key], c.type).length + 2)));
    if (c.type === 'money') column.numFmt = '#,##0.00';
    if (c.type === 'qty') column.numFmt = '#,##0.####';
    if (c.type === 'percent') column.numFmt = '0.00"%"';
    if (c.type === 'date') column.numFmt = 'yyyy-mm-dd';
    if (c.type === 'datetime') column.numFmt = 'yyyy-mm-dd hh:mm';
  });
  ws.views = [{ state: 'frozen', ySplit: first - 1 }];
  if (r.notes?.length) {
    ws.addRow([]);
    for (const n of r.notes) ws.addRow([n]).font = { italic: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Printable HTML (rendered to PDF by Chromium). */
export function reportHtml(r: RenderedReport): string {
  const num = (t: ReportColumn['type']) => ['money', 'qty', 'number', 'percent'].includes(t);
  const cells = (row: Record<string, unknown>, tag = 'td') => r.columns.map((c) => `<${tag} class="${num(c.type) ? 'n' : ''}">${esc(fmt(row[c.key], c.type))}</${tag}>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 9.5pt/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d2733; }
    h1 { font-size: 14pt; margin: 2px 0 4px; } .facility { font-weight: 600; color: #4a5a6a; }
    .meta { color: #556; margin-bottom: 8px; } .meta div { margin: 1px 0; }
    table { border-collapse: collapse; width: 100%; } thead { display: table-header-group; }
    th { background: #e8eef4; text-align: left; font-weight: 600; } th, td { border-bottom: 1px solid #dde3ea; padding: 3px 5px; vertical-align: top; }
    td.n, th.n { text-align: right; white-space: nowrap; } tr.total td { font-weight: 700; border-top: 2px solid #9aa8b6; }
    tr { page-break-inside: avoid; } .notes { margin-top: 8px; color: #556; font-style: italic; } .empty { padding: 12px; color: #667; }
  </style></head><body>
    <div class="facility">${esc(r.facility)}</div><h1>${esc(r.title)}</h1>
    <div class="meta">${r.criteria.map((c) => `<div>${esc(c)}</div>`).join('')}<div>Generated ${esc(r.generatedAt)}${r.generatedBy ? ` by ${esc(r.generatedBy)}` : ''} · ${r.rows.length} row(s)</div></div>
    <table><thead><tr>${r.columns.map((c) => `<th class="${num(c.type) ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
    ${r.rows.map((row) => `<tr>${cells(row)}</tr>`).join('')}
    ${r.totals ? `<tr class="total">${cells({ ...r.totals, [r.columns[0].key]: 'Total' })}</tr>` : ''}
    </tbody></table>${r.rows.length ? '' : '<div class="empty">No rows for these filters.</div>'}
    ${r.notes?.length ? `<div class="notes">${r.notes.map(esc).join('<br>')}</div>` : ''}
  </body></html>`;
}

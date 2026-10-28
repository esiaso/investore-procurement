import { LETTERHEAD_LOGO_SMALL } from '../../common/html';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: number) => Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const human = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

interface PdfRequisition {
  number: string;
  status: string;
  priority: string;
  requiredBy: string | null;
  justification: string;
  estimatedTotal: number;
  createdAt: Date;
  requestedByName: string | null;
  department?: { name: string; costCentreCode?: string | null } | null;
  project?: { code: string; name: string } | null;
  store?: { name: string } | null;
  lines?: { lineNo: number; lineType: string; description: string; quantity: number; uom?: { code: string } | null; estimatedUnitCost: number; glAccount?: { code: string; name: string } | null; status: string }[];
}

/** Printable staff requisition with its approval signatures. */
export function renderStaffRequisitionHtml(r: PdfRequisition, approvals: { step: string; name: string; at: Date }[], facility: string, currency: string): string {
  const rows = (r.lines ?? [])
    .map(
      (l) => `<tr><td>${l.lineNo}</td><td>${esc(l.description)}<div class="sub">${esc(human(l.lineType))}${l.glAccount ? ` · GL ${esc(l.glAccount.code)} ${esc(l.glAccount.name)}` : ''}</div></td>
        <td class="n">${Number(l.quantity).toLocaleString('en-KE', { maximumFractionDigits: 4 })} ${esc(l.uom?.code ?? '')}</td><td class="n">${money(l.estimatedUnitCost)}</td>
        <td class="n">${money(l.quantity * l.estimatedUnitCost)}</td><td>${esc(human(l.status))}</td></tr>`,
    )
    .join('');
  const signatures = [
    { step: 'Requested by', name: r.requestedByName ?? '', at: r.createdAt },
    ...approvals,
  ]
    .map((a) => `<div class="sig"><div class="line">${esc(a.name)}</div><div>${esc(a.step)}</div><div class="sub">${esc(new Date(a.at).toISOString().slice(0, 16).replace('T', ' '))}</div></div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 10pt/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d2733; }
    h1 { font-size: 15pt; margin: 0 0 4px; } .facility { font-weight: 600; color: #4a5a6a; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; } th { background: #e8eef4; text-align: left; }
    th, td { border-bottom: 1px solid #dde3ea; padding: 4px 6px; vertical-align: top; } .n { text-align: right; white-space: nowrap; }
    .sub { color: #667; font-size: 8.5pt; } tfoot td { font-weight: 700; border-top: 2px solid #9aa8b6; }
    .sigs { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 28px; } .sig { width: 180px; } .sig .line { border-bottom: 1px solid #333; height: 22px; font-weight: 600; }
  </style></head><body>
    ${LETTERHEAD_LOGO_SMALL}<div class="facility">${esc(facility)}</div>
    <h1>Requisition ${esc(r.number)}</h1>
    <div class="meta">
      <div>Department: <b>${esc(r.department?.name)}</b>${r.department?.costCentreCode ? ` (cost centre ${esc(r.department.costCentreCode)})` : ''}</div>
      <div>Status: <b>${esc(human(r.status))}</b></div>
      <div>Requested by: ${esc(r.requestedByName)}</div>
      <div>Priority: ${esc(human(r.priority))}${r.requiredBy ? ` · required by ${esc(r.requiredBy)}` : ''}</div>
      ${r.project ? `<div>Project: ${esc(r.project.code)} ${esc(r.project.name)}</div>` : ''}
      ${r.store ? `<div>Stock items from: ${esc(r.store.name)}</div>` : ''}
    </div>
    <div><b>Justification:</b> ${esc(r.justification)}</div>
    <table><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Est. unit cost</th><th class="n">Est. total (${esc(currency)})</th><th>Line status</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td></td><td>Total</td><td></td><td></td><td class="n">${money(r.estimatedTotal)}</td><td></td></tr></tfoot></table>
    <div class="sigs">${signatures}</div>
  </body></html>`;
}

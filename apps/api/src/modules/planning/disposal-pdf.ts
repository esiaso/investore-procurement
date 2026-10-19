import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import type { StockAdjustment } from '../inventory/documents.entities';

/** Certificate of disposal for a posted write-off, with signature blocks for the disposal witnesses. */
export function renderDisposalCertificateHtml(
  adj: StockAdjustment,
  facility: { name: string; address: string | null; phone: string | null; email: string | null } | undefined,
  ctx: { reason: string; submittedBy: string | null; approvedBy: string[]; currency: string; dateFormat: string; timezone: string },
): string {
  const d = (x: string | Date | null | undefined) => fmtDate(x, ctx.dateFormat, ctx.timezone);
  const lines = adj.lines ?? [];
  const total = lines.reduce((s, l) => s + Math.abs(l.quantity) * l.unitCost, 0);
  const rows = lines
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(l.item?.code)}</td>
        <td>${esc(l.item?.name)}</td>
        <td>${esc(l.batch?.batchNo)}</td>
        <td>${d(l.batch?.expiryDate)}</td>
        <td class="r">${Math.abs(l.quantity)}</td>
        <td class="r">${money(l.unitCost, ctx.currency)}</td>
        <td class="r">${money(Math.abs(l.quantity) * l.unitCost, ctx.currency)}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
    ${letterhead(facility)}
    <h1 style="margin-top:12px">CERTIFICATE OF DISPOSAL</h1>
    <div class="grid">
      <div class="box">Write-off: <b>${esc(adj.number)}</b><br>Store: ${esc(adj.store?.name)}<br>Date: ${d(adj.adjustmentDate)}</div>
      <div class="box">Reason: <b>${esc(ctx.reason)}</b><br>Raised by: ${esc(ctx.submittedBy)}<br>Approved by: ${esc(ctx.approvedBy.join(', ') || '—')}</div>
    </div>
    <p>We certify that the items below were removed from stock and disposed of as stated.</p>
    <table><thead><tr><th>#</th><th>Code</th><th>Description</th><th>Batch</th><th>Expiry</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <table class="totals"><tr><td><b>Total value written off</b></td><td class="r"><b>${money(total, ctx.currency)}</b></td></tr></table>
    ${adj.notes ? `<p><b>Notes:</b> ${esc(adj.notes)}</p>` : ''}
    <p style="margin-top:18px">Method of disposal: ______________________________________________ &nbsp; Place: ______________________</p>
    <div class="signs">
      <div class="sign">Pharmacist / Storekeeper<br>Name, signature &amp; date</div>
      <div class="sign">Witness (Finance / Audit)<br>Name, signature &amp; date</div>
      <div class="sign">Disposal agent / contractor<br>Name, signature &amp; date</div>
    </div>
    <div class="foot">Dispose of pharmaceutical waste only through a licensed handler, following the PPB and NEMA guidelines; attach the handler's waste-transfer note to this certificate.</div>
  </body></html>`;
}

import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import type { IssueVoucher, IssueVoucherLine, StoreRequisition } from './stores.entities';

type VoucherView = Omit<IssueVoucher, 'lines'> & {
  issuedByName: string | null;
  witnessName: string | null;
  lines: (IssueVoucherLine & { binCode: string | null })[];
};

/** Printable issue voucher (A4) with signature blocks for issuer, witness and receiver. */
export function renderIssueVoucherHtml(
  v: VoucherView,
  facility: { name: string; address: string | null; phone: string | null; email: string | null } | undefined,
  ctx: { requestedBy: string | null; currency: string; dateFormat: string; timezone: string },
): string {
  const d = (x: string | Date | null | undefined) => fmtDate(x, ctx.dateFormat, ctx.timezone);
  const sr = v.requisition as StoreRequisition | undefined;
  const rows = v.lines
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(l.item?.code)}</td>
        <td>${esc(l.item?.name)}${l.patientRef ? `<br><span class="muted">Patient: ${esc(l.patientRef)}</span>` : ''}</td>
        <td>${esc(l.batch?.batchNo)}</td>
        <td>${d(l.batch?.expiryDate)}</td>
        <td>${esc(l.binCode)}</td>
        <td class="r">${l.quantity}</td>
        <td>${esc(l.item?.baseUom?.code)}</td>
        <td class="r">${money(l.value, ctx.currency)}</td>
        <td>${l.scanConfirmed ? '✓' : ''}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
    ${letterhead(facility)}
    <h1 style="margin-top:12px">ISSUE VOUCHER ${esc(v.number)}</h1>
    <div class="grid">
      <div class="box"><b>Issued from</b><br>${esc(v.store?.name)}<br>Date: <b>${d(v.issueDate)}</b></div>
      <div class="box"><b>Issued to</b><br>${esc(v.department?.name)}<br>Cost centre ${esc(v.department?.costCentreCode)}</div>
      <div class="box">Requisition: <b>${esc(sr?.number)}</b><br>Priority: ${esc(sr?.priority)}<br>Requested by: ${esc(ctx.requestedBy)}</div>
    </div>
    <table><thead><tr><th>#</th><th>Code</th><th>Description</th><th>Batch</th><th>Expiry</th><th>Bin</th><th class="r">Qty</th><th>Unit</th><th class="r">Value</th><th>Scan</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <table class="totals"><tr><td><b>Total value</b></td><td class="r"><b>${money(v.totalValue, ctx.currency)}</b></td></tr></table>
    ${v.fefoOverrideReason ? `<p><b>FEFO override:</b> ${esc(v.fefoOverrideReason)}</p>` : ''}
    ${v.notes ? `<p><b>Notes:</b> ${esc(v.notes)}</p>` : ''}
    <div class="signs">
      <div class="sign">Issued by<br><b>${esc(v.issuedByName)}</b></div>
      ${v.witnessId ? `<div class="sign">Witness (controlled drugs)<br><b>${esc(v.witnessName)}</b></div>` : ''}
      <div class="sign">Collected by<br><b>${esc(v.collectedBy)}</b></div>
      <div class="sign">Received by (department) — signature &amp; date<br>&nbsp;</div>
    </div>
    <div class="foot">Values are at store cost and are charged to the receiving department's cost centre. Check batch numbers and expiry dates on receipt.</div>
  </body></html>`;
}

import { esc, fmtDate, money, LETTERHEAD_LOGO } from '../../common/html';
import type { PurchaseOrder } from './purchasing.entities';

/**
 * Printable purchase order (A4): a PO for stock, an LPO (local purchase order)
 * or LSO (local service order, every line a service) for non-stock buying, with
 * withholding tax, currency, validity and terms. The logo box is a placeholder
 * until a logo is uploaded.
 */
export function renderPurchaseOrderHtml(
  po: PurchaseOrder,
  facility: { name: string; address: string | null; phone: string | null; email: string | null; kra_pin: string | null } | undefined,
  stamps: { step: string; name: string; at: Date; onBehalfOf: string | null }[],
  kind: { short: string; long: string },
  locale: { dateFormat: string; timezone: string },
): string {
  const d = (v: string | Date | null | undefined) => fmtDate(v, locale.dateFormat, locale.timezone);
  const rows = (po.lines ?? [])
    .map(
      (l) => `<tr>
        <td>${l.lineNo}</td>
        <td>${esc(l.item?.code ?? '')}</td>
        <td>${esc(l.item?.name ?? l.description)}${l.whtRatePercent ? ` <span class="muted">(WHT ${l.whtRatePercent}%)</span>` : ''}</td>
        <td class="r">${l.quantity}</td>
        <td>${esc(l.uom?.code)}${l.conversionFactor !== 1 ? ` <span class="muted">(${l.conversionFactor})</span>` : ''}</td>
        <td class="r">${money(l.unitPrice, po.currency)}</td>
        <td class="r">${l.taxRatePercent}%</td>
        <td class="r">${money(l.lineTotal, po.currency)}</td>
      </tr>`,
    )
    .join('');
  const stampHtml = stamps.length
    ? stamps
        .map(
          (s) => `<div class="stamp"><div class="stamp-title">APPROVED</div><div>${esc(s.step)}</div><div><b>${esc(s.name)}</b></div>
            ${s.onBehalfOf ? `<div class="muted">for ${esc(s.onBehalfOf)}</div>` : ''}<div>${d(s.at)}</div></div>`,
        )
        .join('')
    : '<div class="muted">Not yet approved</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #222; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0b6e6e; padding-bottom: 8px; }
    .logo { width: 110px; height: 60px; border: 1px dashed #999; display: flex; align-items: center; justify-content: center; color: #999; }
    h1 { font-size: 18px; margin: 0; color: #0b6e6e; }
    .grid { display: flex; gap: 24px; margin: 12px 0; }
    .box { flex: 1; border: 1px solid #ddd; padding: 8px; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #e3e3e3; padding: 4px 6px; text-align: left; }
    th { background: #f2f6f6; }
    .r { text-align: right; }
    .muted { color: #777; }
    .totals { width: 280px; margin-left: auto; margin-top: 8px; }
    .totals td { border: none; }
    .stamps { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
    .stamp { border: 2px solid #2e7d32; color: #2e7d32; border-radius: 6px; padding: 6px 10px; transform: rotate(-3deg); min-width: 140px; }
    .stamp-title { font-weight: bold; letter-spacing: 2px; }
    .foot { margin-top: 24px; font-size: 10px; color: #666; }
  </style></head><body>
    <div class="head">
      ${LETTERHEAD_LOGO}
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:bold">${esc(facility?.name)}</div>
        <div>${esc(facility?.address)}</div>
        <div>${esc(facility?.phone)} · ${esc(facility?.email)}</div>
        <div>KRA PIN ${esc(facility?.kra_pin)}</div>
      </div>
    </div>
    <h1 style="margin-top:12px">${esc(kind.long.toUpperCase())} ${esc(po.number)}${po.version > 1 ? ` <span class="muted">(version ${po.version})</span>` : ''}</h1>
    <div class="grid">
      <div class="box"><b>Supplier</b><br>${esc(po.supplier?.name)}<br>KRA PIN ${esc(po.supplier?.kraPin)}<br>${esc(po.supplier?.address)}<br>${esc(po.supplier?.email)}</div>
      <div class="box"><b>Deliver to</b><br>${esc(po.deliveryAddress ?? po.store?.name)}<br>Department: ${esc(po.department?.name)}</div>
      <div class="box">Order date: <b>${d(po.orderDate)}</b><br>Expected delivery: <b>${d(po.expectedDelivery)}</b><br>${po.expiresOn ? `Valid until: <b>${d(po.expiresOn)}</b><br>` : ''}Payment terms: ${po.paymentTermsDays ?? '-'} days<br>Currency: ${esc(po.currency)}${po.exchangeRate && po.exchangeRate !== 1 ? ` (rate ${po.exchangeRate})` : ''}<br>Status: ${esc(po.status)}</div>
    </div>
    <table><thead><tr><th>#</th><th>Code</th><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">VAT</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <table class="totals">
      <tr><td>Subtotal</td><td class="r">${money(po.subtotal, po.currency)}</td></tr>
      <tr><td>VAT</td><td class="r">${money(po.taxTotal, po.currency)}</td></tr>
      <tr><td><b>Total</b></td><td class="r"><b>${money(po.total, po.currency)}</b></td></tr>
      ${po.whtTotal ? `<tr><td>Less withholding tax (at payment)</td><td class="r">(${money(po.whtTotal, po.currency)})</td></tr><tr><td>Net payable</td><td class="r">${money(po.total - po.whtTotal, po.currency)}</td></tr>` : ''}
    </table>
    ${po.notes ? `<p><b>Notes:</b> ${esc(po.notes)}</p>` : ''}
    ${po.terms ? `<p><b>Terms and conditions</b><br>${esc(po.terms).replace(/\n/g, '<br>')}</p>` : ''}
    <div class="stamps">${stampHtml}</div>
    <div class="foot">Please quote the ${esc(kind.short)} number on your delivery note and invoice. ${kind.short === 'PO' ? 'Goods are subject to inspection on receipt; batch number and expiry date must be shown for all medicines.' : 'Goods and services are accepted by the requesting department before payment.'}</div>
  </body></html>`;
}

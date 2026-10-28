import { esc, LETTERHEAD_LOGO_SMALL } from '../../common/html';
import type { Rfq } from './purchasing.entities';

/** Request for quotation sent to the invited suppliers (A4). */
export function renderRfqHtml(rfq: Rfq, facility: { name: string; address: string | null; phone: string | null; email: string | null; kra_pin: string | null } | undefined): string {
  const rows = (rfq.lines ?? [])
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item?.name ?? l.description)}${l.lineType && l.lineType !== 'STOCK' ? ` <span class="muted">(${esc(l.lineType.replace(/_/g, ' ').toLowerCase())})</span>` : ''}</td>
        <td class="r">${l.quantity}</td><td>${esc(l.uom?.code ?? l.item?.baseUom?.code ?? '')}</td><td class="blank"></td><td class="blank"></td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #222; }
    .head { display: flex; justify-content: space-between; border-bottom: 2px solid #0b6e6e; padding-bottom: 8px; }
    h1 { font-size: 18px; margin: 12px 0 4px; color: #0b6e6e; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; } th, td { border: 1px solid #ccc; padding: 5px 6px; text-align: left; }
    th { background: #f2f6f6; } .r { text-align: right; } .blank { width: 110px; } .muted { color: #777; }
    .box { border: 1px solid #ddd; padding: 8px; border-radius: 4px; margin-top: 10px; }
  </style></head><body>
    <div class="head"><div>${LETTERHEAD_LOGO_SMALL}<b style="font-size:14px">${esc(facility?.name)}</b><br>${esc(facility?.address)}<br>${esc(facility?.phone)} · ${esc(facility?.email)}</div><div style="text-align:right">KRA PIN ${esc(facility?.kra_pin)}</div></div>
    <h1>REQUEST FOR QUOTATION ${esc(rfq.number)}</h1>
    <div>${esc(rfq.title)}</div>
    <div class="box">Quotations close on <b>${esc(rfq.closingDate)}</b>. Quote unit prices excluding VAT, the delivery time, payment terms and how long the prices are valid. Attach your KRA PIN certificate and any technical literature.</div>
    <table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th>Unit</th><th>Unit price (excl. VAT)</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="box">Delivery time: ______ days &nbsp;&nbsp; Payment terms: ______ days &nbsp;&nbsp; Valid until: __________<br><br>Supplier: ______________________ Signature and stamp: ______________________</div>
  </body></html>`;
}

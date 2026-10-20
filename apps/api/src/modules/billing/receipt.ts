import { esc, fmtDate } from '../../common/html';
import { groupsOf4 } from '../etims/etims-spec';
import type { SalesInvoice, SalesInvoiceLine, SalesPayment } from './billing.entities';

export interface ReceiptView {
  invoice: SalesInvoice & { lines: SalesInvoiceLine[]; payments: SalesPayment[] };
  seller: { name: string; address: string | null; phone: string | null; kraPin: string | null; outlet: string };
  cuId: string | null;
  qrDataUrl: string | null;
  paymentNames: Record<string, string>;
  currency: string;
  dateFormat: string;
  timezone: string;
  /** e.g. COPY for reprints of accepted receipts. */
  label?: string | null;
}

const money = (n: number) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const TAX_LABEL: Record<string, string> = { A: 'A-Exempt', B: 'B-16%', C: 'C-0%', D: 'D-Non-VAT', E: 'E-8%' };

/**
 * Tax invoice / credit note / receipt following the TIS receipt layout
 * (TIS spec v2.0 "Normal Invoice"): seller and buyer PIN, items with tax
 * designation, totals, tax breakdown A–E, then the "SCU information" block
 * (CU date/time, CU ID, CU invoice number, receipt counter, internal data and
 * signature in groups of 4, QR). Until eTIMS accepts the document it prints as
 * "eTIMS PENDING — THIS IS NOT AN OFFICIAL RECEIPT".
 */
export function renderReceiptHtml(v: ReceiptView, layout: 'THERMAL' | 'A4'): string {
  const inv = v.invoice;
  const accepted = inv.etimsStatus === 'ACCEPTED';
  const notRequired = inv.etimsStatus === 'NOT_REQUIRED';
  const credit = inv.docType === 'CREDIT_NOTE';
  const title = credit ? 'CREDIT NOTE' : 'TAX INVOICE';
  const d = (x: string | Date | null | undefined) => fmtDate(x, v.dateFormat, v.timezone);
  const time = (x: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: v.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(x);
  const cuDt = inv.sdcDateTime ? `${inv.sdcDateTime.slice(6, 8)}/${inv.sdcDateTime.slice(4, 6)}/${inv.sdcDateTime.slice(0, 4)} ${inv.sdcDateTime.slice(8, 10)}:${inv.sdcDateTime.slice(10, 12)}:${inv.sdcDateTime.slice(12, 14)}` : '';
  const beforeDiscount = inv.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const exempt = inv.lines.filter((l) => l.taxTypeCode === 'A').reduce((s, l) => s + l.grossAmount, 0);
  const wide = layout === 'A4';
  const css = `
    body { font-family: ${wide ? 'Arial, Helvetica, sans-serif' : '"Courier New", monospace'}; font-size: ${wide ? 11 : 10}px; color: #000; margin: 0; }
    .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 1px 2px; vertical-align: top; }
    th { text-align: left; border-bottom: 1px solid #000; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    .big { font-size: ${wide ? 18 : 13}px; font-weight: bold; }
    .warn { border: 2px solid #000; padding: 4px; margin: 6px 0; text-align: center; font-weight: bold; font-size: ${wide ? 18 : 13}px; }
    .wm { position: fixed; top: 35%; left: 0; right: 0; text-align: center; font-size: ${wide ? 64 : 30}px; color: rgba(0,0,0,0.08); transform: rotate(-20deg); font-weight: bold; }
    .qr { width: ${wide ? 120 : 110}px; height: ${wide ? 120 : 110}px; }
    ${wide ? '.page { max-width: 180mm; margin: 0 auto; }' : '.page { width: 74mm; }'}`;
  const rows = inv.lines
    .map(
      (l) => `<tr><td colspan="${wide ? 1 : 3}">${esc(l.description)}</td>${wide ? `<td class="r">${l.quantity}</td><td class="r">${money(l.unitPrice)}</td><td class="r">${l.discountAmount ? `-${money(l.discountAmount)}` : ''}</td><td class="r">${money(l.grossAmount)} ${esc(l.taxTypeCode)}</td>` : ''}</tr>
      ${wide ? '' : `<tr><td>${l.quantity} x ${money(l.unitPrice)}</td><td class="r">${l.discountAmount ? `-${money(l.discountAmount)}` : ''}</td><td class="r">${money(l.grossAmount)} ${esc(l.taxTypeCode)}</td></tr>`}`,
    )
    .join('');
  const tax = ['A', 'B', 'C', 'D', 'E']
    .map((t) => ({ t, ...(inv.taxSummary[t] ?? { taxable: 0, tax: 0, rate: 0 }) }))
    .filter((x) => x.taxable)
    .map((x) => `<tr><td>${TAX_LABEL[x.t]}</td><td class="r">${money(x.taxable)}</td><td class="r">${money(x.tax)}</td></tr>`)
    .join('');
  const payments = inv.payments.map((p) => `<tr><td>${esc(v.paymentNames[p.modeCode] ?? p.modeCode)}${p.reference ? ` (${esc(p.reference)})` : ''}</td><td class="r">${money(p.amount)}</td></tr>`).join('');
  const marker = v.label ?? (!accepted && !notRequired ? 'eTIMS PENDING' : null);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="page">
    ${marker ? `<div class="wm">${esc(marker)}</div>` : ''}
    <div class="c b big">${esc(v.seller.name)}</div>
    <div class="c">${esc(v.seller.outlet)}${v.seller.address ? `<br>${esc(v.seller.address)}` : ''}${v.seller.phone ? `<br>Tel ${esc(v.seller.phone)}` : ''}</div>
    <div class="c">PIN: ${esc(v.seller.kraPin ?? '')}</div>
    <hr><div class="c b">${title}</div>
    ${marker ? `<div class="c b">${esc(marker)}</div>` : ''}
    <div>${credit ? `Credit note ${esc(inv.number)} for invoice ${esc(inv.originalInvoice?.number ?? '')}` : `Invoice ${esc(inv.number)}`}</div>
    ${inv.customerName ? `<div>Customer: ${esc(inv.customerName)}</div>` : ''}
    ${inv.customerPin ? `<div>Buyer PIN: ${esc(inv.customerPin)}</div>` : ''}
    ${inv.payer ? `<div>Payer: ${esc(inv.payer.name)}</div>` : ''}
    <hr>
    <table>${wide ? '<tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Disc.</th><th class="r">Amount</th></tr>' : ''}${rows}</table>
    <hr>
    <table>
      <tr><td>Total before discount</td><td class="r">${money(beforeDiscount)}</td></tr>
      ${inv.discountAmount ? `<tr><td>Discount</td><td class="r">-${money(inv.discountAmount)}</td></tr>` : ''}
      <tr><td>Total exempted (A)</td><td class="r">${money(exempt)}</td></tr>
      <tr><td>Total excl. tax</td><td class="r">${money(inv.totalNet)}</td></tr>
      <tr><td>Total tax</td><td class="r">${money(inv.totalTax)}</td></tr>
      <tr><td class="b big">TOTAL ${esc(v.currency)}</td><td class="r b big">${money(inv.totalAmount)}</td></tr>
      ${inv.payerAmount ? `<tr><td>Payer share</td><td class="r">${money(inv.payerAmount)}</td></tr><tr><td>Patient share</td><td class="r">${money(inv.patientAmount)}</td></tr>` : ''}
    </table>
    <hr><table>${payments}</table>
    <div>Items: ${inv.lines.length}</div>
    <hr><table><tr><th>Tax</th><th class="r">Taxable</th><th class="r">Tax</th></tr>${tax}</table>
    <hr>
    ${
      accepted
        ? `<div class="b">SCU INFORMATION</div>
           <div>Date: ${cuDt}</div>
           <div>CU ID: ${esc(v.cuId ?? inv.cuId ?? '')}</div>
           <div>CU Invoice No: ${esc(inv.cuInvoiceNo ?? '')}</div>
           <div>Receipt No: ${inv.rcptNo ?? ''}/${inv.totRcptNo ?? ''} ${credit ? 'CR' : 'NS'}</div>
           <div>Internal Data:<br>${esc(groupsOf4(inv.intrlData))}</div>
           <div>Receipt Signature:<br>${esc(groupsOf4(inv.rcptSign))}</div>
           ${v.qrDataUrl ? `<div class="c"><img class="qr" src="${v.qrDataUrl}" alt="eTIMS QR"></div>` : ''}`
        : notRequired
          ? '<div>This outlet does not issue eTIMS invoices.</div>'
          : `<div class="warn">eTIMS PENDING<br>THIS IS NOT AN OFFICIAL RECEIPT</div><div>The signed receipt can be reprinted once KRA eTIMS accepts the invoice.</div>`
    }
    <hr>
    <div>TIS receipt: ${esc(inv.number)}</div>
    <div>Date: ${d(inv.issuedAt)} ${time(inv.issuedAt)}</div>
    ${v.label && accepted ? `<div class="warn">${esc(v.label)}<br>THIS IS NOT AN OFFICIAL RECEIPT</div>` : ''}
    <div class="c">Thank you</div>
  </div></body></html>`;
}

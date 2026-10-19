/** Helpers for the printable (HTML → PDF) documents. */

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtDate(value: string | Date | null | undefined, pattern: string, timeZone: string): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value) : value;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return pattern.replace('YYYY', p.year).replace('MM', p.month).replace('DD', p.day);
}

export const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);

/** Shared A4 styles: letterhead, boxes, tables, signature blocks. */
export const DOC_STYLES = `
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
  .signs { display: flex; gap: 18px; margin-top: 28px; }
  .sign { flex: 1; border-top: 1px solid #444; padding-top: 4px; }
  .foot { margin-top: 24px; font-size: 10px; color: #666; }
`;

export function letterhead(facility: { name: string; address: string | null; phone: string | null; email: string | null; kra_pin?: string | null } | undefined) {
  return `<div class="head">
      <div class="logo">LOGO</div>
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:bold">${esc(facility?.name)}</div>
        <div>${esc(facility?.address)}</div>
        <div>${esc(facility?.phone)} · ${esc(facility?.email)}</div>
        ${facility?.kra_pin ? `<div>KRA PIN ${esc(facility.kra_pin)}</div>` : ''}
      </div>
    </div>`;
}

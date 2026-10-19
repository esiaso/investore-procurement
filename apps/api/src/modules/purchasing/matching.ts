export interface MatchLineInput {
  poLineId: string;
  label: string;
  /** All quantities in the PO line's ordering unit. */
  orderedQty: number;
  receivedQty: number;
  /** On other invoices of this PO that are not rejected/cancelled. */
  previouslyInvoicedQty: number;
  invoicedQty: number;
  poUnitPrice: number;
  invoiceUnitPrice: number;
}

export interface MatchTolerances {
  /** % over received quantity accepted. */
  quantityPct: number;
  /** % price difference accepted (either way). */
  pricePct: number;
}

export interface Variance {
  poLineId: string;
  code: 'NOT_RECEIVED' | 'QTY_EXCEEDS_RECEIVED' | 'QTY_EXCEEDS_ORDERED' | 'PRICE_VARIANCE';
  message: string;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Three-way match: purchase order vs goods received vs invoice, per line. */
export function threeWayMatch(lines: MatchLineInput[], tol: MatchTolerances): Variance[] {
  const out: Variance[] = [];
  for (const l of lines) {
    const totalInvoiced = r4(l.previouslyInvoicedQty + l.invoicedQty);
    if (l.receivedQty <= 0) {
      out.push({ poLineId: l.poLineId, code: 'NOT_RECEIVED', message: `${l.label}: invoiced but nothing received yet` });
    } else if (totalInvoiced > r4(l.receivedQty * (1 + tol.quantityPct / 100))) {
      out.push({
        poLineId: l.poLineId,
        code: 'QTY_EXCEEDS_RECEIVED',
        message: `${l.label}: invoiced ${totalInvoiced} (incl. earlier invoices) but received ${l.receivedQty}`,
      });
    }
    if (totalInvoiced > r4(l.orderedQty * (1 + tol.quantityPct / 100))) {
      out.push({ poLineId: l.poLineId, code: 'QTY_EXCEEDS_ORDERED', message: `${l.label}: invoiced ${totalInvoiced} but ordered ${l.orderedQty}` });
    }
    if (l.poUnitPrice > 0) {
      const diffPct = ((l.invoiceUnitPrice - l.poUnitPrice) / l.poUnitPrice) * 100;
      if (Math.abs(diffPct) > tol.pricePct + 1e-9) {
        out.push({
          poLineId: l.poLineId,
          code: 'PRICE_VARIANCE',
          message: `${l.label}: invoice price ${l.invoiceUnitPrice} vs PO ${l.poUnitPrice} (${diffPct > 0 ? '+' : ''}${diffPct.toFixed(2)}%)`,
        });
      }
    } else if (l.invoiceUnitPrice > 0) {
      out.push({ poLineId: l.poLineId, code: 'PRICE_VARIANCE', message: `${l.label}: PO price is zero but invoice charges ${l.invoiceUnitPrice}` });
    }
  }
  return out;
}

/**
 * Sales tax arithmetic. Selling prices are VAT inclusive, as eTIMS expects
 * (taxblAmt is the VAT-inclusive amount and taxAmt = taxblAmt × rate / (100 + rate)).
 * All amounts are rounded to 2 decimals per line; document totals are sums of lines.
 */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineInput {
  quantity: number;
  /** VAT inclusive per unit. */
  unitPrice: number;
  discountPercent?: number;
  taxRatePercent: number;
  taxTypeCode: string;
}

export interface LineAmounts {
  grossBeforeDiscount: number;
  discountAmount: number;
  /** VAT inclusive after discount. */
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
}

export function computeLine(l: LineInput): LineAmounts {
  if (l.quantity < 0 || l.unitPrice < 0) throw new Error('Quantity and price cannot be negative');
  const grossBeforeDiscount = round2(l.quantity * l.unitPrice);
  const discountAmount = round2((grossBeforeDiscount * (l.discountPercent ?? 0)) / 100);
  const grossAmount = round2(grossBeforeDiscount - discountAmount);
  const taxAmount = l.taxRatePercent > 0 ? round2((grossAmount * l.taxRatePercent) / (100 + l.taxRatePercent)) : 0;
  return { grossBeforeDiscount, discountAmount, grossAmount, taxAmount, netAmount: round2(grossAmount - taxAmount) };
}

export interface TaxBucket {
  taxable: number;
  tax: number;
  rate: number;
}

/** eTIMS tax types are A–E; every bucket is present (zeros where unused). */
export const TAX_TYPES = ['A', 'B', 'C', 'D', 'E'] as const;

export function summarise(lines: (Omit<LineAmounts, 'grossBeforeDiscount'> & { taxTypeCode: string; taxRatePercent: number })[]) {
  const buckets: Record<string, TaxBucket> = Object.fromEntries(TAX_TYPES.map((t) => [t, { taxable: 0, tax: 0, rate: 0 }]));
  for (const l of lines) {
    const b = (buckets[l.taxTypeCode] ??= { taxable: 0, tax: 0, rate: 0 });
    b.taxable = round2(b.taxable + l.grossAmount);
    b.tax = round2(b.tax + l.taxAmount);
    b.rate = l.taxRatePercent;
  }
  const sum = (k: 'grossAmount' | 'taxAmount' | 'netAmount' | 'discountAmount') => round2(lines.reduce((s, l) => s + l[k], 0));
  return {
    buckets,
    totalAmount: sum('grossAmount'),
    totalTax: sum('taxAmount'),
    totalNet: sum('netAmount'),
    discountAmount: sum('discountAmount'),
  };
}

/**
 * Patient co-pay vs payer: the patient pays `coPayPercent` of each line (rounded),
 * the payer the rest. Without a payer the patient pays everything.
 */
export function splitPayer(gross: number, coPayPercent: number | null): { patientShare: number; payerShare: number } {
  if (coPayPercent === null) return { patientShare: gross, payerShare: 0 };
  const patientShare = round2((gross * coPayPercent) / 100);
  return { patientShare, payerShare: round2(gross - patientShare) };
}

/** Shelf price from the item's VAT-exclusive base price, a price-list adjustment and the VAT rate. */
export function inclusivePrice(baseExclusive: number, adjustPercent: number, taxRatePercent: number): number {
  return round2(baseExclusive * (1 + adjustPercent / 100) * (1 + taxRatePercent / 100));
}

/** Kenya PIN: A/P + 9 digits + letter (e.g. P051234567X). */
export const KRA_PIN = /^[AP]\d{9}[A-Z]$/;

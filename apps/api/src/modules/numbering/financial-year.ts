export interface FinancialYear {
  /** Calendar year in which the financial year starts. */
  startYear: number;
  /** "2026" when the FY is the calendar year, otherwise "2026/27". */
  label: string;
}

/**
 * Financial year containing a calendar date (YYYY-MM-DD).
 * startMonth is 1-12 (1 = January, i.e. FY = calendar year).
 */
export function financialYearOf(date: string, startMonth: number): FinancialYear {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error(`Invalid financial year start month: ${startMonth}`);
  }
  const [year, month] = date.split('-').map(Number);
  const startYear = month >= startMonth ? year : year - 1;
  const label = startMonth === 1 ? String(startYear) : `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
  return { startYear, label };
}

export function formatDocumentNumber(
  format: string,
  parts: { prefix: string; storeCode: string | null; fyLabel: string; date: string; seq: number; padding: number },
): string {
  const [yyyy, mm] = parts.date.split('-');
  return format
    .replace(/\{PREFIX\}/g, parts.prefix)
    .replace(/\{STORE\}/g, parts.storeCode ?? '')
    .replace(/\{FY\}/g, parts.fyLabel)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{SEQ\}/g, String(parts.seq).padStart(parts.padding, '0'))
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-');
}

/** Formats a date/time per a pattern using DD, MM, YYYY, HH, mm tokens, in a timezone. */
export function formatDate(value: string | Date | null | undefined, pattern: string, timeZone: string, withTime = false): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const out = pattern.replace('YYYY', parts.year).replace('MM', parts.month).replace('DD', parts.day);
  return withTime ? `${out} ${parts.hour}:${parts.minute}` : out;
}

export function formatMoney(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value);
}

/** '' → null for optional API fields. */
export function emptyToNull<T extends Record<string, unknown>>(values: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === '' ? null : v;
  return out as T;
}

export const humanise = (s: string) =>
  s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** CSV of plain rows (header = keys of the first row), formula-injection safe. */
export function toCsv(rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  if (!rows.length) return '\r\n';
  const keys = Object.keys(rows[0]);
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n') + '\r\n';
}

/** A segment with values at the given field numbers. */
export const seg = (name: string, fields: Record<number, string>) => {
  const n = Math.max(...Object.keys(fields).map(Number));
  return [name, ...Array.from({ length: n }, (_, i) => fields[i + 1] ?? '')].join('|');
};

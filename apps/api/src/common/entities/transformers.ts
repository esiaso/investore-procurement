import type { ValueTransformer } from 'typeorm';

/**
 * NUMERIC columns come back from pg as strings. Quantities are NUMERIC(18,4)
 * and fit comfortably in a double for the magnitudes a hospital handles.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null || value === undefined ? null : Number(value)),
};

/** Standard column options for quantities held in base units. */
export const QUANTITY = { type: 'numeric', precision: 18, scale: 4, transformer: numericTransformer } as const;
/** Standard column options for money amounts. */
export const MONEY = { type: 'numeric', precision: 18, scale: 4, transformer: numericTransformer } as const;

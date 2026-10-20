import { SourcingMethod } from '@sil/shared';
import type { SourcingMethodRule } from '../settings/setting-keys';

/** Amount is inside the rule's band: [minAmount, maxAmount). */
export const inMethodBand = (r: SourcingMethodRule, amount: number) => amount >= (r.minAmount ?? 0) && (r.maxAmount === null || amount < r.maxAmount);

/** Methods that need something besides an amount band to be chosen. */
const SPECIAL = new Set<string>([SourcingMethod.DIRECT, SourcingMethod.FRAMEWORK, SourcingMethod.RFP]);

/**
 * The recommended method for an estimated value: a framework agreement when one
 * covers the items, otherwise the first active competitive method (in the order
 * configured) whose band contains the amount.
 */
export function recommendMethod(rules: SourcingMethodRule[], amount: number, frameworkAvailable = false): SourcingMethodRule | null {
  if (frameworkAvailable) {
    const fw = rules.find((r) => r.code === SourcingMethod.FRAMEWORK && r.isActive);
    if (fw) return fw;
  }
  return rules.find((r) => r.isActive && !SPECIAL.has(r.code) && !r.requiresJustification && inMethodBand(r, amount)) ?? null;
}

/** Why `code` may not be used for `amount` (null = allowed). */
export function methodProblem(rules: SourcingMethodRule[], code: string, amount: number, justification?: string | null, frameworkAvailable = false): string | null {
  const r = rules.find((x) => x.code === code);
  if (!r || !r.isActive) return `Sourcing method ${code} is not enabled`;
  if (!inMethodBand(r, amount)) {
    const band = `${r.minAmount ?? 0}${r.maxAmount === null ? '+' : `–${r.maxAmount}`}`;
    return `${r.label} is for estimated values of ${band}; this one is ${amount}`;
  }
  if (r.requiresJustification && !justification?.trim()) return `${r.label} needs a written justification`;
  if (code === SourcingMethod.FRAMEWORK && !frameworkAvailable) return 'No active framework agreement covers these items';
  return null;
}

/** Pure stock-planning arithmetic (unit-tested; no database). */

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const DAYS_PER_MONTH = 30;

export interface AmcInput {
  /** Net base units consumed in the window (issues + transfers out − returns in). */
  consumed: number;
  windowDays: number;
  /** Days in the window with no stock on hand. */
  stockoutDays: number;
  excludeStockoutDays: boolean;
  /** Never average over fewer days than this. */
  minDays: number;
}

/** Average monthly consumption: consumption per available day × 30. */
export function computeAmc(i: AmcInput): { amc: number; days: number } {
  const usable = i.excludeStockoutDays ? i.windowDays - Math.min(i.stockoutDays, i.windowDays) : i.windowDays;
  const days = Math.max(usable, Math.min(i.minDays, i.windowDays), 1);
  const consumed = Math.max(0, i.consumed);
  return { amc: round4((consumed / days) * DAYS_PER_MONTH), days };
}

export interface LevelsInput {
  amc: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyStockDays: number;
}

/**
 * AUTO levels: safety = daily use × safety days; reorder level = daily use ×
 * lead time + safety; max = reorder level + daily use × review period;
 * reorder qty = max − reorder level; min = safety stock. Rounded up to whole units.
 */
export function computeLevels(i: LevelsInput) {
  const daily = i.amc / DAYS_PER_MONTH;
  const up = (n: number) => Math.ceil(round4(n));
  const safetyStock = up(daily * i.safetyStockDays);
  const reorderLevel = up(daily * i.leadTimeDays + safetyStock);
  const maxLevel = up(reorderLevel + daily * i.reviewPeriodDays);
  return { safetyStock, minLevel: safetyStock, reorderLevel, maxLevel, reorderQty: maxLevel - reorderLevel };
}

export interface ReorderInput {
  available: number;
  onOrder: number;
  inTransit: number;
  includeOnOrder: boolean;
  reorderLevel: number;
  maxLevel: number;
  reorderQty: number;
  amc: number;
}

/**
 * Reorder status of an item in a store. Position = available (+ on order + in
 * transit). Below when position ≤ reorder level (and a level is set).
 * Suggested quantity tops up to max (or the reorder quantity when no max).
 */
export function reorderStatus(i: ReorderInput) {
  const position = round4(i.available + (i.includeOnOrder ? i.onOrder + i.inTransit : 0));
  const below = i.reorderLevel > 0 && position <= i.reorderLevel;
  const target = i.maxLevel > 0 ? i.maxLevel : position + i.reorderQty;
  const suggestedQty = below ? Math.max(0, Math.ceil(round4(target - position))) : 0;
  const daily = i.amc / DAYS_PER_MONTH;
  const daysOfStock = daily > 0 ? Math.floor(Math.max(0, i.available) / daily) : null;
  return { position, below, stockOut: i.available <= 0, suggestedQty, daysOfStock };
}

/** Horizons (days) a batch has crossed: every horizon ≥ days left, for unexpired stock. */
export function crossedHorizons(daysLeft: number, horizons: number[]): number[] {
  if (daysLeft <= 0) return [];
  return [...new Set(horizons)].filter((h) => h > 0 && daysLeft <= h).sort((a, b) => a - b);
}

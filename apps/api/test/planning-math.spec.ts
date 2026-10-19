import { computeAmc, computeLevels, crossedHorizons, reorderStatus } from '../src/modules/planning/planning-math';

describe('AMC', () => {
  const base = { windowDays: 90, stockoutDays: 0, excludeStockoutDays: true, minDays: 14 };

  it('is consumption per day × 30 over the window', () => {
    expect(computeAmc({ ...base, consumed: 900 })).toEqual({ amc: 300, days: 90 });
  });

  it('leaves stock-out days out so a stock-out does not understate demand', () => {
    expect(computeAmc({ ...base, consumed: 900, stockoutDays: 45 })).toEqual({ amc: 600, days: 45 });
    expect(computeAmc({ ...base, consumed: 900, stockoutDays: 45, excludeStockoutDays: false })).toEqual({ amc: 300, days: 90 });
  });

  it('never averages over fewer than the minimum days, and ignores net returns', () => {
    expect(computeAmc({ ...base, consumed: 70, stockoutDays: 89 })).toEqual({ amc: 150, days: 14 });
    expect(computeAmc({ ...base, consumed: -20 }).amc).toBe(0);
    expect(computeAmc({ ...base, consumed: 10, windowDays: 7, minDays: 14 }).days).toBe(7);
  });
});

describe('reorder levels', () => {
  it('derives safety stock, reorder level, max and reorder quantity from AMC', () => {
    // 300/month = 10/day: safety 7 days = 70; reorder = 10 × 14 + 70 = 210; max = 210 + 10 × 30 = 510.
    expect(computeLevels({ amc: 300, leadTimeDays: 14, reviewPeriodDays: 30, safetyStockDays: 7 })).toEqual({
      safetyStock: 70,
      minLevel: 70,
      reorderLevel: 210,
      maxLevel: 510,
      reorderQty: 300,
    });
  });

  it('rounds up to whole units and gives zero levels without consumption', () => {
    expect(computeLevels({ amc: 1, leadTimeDays: 14, reviewPeriodDays: 30, safetyStockDays: 7 })).toMatchObject({ safetyStock: 1, reorderLevel: 2, maxLevel: 3 });
    expect(computeLevels({ amc: 0, leadTimeDays: 14, reviewPeriodDays: 30, safetyStockDays: 7 })).toMatchObject({ reorderLevel: 0, maxLevel: 0 });
  });
});

describe('reorder status', () => {
  const levels = { reorderLevel: 210, maxLevel: 510, reorderQty: 300, amc: 300, onOrder: 0, inTransit: 0, includeOnOrder: true };

  it('suggests topping up to max once at or below the reorder level', () => {
    expect(reorderStatus({ ...levels, available: 211 })).toMatchObject({ below: false, suggestedQty: 0 });
    expect(reorderStatus({ ...levels, available: 210 })).toMatchObject({ below: true, suggestedQty: 300, daysOfStock: 21, stockOut: false });
    expect(reorderStatus({ ...levels, available: 0 })).toMatchObject({ below: true, suggestedQty: 510, stockOut: true, daysOfStock: 0 });
  });

  it('counts stock on order and in transit only when configured', () => {
    expect(reorderStatus({ ...levels, available: 100, onOrder: 150 })).toMatchObject({ position: 250, below: false });
    expect(reorderStatus({ ...levels, available: 100, onOrder: 150, includeOnOrder: false })).toMatchObject({ position: 100, below: true, suggestedQty: 410 });
    expect(reorderStatus({ ...levels, available: 100, inTransit: 50 })).toMatchObject({ position: 150, suggestedQty: 360 });
  });

  it('uses the reorder quantity when no max is set, and ignores items without a level', () => {
    expect(reorderStatus({ ...levels, maxLevel: 0, available: 10 })).toMatchObject({ suggestedQty: 300 });
    expect(reorderStatus({ ...levels, reorderLevel: 0, available: 0 })).toMatchObject({ below: false, stockOut: true });
  });
});

describe('expiry horizons', () => {
  it('lists every horizon the batch is inside, smallest first; none once expired', () => {
    expect(crossedHorizons(25, [180, 30, 90, 60])).toEqual([30, 60, 90, 180]);
    expect(crossedHorizons(75, [30, 60, 90, 180])).toEqual([90, 180]);
    expect(crossedHorizons(200, [30, 60, 90, 180])).toEqual([]);
    expect(crossedHorizons(0, [30])).toEqual([]);
  });
});

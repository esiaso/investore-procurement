import {
  AmcForecaster,
  backtest,
  holtLinear,
  HoltWintersForecaster,
  mape,
  monthsOfStock,
  morbidityQty,
  MovingAverageForecaster,
  pickBest,
  suggestedOrderQty,
} from '../src/modules/forecasting/forecast-math';
import { addMonths, monthsBetween } from '../src/modules/forecasting/forecasting.service';
import { addMonthsToDate } from '../src/modules/procurement/agencies.service';
import { evaluateBids, scoringMembers } from '../src/modules/procurement/evaluation';
import { overallScore } from '../src/modules/procurement/performance.service';
import { fyWindow } from '../src/modules/procurement/plans.service';
import { inMethodBand, methodProblem, recommendMethod } from '../src/modules/procurement/sourcing';
import { DEFAULT_SOURCING_METHODS } from '../src/database/seeds/reference-data';

describe('forecasters', () => {
  it('AMC is the flat mean of the last months', () => {
    expect(new AmcForecaster(3).forecast([10, 20, 30, 60], 2)).toEqual([36.6667, 36.6667]);
  });

  it('moving average rolls its own forecasts forward', () => {
    expect(new MovingAverageForecaster(2).forecast([10, 20, 30], 3)).toEqual([25, 27.5, 26.25]);
  });

  it("Holt's linear trend extrapolates a straight line", () => {
    const f = holtLinear([10, 20, 30, 40, 50], 0.8, 0.8, 3);
    expect(f[0]).toBeCloseTo(60, 0);
    expect(f[2]).toBeCloseTo(80, 0);
  });

  it('Holt-Winters reproduces a seasonal pattern (and falls back to Holt with short history)', () => {
    const season = [10, 12, 15, 20, 30, 40, 35, 25, 18, 14, 11, 10];
    const history = [...season, ...season.map((x) => x + 2), ...season.map((x) => x + 4)];
    const hw = new HoltWintersForecaster({ alpha: 0.3, beta: 0.1, gamma: 0.3, seasonLength: 12 });
    const next = hw.forecast(history, 12);
    // Peak in month 6, trough at the ends: the shape survives.
    expect(next.indexOf(Math.max(...next))).toBe(5);
    expect(next[5]).toBeGreaterThan(next[0] * 2.5);
    expect(mape(season.map((x) => x + 6), next)!).toBeLessThan(10);
    expect(hw.forecast([5, 6, 7], 2).length).toBe(2); // < 2 seasons: Holt's linear
  });

  it('never forecasts negative demand', () => {
    expect(holtLinear([50, 30, 10, 0], 0.9, 0.9, 6).every((x) => x >= 0)).toBe(true);
  });

  it('MAPE ignores months without demand; back-test holds out the last months', () => {
    expect(mape([100, 0, 50], [110, 7, 40])).toBe(15);
    expect(mape([0, 0], [1, 2])).toBeNull();
    expect(backtest(new AmcForecaster(3), [10, 10, 10, 10, 10, 10], 3)).toBe(0);
    expect(backtest(new AmcForecaster(3), [10], 3)).toBeNull();
  });

  it('picks the forecaster with the lowest back-tested MAPE', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80];
    const best = pickBest([new AmcForecaster(3), new MovingAverageForecaster(2), new HoltWintersForecaster({ alpha: 0.8, beta: 0.8, gamma: 0.1, seasonLength: 12 })], trend, 3);
    expect(best.forecaster.method).toBe('HOLT_WINTERS');
  });
});

describe('order and quantification maths', () => {
  it('suggested order covers lead time + review period + safety stock, less the pipeline', () => {
    // 30 + 15 days of 60/month = 90; + 20 safety − 50 in the pipeline = 60.
    expect(suggestedOrderQty({ monthly: [60, 60], leadTimeDays: 30, reviewPeriodDays: 15, safetyStock: 20, position: 50 })).toEqual({ demand: 90, qty: 60 });
    expect(suggestedOrderQty({ monthly: [10], leadTimeDays: 30, reviewPeriodDays: 30, safetyStock: 0, position: 500 }).qty).toBe(0);
    // Uses the month-by-month forecast (rising demand).
    expect(suggestedOrderQty({ monthly: [30, 60, 90], leadTimeDays: 60, reviewPeriodDays: 30, safetyStock: 0, position: 0 }).demand).toBe(180);
  });

  it('morbidity method: people × coverage × units per patient-month × months (+ wastage)', () => {
    expect(morbidityQty({ population: 100, coveragePercent: 80, unitsPerPatientMonth: 24, months: 12 })).toBe(23040);
    expect(morbidityQty({ population: 100, coveragePercent: 80, unitsPerPatientMonth: 24, months: 12, wastagePercent: 5 })).toBe(24192);
  });

  it('months of stock', () => {
    expect(monthsOfStock(300, 100)).toBe(3);
    expect(monthsOfStock(100, 0)).toBeNull();
  });

  it('month arithmetic', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(fyWindow('2026/27', 7)).toEqual({ from: '2026-07-01', to: '2027-07-01' });
    expect(fyWindow('2026', 1)).toEqual({ from: '2026-01-01', to: '2027-01-01' });
  });
});

describe('sourcing methods', () => {
  const rules = DEFAULT_SOURCING_METHODS;

  it('recommends the competitive method for the value band; a framework when one covers the items', () => {
    expect(recommendMethod(rules, 10_000)?.code).toBe('LOW_VALUE');
    expect(recommendMethod(rules, 50_000)?.code).toBe('RFQ');
    expect(recommendMethod(rules, 2_000_000)?.code).toBe('OPEN_TENDER');
    expect(recommendMethod(rules, 2_000_000, true)?.code).toBe('FRAMEWORK');
    expect(inMethodBand(rules[1], 999_999.99)).toBe(true);
    expect(inMethodBand(rules[1], 1_000_000)).toBe(false);
  });

  it('refuses a method outside its band, without justification, or a framework that does not exist', () => {
    expect(methodProblem(rules, 'LOW_VALUE', 60_000)).toMatch(/Low-value procurement is for/);
    expect(methodProblem(rules, 'DIRECT', 10_000)).toMatch(/justification/);
    expect(methodProblem(rules, 'DIRECT', 10_000, 'Sole distributor of this implant')).toBeNull();
    expect(methodProblem(rules, 'FRAMEWORK', 10_000)).toMatch(/framework/);
    expect(methodProblem(rules, 'NOPE', 1)).toMatch(/not enabled/);
  });
});

describe('tender evaluation', () => {
  const criteria = [
    { id: 'p1', stage: 'PRELIMINARY' as const, weight: 0, maxScore: 1 },
    { id: 't1', stage: 'TECHNICAL' as const, weight: 60, maxScore: 10 },
    { id: 't2', stage: 'TECHNICAL' as const, weight: 40, maxScore: 10 },
  ];
  const members = ['m1', 'm2', 'm3'];
  const s = (criterionId: string, bidId: string, values: number[]) => values.map((score, i) => ({ criterionId, bidId, memberId: members[i], score }));

  it('preliminary by majority, weighted technical, financial against the lowest qualified price, combined ranking', () => {
    const scores = [
      ...s('p1', 'A', [1, 1, 1]),
      ...s('p1', 'B', [1, 1, 0]), // majority passes
      ...s('p1', 'C', [0, 0, 1]), // majority fails
      ...s('t1', 'A', [9, 9, 9]),
      ...s('t2', 'A', [8, 8, 8]),
      ...s('t1', 'B', [6, 6, 6]),
      ...s('t2', 'B', [5, 5, 5]),
    ];
    const r = evaluateBids({ bids: [{ id: 'A', totalPrice: 200 }, { id: 'B', totalPrice: 180 }, { id: 'C', totalPrice: 160 }], members, criteria, scores, technicalWeight: 30, technicalPassMark: 50 });
    const by = (id: string) => r.find((x) => x.bidId === id)!;
    expect(by('C')).toMatchObject({ responsive: false, failedCriteria: ['p1'], rank: null });
    expect(by('A')).toMatchObject({ responsive: true, technicalScore: 86, financialScore: 90, combinedScore: 88.8, rank: 1 });
    expect(by('B')).toMatchObject({ technicalScore: 56, financialScore: 100, combinedScore: 86.8, rank: 2 });
  });

  it('below the pass mark a bid is technically failed; weight 0 = lowest evaluated price', () => {
    const scores = [...s('p1', 'A', [1, 1, 1]), ...s('p1', 'B', [1, 1, 1]), ...s('t1', 'A', [9, 9, 9]), ...s('t2', 'A', [9, 9, 9]), ...s('t1', 'B', [3, 3, 3]), ...s('t2', 'B', [3, 3, 3])];
    const bids = [{ id: 'A', totalPrice: 300 }, { id: 'B', totalPrice: 100 }];
    const strict = evaluateBids({ bids, members, criteria, scores, technicalWeight: 0, technicalPassMark: 50 });
    expect(strict.find((x) => x.bidId === 'B')).toMatchObject({ qualified: false, rank: null });
    expect(strict.find((x) => x.bidId === 'A')!.rank).toBe(1);
    const lenient = evaluateBids({ bids, members, criteria, scores, technicalWeight: 0, technicalPassMark: 0 });
    expect(lenient.find((x) => x.bidId === 'B')!.rank).toBe(1); // cheapest wins on price only
  });

  it('only declared members without a conflict score', () => {
    expect(scoringMembers([
      { id: 'a', declaredAt: new Date(), hasConflict: false },
      { id: 'b', declaredAt: new Date(), hasConflict: true },
      { id: 'c', declaredAt: null, hasConflict: null },
    ])).toEqual(['a']);
  });
});

describe('supplier scorecard', () => {
  const w = { onTime: 30, inFull: 25, quality: 25, price: 10, documents: 10 };
  it('weights the dimensions; quality counts as 100 − reject rate; missing dimensions are rescaled away', () => {
    expect(overallScore({ onTimeRate: 100, inFullRate: 100, qualityRejectRate: 0, priceComplianceRate: 100, documentComplianceRate: 100 }, w)).toBe(100);
    expect(overallScore({ onTimeRate: 50, inFullRate: 100, qualityRejectRate: 20, priceComplianceRate: 100, documentComplianceRate: 0 }, w)).toBe(70);
    // Only documents measurable.
    expect(overallScore({ onTimeRate: null, inFullRate: null, qualityRejectRate: null, priceComplianceRate: null, documentComplianceRate: 50 }, w)).toBe(50);
    expect(overallScore({ onTimeRate: null, inFullRate: null, qualityRejectRate: null, priceComplianceRate: null, documentComplianceRate: null }, w)).toBeNull();
  });
});

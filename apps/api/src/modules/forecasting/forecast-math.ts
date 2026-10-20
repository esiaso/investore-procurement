/**
 * Demand forecasting maths. Histories are monthly consumption, oldest first,
 * in base units. Forecasts are never negative.
 */

export interface Forecaster {
  readonly method: string;
  /** Forecast for the next `horizon` months. */
  forecast(history: number[], horizon: number): number[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const nonNeg = (xs: number[]) => xs.map((x) => r4(Math.max(0, x)));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Average monthly consumption over the last `months`, flat. */
export class AmcForecaster implements Forecaster {
  readonly method = 'AMC';
  constructor(private readonly months: number) {}
  forecast(history: number[], horizon: number): number[] {
    const level = mean(history.slice(-this.months));
    return nonNeg(Array(horizon).fill(level));
  }
}

/** Simple moving average of the last `window` months, rolled forward. */
export class MovingAverageForecaster implements Forecaster {
  readonly method = 'MOVING_AVERAGE';
  constructor(private readonly window: number) {}
  forecast(history: number[], horizon: number): number[] {
    const series = [...history];
    const out: number[] = [];
    for (let h = 0; h < horizon; h++) {
      const next = mean(series.slice(-this.window));
      out.push(next);
      series.push(next);
    }
    return nonNeg(out);
  }
}

export interface HoltWintersParams {
  alpha: number;
  beta: number;
  gamma: number;
  seasonLength: number;
}

/**
 * Additive Holt-Winters (level, trend, seasonality). With fewer than two full
 * seasons of history the seasonal component cannot be estimated, so it falls
 * back to Holt's linear trend (double exponential smoothing).
 */
export class HoltWintersForecaster implements Forecaster {
  readonly method = 'HOLT_WINTERS';
  constructor(private readonly p: HoltWintersParams) {}

  forecast(history: number[], horizon: number): number[] {
    const { alpha, beta, gamma, seasonLength: L } = this.p;
    const y = history;
    if (y.length === 0) return Array(horizon).fill(0);
    if (y.length < 2 * L) return holtLinear(y, alpha, beta, horizon);
    // Initial level and trend from the first two seasons; seasonal indices from season 1.
    const s1 = mean(y.slice(0, L));
    const s2 = mean(y.slice(L, 2 * L));
    let level = s1;
    let trend = (s2 - s1) / L;
    const season = y.slice(0, L).map((v) => v - s1);
    for (let t = L; t < y.length; t++) {
      const sIdx = t % L;
      const prevLevel = level;
      level = alpha * (y[t] - season[sIdx]) + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
      season[sIdx] = gamma * (y[t] - level) + (1 - gamma) * season[sIdx];
    }
    const out: number[] = [];
    for (let h = 1; h <= horizon; h++) out.push(level + h * trend + season[(y.length + h - 1) % L]);
    return nonNeg(out);
  }
}

export function holtLinear(y: number[], alpha: number, beta: number, horizon: number): number[] {
  if (y.length === 1) return nonNeg(Array(horizon).fill(y[0]));
  let level = y[0];
  let trend = y[1] - y[0];
  for (let t = 1; t < y.length; t++) {
    const prev = level;
    level = alpha * y[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return nonNeg(Array.from({ length: horizon }, (_, h) => level + (h + 1) * trend));
}

/** Mean absolute percentage error (%), over months with non-zero actuals; null when none. */
export function mape(actual: number[], forecast: number[]): number | null {
  const pairs = actual.map((a, i) => [a, forecast[i]] as const).filter(([a, f]) => a > 0 && f !== undefined);
  if (!pairs.length) return null;
  return Math.round((100 * pairs.reduce((s, [a, f]) => s + Math.abs(a - f) / a, 0)) / pairs.length * 100) / 100;
}

/** MAPE of forecasting the last `holdout` months from the months before them. */
export function backtest(f: Forecaster, history: number[], holdout: number): number | null {
  if (history.length <= holdout + 1) return null;
  const train = history.slice(0, -holdout);
  const test = history.slice(-holdout);
  return mape(test, f.forecast(train, holdout));
}

/** The forecaster with the lowest back-tested MAPE (ties and no data: the first one). */
export function pickBest(forecasters: Forecaster[], history: number[], holdout: number): { forecaster: Forecaster; mape: number | null } {
  let best = { forecaster: forecasters[0], mape: null as number | null };
  for (const f of forecasters) {
    const m = backtest(f, history, holdout);
    if (m !== null && (best.mape === null || m < best.mape)) best = { forecaster: f, mape: m };
  }
  return best;
}

/**
 * Suggested order: demand over lead time + review period (from the forecast,
 * pro rata for part months) plus safety stock, less what is available and on
 * the way. Never negative; rounded up to whole base units.
 */
export function suggestedOrderQty(input: { monthly: number[]; leadTimeDays: number; reviewPeriodDays: number; safetyStock: number; position: number }): { demand: number; qty: number } {
  const days = input.leadTimeDays + input.reviewPeriodDays;
  let demand = 0;
  let left = days;
  for (let i = 0; left > 0; i++) {
    const m = input.monthly[Math.min(i, input.monthly.length - 1)] ?? 0;
    const part = Math.min(30, left) / 30;
    demand += m * part;
    left -= 30;
  }
  const qty = Math.max(0, Math.ceil(demand + input.safetyStock - input.position));
  return { demand: r4(demand), qty };
}

/** Morbidity-based need: people × coverage × units per person per month × months. */
export function morbidityQty(input: { population: number; coveragePercent: number; unitsPerPatientMonth: number; months: number; wastagePercent?: number }): number {
  const base = input.population * (input.coveragePercent / 100) * input.unitsPerPatientMonth * input.months;
  return Math.ceil(base * (1 + (input.wastagePercent ?? 0) / 100));
}

/** Months of stock. AMC of zero means unlimited (null). */
export function monthsOfStock(quantity: number, amc: number): number | null {
  return amc > 0 ? Math.round((quantity / amc) * 10) / 10 : null;
}

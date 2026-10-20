import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { ForecastMethod, QuantificationMethod, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { FundingSource } from '../inventory/funding';
import { JobsService } from '../jobs/jobs.service';
import { ReorderRow, ReorderService } from '../planning/reorder.service';
import { SettingsService } from '../settings/settings.service';
import {
  AmcForecaster,
  Forecaster,
  HoltWintersForecaster,
  monthsOfStock,
  morbidityQty,
  MovingAverageForecaster,
  pickBest,
  backtest,
  suggestedOrderQty,
} from './forecast-math';
import { DemandForecast, ForecastAccuracy, ForecastAdjustment, Programme, ProgrammeCommodity, Quantification } from './forecasting.entities';

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** YYYY-MM arithmetic. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export const monthsBetween = (from: string, to: string) => {
  const [a, b] = [from, to].map((s) => s.split('-').map(Number));
  return (b[0] - a[0]) * 12 + (b[1] - a[1]);
};

export interface RunOptions {
  storeId?: string;
  itemId?: string;
  categoryId?: string;
  method?: ForecastMethod;
}

/**
 * Demand forecasting per item × store from ledger consumption, with manual
 * adjustment factors, suggested order quantities and accuracy (MAPE) tracking;
 * supply planning (months of stock, pipeline, order schedule); programme
 * quantification; donor stock.
 */
@Injectable()
export class ForecastingService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly reorder: ReorderService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('forecast.run', 'Forecast demand for every stocked item and store', () => this.run({}));
    this.jobs.register('forecast.accuracy', 'Compare last month’s forecasts with actual consumption (MAPE)', () => this.trackAccuracy());
  }

  async currentMonth(m: EntityManager = this.ds.manager) {
    return (await this.settings.today(m)).slice(0, 7);
  }

  /** The forecasters configured in settings. */
  async forecasters(m: EntityManager = this.ds.manager): Promise<Record<Exclude<ForecastMethod, ForecastMethod.AUTO>, Forecaster>> {
    const amcMonths = Math.max(1, Math.round((await this.settings.get('stock.amcWindowDays', m)) / 30));
    return {
      [ForecastMethod.AMC]: new AmcForecaster(amcMonths),
      [ForecastMethod.MOVING_AVERAGE]: new MovingAverageForecaster(await this.settings.get('forecast.movingAverageMonths', m)),
      [ForecastMethod.HOLT_WINTERS]: new HoltWintersForecaster(await this.settings.get('forecast.holtWinters', m)),
    };
  }

  /**
   * Monthly consumption (base units, oldest first) for `months` complete months
   * before `untilMonth`, per item. Consumption = the movements in
   * stock.amcTxnTypes, net of department / patient returns; never negative.
   */
  async monthlyConsumption(m: EntityManager, storeIds: string[] | null, itemIds: string[], months: number, untilMonth: string): Promise<Map<string, number[]>> {
    const from = addMonths(untilMonth, -months);
    const types = [...(await this.settings.get('stock.amcTxnTypes', m)), 'RETURN_IN', 'DISPENSE_RETURN'];
    const rows: { item_id: string; month: string; qty: number }[] = await m.query(
      `SELECT t.item_id, to_char(t.effective_date, 'YYYY-MM') AS month, SUM(-t.quantity)::float AS qty
         FROM stock_transaction t
        WHERE t.item_id = ANY($1::uuid[]) AND t.txn_type::text = ANY($2::text[])
          AND t.effective_date >= ($3 || '-01')::date AND t.effective_date < ($4 || '-01')::date
          ${storeIds ? 'AND t.store_id = ANY($5::uuid[])' : ''}
        GROUP BY 1, 2`,
      storeIds ? [itemIds, types, from, untilMonth, storeIds] : [itemIds, types, from, untilMonth],
    );
    const out = new Map<string, number[]>();
    for (const id of itemIds) out.set(id, Array(months).fill(0));
    for (const r of rows) {
      const i = monthsBetween(from, r.month);
      if (i >= 0 && i < months) out.get(r.item_id)![i] = Math.max(0, r4(r.qty));
    }
    return out;
  }

  /** Product of the active adjustment factors for each forecast month. */
  private async factorsFor(m: EntityManager, storeId: string, itemId: string, categoryId: string | null, months: string[]) {
    const adj = await m
      .getRepository(ForecastAdjustment)
      .createQueryBuilder('a')
      .where('a.is_active')
      .andWhere('(a.store_id IS NULL OR a.store_id = :s)', { s: storeId })
      .andWhere('(a.item_id = :i OR (a.item_id IS NULL AND a.category_id = :c))', { i: itemId, c: categoryId })
      .getMany();
    const factors = months.map(() => 1);
    const applied: DemandForecast['adjustments'] = [];
    for (const a of adj) {
      const hit = months.filter((mo) => mo >= a.fromMonth && (!a.toMonth || mo <= a.toMonth));
      if (!hit.length) continue;
      months.forEach((mo, i) => {
        if (hit.includes(mo)) factors[i] *= a.factor;
      });
      applied.push({ id: a.id, reasonCode: a.reasonCode, factor: a.factor, months: hit });
    }
    return { factors, applied };
  }

  /**
   * Forecasts every store item setting in scope (store / item / category) and
   * stores the result as the current forecast. Returns a summary.
   */
  async run(opts: RunOptions, actor?: SessionUser): Promise<{ forecasts: number; method: string; startMonth: string }> {
    if (opts.storeId) StoreScope.assert(opts.storeId);
    return this.ds.transaction(async (m) => {
      const historyMonths = await this.settings.get('forecast.historyMonths', m);
      const horizon = await this.settings.get('forecast.horizonMonths', m);
      const reviewDefault = await this.settings.get('stock.defaultReviewPeriodDays', m);
      const defaultMethod = (opts.method ?? (await this.settings.get('forecast.defaultMethod', m))) as ForecastMethod;
      const start = await this.currentMonth(m);
      const forecastMonths = Array.from({ length: horizon }, (_, i) => addMonths(start, i));
      const rows: ReorderRow[] = await this.reorder.rows(m, { storeId: opts.storeId, itemId: opts.itemId, categoryId: opts.categoryId, belowOnly: false } as never, actor ? actor.storeIds : null);
      const fs = await this.forecasters(m);
      const byStore = new Map<string, ReorderRow[]>();
      for (const r of rows) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);
      let count = 0;
      for (const [storeId, storeRows] of byStore) {
        const history = await this.monthlyConsumption(m, [storeId], storeRows.map((r) => r.itemId), historyMonths, start);
        const meta: { item_id: string; category_id: string; review: number | null }[] = await m.query(
          `SELECT i.id AS item_id, i.category_id, sis.review_period_days AS review FROM item i
             LEFT JOIN store_item_setting sis ON sis.item_id = i.id AND sis.store_id = $1 WHERE i.id = ANY($2::uuid[])`,
          [storeId, storeRows.map((r) => r.itemId)],
        );
        for (const r of storeRows) {
          const h = history.get(r.itemId)!;
          let forecaster: Forecaster;
          let mapeValue: number | null;
          if (defaultMethod === ForecastMethod.AUTO) {
            const best = pickBest(Object.values(fs), h, 3);
            forecaster = best.forecaster;
            mapeValue = best.mape;
          } else {
            forecaster = fs[defaultMethod as Exclude<ForecastMethod, ForecastMethod.AUTO>];
            if (!forecaster) throw new BadRequestException(`Unknown forecast method ${defaultMethod}`);
            mapeValue = backtest(forecaster, h, 3);
          }
          const baseline = forecaster.forecast(h, horizon);
          const info = meta.find((x) => x.item_id === r.itemId);
          const { factors, applied } = await this.factorsFor(m, storeId, r.itemId, info?.category_id ?? null, forecastMonths);
          const adjusted = baseline.map((b, i) => r4(b * factors[i]));
          const position = r4(r.available + r.onOrder + r.inTransit);
          const sug = suggestedOrderQty({ monthly: adjusted, leadTimeDays: r.leadTimeDays, reviewPeriodDays: info?.review ?? reviewDefault, safetyStock: r.safetyStock, position });
          await m.update(DemandForecast, { storeId, itemId: r.itemId, isCurrent: true }, { isCurrent: false });
          await m.save(
            m.create(DemandForecast, {
              storeId,
              itemId: r.itemId,
              method: forecaster.method as ForecastMethod,
              startMonth: start,
              history: h,
              baseline,
              adjusted,
              adjustments: applied,
              backtestMape: mapeValue,
              position,
              demandOverCover: sug.demand,
              safetyStock: r.safetyStock,
              suggestedQty: sug.qty,
              isCurrent: true,
            }),
          );
          count++;
        }
      }
      return { forecasts: count, method: defaultMethod, startMonth: start };
    });
  }

  async current(q: { storeId?: string; itemId?: string; search?: string; onlySuggested?: boolean }) {
    const qb = this.ds
      .getRepository(DemandForecast)
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.item', 'item')
      .leftJoinAndSelect('f.store', 'store')
      .where('f.is_current')
      .orderBy('store.name')
      .addOrderBy('item.name')
      .take(2000);
    StoreScope.apply(qb, 'f.store_id');
    if (q.storeId) qb.andWhere('f.store_id = :s', { s: q.storeId });
    if (q.itemId) qb.andWhere('f.item_id = :i', { i: q.itemId });
    if (q.search) qb.andWhere('(item.name ILIKE :q OR item.code ILIKE :q)', { q: `%${q.search}%` });
    if (q.onlySuggested) qb.andWhere('f.suggested_qty > 0');
    return qb.getMany();
  }

  async get(id: string) {
    const f = await this.ds.getRepository(DemandForecast).findOne({ where: { id }, relations: { item: true, store: true } });
    if (!f) throw new NotFoundException('Forecast not found');
    StoreScope.assert(f.storeId);
    const actuals = await this.ds.getRepository(ForecastAccuracy).find({ where: { storeId: f.storeId, itemId: f.itemId }, order: { month: 'ASC' } });
    return { ...f, months: f.adjusted.map((_, i) => addMonths(f.startMonth, i)), historyMonths: f.history.map((_, i) => addMonths(f.startMonth, i - f.history.length)), accuracy: actuals };
  }

  /**
   * For last month: actual consumption vs the forecast made before it started
   * (the latest one generated before the month began). Idempotent.
   */
  async trackAccuracy(month?: string): Promise<{ month: string; pairs: number; mape: number | null }> {
    const target = month ?? addMonths(await this.currentMonth(), -1);
    return this.ds.transaction(async (m) => {
      const forecasts: { id: string; store_id: string; item_id: string; method: ForecastMethod; start_month: string; adjusted: number[] }[] = await m.query(
        `SELECT DISTINCT ON (store_id, item_id) id, store_id, item_id, method, start_month, adjusted
           FROM demand_forecast
          WHERE start_month <= $1 AND generated_at < ($1 || '-01')::date
          ORDER BY store_id, item_id, generated_at DESC`,
        [target],
      );
      let pairs = 0;
      const apes: number[] = [];
      const byStore = new Map<string, typeof forecasts>();
      for (const f of forecasts) byStore.set(f.store_id, [...(byStore.get(f.store_id) ?? []), f]);
      for (const [storeId, list] of byStore) {
        const actual = await this.monthlyConsumption(m, [storeId], list.map((f) => f.item_id), 1, addMonths(target, 1));
        for (const f of list) {
          const idx = monthsBetween(f.start_month, target);
          const fq = f.adjusted[idx];
          if (fq === undefined) continue;
          const aq = actual.get(f.item_id)![0];
          const ape = aq > 0 ? r2((100 * Math.abs(aq - fq)) / aq) : null;
          if (ape !== null) apes.push(ape);
          await m.query(
            `INSERT INTO forecast_accuracy (store_id, item_id, month, forecast_id, method, forecast_qty, actual_qty, ape)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (store_id, item_id, month) DO UPDATE SET forecast_id = EXCLUDED.forecast_id, method = EXCLUDED.method,
               forecast_qty = EXCLUDED.forecast_qty, actual_qty = EXCLUDED.actual_qty, ape = EXCLUDED.ape, computed_at = now()`,
            [storeId, f.item_id, target, f.id, f.method, fq, aq, ape],
          );
          pairs++;
        }
      }
      return { month: target, pairs, mape: apes.length ? r2(apes.reduce((a, b) => a + b, 0) / apes.length) : null };
    });
  }

  /** MAPE by method (and overall) over a month range. */
  async accuracy(q: { fromMonth: string; toMonth: string; storeId?: string }) {
    const params: unknown[] = [q.fromMonth, q.toMonth];
    let f = '';
    if (q.storeId) {
      params.push(q.storeId);
      f += ` AND a.store_id = $${params.length}`;
    }
    const allowed = StoreScope.current();
    if (allowed !== null) {
      params.push(allowed);
      f += ` AND a.store_id = ANY($${params.length}::uuid[])`;
    }
    const byMethod = await this.ds.query(
      `SELECT a.method, count(*)::int AS pairs, round(avg(a.ape), 2)::float AS mape
         FROM forecast_accuracy a WHERE a.month BETWEEN $1 AND $2 AND a.ape IS NOT NULL ${f} GROUP BY a.method ORDER BY a.method`,
      params,
    );
    const [overall] = await this.ds.query(`SELECT count(*)::int AS pairs, round(avg(a.ape), 2)::float AS mape FROM forecast_accuracy a WHERE a.month BETWEEN $1 AND $2 AND a.ape IS NOT NULL ${f}`, params);
    const worst = await this.ds.query(
      `SELECT i.code, i.name, s.name AS store, round(avg(a.ape), 2)::float AS mape, count(*)::int AS months
         FROM forecast_accuracy a JOIN item i ON i.id = a.item_id JOIN store s ON s.id = a.store_id
        WHERE a.month BETWEEN $1 AND $2 AND a.ape IS NOT NULL ${f}
        GROUP BY i.code, i.name, s.name ORDER BY 4 DESC LIMIT 20`,
      params,
    );
    return { overall, byMethod, worst };
  }

  // ------------------------------------------------------------------ adjustments

  adjustments() {
    return this.ds.getRepository(ForecastAdjustment).find({ relations: { item: true }, order: { fromMonth: 'DESC' } });
  }

  async saveAdjustment(id: string | null, dto: Partial<ForecastAdjustment>) {
    if (!dto.itemId && !dto.categoryId) throw new BadRequestException('An adjustment applies to an item or a category');
    if (dto.toMonth && dto.fromMonth && dto.toMonth < dto.fromMonth) throw new BadRequestException('toMonth is before fromMonth');
    const repo = this.ds.getRepository(ForecastAdjustment);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Adjustment not found');
    return repo.save(Object.assign(row, dto));
  }

  // ------------------------------------------------------------------ supply planning

  /**
   * Months of stock and pipeline per item at a store, with status against
   * supply.minMonthsOfStock / supply.maxMonthsOfStock.
   */
  async supplyPlan(storeId: string, q: { categoryId?: string; search?: string }) {
    StoreScope.assert(storeId);
    const minMos = await this.settings.get('supply.minMonthsOfStock');
    const maxMos = await this.settings.get('supply.maxMonthsOfStock');
    const rows = await this.reorder.rows(this.ds.manager, { storeId, categoryId: q.categoryId, search: q.search, belowOnly: false } as never, null);
    const forecasts = await this.ds.getRepository(DemandForecast).find({ where: { storeId, isCurrent: true, itemId: In(rows.map((r) => r.itemId)) } });
    return rows.map((r) => {
      const f = forecasts.find((x) => x.itemId === r.itemId);
      const monthly = f ? f.adjusted[0] : r.amc;
      const pipeline = r4(r.available + r.onOrder + r.inTransit);
      const mos = monthsOfStock(r.available, monthly);
      const pipelineMos = monthsOfStock(pipeline, monthly);
      const status = r.available <= 0 ? 'STOCK_OUT' : mos !== null && mos < minMos ? (pipelineMos !== null && pipelineMos >= minMos ? 'BELOW_MIN_COVERED' : 'BELOW_MIN') : mos !== null && mos > maxMos ? 'ABOVE_MAX' : 'OK';
      return {
        itemId: r.itemId,
        itemCode: r.itemCode,
        itemName: r.itemName,
        uom: r.uom,
        amc: r.amc,
        forecastMonthly: monthly,
        onHand: r.onHand,
        available: r.available,
        onOrder: r.onOrder,
        inTransit: r.inTransit,
        pipeline,
        monthsOfStock: mos,
        pipelineMonthsOfStock: pipelineMos,
        minMonths: minMos,
        maxMonths: maxMos,
        status,
        leadTimeDays: r.leadTimeDays,
        unitCost: r.unitCost,
      };
    });
  }

  /**
   * Suggested order schedule for one item: month by month the projected stock
   * (pipeline less forecast demand); when it would fall below the minimum
   * months of stock an order is placed lead-time ahead, up to the maximum.
   */
  async orderSchedule(storeId: string, itemId: string) {
    StoreScope.assert(storeId);
    const [row] = await this.supplyPlan(storeId, {}).then((rs) => rs.filter((r) => r.itemId === itemId));
    if (!row) throw new NotFoundException('No stock setting for this item at the store');
    const f = await this.ds.getRepository(DemandForecast).findOneBy({ storeId, itemId, isCurrent: true });
    const horizon = await this.settings.get('forecast.horizonMonths');
    const start = await this.currentMonth();
    const demand = Array.from({ length: horizon }, (_, i) => (f ? (f.adjusted[i] ?? f.adjusted.at(-1) ?? 0) : row.amc));
    const today = await this.settings.today();
    let stock = row.pipeline;
    const months: { month: string; demand: number; opening: number; arrival: number; closing: number; monthsOfStock: number | null }[] = [];
    const orders: { orderBy: string; arrivalMonth: string; quantity: number }[] = [];
    for (let i = 0; i < horizon; i++) {
      const month = addMonths(start, i);
      const opening = stock;
      let arrival = 0;
      const next = demand[i + 1] ?? demand[i];
      const closing = opening - demand[i];
      if (next > 0 && closing / next < row.minMonths) {
        arrival = Math.max(0, Math.ceil(row.maxMonths * next - closing));
        const arrive = new Date(`${month}-01T00:00:00Z`);
        const orderBy = new Date(arrive.getTime() - row.leadTimeDays * 86_400_000).toISOString().slice(0, 10);
        orders.push({ orderBy: orderBy < today ? today : orderBy, arrivalMonth: month, quantity: arrival });
      }
      stock = r4(closing + arrival);
      months.push({ month, demand: r4(demand[i]), opening: r4(opening), arrival, closing: stock, monthsOfStock: monthsOfStock(stock, next) });
    }
    return { item: row, months, orders };
  }

  // ------------------------------------------------------------------ programmes and quantification

  programmes() {
    return this.ds.getRepository(Programme).find({ relations: { commodities: { item: true } }, order: { code: 'ASC' } });
  }

  async saveProgramme(id: string | null, dto: { code: string; name: string; description?: string; isActive?: boolean; commodities?: { itemId: string; unitsPerPatientMonth: number; regimenSharePercent?: number; protocolNotes?: string }[] }) {
    return this.ds.transaction(async (m) => {
      const row = id ? await m.findOneBy(Programme, { id }) : m.create(Programme);
      if (!row) throw new NotFoundException('Programme not found');
      Object.assign(row, { code: dto.code, name: dto.name, description: dto.description ?? null, isActive: dto.isActive ?? true });
      const saved = await m.save(row);
      if (dto.commodities) {
        await m.delete(ProgrammeCommodity, { programmeId: saved.id });
        for (const c of dto.commodities) {
          await m.save(m.create(ProgrammeCommodity, { programmeId: saved.id, itemId: c.itemId, unitsPerPatientMonth: c.unitsPerPatientMonth, regimenSharePercent: c.regimenSharePercent ?? 100, protocolNotes: c.protocolNotes ?? null }));
        }
      }
      return m.findOneOrFail(Programme, { where: { id: saved.id }, relations: { commodities: { item: true } } });
    });
  }

  /**
   * Morbidity method: target population × coverage × regimen share × units per
   * patient-month × months (+ wastage). Consumption method: AMC × months. Both
   * are shown with their difference; the chosen method gives the final
   * quantity, less usable stock = quantity to procure.
   */
  async quantify(dto: { programmeId: string; storeId?: string; title: string; periodMonths: number; targetPopulation: number; coveragePercent: number; wastagePercent?: number; method?: QuantificationMethod; notes?: string }) {
    if (dto.storeId) StoreScope.assert(dto.storeId);
    return this.ds.transaction(async (m) => {
      const prog = await m.findOne(Programme, { where: { id: dto.programmeId }, relations: { commodities: { item: true } } });
      if (!prog) throw new NotFoundException('Programme not found');
      if (!prog.commodities?.length) throw new BadRequestException('The programme has no commodities');
      const itemIds = prog.commodities.map((c) => c.itemId);
      const historyMonths = Math.max(1, Math.round((await this.settings.get('stock.amcWindowDays', m)) / 30));
      const history = await this.monthlyConsumption(m, dto.storeId ? [dto.storeId] : null, itemIds, historyMonths, await this.currentMonth(m));
      const stock: { item_id: string; q: number }[] = await m.query(
        `SELECT sb.item_id, COALESCE(SUM(sb.on_hand - sb.reserved) FILTER (WHERE b.hold_status = 'NONE' AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)), 0)::float AS q
           FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id WHERE sb.item_id = ANY($1::uuid[]) ${dto.storeId ? 'AND sb.store_id = $2' : ''} GROUP BY sb.item_id`,
        dto.storeId ? [itemIds, dto.storeId] : [itemIds],
      );
      const method = dto.method ?? QuantificationMethod.MORBIDITY;
      const lines = prog.commodities.map((c) => {
        const h = history.get(c.itemId)!;
        const amc = r4(h.reduce((a, b) => a + b, 0) / h.length);
        const morbidity = morbidityQty({
          population: dto.targetPopulation * (c.regimenSharePercent / 100),
          coveragePercent: dto.coveragePercent,
          unitsPerPatientMonth: c.unitsPerPatientMonth,
          months: dto.periodMonths,
          wastagePercent: dto.wastagePercent ?? 0,
        });
        const consumption = Math.ceil(amc * dto.periodMonths);
        const available = stock.find((s) => s.item_id === c.itemId)?.q ?? 0;
        const finalQty = method === QuantificationMethod.MORBIDITY ? morbidity : consumption;
        return {
          itemId: c.itemId,
          itemCode: c.item?.code ?? '',
          itemName: c.item?.name ?? '',
          morbidityQty: morbidity,
          consumptionQty: consumption,
          amc,
          differencePercent: consumption > 0 ? r2((100 * (morbidity - consumption)) / consumption) : null,
          available,
          finalQty,
          toProcure: Math.max(0, Math.ceil(finalQty - available)),
        };
      });
      return m.save(
        m.create(Quantification, {
          programmeId: prog.id,
          storeId: dto.storeId ?? null,
          title: dto.title,
          periodMonths: dto.periodMonths,
          targetPopulation: dto.targetPopulation,
          coveragePercent: dto.coveragePercent,
          wastagePercent: dto.wastagePercent ?? 0,
          method,
          lines,
          notes: dto.notes ?? null,
        }),
      );
    });
  }

  quantifications(programmeId?: string) {
    return this.ds.getRepository(Quantification).find({ where: programmeId ? { programmeId } : {}, relations: { programme: true }, order: { createdAt: 'DESC' }, take: 200 });
  }

  async quantification(id: string) {
    const q = await this.ds.getRepository(Quantification).findOne({ where: { id }, relations: { programme: true } });
    if (!q) throw new NotFoundException('Quantification not found');
    return q;
  }

  // ------------------------------------------------------------------ funding sources

  fundingSources() {
    return this.ds.getRepository(FundingSource).find({ order: { code: 'ASC' } });
  }

  async saveFundingSource(id: string | null, dto: Partial<FundingSource>) {
    const repo = this.ds.getRepository(FundingSource);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Funding source not found');
    return repo.save(Object.assign(row, dto));
  }

  /** Stock per funding source × store × item: quantity, value, earliest expiry, consumption and months of stock. */
  async donorStock(q: { fundingSource?: string; storeId?: string }) {
    const params: unknown[] = [];
    const where = ['b.funding_source IS NOT NULL', 'sb.on_hand <> 0'];
    if (q.fundingSource) {
      params.push(q.fundingSource);
      where.push(`b.funding_source = $${params.length}`);
    }
    if (q.storeId) {
      params.push(q.storeId);
      where.push(`sb.store_id = $${params.length}`);
    }
    const allowed = StoreScope.current();
    if (allowed !== null) {
      params.push(allowed);
      where.push(`sb.store_id = ANY($${params.length}::uuid[])`);
    }
    const rows: { funding_source: string; funder: string | null; allow_sale: boolean | null; store_id: string; store: string; item_id: string; code: string; name: string; on_hand: number; value: number; earliest_expiry: string | null; batches: number }[] = await this.ds.query(
      `SELECT b.funding_source, fs.name AS funder, fs.allow_sale, sb.store_id, s.name AS store, i.id AS item_id, i.code, i.name,
              SUM(sb.on_hand)::float AS on_hand, SUM(sb.on_hand * b.unit_cost)::float AS value,
              to_char(MIN(b.expiry_date), 'YYYY-MM-DD') AS earliest_expiry, count(DISTINCT b.id)::int AS batches
         FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id JOIN item i ON i.id = sb.item_id JOIN store s ON s.id = sb.store_id
         LEFT JOIN funding_source fs ON fs.code = b.funding_source
        WHERE ${where.join(' AND ')}
        GROUP BY b.funding_source, fs.name, fs.allow_sale, sb.store_id, s.name, i.id, i.code, i.name
        ORDER BY b.funding_source, s.name, i.name`,
      params,
    );
    // Consumption of that donor's batches over the last 3 months → months of stock.
    const cons: { funding_source: string; store_id: string; item_id: string; q: number }[] = rows.length
      ? await this.ds.query(
          `SELECT b.funding_source, t.store_id, t.item_id, SUM(-t.quantity)::float / 3 AS q
             FROM stock_transaction t JOIN batch b ON b.id = t.batch_id
            WHERE b.funding_source IS NOT NULL AND t.quantity < 0 AND t.txn_type::text IN ('ISSUE', 'DISPENSE', 'TRANSFER_DISPATCH')
              AND t.effective_date >= CURRENT_DATE - 90
            GROUP BY 1, 2, 3`,
        )
      : [];
    return rows.map((r) => {
      const monthly = cons.find((c) => c.funding_source === r.funding_source && c.store_id === r.store_id && c.item_id === r.item_id)?.q ?? 0;
      return { ...r, monthlyUse: r4(monthly), monthsOfStock: monthsOfStock(r.on_hand, monthly) };
    });
  }
}

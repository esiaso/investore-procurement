import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { StockSettingMode } from '@sil/shared';
import { addDays } from '../inventory/inventory.service';
import { SettingsService } from '../settings/settings.service';
import { computeAmc, computeLevels } from './planning-math';
import { StoreItemSetting } from './planning.entities';

const same = (a: number, b: number) => Math.abs(a - b) < 0.00005;

/**
 * Average monthly consumption per item per store from the ledger, and the
 * AUTO reorder levels derived from it. Safe to re-run: rows only change when
 * the numbers do.
 */
@Injectable()
export class AmcService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  /** Consumption and stock-out days per item in a store over [from, to]. */
  async history(m: EntityManager, storeId: string, from: string, to: string, types: string[]) {
    const consumed: { item_id: string; consumed: number }[] = await m.query(
      `SELECT item_id,
              (COALESCE(SUM(-quantity) FILTER (WHERE txn_type::text = ANY($4::text[]) AND quantity < 0), 0)
               - COALESCE(SUM(quantity) FILTER (WHERE txn_type = 'RETURN_IN'), 0))::float AS consumed
         FROM stock_transaction
        WHERE store_id = $1 AND effective_date BETWEEN $2::date AND $3::date
        GROUP BY item_id`,
      [storeId, from, to, types],
    );
    // Days in the window when the store held none of the item (end-of-day on hand ≤ 0).
    const stockout: { item_id: string; days: number }[] = await m.query(
      `WITH d AS (
         SELECT item_id, effective_date AS day, SUM(quantity) AS q
           FROM stock_transaction WHERE store_id = $1 AND effective_date <= $3::date GROUP BY item_id, effective_date
       ), c AS (
         SELECT item_id, day, SUM(q) OVER (PARTITION BY item_id ORDER BY day) AS bal,
                COALESCE(LEAD(day) OVER (PARTITION BY item_id ORDER BY day), $3::date + 1) AS next_day
           FROM d
       ), seg AS (
         SELECT item_id, GREATEST(day, $2::date) AS s, LEAST(next_day, $3::date + 1) AS e, bal FROM c
          WHERE next_day > $2::date AND day <= $3::date
         UNION ALL
         SELECT item_id, $2::date, MIN(day), 0 FROM d GROUP BY item_id HAVING MIN(day) > $2::date
       )
       SELECT item_id, COALESCE(SUM(CASE WHEN bal <= 0 THEN e - s ELSE 0 END), 0)::int AS days FROM seg WHERE e > s GROUP BY item_id`,
      [storeId, from, to],
    );
    return { consumed: new Map(consumed.map((r) => [r.item_id, r.consumed])), stockout: new Map(stockout.map((r) => [r.item_id, r.days])) };
  }

  /** Recalculates every item with ledger history (or a setting) in the store(s). */
  async recalc(storeId?: string): Promise<{ stores: number; items: number; changed: number }> {
    const window = await this.settings.get('stock.amcWindowDays');
    const types = await this.settings.get('stock.amcTxnTypes');
    const exclude = await this.settings.get('stock.amcExcludeStockoutDays');
    const minDays = await this.settings.get('stock.amcMinDays');
    const leadDefault = await this.settings.get('stock.defaultLeadTimeDays');
    const reviewDefault = await this.settings.get('stock.defaultReviewPeriodDays');
    const safetyDays = await this.settings.get('stock.safetyStockDays');
    const to = await this.settings.today();
    const from = addDays(to, -(window - 1));
    const stores: { id: string }[] = await this.ds.query(`SELECT id FROM store WHERE is_active ${storeId ? 'AND id = $1' : ''}`, storeId ? [storeId] : []);
    let items = 0;
    let changed = 0;
    for (const s of stores) {
      await this.ds.transaction(async (m) => {
        const { consumed, stockout } = await this.history(m, s.id, from, to, types);
        const known: { item_id: string }[] = await m.query(
          `SELECT DISTINCT item_id FROM stock_transaction WHERE store_id = $1
           UNION SELECT item_id FROM store_item_setting WHERE store_id = $1`,
          [s.id],
        );
        const existing = new Map((await m.find(StoreItemSetting, { where: { storeId: s.id } })).map((r) => [r.itemId, r]));
        for (const { item_id } of known) {
          items++;
          const { amc, days } = computeAmc({
            consumed: consumed.get(item_id) ?? 0,
            windowDays: window,
            stockoutDays: stockout.get(item_id) ?? window,
            excludeStockoutDays: exclude,
            minDays,
          });
          let row = existing.get(item_id);
          const isNew = !row;
          row ??= m.create(StoreItemSetting, { storeId: s.id, itemId: item_id, mode: StockSettingMode.AUTO });
          const next: Partial<StoreItemSetting> = { amc, amcDays: days };
          if (row.mode === StockSettingMode.AUTO) {
            Object.assign(
              next,
              computeLevels({ amc, leadTimeDays: row.leadTimeDays ?? leadDefault, reviewPeriodDays: row.reviewPeriodDays ?? reviewDefault, safetyStockDays: safetyDays }),
            );
          }
          const dirty = isNew || Object.entries(next).some(([k, v]) => !same(Number((row as unknown as Record<string, unknown>)[k] ?? NaN), Number(v)));
          if (!dirty) continue;
          Object.assign(row, next, { amcCalculatedAt: new Date() });
          await m.save(row);
          changed++;
        }
      });
    }
    return { stores: stores.length, items, changed };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { SessionUser, StockSettingMode } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { SettingsService } from '../settings/settings.service';
import { StoreItemSetting } from './planning.entities';
import { SettingsQueryDto, UpdateStoreItemSettingDto } from './planning.dto';

export type Column<T> = [header: string, value: (r: T) => unknown];

const LEVEL_FIELDS = ['minLevel', 'maxLevel', 'reorderLevel', 'reorderQty', 'safetyStock'] as const;

/** Store item settings, dashboard figures and report exports. */
@Injectable()
export class PlanningService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async listSettings(q: SettingsQueryDto) {
    StoreScope.assert(q.storeId);
    const qb = this.ds
      .getRepository(StoreItemSetting)
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.item', 'item')
      .leftJoinAndSelect('item.baseUom', 'uom')
      .where('s.store_id = :store', { store: q.storeId })
      .orderBy('item.name', 'ASC')
      .take(2000);
    if (q.search) qb.andWhere('(item.name ILIKE :q OR item.code ILIKE :q)', { q: `%${q.search}%` });
    return qb.getMany();
  }

  /** Editing a level switches the row to MANUAL (the AMC job then leaves the levels alone) unless a mode is given. */
  async updateSetting(id: string, dto: UpdateStoreItemSettingDto) {
    const repo = this.ds.getRepository(StoreItemSetting);
    const row = await repo.findOneBy({ id });
    if (!row) throw new NotFoundException('Setting not found');
    StoreScope.assert(row.storeId);
    const touchesLevels = LEVEL_FIELDS.some((f) => dto[f] !== undefined);
    Object.assign(row, dto);
    if (touchesLevels && dto.mode === undefined) row.mode = StockSettingMode.MANUAL;
    return repo.save(row);
  }

  async upsertSetting(storeId: string, itemId: string, dto: UpdateStoreItemSettingDto) {
    StoreScope.assert(storeId);
    const repo = this.ds.getRepository(StoreItemSetting);
    const row = (await repo.findOneBy({ storeId, itemId })) ?? repo.create({ storeId, itemId, mode: StockSettingMode.MANUAL });
    Object.assign(row, dto);
    if (LEVEL_FIELDS.some((f) => dto[f] !== undefined) && dto.mode === undefined) row.mode = StockSettingMode.MANUAL;
    return repo.save(row);
  }

  /** Counts and values for the dashboard widgets (stores the user can see). */
  async dashboard(actor: SessionUser, storeId?: string) {
    if (storeId) StoreScope.assert(storeId);
    const today = await this.settings.today();
    const horizons = [...(await this.settings.get('inventory.expiryWarningDays'))].sort((a, b) => a - b);
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const scope: string[] = [];
    if (actor.storeIds !== null) scope.push(`store_id = ANY(${p(actor.storeIds)}::uuid[])`);
    if (storeId) scope.push(`store_id = ${p(storeId)}`);
    const and = scope.length ? `AND ${scope.join(' AND ')}` : '';
    const [alerts] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE type = 'REORDER')::int AS reorder, COUNT(*) FILTER (WHERE type = 'STOCKOUT')::int AS stockout,
              COUNT(*) FILTER (WHERE type IN ('NEAR_EXPIRY', 'EXPIRED') AND raised_at > now() - interval '7 days')::int AS expiry_week
         FROM stock_alert WHERE status = 'OPEN' ${and}`,
      params,
    );
    const todayP = p(today);
    const buckets: { days_left: number; value: number; qty: number }[] = await this.ds.query(
      `SELECT (b.expiry_date - ${todayP}::date)::int AS days_left,
              SUM(sb.on_hand * COALESCE(c.avg_cost, b.unit_cost))::float AS value, COUNT(DISTINCT b.id)::int AS qty
         FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id
         LEFT JOIN item_store_cost c ON c.store_id = sb.store_id AND c.item_id = sb.item_id
        WHERE sb.on_hand > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ${todayP}::date + ${p(horizons.at(-1) ?? 180)}::int
          ${scope.length ? `AND ${scope.map((s) => `sb.${s}`).join(' AND ')}` : ''}
        GROUP BY b.expiry_date`,
      params,
    );
    const round2 = (n: number) => Math.round(n * 100) / 100;
    let lower = 0;
    const nearExpiry = horizons.map((h) => {
      const inBucket = buckets.filter((b) => b.days_left > lower && b.days_left <= h);
      const out = { label: `${lower + 1}–${h} days`, horizonDays: h, value: round2(inBucket.reduce((s, b) => s + b.value, 0)), batches: inBucket.reduce((s, b) => s + b.qty, 0) };
      lower = h;
      return out;
    });
    const expired = buckets.filter((b) => b.days_left <= 0);
    return {
      reorderAlerts: alerts.reorder,
      stockOuts: alerts.stockout,
      newExpiryAlerts: alerts.expiry_week,
      nearExpiry,
      expired: { value: round2(expired.reduce((s, b) => s + b.value, 0)), batches: expired.reduce((s, b) => s + b.qty, 0) },
      currency: await this.settings.get('locale.currency'),
    };
  }

  // ------------------------------------------------------------------ exports

  toCsv<T>(columns: Column<T>[], rows: T[]): string {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return [columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, f]) => cell(f(r))).join(','))].join('\r\n') + '\r\n';
  }

  async toXlsx<T>(sheet: string, columns: Column<T>[], rows: T[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.addRow(columns.map(([h]) => h)).font = { bold: true };
    for (const r of rows) ws.addRow(columns.map(([, f]) => f(r) ?? ''));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    columns.forEach((_, i) => (ws.getColumn(i + 1).width = 16));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

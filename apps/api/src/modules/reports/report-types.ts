import type { DataSource } from 'typeorm';
import type { PermissionCode } from '@sil/shared';
import type { SettingsService } from '../settings/settings.service';

export type ColumnType = 'text' | 'number' | 'qty' | 'money' | 'percent' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export type FilterKey = 'from' | 'to' | 'storeId' | 'categoryId' | 'itemId' | 'supplierId' | 'departmentId' | 'groupBy' | 'days' | 'limit' | 'status';

/** Values as received (query string): dates YYYY-MM-DD, ids uuid. */
export interface ReportFilters {
  from?: string;
  to?: string;
  storeId?: string;
  categoryId?: string;
  itemId?: string;
  supplierId?: string;
  departmentId?: string;
  groupBy?: string;
  days?: number;
  limit?: number;
  status?: string;
}

export interface ReportContext {
  ds: DataSource;
  f: ReportFilters;
  /** Stores the user may see (null = all). */
  scope: string[] | null;
  tz: string;
  today: string;
  maxRows: number;
  settings: SettingsService;
}

export interface ReportResult {
  /** Overrides the definition's columns (e.g. per groupBy). */
  columns?: ReportColumn[];
  rows: Record<string, unknown>[];
  /** Totals row (same keys as the rows). */
  totals?: Record<string, unknown>;
  notes?: string[];
}

export type ReportGroup = 'INVENTORY' | 'PHARMACY' | 'PURCHASING' | 'SUPPLY_CHAIN';

export interface ReportDef {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  /** Any of these may run it. */
  permissions: PermissionCode[];
  filters: FilterKey[];
  required?: FilterKey[];
  groupBy?: { value: string; label: string }[];
  columns: ReportColumn[];
  /** Wide reports print landscape. */
  landscape?: boolean;
  run(ctx: ReportContext): Promise<ReportResult>;
}

/** Positional parameters and the common filter conditions. */
export class Sql {
  readonly params: unknown[] = [];

  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  /** Store filter and the user's store scope on a store id column. */
  store(col: string, ctx: ReportContext): string {
    const out: string[] = [];
    if (ctx.f.storeId) out.push(`${col} = ${this.p(ctx.f.storeId)}`);
    if (ctx.scope !== null) out.push(`${col} = ANY(${this.p(ctx.scope)}::uuid[])`);
    return out.length ? out.join(' AND ') : 'TRUE';
  }

  /** Category and its sub-categories. */
  category(itemAlias: string, ctx: ReportContext): string {
    if (!ctx.f.categoryId) return 'TRUE';
    return `${itemAlias}.category_id IN (WITH RECURSIVE c AS (SELECT id FROM item_category WHERE id = ${this.p(ctx.f.categoryId)}
      UNION ALL SELECT ic.id FROM item_category ic JOIN c ON ic.parent_id = c.id) SELECT id FROM c)`;
  }

  eq(col: string, v: string | undefined): string {
    return v ? `${col} = ${this.p(v)}` : 'TRUE';
  }

  /** A timestamp's local date between from and to. */
  localDate(col: string, ctx: ReportContext): string {
    return `(${col} AT TIME ZONE ${this.p(ctx.tz)})::date BETWEEN ${this.p(ctx.f.from)}::date AND ${this.p(ctx.f.to)}::date`;
  }

  between(col: string, ctx: ReportContext): string {
    return `${col} BETWEEN ${this.p(ctx.f.from)}::date AND ${this.p(ctx.f.to)}::date`;
  }
}

export const r2 = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
export const pct = (a: number, b: number) => (b ? Math.round((10000 * a) / b) / 100 : null);
export const sum = (rows: Record<string, unknown>[], key: string) => r2(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Stock-ledger transaction types by direction (bin card / movement summary). */
export const TXN_IN = `('OPENING','RECEIPT','TRANSFER_RECEIPT','RETURN_IN','DISPENSE_RETURN')`;
export const TXN_OUT = `('ISSUE','DISPENSE','TRANSFER_DISPATCH','SUPPLIER_RETURN')`;
export const TXN_ADJ = `('ADJUSTMENT','STOCK_TAKE','TRANSFER_DISCREPANCY')`;
/** Consumption: what left stock to patients and departments (net of their returns). */
export const TXN_CONSUMPTION = `('ISSUE','DISPENSE','RETURN_IN','DISPENSE_RETURN')`;
/** Adjustment reasons that are losses (expiry, damage, disposal…). */
export const WRITE_OFF_REASONS = `('EXPIRY','DISPOSAL','DAMAGE','BREAKAGE','THEFT','LOSS','TRANSIT_LOSS')`;

export const col = (key: string, label: string, type: ColumnType = 'text'): ReportColumn => ({ key, label, type });

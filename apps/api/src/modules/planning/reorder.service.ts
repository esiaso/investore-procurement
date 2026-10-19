import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Permissions, RequisitionPriority, SessionUser, StockAlertType, ValuationMethod } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { TransfersService } from '../inventory/transfers.service';
import { RequisitionsService } from '../purchasing/requisitions.service';
import { SettingsService } from '../settings/settings.service';
import { AlertsService, NewAlert } from './alerts.service';
import { reorderStatus } from './planning-math';
import { CreateReorderRequisitionDto, ReorderQueryDto } from './planning.dto';

export interface ReorderRow {
  storeId: string;
  storeCode: string;
  storeName: string;
  parentStoreId: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  categoryName: string;
  mode: string;
  amc: number;
  minLevel: number;
  reorderLevel: number;
  maxLevel: number;
  reorderQty: number;
  safetyStock: number;
  leadTimeDays: number;
  onHand: number;
  reserved: number;
  available: number;
  onOrder: number;
  inTransit: number;
  unitCost: number;
  position: number;
  below: boolean;
  stockOut: boolean;
  daysOfStock: number | null;
  suggestedQty: number;
  suggestedValue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reorder engine. Position = available (on hand − reserved, usable stock only)
 * plus, when `stock.reorderIncludeOnOrder`, open PO quantities and stock in
 * transit. Items at or below their reorder level are suggested up to max.
 */
@Injectable()
export class ReorderService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly requisitions: RequisitionsService,
    private readonly transfers: TransfersService,
  ) {}

  async rows(m: EntityManager, q: ReorderQueryDto, storeIds: string[] | null): Promise<ReorderRow[]> {
    const today = await this.settings.today(m);
    const includeOnOrder = await this.settings.get('stock.reorderIncludeOnOrder', m);
    const leadDefault = await this.settings.get('stock.defaultLeadTimeDays', m);
    const method = await this.settings.get('inventory.valuationMethod', m);
    const params: unknown[] = [today];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = ['sis.is_active', 's.is_active'];
    if (storeIds !== null) where.push(`sis.store_id = ANY(${p(storeIds)}::uuid[])`);
    if (q.storeId) where.push(`sis.store_id = ${p(q.storeId)}`);
    if (q.categoryId) where.push(`i.category_id = ${p(q.categoryId)}`);
    if (q.itemId) where.push(`sis.item_id = ${p(q.itemId)}`);
    if (q.search) {
      const t = p(`%${q.search.trim()}%`);
      where.push(`(i.name ILIKE ${t} OR i.code ILIKE ${t})`);
    }
    const raw = await m.query(
      `WITH bal AS (
         SELECT sb.store_id, sb.item_id, SUM(sb.on_hand) AS on_hand, SUM(sb.reserved) AS reserved, SUM(sb.in_transit) AS in_transit,
                COALESCE(SUM(sb.on_hand - sb.reserved) FILTER (WHERE b.hold_status = 'NONE' AND NOT COALESCE(bn.is_quarantine, false)
                  AND (b.expiry_date IS NULL OR b.expiry_date > $1::date)), 0) AS available,
                MAX(b.unit_cost) AS batch_cost
           FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
          GROUP BY sb.store_id, sb.item_id
       ), po AS (
         SELECT o.store_id, l.item_id, SUM(GREATEST(l.quantity * l.conversion_factor - l.received_base_qty, 0)) AS on_order
           FROM purchase_order_line l JOIN purchase_order o ON o.id = l.purchase_order_id
          WHERE o.status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
          GROUP BY o.store_id, l.item_id
       )
       SELECT sis.store_id AS "storeId", s.code AS "storeCode", s.name AS "storeName", s.parent_store_id AS "parentStoreId",
              sis.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName", u.code AS uom, c.name AS "categoryName",
              sis.mode, sis.amc::float AS amc, sis.min_level::float AS "minLevel", sis.reorder_level::float AS "reorderLevel",
              sis.max_level::float AS "maxLevel", sis.reorder_qty::float AS "reorderQty", sis.safety_stock::float AS "safetyStock",
              COALESCE(sis.lead_time_days, ${p(leadDefault)})::int AS "leadTimeDays",
              COALESCE(bal.on_hand, 0)::float AS "onHand", COALESCE(bal.reserved, 0)::float AS reserved,
              COALESCE(bal.available, 0)::float AS available, COALESCE(po.on_order, 0)::float AS "onOrder",
              COALESCE(bal.in_transit, 0)::float AS "inTransit",
              COALESCE(${method === ValuationMethod.FIFO ? 'bal.batch_cost' : 'cost.avg_cost'}, i.unit_price)::float AS "unitCost"
         FROM store_item_setting sis
         JOIN store s ON s.id = sis.store_id
         JOIN item i ON i.id = sis.item_id
         JOIN item_category c ON c.id = i.category_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN bal ON bal.store_id = sis.store_id AND bal.item_id = sis.item_id
         LEFT JOIN po ON po.store_id = sis.store_id AND po.item_id = sis.item_id
         LEFT JOIN item_store_cost cost ON cost.store_id = sis.store_id AND cost.item_id = sis.item_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.name, i.name
        LIMIT 20000`,
      params,
    );
    const rows: ReorderRow[] = raw.map((r: Omit<ReorderRow, 'position' | 'below' | 'stockOut' | 'daysOfStock' | 'suggestedQty' | 'suggestedValue'>) => {
      const st = reorderStatus({ ...r, includeOnOrder });
      return { ...r, ...st, suggestedValue: round2(st.suggestedQty * r.unitCost) };
    });
    return q.belowOnly ? rows.filter((r) => r.below) : rows;
  }

  report(q: ReorderQueryDto, actor: SessionUser) {
    return this.rows(this.ds.manager, q, actor.storeIds);
  }

  /** Raises/resolves reorder and stock-out alerts for every store and notifies new ones. Idempotent. */
  async scan(storeId?: string): Promise<{ stores: number; reorder: number; stockOut: number; resolved: number; notified: number }> {
    const stores: { id: string }[] = await this.ds.query(`SELECT id FROM store WHERE is_active ${storeId ? 'AND id = $1' : ''}`, storeId ? [storeId] : []);
    const totals = { stores: stores.length, reorder: 0, stockOut: 0, resolved: 0, notified: 0 };
    for (const s of stores) {
      await this.ds.transaction(async (m) => {
        const rows = (await this.rows(m, { storeId: s.id }, null)).filter((r) => r.reorderLevel > 0 || r.amc > 0);
        const below = rows.filter((r) => r.below);
        const out = rows.filter((r) => r.stockOut);
        const alerts: NewAlert[] = [
          ...below.map((r) => ({
            type: StockAlertType.REORDER,
            storeId: s.id,
            itemId: r.itemId,
            dedupeKey: `REORDER|${s.id}|${r.itemId}|open`,
            message: `${r.itemName}: ${r.available} ${r.uom} available, reorder level ${r.reorderLevel}; suggest ${r.suggestedQty}`,
            details: { available: r.available, position: r.position, reorderLevel: r.reorderLevel, suggestedQty: r.suggestedQty, daysOfStock: r.daysOfStock },
            value: r.suggestedValue,
          })),
          ...out.map((r) => ({
            type: StockAlertType.STOCKOUT,
            storeId: s.id,
            itemId: r.itemId,
            dedupeKey: `STOCKOUT|${s.id}|${r.itemId}|open`,
            message: `${r.itemName}: none available (AMC ${r.amc} ${r.uom})`,
            details: { onHand: r.onHand, reserved: r.reserved, onOrder: r.onOrder },
          })),
        ];
        const created = await this.alerts.raise(m, alerts);
        totals.resolved += await this.alerts.resolveExcept(m, StockAlertType.REORDER, s.id, new Set(below.map((r) => r.itemId)));
        totals.resolved += await this.alerts.resolveExcept(m, StockAlertType.STOCKOUT, s.id, new Set(out.map((r) => r.itemId)));
        totals.reorder += created.filter((a) => a.type === StockAlertType.REORDER).length;
        totals.stockOut += created.filter((a) => a.type === StockAlertType.STOCKOUT).length;
        totals.notified += await this.alerts.notify(m, created);
      });
    }
    return totals;
  }

  /**
   * One click from the reorder report: a draft purchase requisition for stores
   * that buy (no parent store), or a transfer request to the parent store for
   * satellite stores. Quantities default to the suggestion.
   */
  async createRequisition(dto: CreateReorderRequisitionDto, actor: SessionUser) {
    StoreScope.assert(dto.storeId);
    const [store] = await this.ds.query(`SELECT id, name, parent_store_id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
    if (!store) throw new NotFoundException('Store not found');
    const lines = dto.lines.filter((l) => l.quantity > 0);
    if (!lines.length) throw new BadRequestException('Nothing to order');
    const today = await this.settings.today();
    if (store.parent_store_id) {
      if (!actor.permissions.includes(Permissions.INVENTORY_TRANSFER_REQUEST)) throw new ForbiddenException('Requesting stock from the main store needs inventory.transfer_request');
      const t = await this.transfers.request(
        { fromStoreId: store.parent_store_id, toStoreId: store.id, notes: dto.justification ?? `Reorder suggestion ${today}`, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) },
        actor,
      );
      return { kind: 'TRANSFER' as const, id: t.id, number: t.number, link: '/transfers' };
    }
    if (!actor.permissions.includes(Permissions.PURCHASING_REQUISITION)) throw new ForbiddenException('Raising a purchase requisition needs purchasing.requisition');
    const departmentId = dto.departmentId ?? actor.departmentId;
    if (!departmentId) throw new BadRequestException('Choose the department the purchase is for');
    const pr = await this.requisitions.create(
      {
        departmentId,
        storeId: store.id,
        priority: RequisitionPriority.ROUTINE,
        justification: dto.justification ?? `Replenishment for ${store.name} from the reorder report (${today})`,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      },
      actor,
    );
    return { kind: 'PR' as const, id: pr.id, number: pr.number, link: `/requisitions/${pr.id}` };
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DeliveryStage, Permissions, PurchaseOrderSource, PurchaseOrderStatus, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { NotificationsService } from '../approvals/notifications.service';
import { PurchaseOrder } from '../purchasing/purchasing.entities';
import { DraftLine, PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { SettingsService } from '../settings/settings.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { UsersService } from '../users/users.service';
import { OrderTemplate, PurchaseOrderDelivery } from './agencies.entities';

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const STAGES = Object.values(DeliveryStage);

export function addMonthsToDate(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** National agency ordering (KEMSA / MEDS order cycles from templates) and delivery tracking. */
@Injectable()
export class AgenciesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly orders: PurchaseOrdersService,
    private readonly suppliers: SuppliersService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  templates() {
    return this.ds.getRepository(OrderTemplate).find({ relations: { supplier: true, store: true }, order: { nextOrderDate: 'ASC' } });
  }

  async saveTemplate(id: string | null, dto: Partial<OrderTemplate>) {
    if (dto.storeId) StoreScope.assert(dto.storeId);
    if (dto.lines && !dto.lines.length) throw new BadRequestException('A template needs at least one item');
    const repo = this.ds.getRepository(OrderTemplate);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Template not found');
    return repo.save(Object.assign(row, dto));
  }

  /** Quantities for a cycle: fixed, or the current forecast / reorder suggestion for the store. */
  private async quantities(m: EntityManager, t: OrderTemplate): Promise<{ itemId: string; quantity: number; uomId: string | null }[]> {
    if (t.quantityMode === 'FIXED') return t.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, uomId: l.uomId ?? null }));
    const ids = t.lines.map((l) => l.itemId);
    const rows: { item_id: string; q: number }[] = await m.query(
      `SELECT item_id, suggested_qty::float AS q FROM demand_forecast WHERE store_id = $1 AND is_current AND item_id = ANY($2::uuid[])`,
      [t.storeId, ids],
    );
    return t.lines.map((l) => {
      const f = rows.find((r) => r.item_id === l.itemId);
      // Suggestions are base units; template quantities may be in an ordering unit.
      return f ? { itemId: l.itemId, quantity: f.q, uomId: null } : { itemId: l.itemId, quantity: l.quantity, uomId: l.uomId ?? null };
    });
  }

  /** Raises the draft PO of one template now (and moves its next date on). */
  async raise(id: string, actor: SessionUser | null) {
    return this.ds.transaction(async (m) => {
      const t = await m.findOne(OrderTemplate, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!t) throw new NotFoundException('Template not found');
      if (!t.isActive) throw new ConflictException('Template is inactive');
      const today = await this.settings.today(m);
      const qty = (await this.quantities(m, t)).filter((l) => l.quantity > 0);
      if (!qty.length) {
        t.nextOrderDate = addMonthsToDate(t.nextOrderDate <= today ? t.nextOrderDate : today, t.frequencyMonths);
        await m.save(t);
        return { purchaseOrderId: null as string | null, skipped: 'Nothing to order this cycle' };
      }
      const lines: DraftLine[] = [];
      for (const l of qty) {
        const contract = await this.suppliers.priceOn(m, t.supplierId, l.itemId, today);
        const [it] = await m.query(`SELECT unit_price::float AS p FROM item WHERE id = $1`, [l.itemId]);
        lines.push({ itemId: l.itemId, uomId: l.uomId, quantity: r4(l.quantity), unitPrice: contract?.unitPrice ?? it?.p ?? 0, contractLineId: l.uomId ? null : (contract?.contractLineId ?? null) });
      }
      const creator = actor ?? (await this.systemActor(m));
      const po = await this.orders.createDraft(
        m,
        {
          supplierId: t.supplierId,
          storeId: t.storeId,
          departmentId: t.departmentId,
          budgetId: t.budgetId,
          source: PurchaseOrderSource.ORDER_CYCLE,
          expectedDelivery: new Date(Date.parse(`${today}T00:00:00Z`) + t.leadTimeDays * 86_400_000).toISOString().slice(0, 10),
          notes: `Order cycle: ${t.name}`,
        },
        lines,
        creator,
      );
      t.lastOrderedOn = today;
      t.nextOrderDate = addMonthsToDate(t.nextOrderDate <= today ? t.nextOrderDate : today, t.frequencyMonths);
      await m.save(t);
      const buyers: { id: string }[] = await m.query(
        `SELECT DISTINCT ur.user_id AS id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
        [Permissions.PURCHASING_PO],
      );
      await this.notifications.notify(m, buyers.map((b) => b.id), { title: `Order cycle: draft ${po.number} for ${t.name}`, body: 'Review the quantities and submit it for approval.', link: `/purchase-orders/${po.id}` });
      return { purchaseOrderId: po.id, skipped: null };
    });
  }

  private async systemActor(m: EntityManager): Promise<SessionUser> {
    // Jobs act as the oldest active administrator (recorded as the PO creator).
    const [u] = await m.query(`SELECT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.code = 'SYSTEM_ADMIN' AND u.is_active ORDER BY u.created_at LIMIT 1`);
    const s = u ? await this.users.findForSession(u.id) : null;
    if (!s) throw new BadRequestException('No administrator to act for the order-cycle job');
    return s;
  }

  /** Job agency.ordercycle: every active template due today or earlier. */
  async runDue(): Promise<{ raised: number; skipped: number }> {
    const today = await this.settings.today();
    const due: { id: string }[] = await this.ds.query(`SELECT id FROM order_template WHERE is_active AND next_order_date <= $1::date ORDER BY next_order_date`, [today]);
    let raised = 0;
    let skipped = 0;
    for (const d of due) {
      const r = await this.raise(d.id, null);
      if (r.purchaseOrderId) raised++;
      else skipped++;
    }
    return { raised, skipped };
  }

  // ------------------------------------------------------------------ delivery tracking

  /** Records a delivery stage (staff, or the supplier via the portal). */
  async track(purchaseOrderId: string, dto: { stage: DeliveryStage; reference?: string | null; expectedDate?: string | null; note?: string | null }, actor: SessionUser, viaPortal = false) {
    if (!STAGES.includes(dto.stage)) throw new BadRequestException('Unknown delivery stage');
    return this.ds.transaction(async (m) => {
      const po = await m.findOne(PurchaseOrder, { where: { id: purchaseOrderId }, lock: { mode: 'pessimistic_write' } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!viaPortal) StoreScope.assert(po.storeId);
      if (![PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.RECEIVED].includes(po.status)) throw new ConflictException(`PO is ${po.status}`);
      const row = await m.save(m.create(PurchaseOrderDelivery, { purchaseOrderId, stage: dto.stage, reference: dto.reference ?? null, expectedDate: dto.expectedDate ?? null, note: dto.note ?? null, recordedBy: actor.id, viaPortal }));
      po.deliveryStage = dto.stage;
      if (dto.stage === DeliveryStage.ACKNOWLEDGED && !po.acknowledgedAt) po.acknowledgedAt = new Date();
      if (dto.expectedDate) po.expectedDelivery = po.expectedDelivery ?? dto.expectedDate;
      await m.save(po);
      return row;
    });
  }

  deliveries(purchaseOrderId: string) {
    return this.ds.getRepository(PurchaseOrderDelivery).find({ where: { purchaseOrderId }, order: { at: 'ASC' } });
  }

  /** Open orders to national agencies with their latest delivery stage. */
  async agencyOrders() {
    return this.ds.query(
      `SELECT po.id, po.number, po.status, po.order_date AS "orderDate", po.expected_delivery AS "expectedDelivery", po.delivery_stage AS "deliveryStage",
              po.acknowledged_at AS "acknowledgedAt", po.total::float AS total, s.name AS supplier, s.national_agency AS agency, st.name AS store
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN store st ON st.id = po.store_id
        WHERE s.national_agency IS NOT NULL AND po.status NOT IN ('CANCELLED', 'REJECTED', 'CLOSED')
        ORDER BY po.order_date DESC LIMIT 500`,
    );
  }
}

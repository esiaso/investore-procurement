import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Permissions } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ReservationsService } from './reservations.service';
import { ISSUABLE, StoreRequisitionsService } from './store-requisitions.service';

/**
 * When stock arrives in a store (GRN, transfer receipt, receipt, department
 * return), open requisitions there are reserved again from the new stock
 * (job `stores.replan`), oldest/most urgent first, and the store is told
 * which back-orders can now be filled.
 */
@Injectable()
export class BackorderReplanService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly inventory: InventoryService,
    private readonly jobs: JobsService,
    private readonly reservations: ReservationsService,
    private readonly requisitions: StoreRequisitionsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.jobs.register('stores.replan', 'Re-reserve open back-orders after stock arrives', (d) =>
      this.replan(String(d.storeId), Array.isArray(d.itemIds) ? (d.itemIds as string[]) : undefined),
    );
    this.inventory.onStockArrived(async (storeId, itemIds) => {
      await this.jobs.enqueue('stores.replan', { storeId, itemIds }, { trigger: 'event' });
    });
  }

  async replan(storeId: string, itemIds?: string[]): Promise<{ requisitions: number; reserved: number; fillable: string[] }> {
    if (!(await this.settings.get('inventory.reserveOnApproval'))) return { requisitions: 0, reserved: 0, fillable: [] };
    const open: { id: string; number: string }[] = await this.ds.query(
      `SELECT DISTINCT r.id, r.number, r.priority, r.approved_at FROM store_requisition r
         JOIN store_requisition_line l ON l.requisition_id = r.id
        WHERE r.store_id = $1 AND r.status = ANY($2::store_requisition_status[])
          AND l.requested_qty - l.issued_qty - l.cancelled_qty > 0
          ${itemIds?.length ? 'AND l.item_id = ANY($3::uuid[])' : ''}
        ORDER BY r.priority DESC, r.approved_at`,
      itemIds?.length ? [storeId, ISSUABLE, itemIds] : [storeId, ISSUABLE],
    );
    const today = await this.settings.today();
    let reserved = 0;
    const fillable: string[] = [];
    for (const r of open) {
      await this.ds.transaction(async (m) => {
        const sr = await this.requisitions.lock(m, r.id);
        if (!ISSUABLE.includes(sr.status)) return;
        const before = await this.held(m, sr.id);
        await this.reservations.reserve(m, sr, today);
        const added = (await this.held(m, sr.id)) - before;
        if (added > 0) {
          reserved += added;
          if (sr.status === 'PARTIALLY_ISSUED') fillable.push(sr.number);
        }
      });
    }
    if (fillable.length) {
      const users: { user_id: string }[] = await this.ds.query(
        `SELECT DISTINCT us.user_id FROM user_store us JOIN user_role ur ON ur.user_id = us.user_id
           JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $2
           JOIN app_user u ON u.id = us.user_id AND u.is_active
          WHERE us.store_id = $1`,
        [storeId, Permissions.INVENTORY_ISSUE],
      );
      await this.notifications.notify(this.ds.manager, users.map((u) => u.user_id), {
        title: `Back-orders ready to fill: ${fillable.length}`,
        body: fillable.join(', '),
        link: '/backorders',
      });
    }
    return { requisitions: open.length, reserved: Math.round(reserved * 10_000) / 10_000, fillable };
  }

  private async held(m: EntityManager, requisitionId: string): Promise<number> {
    const [r] = await m.query(`SELECT COALESCE(SUM(quantity), 0)::float AS q FROM stock_reservation WHERE requisition_id = $1 AND released_at IS NULL`, [requisitionId]);
    return r.q;
  }
}

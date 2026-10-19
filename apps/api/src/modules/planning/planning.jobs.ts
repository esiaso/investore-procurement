import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotificationCategory, Permissions } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from '../jobs/jobs.service';
import { AmcService } from './amc.service';
import { ExpiryService } from './expiry.service';
import { ReorderService } from './reorder.service';

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Registers the stock-planning and reconciliation jobs (schedules: setting jobs.schedules). */
@Injectable()
export class PlanningJobs implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly jobs: JobsService,
    private readonly amc: AmcService,
    private readonly reorder: ReorderService,
    private readonly expiry: ExpiryService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.jobs.register('stock.amc', 'Recalculate AMC and AUTO reorder levels', (d) => this.amc.recalc(str(d.storeId)));
    this.jobs.register('stock.reorder', 'Reorder and stock-out alerts', (d) => this.reorder.scan(str(d.storeId)));
    this.jobs.register('stock.expiry', 'Hold expired batches; near-expiry alerts', () => this.expiry.scan());
    this.jobs.register('inventory.reconcile', 'Check balances and reservations against the ledger (report only)', (d) => this.reconcile(str(d.storeId)));
  }

  /** Report-only reconciliation; tells reconcilers when anything drifted. Repairs stay manual (audited endpoint). */
  private async reconcile(storeId?: string) {
    const r = await this.inventory.reconcile(storeId, false);
    const problems = r.driftCount + r.reservationDriftCount + r.overReservedCount;
    if (problems > 0) {
      const users: { id: string }[] = await this.ds.query(
        `SELECT DISTINCT ur.user_id AS id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
           JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
        [Permissions.INVENTORY_RECONCILE],
      );
      await this.notifications.dispatch(this.ds.manager, users.map((u) => u.id), NotificationCategory.JOBS, {
        title: `Stock reconciliation found ${problems} problem${problems === 1 ? '' : 's'}`,
        body: `${r.driftCount} balance drift, ${r.reservationDriftCount} reservation drift, ${r.overReservedCount} over-reserved row(s)`,
        link: '/stock',
      });
    }
    return { checked: r.checked, driftCount: r.driftCount, reservationDriftCount: r.reservationDriftCount, overReservedCount: r.overReservedCount };
  }
}

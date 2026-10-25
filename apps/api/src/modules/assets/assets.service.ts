import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AssetStatus, AttachmentOwner, DocumentType, Permissions, SessionUser } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { AttachmentsService } from '../files/attachments.service';
import { JobsService } from '../jobs/jobs.service';
import { NumberingService } from '../numbering/numbering.service';
import { GoodsReceivedNote, GrnLine } from '../purchasing/purchasing.entities';
import { GrnsService } from '../purchasing/grns.service';
import { SettingsService } from '../settings/settings.service';
import { Asset, AssetMaintenance, AssetMovement } from './assets.entities';

/** YYYY-MM-DD plus whole months (end of month clamps). */
export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Dates within `days` of today that have not been alerted for yet. */
export function dueForAlert(date: string | null, alertedFor: string | null, today: string, days: number): boolean {
  if (!date || alertedFor === date) return false;
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return date <= limit;
}

type Location = AssetMovement['toLocation'];

/**
 * Basic asset register: assets are created from posted GRN lines of asset
 * categories (one per unit), then moved between locations / custodians and
 * maintained; warranty and maintenance due dates raise alerts. No depreciation.
 */
@Injectable()
export class AssetsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly grns: GrnsService,
    private readonly attachments: AttachmentsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.grns.registerPostHook((m, grn, lines) => this.fromGrn(m, grn, lines).then(() => undefined));
    this.attachments.registerOwner(AttachmentOwner.ASSET, {
      read: [Permissions.ASSETS_READ],
      write: [Permissions.ASSETS_MANAGE],
      visible: async (m, id) => (await m.query(`SELECT 1 FROM asset WHERE id = $1`, [id])).length > 0,
    });
    this.jobs.register('assets.alerts', 'Warranties ending and maintenance falling due', () => this.alerts());
  }

  /** One asset per received base unit of an asset-category item. */
  async fromGrn(m: EntityManager, grn: GoodsReceivedNote, lines: GrnLine[]): Promise<number> {
    const codes = await this.settings.get('assets.categoryCodes', m);
    if (!codes.length) return 0;
    let n = 0;
    for (const l of lines) {
      if (l.acceptedBaseQty <= 0) continue;
      const [item] = await m.query(`SELECT i.id, i.name, i.manufacturer, c.code FROM item i JOIN item_category c ON c.id = i.category_id WHERE i.id = $1`, [l.itemId]);
      if (!item || !codes.includes(item.code)) continue;
      const units = Math.floor(l.acceptedBaseQty + 1e-9);
      if (units !== l.acceptedBaseQty) throw new BadRequestException(`${item.name}: assets are received in whole units`);
      for (let i = 0; i < units; i++) {
        await m.save(
          m.create(Asset, {
            tagNo: await this.numbering.next(DocumentType.ASSET, { manager: m }),
            itemId: l.itemId,
            description: item.name,
            model: item.manufacturer ?? null,
            grnId: grn.id,
            grnLineId: l.id,
            supplierId: grn.supplierId,
            acquiredOn: grn.receivedDate,
            cost: Math.round((l.unitPrice / l.conversionFactor) * 10_000) / 10_000,
            storeId: grn.storeId,
            status: AssetStatus.ACTIVE,
          }),
        );
        n++;
      }
    }
    return n;
  }

  async update(id: string, dto: Partial<Pick<Asset, 'serialNo' | 'model' | 'description' | 'warrantyEndsOn' | 'maintenanceIntervalMonths' | 'nextMaintenanceOn' | 'status' | 'notes'>>) {
    const repo = this.ds.getRepository(Asset);
    const a = await repo.findOneBy({ id });
    if (!a) throw new NotFoundException('Asset not found');
    if (a.status === AssetStatus.DISPOSED) throw new ConflictException('The asset has been disposed of');
    if (dto.serialNo && (await repo.createQueryBuilder('a').where('a.item_id = :i AND a.serial_no = :s AND a.id <> :id', { i: a.itemId, s: dto.serialNo, id }).getExists())) {
      throw new ConflictException('Another asset of this item has that serial number');
    }
    Object.assign(a, dto);
    // First schedule: last maintenance (or acquisition) + interval.
    if (dto.maintenanceIntervalMonths && !dto.nextMaintenanceOn && !a.nextMaintenanceOn) a.nextMaintenanceOn = addMonthsIso(a.lastMaintenanceOn ?? a.acquiredOn, dto.maintenanceIntervalMonths);
    if (dto.warrantyEndsOn !== undefined) a.warrantyAlertedFor = null;
    if (dto.nextMaintenanceOn !== undefined) a.maintenanceAlertedFor = null;
    await repo.save(a);
    return this.get(id);
  }

  /** Transfer to another location and / or custodian (history kept). */
  async move(id: string, dto: Location & { reason: string; movedOn?: string }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const a = await m.findOne(Asset, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('Asset not found');
      if (a.status === AssetStatus.DISPOSED) throw new ConflictException('The asset has been disposed of');
      if (!dto.storeId && !dto.departmentId) throw new BadRequestException('Choose a store or a department');
      let custodianName = dto.custodianName ?? null;
      if (dto.custodianUserId && !custodianName) custodianName = (await m.query(`SELECT full_name FROM app_user WHERE id = $1`, [dto.custodianUserId]))[0]?.full_name ?? null;
      const from: Location = { storeId: a.storeId, departmentId: a.departmentId, location: a.location, custodianUserId: a.custodianUserId, custodianName: a.custodianName };
      const to: Location = { storeId: dto.storeId ?? null, departmentId: dto.departmentId ?? null, location: dto.location ?? null, custodianUserId: dto.custodianUserId ?? null, custodianName };
      await m.save(m.create(AssetMovement, { assetId: id, movedOn: dto.movedOn ?? (await this.settings.today(m)), fromLocation: from, toLocation: to, reason: dto.reason, movedBy: actor.id }));
      Object.assign(a, to);
      await m.save(a);
    });
    return this.get(id);
  }

  async maintain(id: string, dto: { performedOn?: string; kind: string; performedBy?: string | null; cost?: number | null; notes?: string | null; nextDueOn?: string | null }) {
    await this.ds.transaction(async (m) => {
      const a = await m.findOne(Asset, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('Asset not found');
      const performedOn = dto.performedOn ?? (await this.settings.today(m));
      const next = dto.nextDueOn ?? (a.maintenanceIntervalMonths ? addMonthsIso(performedOn, a.maintenanceIntervalMonths) : null);
      await m.save(m.create(AssetMaintenance, { assetId: id, performedOn, kind: dto.kind, performedBy: dto.performedBy ?? null, cost: dto.cost ?? null, notes: dto.notes ?? null, nextDueOn: next }));
      Object.assign(a, { lastMaintenanceOn: performedOn, nextMaintenanceOn: next, maintenanceAlertedFor: null, status: a.status === AssetStatus.IN_REPAIR ? AssetStatus.ACTIVE : a.status });
      await m.save(a);
    });
    return this.get(id);
  }

  async get(id: string) {
    const a = await this.ds.getRepository(Asset).findOne({ where: { id }, relations: { item: true, store: true, department: true, supplier: true } });
    if (!a) throw new NotFoundException('Asset not found');
    const movements = await this.ds.getRepository(AssetMovement).find({ where: { assetId: id }, order: { movedOn: 'DESC', createdAt: 'DESC' } });
    const maintenance = await this.ds.getRepository(AssetMaintenance).find({ where: { assetId: id }, order: { performedOn: 'DESC' } });
    const [grn] = a.grnId ? await this.ds.query(`SELECT id, number FROM goods_received_note WHERE id = $1`, [a.grnId]) : [];
    return { ...a, movements, maintenance, grn: grn ?? null };
  }

  list(q: { search?: string; storeId?: string; departmentId?: string; status?: string; due?: string }) {
    const qb = this.ds.getRepository(Asset).createQueryBuilder('a').leftJoinAndSelect('a.item', 'item').leftJoinAndSelect('a.store', 'store').leftJoinAndSelect('a.department', 'department').orderBy('a.tag_no').take(2000);
    if (q.search) qb.andWhere('(a.tag_no ILIKE :q OR a.serial_no ILIKE :q OR a.description ILIKE :q)', { q: `%${q.search}%` });
    if (q.storeId) qb.andWhere('a.store_id = :s', { s: q.storeId });
    if (q.departmentId) qb.andWhere('a.department_id = :d', { d: q.departmentId });
    if (q.status) qb.andWhere('a.status = :st', { st: q.status });
    if (q.due === 'maintenance') qb.andWhere(`a.next_maintenance_on <= CURRENT_DATE + 30`);
    if (q.due === 'warranty') qb.andWhere(`a.warranty_ends_on <= CURRENT_DATE + 60`);
    return qb.getMany();
  }

  /** Job assets.alerts: warranty ending / maintenance due within the configured days, once per date. */
  async alerts(): Promise<{ warranty: number; maintenance: number }> {
    return this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      const wDays = await this.settings.get('assets.warrantyAlertDays', m);
      const mDays = await this.settings.get('assets.maintenanceAlertDays', m);
      const users: { id: string }[] = await m.query(
        `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role_permission rp ON rp.role_id = ur.role_id WHERE u.is_active AND rp.permission_code = $1`,
        [Permissions.ASSETS_MANAGE],
      );
      const ids = users.map((u) => u.id);
      const assets = await m.find(Asset, { where: { status: AssetStatus.ACTIVE } });
      let warranty = 0;
      let maintenance = 0;
      for (const a of assets) {
        if (dueForAlert(a.warrantyEndsOn, a.warrantyAlertedFor, today, wDays)) {
          a.warrantyAlertedFor = a.warrantyEndsOn;
          await this.notifications.notify(m, ids, { title: `Warranty of ${a.tagNo} ${a.description} ends ${a.warrantyEndsOn}`, body: 'Arrange any warranty repairs or an extended service contract.', link: `/assets/${a.id}` });
          warranty++;
        }
        if (dueForAlert(a.nextMaintenanceOn, a.maintenanceAlertedFor, today, mDays)) {
          a.maintenanceAlertedFor = a.nextMaintenanceOn;
          await this.notifications.notify(m, ids, { title: `Maintenance of ${a.tagNo} ${a.description} due ${a.nextMaintenanceOn}`, body: `${a.location ?? ''}`.trim() || 'Schedule the preventive maintenance.', link: `/assets/${a.id}` });
          maintenance++;
        }
        if (a.warrantyAlertedFor === a.warrantyEndsOn || a.maintenanceAlertedFor === a.nextMaintenanceOn) await m.save(a);
      }
      return { warranty, maintenance };
    });
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { AdjustmentStatus, BatchHoldStatus, SessionUser, StockAlertType, ValuationMethod } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AdjustmentsService } from '../inventory/adjustments.service';
import { Batch } from '../inventory/inventory.entities';
import { TransfersService } from '../inventory/transfers.service';
import { PdfService } from '../mail/pdf.service';
import { SettingsService } from '../settings/settings.service';
import { AlertsService, NewAlert } from './alerts.service';
import { renderDisposalCertificateHtml } from './disposal-pdf';
import { crossedHorizons } from './planning-math';
import { ExpiryQueryDto, RedistributeDto, WriteOffDto } from './planning.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ExpiryRow {
  storeId: string;
  storeName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  batchId: string;
  batchNo: string;
  expiryDate: string;
  daysLeft: number;
  holdStatus: string;
  quantity: number;
  reserved: number;
  inQuarantine: number;
  unitCost: number;
  value: number;
  amc: number;
  /** Days this store needs to use the batch up at its AMC (null = no use). */
  daysToConsume: number | null;
  /** The batch will not be used up here before it expires. */
  atRisk: boolean;
  suggestedStore: { id: string; name: string; amc: number } | null;
  bins: { binId: string | null; binCode: string | null; quantity: number }[];
}

/**
 * Expiry engine: puts expired batches on hold (EXPIRED) and raises near-expiry
 * alerts once per batch × store × horizon. Horizons come from the item
 * category, else `inventory.expiryWarningDays`. Also the near-expiry report and
 * its actions (redistribute by transfer, write off by adjustment).
 */
@Injectable()
export class ExpiryService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly transfers: TransfersService,
    private readonly adjustments: AdjustmentsService,
    private readonly pdf: PdfService,
  ) {}

  async rows(m: EntityManager, q: ExpiryQueryDto, storeIds: string[] | null): Promise<ExpiryRow[]> {
    const today = await this.settings.today(m);
    const method = await this.settings.get('inventory.valuationMethod', m);
    const defaults = await this.settings.get('inventory.expiryWarningDays', m);
    const horizon = q.horizonDays ?? Math.max(...defaults);
    const params: unknown[] = [today, horizon];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = [`sb.on_hand > 0`, `b.expiry_date IS NOT NULL`, `b.expiry_date <= $1::date + $2::int`];
    if (!q.includeExpired) where.push(`b.expiry_date > $1::date`);
    if (storeIds !== null) where.push(`sb.store_id = ANY(${p(storeIds)}::uuid[])`);
    if (q.storeId) where.push(`sb.store_id = ${p(q.storeId)}`);
    if (q.categoryId) where.push(`i.category_id = ${p(q.categoryId)}`);
    if (q.search) {
      const t = p(`%${q.search.trim()}%`);
      where.push(`(i.name ILIKE ${t} OR i.code ILIKE ${t} OR b.batch_no ILIKE ${t})`);
    }
    const raw = await m.query(
      `SELECT sb.store_id AS "storeId", s.name AS "storeName", i.id AS "itemId", i.code AS "itemCode", i.name AS "itemName", u.code AS uom,
              b.id AS "batchId", b.batch_no AS "batchNo", to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
              (b.expiry_date - $1::date)::int AS "daysLeft", b.hold_status AS "holdStatus",
              SUM(sb.on_hand)::float AS quantity, SUM(sb.reserved)::float AS reserved,
              COALESCE(SUM(sb.on_hand) FILTER (WHERE bn.is_quarantine), 0)::float AS "inQuarantine",
              COALESCE(${method === ValuationMethod.FIFO ? 'b.unit_cost' : 'c.avg_cost'}, b.unit_cost)::float AS "unitCost",
              COALESCE(sis.amc, 0)::float AS amc,
              json_agg(json_build_object('binId', sb.bin_id, 'binCode', bn.code, 'quantity', sb.on_hand::float)) AS bins
         FROM stock_balance sb
         JOIN batch b ON b.id = sb.batch_id
         JOIN item i ON i.id = sb.item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         JOIN store s ON s.id = sb.store_id
         LEFT JOIN bin bn ON bn.id = sb.bin_id
         LEFT JOIN item_store_cost c ON c.store_id = sb.store_id AND c.item_id = sb.item_id
         LEFT JOIN store_item_setting sis ON sis.store_id = sb.store_id AND sis.item_id = sb.item_id
        WHERE ${where.join(' AND ')}
        GROUP BY sb.store_id, s.name, i.id, i.code, i.name, u.code, b.id, b.batch_no, b.expiry_date, b.hold_status, c.avg_cost, b.unit_cost, sis.amc
        ORDER BY b.expiry_date, s.name, i.name
        LIMIT 5000`,
      params,
    );
    // Store with the highest AMC for each item (redistribution target).
    const itemIds = [...new Set(raw.map((r: { itemId: string }) => r.itemId))];
    const amcs: { item_id: string; store_id: string; name: string; amc: number }[] = itemIds.length
      ? await m.query(
          `SELECT sis.item_id, sis.store_id, s.name, sis.amc::float AS amc FROM store_item_setting sis JOIN store s ON s.id = sis.store_id
            WHERE sis.item_id = ANY($1::uuid[]) AND sis.amc > 0 AND s.is_active ORDER BY sis.amc DESC`,
          [itemIds],
        )
      : [];
    return raw.map((r: Omit<ExpiryRow, 'value' | 'daysToConsume' | 'atRisk' | 'suggestedStore'>) => {
      const daily = r.amc / 30;
      const daysToConsume = daily > 0 ? Math.ceil(r.quantity / daily) : null;
      const best = amcs.find((a) => a.item_id === r.itemId && a.store_id !== r.storeId && a.amc > r.amc);
      return {
        ...r,
        value: round2(r.quantity * r.unitCost),
        daysToConsume,
        atRisk: r.daysLeft <= 0 || daysToConsume === null || daysToConsume > r.daysLeft,
        suggestedStore: best ? { id: best.store_id, name: best.name, amc: best.amc } : null,
      };
    });
  }

  report(q: ExpiryQueryDto, actor: SessionUser) {
    return this.rows(this.ds.manager, q, actor.storeIds);
  }

  /** Daily: hold expired batches, raise near-expiry alerts (once per horizon). Idempotent. */
  async scan(): Promise<{ heldExpired: number; expiredAlerts: number; nearExpiryAlerts: number; notified: number }> {
    const today = await this.settings.today();
    const defaults = await this.settings.get('inventory.expiryWarningDays');
    return this.ds.transaction(async (m) => {
      // 1. Expired batches go on hold (audited; issue/transfer already refuse them).
      const expired = await m.find(Batch, { where: { expiryDate: LessThanOrEqual(today), holdStatus: BatchHoldStatus.NONE } });
      for (const b of expired) {
        b.holdStatus = BatchHoldStatus.EXPIRED;
        b.holdReason = `Expired on ${b.expiryDate} (set automatically)`;
      }
      if (expired.length) await m.save(expired);

      const stock: { store_id: string; batch_id: string; item_id: string; batch_no: string; item_name: string; uom: string; expiry: string; days_left: number; qty: number; value: number; horizons: number[] | null }[] =
        await m.query(
          `SELECT sb.store_id, b.id AS batch_id, b.item_id, b.batch_no, i.name AS item_name, u.code AS uom,
                  to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry, (b.expiry_date - $1::date)::int AS days_left,
                  SUM(sb.on_hand)::float AS qty, SUM(sb.on_hand * COALESCE(c.avg_cost, b.unit_cost))::float AS value, cat.expiry_alert_days AS horizons
             FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id JOIN item i ON i.id = b.item_id
             JOIN item_category cat ON cat.id = i.category_id JOIN unit_of_measure u ON u.id = i.base_uom_id
             LEFT JOIN item_store_cost c ON c.store_id = sb.store_id AND c.item_id = sb.item_id
            WHERE sb.on_hand > 0 AND b.expiry_date IS NOT NULL
            GROUP BY sb.store_id, b.id, b.item_id, b.batch_no, i.name, u.code, b.expiry_date, cat.expiry_alert_days`,
          [today],
        );
      const alerts: NewAlert[] = [];
      for (const s of stock) {
        if (s.days_left <= 0) {
          alerts.push({
            type: StockAlertType.EXPIRED,
            storeId: s.store_id,
            itemId: s.item_id,
            batchId: s.batch_id,
            dedupeKey: `EXPIRED|${s.store_id}|${s.batch_id}`,
            message: `${s.item_name} batch ${s.batch_no}: ${s.qty} ${s.uom} expired on ${s.expiry}`,
            details: { quantity: s.qty, expiryDate: s.expiry },
            value: Math.round(s.value * 100) / 100,
          });
          continue;
        }
        for (const h of crossedHorizons(s.days_left, s.horizons?.length ? s.horizons : defaults)) {
          alerts.push({
            type: StockAlertType.NEAR_EXPIRY,
            storeId: s.store_id,
            itemId: s.item_id,
            batchId: s.batch_id,
            horizonDays: h,
            dedupeKey: `NEAR_EXPIRY|${s.store_id}|${s.batch_id}|${h}`,
            message: `${s.item_name} batch ${s.batch_no}: ${s.qty} ${s.uom} expires ${s.expiry} (${s.days_left} days, within ${h})`,
            details: { quantity: s.qty, expiryDate: s.expiry, daysLeft: s.days_left },
            value: Math.round(s.value * 100) / 100,
          });
        }
      }
      const created = await this.alerts.raise(m, alerts);
      // A batch first seen inside several horizons is announced once, at the tightest.
      const tightest = new Map<string, (typeof created)[number]>();
      for (const a of created) {
        const key = `${a.type}|${a.storeId}|${a.batchId}`;
        const prev = tightest.get(key);
        if (!prev || (a.horizonDays ?? 0) < (prev.horizonDays ?? 0)) tightest.set(key, a);
      }
      const notified = await this.alerts.notify(m, [...tightest.values()]);
      return {
        heldExpired: expired.length,
        expiredAlerts: created.filter((a) => a.type === StockAlertType.EXPIRED).length,
        nearExpiryAlerts: created.filter((a) => a.type === StockAlertType.NEAR_EXPIRY).length,
        notified,
      };
    });
  }

  /** Sends near-expiry stock to a store that uses more of it (a transfer the source raises and dispatches). */
  async redistribute(dto: RedistributeDto, actor: SessionUser) {
    StoreScope.assert(dto.fromStoreId);
    const batch = await this.ds.getRepository(Batch).findOneBy({ id: dto.batchId });
    if (!batch) throw new NotFoundException('Batch not found');
    return this.transfers.request(
      {
        fromStoreId: dto.fromStoreId,
        toStoreId: dto.toStoreId,
        notes: dto.notes ?? `Redistribution of batch ${batch.batchNo} (expires ${batch.expiryDate}) to a store that uses more`,
        lines: [{ itemId: batch.itemId, quantity: dto.quantity }],
      },
      actor,
      { pushedBySource: true },
    );
  }

  /** Write-off / disposal: an adjustment with the disposal reason, submitted for approval. */
  async writeOff(dto: WriteOffDto, actor: SessionUser) {
    StoreScope.assert(dto.storeId);
    const batches = await this.ds.getRepository(Batch).findBy({ id: In(dto.lines.map((l) => l.batchId)) });
    const reasonCode = await this.settings.get('stock.disposalReasonCode');
    return this.adjustments.create(
      {
        storeId: dto.storeId,
        reasonCode,
        notes: dto.notes ?? 'Disposal of expired / unusable stock',
        submit: true,
        lines: dto.lines.map((l) => {
          const b = batches.find((x) => x.id === l.batchId);
          if (!b) throw new NotFoundException('Batch not found');
          return { itemId: b.itemId, batchId: b.id, binId: l.binId ?? null, quantity: -Math.abs(l.quantity) };
        }),
      },
      actor,
    );
  }

  /** PDF certificate for a posted disposal adjustment. */
  async disposalCertificate(adjustmentId: string): Promise<{ number: string; pdf: Buffer }> {
    const adj = await this.adjustments.get(adjustmentId);
    if (adj.status !== AdjustmentStatus.POSTED) throw new BadRequestException('The write-off must be approved and posted first');
    if (!(adj.lines ?? []).every((l) => l.quantity < 0)) throw new BadRequestException('Only stock write-offs have a disposal certificate');
    const ids = [adj.submittedBy, adj.firstApprovedBy, adj.secondApprovedBy].filter(Boolean) as string[];
    const users: { id: string; full_name: string }[] = ids.length ? await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [ids]) : [];
    const name = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? null;
    const [facility] = await this.ds.query(`SELECT f.name, f.address, f.phone, f.email FROM facility f JOIN store s ON s.facility_id = f.id WHERE s.id = $1`, [adj.storeId]);
    const [reason] = await this.ds.query(`SELECT name FROM adjustment_reason WHERE code = $1`, [adj.reasonCode]);
    const html = renderDisposalCertificateHtml(adj, facility, {
      reason: reason?.name ?? adj.reasonCode,
      submittedBy: name(adj.submittedBy),
      approvedBy: [name(adj.firstApprovedBy), name(adj.secondApprovedBy)].filter(Boolean) as string[],
      currency: await this.settings.get('locale.currency'),
      dateFormat: await this.settings.get('locale.dateFormat'),
      timezone: await this.settings.get('locale.timezone'),
    });
    return { number: adj.number, pdf: await this.pdf.render(html) };
  }
}

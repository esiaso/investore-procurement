import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { DocumentType, Permissions, SessionUser, ShipmentStatus } from '@sil/shared';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { NumberingService } from '../numbering/numbering.service';
import { PurchaseOrder, PurchaseOrderLine } from '../purchasing/purchasing.entities';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { SettingsService } from '../settings/settings.service';
import { InboundShipment, InboundShipmentLine } from './logistics.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const CLOSED = [ShipmentStatus.RECEIVED, ShipmentStatus.CANCELLED];

/** Status of a shipment from what has been received against its lines and the date. */
export function shipmentStatus(lines: { quantity: number; receivedQty: number }[], expectedOn: string, today: string, graceDays: number, inTransit: boolean): ShipmentStatus {
  const received = lines.reduce((s, l) => s + l.receivedQty, 0);
  if (lines.length && lines.every((l) => l.receivedQty + 1e-9 >= l.quantity)) return ShipmentStatus.RECEIVED;
  if (received > 0) return ShipmentStatus.PARTIALLY_RECEIVED;
  const due = new Date(Date.parse(`${expectedOn}T00:00:00Z`) + graceDays * 86_400_000).toISOString().slice(0, 10);
  if (due < today) return ShipmentStatus.DELAYED;
  return inTransit ? ShipmentStatus.IN_TRANSIT : ShipmentStatus.EXPECTED;
}

/**
 * Inbound shipments against purchase orders: expected dates (with the history
 * of changes), delays, partial deliveries, and the supplier lead-time history
 * that feeds scorecards and default delivery dates.
 */
@Injectable()
export class ShipmentsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly orders: PurchaseOrdersService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  async create(dto: { purchaseOrderId: string; shippedOn?: string | null; expectedOn: string; carrier?: string | null; trackingRef?: string | null; notes?: string | null; lines?: { poLineId: string; quantity: number }[] }, _actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const po = await m.findOneBy(PurchaseOrder, { id: dto.purchaseOrderId });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po.status}`);
      const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
      // Default: everything still outstanding (base units).
      const wanted = dto.lines?.length
        ? dto.lines
        : poLines.map((l) => ({ poLineId: l.id, quantity: round4(l.quantity * l.conversionFactor - l.receivedBaseQty) })).filter((l) => l.quantity > 0);
      if (!wanted.length) throw new BadRequestException('Nothing is outstanding on this order');
      for (const w of wanted) {
        const pl = poLines.find((p) => p.id === w.poLineId);
        if (!pl) throw new BadRequestException('A line is not on this PO');
        const outstanding = round4(pl.quantity * pl.conversionFactor - pl.receivedBaseQty);
        if (w.quantity <= 0 || w.quantity > outstanding + 1e-9) throw new BadRequestException(`Line ${pl.lineNo}: at most ${outstanding} base units are outstanding`);
      }
      const today = await this.settings.today(m);
      const s = await m.save(
        m.create(InboundShipment, {
          number: await this.numbering.next(DocumentType.SHIPMENT, { manager: m }),
          purchaseOrderId: po.id,
          supplierId: po.supplierId,
          shippedOn: dto.shippedOn ?? null,
          expectedOn: dto.expectedOn,
          carrier: dto.carrier ?? null,
          trackingRef: dto.trackingRef ?? null,
          notes: dto.notes ?? null,
          status: dto.shippedOn && dto.shippedOn <= today ? ShipmentStatus.IN_TRANSIT : ShipmentStatus.EXPECTED,
          lines: wanted.map((w) => m.create(InboundShipmentLine, { poLineId: w.poLineId, quantity: w.quantity, receivedQty: 0 })),
        }),
      );
      await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.SHIPMENT, id: s.id, no: s.number });
      return s.id;
    });
    return this.get(id);
  }

  /** New expected date (the old one is kept with the reason), carrier details, shipped date. */
  async update(id: string, dto: { expectedOn?: string; reason?: string | null; shippedOn?: string | null; carrier?: string | null; trackingRef?: string | null; notes?: string | null }) {
    await this.ds.transaction(async (m) => {
      const s = await m.findOne(InboundShipment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('Shipment not found');
      if (CLOSED.includes(s.status)) throw new ConflictException(`Shipment is ${s.status}`);
      if (dto.expectedOn && dto.expectedOn !== s.expectedOn) {
        s.expectedHistory = [...s.expectedHistory, { date: s.expectedOn, reason: dto.reason ?? null, at: new Date().toISOString() }];
        s.expectedOn = dto.expectedOn;
        s.delayNotifiedFor = null;
      }
      for (const k of ['shippedOn', 'carrier', 'trackingRef', 'notes'] as const) if (dto[k] !== undefined) (s as never as Record<string, unknown>)[k] = dto[k];
      await this.refresh(m, s);
    });
    return this.get(id);
  }

  async cancel(id: string, reason: string) {
    await this.ds.transaction(async (m) => {
      const s = await m.findOne(InboundShipment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('Shipment not found');
      if (CLOSED.includes(s.status)) throw new ConflictException(`Shipment is ${s.status}`);
      Object.assign(s, { status: ShipmentStatus.CANCELLED, notes: [s.notes, `Cancelled: ${reason}`].filter(Boolean).join('\n') });
      await m.save(s);
    });
    return this.get(id);
  }

  private async refresh(m: EntityManager, s: InboundShipment) {
    const lines = await m.find(InboundShipmentLine, { where: { shipmentId: s.id } });
    const today = await this.settings.today(m);
    s.status = shipmentStatus(lines, s.expectedOn, today, await this.settings.get('shipments.delayGraceDays', m), !!s.shippedOn && s.shippedOn <= today);
    if (s.status === ShipmentStatus.RECEIVED) s.receivedAt ??= new Date();
    await m.save(s);
  }

  /** GRN posted against the shipment: received quantities go onto its lines. */
  async applyReceipt(m: EntityManager, shipmentId: string, received: { poLineId: string; baseQty: number }[]) {
    const s = await m.findOne(InboundShipment, { where: { id: shipmentId }, lock: { mode: 'pessimistic_write' } });
    if (!s || CLOSED.includes(s.status)) return;
    const lines = await m.find(InboundShipmentLine, { where: { shipmentId } });
    for (const r of received) {
      const l = lines.find((x) => x.poLineId === r.poLineId);
      if (!l) continue;
      l.receivedQty = round4(l.receivedQty + r.baseQty);
      await m.save(l);
    }
    await this.refresh(m, s);
  }

  /** Job shipments.delays: flags overdue shipments and tells the buyers once per expected date. */
  async flagDelays(): Promise<{ checked: number; delayed: number; notified: number }> {
    return this.ds.transaction(async (m) => {
      const open = await m.find(InboundShipment, { where: { status: Not(In(CLOSED)) }, relations: { supplier: true } });
      let delayed = 0;
      let notified = 0;
      const buyers: { id: string }[] = await m.query(
        `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role_permission rp ON rp.role_id = ur.role_id WHERE u.is_active AND rp.permission_code = $1`,
        [Permissions.SHIPMENTS_MANAGE],
      );
      for (const s of open) {
        await this.refresh(m, s);
        if (s.status !== ShipmentStatus.DELAYED) continue;
        delayed++;
        if (s.delayNotifiedFor === s.expectedOn) continue;
        s.delayNotifiedFor = s.expectedOn;
        await m.save(s);
        await this.notifications.notify(m, buyers.map((b) => b.id), { title: `Shipment ${s.number} from ${s.supplier?.name ?? ''} is late`, body: `It was expected on ${s.expectedOn}. Chase the supplier or update the date.`, link: `/shipments/${s.id}` });
        notified++;
      }
      return { checked: open.length, delayed, notified };
    });
  }

  async get(id: string) {
    const s = await this.ds.getRepository(InboundShipment).findOne({ where: { id }, relations: { supplier: true, purchaseOrder: true, lines: true } });
    if (!s) throw new NotFoundException('Shipment not found');
    const poLines: { id: string; line_no: number; item: string; uom: string }[] = await this.ds.query(
      `SELECT l.id, l.line_no, i.name AS item, u.code AS uom FROM purchase_order_line l JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = i.base_uom_id WHERE l.id = ANY($1::uuid[])`,
      [(s.lines ?? []).map((l) => l.poLineId)],
    );
    const grns = await this.ds.query(`SELECT id, number, status, received_date AS "receivedDate" FROM goods_received_note WHERE shipment_id = $1 ORDER BY received_date`, [id]);
    return { ...s, lines: (s.lines ?? []).map((l) => ({ ...l, ...(() => { const p = poLines.find((x) => x.id === l.poLineId); return { lineNo: p?.line_no, item: p?.item, uom: p?.uom }; })() })), grns };
  }

  list(q: { status?: string; supplierId?: string; purchaseOrderId?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.purchaseOrderId) where.purchaseOrderId = q.purchaseOrderId;
    return this.ds.getRepository(InboundShipment).find({ where, relations: { supplier: true, purchaseOrder: true }, order: { expectedOn: 'ASC' }, take: 1000 });
  }

  /**
   * Lead-time history per supplier: days from the PO being sent to its first
   * posted GRN, over the configured months; and how many shipments were late.
   */
  async leadTimes(supplierId?: string, m: EntityManager = this.ds.manager) {
    const months = await this.settings.get('shipments.leadTimeHistoryMonths', m);
    const params: unknown[] = [months];
    if (supplierId) params.push(supplierId);
    return m.query(
      `WITH first_grn AS (SELECT purchase_order_id, MIN(received_date) AS d FROM goods_received_note WHERE status = 'POSTED' AND purchase_order_id IS NOT NULL GROUP BY purchase_order_id),
            lt AS (SELECT po.supplier_id, (fg.d - COALESCE(po.sent_at::date, po.order_date)) AS days, po.expected_delivery, fg.d
                     FROM purchase_order po JOIN first_grn fg ON fg.purchase_order_id = po.id
                    WHERE fg.d >= (CURRENT_DATE - ($1::int * INTERVAL '1 month'))::date ${supplierId ? 'AND po.supplier_id = $2' : ''})
       SELECT s.id AS "supplierId", s.name AS supplier, count(lt.*)::int AS orders,
              round(avg(lt.days)::numeric, 1)::float AS "avgDays", min(lt.days)::int AS "minDays", max(lt.days)::int AS "maxDays",
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY lt.days)::numeric, 1)::float AS "p90Days",
              count(*) FILTER (WHERE lt.expected_delivery IS NOT NULL AND lt.d > lt.expected_delivery)::int AS late,
              (SELECT count(*)::int FROM inbound_shipment sh WHERE sh.supplier_id = s.id AND (sh.status = 'DELAYED' OR jsonb_array_length(sh.expected_history) > 0)) AS "delayedShipments",
              s.observed_lead_time_days AS "observedLeadTimeDays"
         FROM lt JOIN supplier s ON s.id = lt.supplier_id
        GROUP BY s.id ORDER BY s.name`,
      params,
    );
  }

  /** Job suppliers.leadtimes: stores each supplier's average lead time (used as the default delivery date on new POs). */
  async updateObservedLeadTimes(): Promise<{ suppliers: number }> {
    return this.ds.transaction(async (m) => {
      const rows: { supplierId: string; avgDays: number }[] = await this.leadTimes(undefined, m);
      for (const r of rows) await m.query(`UPDATE supplier SET observed_lead_time_days = $2 WHERE id = $1`, [r.supplierId, Math.max(0, Math.round(r.avgDays))]);
      return { suppliers: rows.length };
    });
  }
}

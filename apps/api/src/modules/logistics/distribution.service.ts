import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DistributionRunStatus, DocumentType, SessionUser, StopStatus, TransferStatus } from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead } from '../../common/html';
import { StoreScope } from '../../common/store-scope';
import { StockTransfer, StockTransferLine } from '../inventory/documents.entities';
import { allocateFefo, loadFefoCandidates } from '../inventory/fefo';
import { TransfersService } from '../inventory/transfers.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryRoute, DistributionRun, DistributionStop, StopPick } from './logistics.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Stop order: the route's order first, then the rest by store name. */
export function orderStops<T extends { toStoreId: string; storeName: string }>(stops: T[], routeOrder: string[]): T[] {
  const rank = (id: string) => {
    const i = routeOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...stops].sort((a, b) => rank(a.toStoreId) - rank(b.toStoreId) || a.storeName.localeCompare(b.storeName));
}

@Injectable()
export class DistributionService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly transfers: TransfersService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
  ) {}

  // ------------------------------------------------------------------ routes

  routes() {
    return this.ds.getRepository(DeliveryRoute).find({ relations: { fromStore: true }, order: { code: 'ASC' } });
  }

  async saveRoute(id: string | null, dto: Partial<DeliveryRoute>) {
    const repo = this.ds.getRepository(DeliveryRoute);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Route not found');
    if (dto.stopStoreIds?.includes(dto.fromStoreId ?? row.fromStoreId)) throw new BadRequestException('A route cannot stop at its own store');
    return repo.save(Object.assign(row, dto));
  }

  /** Transfer requests from the store still waiting for a run. */
  async pending(fromStoreId: string) {
    StoreScope.assert(fromStoreId);
    return this.ds.query(
      `SELECT t.id, t.number, t.created_at AS "requestedAt", s.id AS "toStoreId", s.name AS "toStore", count(l.id)::int AS lines
         FROM stock_transfer t JOIN store s ON s.id = t.to_store_id JOIN stock_transfer_line l ON l.transfer_id = t.id
        WHERE t.from_store_id = $1 AND t.status = 'REQUESTED'
          AND NOT EXISTS (SELECT 1 FROM distribution_stop ds JOIN distribution_run r ON r.id = ds.run_id WHERE ds.transfer_id = t.id AND r.status <> 'CANCELLED')
        GROUP BY t.id, s.id ORDER BY s.name, t.created_at`,
      [fromStoreId],
    );
  }

  // ------------------------------------------------------------------ runs

  async create(dto: { fromStoreId: string; routeId?: string | null; runDate?: string; vehicle?: string | null; driver?: string | null; notes?: string | null; transferIds: string[] }, _actor: SessionUser) {
    StoreScope.assert(dto.fromStoreId);
    const id = await this.ds.transaction(async (m) => {
      const route = dto.routeId ? await m.findOneBy(DeliveryRoute, { id: dto.routeId }) : null;
      if (dto.routeId && !route) throw new NotFoundException('Route not found');
      if (route && route.fromStoreId !== dto.fromStoreId) throw new BadRequestException('The route starts at another store');
      const transfers = await m.find(StockTransfer, { where: { id: In(dto.transferIds) }, relations: { toStore: true } });
      if (transfers.length !== new Set(dto.transferIds).size) throw new BadRequestException('A transfer was not found');
      for (const t of transfers) {
        if (t.fromStoreId !== dto.fromStoreId) throw new BadRequestException(`${t.number} is from another store`);
        if (t.status !== TransferStatus.REQUESTED) throw new ConflictException(`${t.number} is ${t.status}`);
      }
      const busy = await m.query(
        `SELECT t.number FROM distribution_stop s JOIN distribution_run r ON r.id = s.run_id JOIN stock_transfer t ON t.id = s.transfer_id WHERE s.transfer_id = ANY($1::uuid[]) AND r.status <> 'CANCELLED'`,
        [dto.transferIds],
      );
      if (busy.length) throw new ConflictException(`${busy[0].number} is already on a run`);
      const ordered = orderStops(transfers.map((t) => ({ t, toStoreId: t.toStoreId, storeName: t.toStore?.name ?? '' })), route?.stopStoreIds ?? []);
      const run = await m.save(
        m.create(DistributionRun, {
          number: await this.numbering.next(DocumentType.DISTRIBUTION_RUN, { storeId: dto.fromStoreId, manager: m }),
          routeId: route?.id ?? null,
          fromStoreId: dto.fromStoreId,
          runDate: dto.runDate ?? (await this.settings.today(m)),
          vehicle: dto.vehicle ?? null,
          driver: dto.driver ?? null,
          notes: dto.notes ?? null,
          status: DistributionRunStatus.PLANNED,
          stops: ordered.map((o, i) => m.create(DistributionStop, { sequence: i + 1, transferId: o.t.id, toStoreId: o.t.toStoreId, status: StopStatus.PENDING })),
        }),
      );
      return run.id;
    });
    return this.get(id);
  }

  private async lockRun(m: EntityManager, id: string) {
    const r = await m.findOne(DistributionRun, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Distribution run not found');
    StoreScope.assert(r.fromStoreId);
    return r;
  }

  private async stopOf(m: EntityManager, runId: string, stopId: string) {
    const s = await m.findOne(DistributionStop, { where: { id: stopId, runId }, lock: { mode: 'pessimistic_write' } });
    if (!s) throw new NotFoundException('Stop not found');
    return s;
  }

  /**
   * Picking list: per stop and transfer line, the FEFO batches and bins to
   * take (or the picks already confirmed), with shortfalls.
   */
  async pickingList(id: string) {
    const run = await this.get(id);
    const today = await this.settings.today();
    const stops = [];
    for (const s of run.stops ?? []) {
      const lines = await this.ds.getRepository(StockTransferLine).find({ where: { transferId: s.transferId }, relations: { item: { baseUom: true } } });
      const out = [];
      for (const l of lines) {
        const confirmed = s.picks.filter((p) => p.lineId === l.id);
        let picks: { batchId: string; binId: string | null; batchNo: string; expiryDate: string | null; quantity: number }[];
        let shortfall = 0;
        if (confirmed.length) {
          const meta: { id: string; batch_no: string; expiry: string | null }[] = await this.ds.query(`SELECT id, batch_no, to_char(expiry_date, 'YYYY-MM-DD') AS expiry FROM batch WHERE id = ANY($1::uuid[])`, [confirmed.map((p) => p.batchId)]);
          picks = confirmed.map((p) => ({ ...p, batchNo: meta.find((x) => x.id === p.batchId)?.batch_no ?? '', expiryDate: meta.find((x) => x.id === p.batchId)?.expiry ?? null }));
        } else {
          const fefo = allocateFefo(await loadFefoCandidates(this.ds.manager, l.itemId, run.fromStoreId, { purpose: 'TRANSFER', toStoreId: s.toStoreId } as never), l.requestedQty, today);
          picks = fefo.allocations;
          shortfall = fefo.shortfall;
        }
        const bins: { id: string; code: string }[] = await this.ds.query(`SELECT id, code FROM bin WHERE id = ANY($1::uuid[])`, [picks.map((p) => p.binId).filter(Boolean)]);
        out.push({
          lineId: l.id,
          itemId: l.itemId,
          itemCode: l.item?.code,
          itemName: l.item?.name,
          uom: l.item?.baseUom?.code,
          requested: l.requestedQty,
          confirmed: confirmed.length > 0,
          shortfall,
          picks: picks.map((p) => ({ ...p, binCode: bins.find((b) => b.id === p.binId)?.code ?? null })),
        });
      }
      stops.push({ stopId: s.id, sequence: s.sequence, status: s.status, transferNo: s.transfer?.number, toStore: s.toStore?.name, lines: out });
    }
    return { run: { id: run.id, number: run.number, runDate: run.runDate, fromStore: run.fromStore?.name, status: run.status }, stops };
  }

  /** Confirms the picks of a stop (default: the FEFO suggestion; quantities may be cut to what is there). */
  async pick(id: string, stopId: string, dto: { lines?: { lineId: string; quantity?: number; picks?: { batchId: string; binId?: string | null; quantity: number }[] }[] }, actor: SessionUser) {
    const list = await this.pickingList(id);
    await this.ds.transaction(async (m) => {
      const run = await this.lockRun(m, id);
      if (![DistributionRunStatus.PLANNED, DistributionRunStatus.PICKING].includes(run.status)) throw new ConflictException(`Run is ${run.status}`);
      const stop = await this.stopOf(m, id, stopId);
      if (![StopStatus.PENDING, StopStatus.PICKED].includes(stop.status)) throw new ConflictException(`Stop is ${stop.status}`);
      const suggested = list.stops.find((s) => s.stopId === stopId)!;
      const given = new Map((dto.lines ?? []).map((l) => [l.lineId, l]));
      const picks: StopPick[] = [];
      for (const line of suggested.lines) {
        const g = given.get(line.lineId);
        if (g?.picks?.length) {
          const total = round4(g.picks.reduce((s, p) => s + p.quantity, 0));
          if (total > line.requested + 1e-9) throw new BadRequestException(`${line.itemName}: more than requested`);
          picks.push(...g.picks.map((p) => ({ lineId: line.lineId, batchId: p.batchId, binId: p.binId ?? null, quantity: p.quantity })));
          continue;
        }
        let want = g?.quantity ?? line.requested;
        for (const p of line.picks) {
          if (want <= 0) break;
          const q = round4(Math.min(p.quantity, want));
          picks.push({ lineId: line.lineId, batchId: p.batchId, binId: p.binId, quantity: q });
          want = round4(want - q);
        }
      }
      Object.assign(stop, { picks, status: StopStatus.PICKED, pickedBy: actor.id });
      await m.save(stop);
      if (run.status === DistributionRunStatus.PLANNED) {
        run.status = DistributionRunStatus.PICKING;
        await m.save(run);
      }
    });
    return this.get(id);
  }

  async pack(id: string, stopId: string, dto: { packages: number; notes?: string | null }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const run = await this.lockRun(m, id);
      if (run.status !== DistributionRunStatus.PICKING) throw new ConflictException('Pick the stop first');
      const stop = await this.stopOf(m, id, stopId);
      if (stop.status !== StopStatus.PICKED) throw new ConflictException(`Stop is ${stop.status}`);
      if (dto.packages < 1) throw new BadRequestException('At least one package');
      Object.assign(stop, { packages: dto.packages, status: StopStatus.PACKED, packedBy: actor.id, packedAt: new Date(), podNotes: dto.notes ?? stop.podNotes });
      await m.save(stop);
    });
    return this.get(id);
  }

  /** Dispatches every packed stop: each transfer leaves the store with its confirmed picks. */
  async dispatch(id: string, actor: SessionUser, dto: { fefoOverrideReason?: string; witness?: { username: string; password: string } } = {}) {
    const run = await this.get(id);
    if (run.status !== DistributionRunStatus.PICKING) throw new ConflictException(`Run is ${run.status}`);
    const stops = run.stops ?? [];
    if (!stops.length || stops.some((s) => s.status !== StopStatus.PACKED)) throw new BadRequestException('Pick and pack every stop before dispatch');
    for (const s of stops) {
      const byLine = new Map<string, StopPick[]>();
      for (const p of s.picks) byLine.set(p.lineId, [...(byLine.get(p.lineId) ?? []), p]);
      const lines = await this.ds.getRepository(StockTransferLine).find({ where: { transferId: s.transferId } });
      await this.transfers.dispatch(
        s.transferId,
        {
          lines: lines.map((l) => {
            const picks = byLine.get(l.id) ?? [];
            const quantity = round4(picks.reduce((x, p) => x + p.quantity, 0));
            return { lineId: l.id, quantity, picks: quantity > 0 ? picks.map((p) => ({ batchId: p.batchId, binId: p.binId, quantity: p.quantity })) : undefined };
          }),
          fefoOverrideReason: dto.fefoOverrideReason,
          witness: dto.witness,
        } as never,
        actor,
      );
      await this.ds.getRepository(DistributionStop).update(s.id, { status: StopStatus.DISPATCHED });
    }
    await this.ds.getRepository(DistributionRun).update(id, { status: DistributionRunStatus.DISPATCHED, dispatchedAt: new Date(), dispatchedBy: actor.id });
    return this.get(id);
  }

  /**
   * Proof of delivery at a stop: who received and signed, when, and what
   * actually arrived. Posts the transfer receipt (short quantities need a
   * discrepancy reason, as on any transfer receipt).
   */
  async deliver(
    id: string,
    stopId: string,
    dto: { receivedByName: string; signatureName: string; deliveredAt?: string; notes?: string | null; toBinId?: string | null; allocations?: { allocationId: string; receivedQty: number; discrepancyReasonCode?: string; discrepancyNotes?: string }[]; witness?: { username: string; password: string } },
    actor: SessionUser,
  ) {
    const run = await this.ds.getRepository(DistributionRun).findOne({ where: { id }, relations: { stops: true } });
    if (!run) throw new NotFoundException('Distribution run not found');
    if (run.status !== DistributionRunStatus.DISPATCHED) throw new ConflictException(`Run is ${run.status}`);
    const stop = run.stops?.find((s) => s.id === stopId);
    if (!stop) throw new NotFoundException('Stop not found');
    if (stop.status !== StopStatus.DISPATCHED) throw new ConflictException(`Stop is ${stop.status}`);
    const t = await this.transfers.receive(stop.transferId, { allocations: dto.allocations as never, toBinId: dto.toBinId ?? null, witness: dto.witness } as never, actor);
    const discrepancies = (t.lines ?? []).flatMap((l) =>
      (l.allocations ?? [])
        .filter((a) => (a.receivedQty ?? 0) < a.dispatchedQty)
        .map((a) => ({ allocationId: a.id, item: l.item?.name ?? '', batchNo: a.batch?.batchNo ?? '', dispatched: a.dispatchedQty, received: a.receivedQty ?? 0, reasonCode: a.discrepancyReasonCode, notes: a.discrepancyNotes })),
    );
    await this.ds.transaction(async (m) => {
      await m.update(DistributionStop, stop.id, {
        status: discrepancies.length ? StopStatus.DELIVERED_WITH_DISCREPANCY : StopStatus.DELIVERED,
        receivedByName: dto.receivedByName,
        signatureName: dto.signatureName,
        deliveredAt: dto.deliveredAt ? new Date(dto.deliveredAt) : new Date(),
        podRecordedBy: actor.id,
        podNotes: dto.notes ?? stop.podNotes,
        discrepancies,
      });
      const open: { n: number }[] = await m.query(`SELECT count(*)::int AS n FROM distribution_stop WHERE run_id = $1 AND status NOT IN ('DELIVERED', 'DELIVERED_WITH_DISCREPANCY')`, [id]);
      if (open[0].n === 0) await m.update(DistributionRun, id, { status: DistributionRunStatus.COMPLETED, completedAt: new Date() });
    });
    return this.get(id);
  }

  async cancel(id: string) {
    await this.ds.transaction(async (m) => {
      const r = await this.lockRun(m, id);
      if (![DistributionRunStatus.PLANNED, DistributionRunStatus.PICKING].includes(r.status)) throw new ConflictException('Only a run that has not left can be cancelled');
      r.status = DistributionRunStatus.CANCELLED;
      await m.save(r);
    });
    return this.get(id);
  }

  async get(id: string) {
    const r = await this.ds.getRepository(DistributionRun).findOne({
      where: { id },
      relations: { fromStore: true, route: true, stops: { toStore: true, transfer: true } },
      order: { stops: { sequence: 'ASC' } },
    });
    if (!r) throw new NotFoundException('Distribution run not found');
    const scope = StoreScope.current();
    if (scope !== null && !scope.includes(r.fromStoreId) && !(r.stops ?? []).some((s) => scope.includes(s.toStoreId))) throw new NotFoundException('Distribution run not found');
    return r;
  }

  list(q: { status?: string; storeId?: string }) {
    const qb = this.ds.getRepository(DistributionRun).createQueryBuilder('r').leftJoinAndSelect('r.fromStore', 'fromStore').leftJoinAndSelect('r.stops', 'stops').leftJoinAndSelect('stops.toStore', 'toStore').orderBy('r.run_date', 'DESC').addOrderBy('stops.sequence', 'ASC').take(300);
    const scope = StoreScope.current();
    if (scope !== null) qb.andWhere('(r.from_store_id IN (:...sc) OR EXISTS (SELECT 1 FROM distribution_stop x WHERE x.run_id = r.id AND x.to_store_id IN (:...sc)))', { sc: scope.length ? scope : ['00000000-0000-0000-0000-000000000000'] });
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    if (q.storeId) qb.andWhere('r.from_store_id = :st', { st: q.storeId });
    return qb.getMany();
  }

  /** Dispatch note / delivery manifest: stops, packages, lines with batches, signature blocks. */
  async dispatchNote(id: string): Promise<{ number: string; pdf: Buffer }> {
    const run = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const sections = [];
    for (const s of run.stops ?? []) {
      const rows: { item: string; code: string; batch: string; expiry: string | null; qty: number; uom: string }[] = await this.ds.query(
        `SELECT i.name AS item, i.code, b.batch_no AS batch, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry, a.dispatched_qty::float AS qty, u.code AS uom
           FROM stock_transfer_allocation a JOIN stock_transfer_line l ON l.id = a.line_id JOIN item i ON i.id = l.item_id
           JOIN unit_of_measure u ON u.id = i.base_uom_id JOIN batch b ON b.id = a.batch_id WHERE l.transfer_id = $1 ORDER BY i.name`,
        [s.transferId],
      );
      const picks = rows.length ? rows : s.picks.map((p) => ({ item: p.lineId, code: '', batch: p.batchId, expiry: null, qty: p.quantity, uom: '' }));
      sections.push(`<h3>Stop ${s.sequence}: ${esc(s.toStore?.name)} — ${esc(s.transfer?.number)} · ${s.packages} package(s)</h3>
        <table><thead><tr><th>Code</th><th>Item</th><th>Batch</th><th>Expiry</th><th class="r">Qty</th><th>Unit</th><th class="r">Received</th></tr></thead>
        <tbody>${picks.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.item)}</td><td>${esc(r.batch)}</td><td>${d(r.expiry)}</td><td class="r">${r.qty}</td><td>${esc(r.uom)}</td><td></td></tr>`).join('')}</tbody></table>
        ${s.deliveredAt ? `<p>Received by ${esc(s.receivedByName)} (signed ${esc(s.signatureName)}) on ${d(s.deliveredAt)}</p>` : '<div class="signs"><div class="sign">Received by (name, signature, date &amp; time)</div><div class="sign">Discrepancies noted</div></div>'}`);
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">DISPATCH NOTE / DELIVERY MANIFEST</h1>
      <div class="grid"><div class="box">Run: <b>${esc(run.number)}</b><br>From: ${esc(run.fromStore?.name)}<br>Date: ${d(run.runDate)}</div>
      <div class="box">Route: ${esc(run.route?.name ?? '—')}<br>Vehicle: ${esc(run.vehicle ?? '—')}<br>Driver: ${esc(run.driver ?? '—')}</div></div>
      ${sections.join('')}
      <div class="signs"><div class="sign">Dispatched by</div><div class="sign">Driver</div></div>
    </body></html>`;
    return { number: run.number, pdf: await this.pdf.render(html) };
  }
}

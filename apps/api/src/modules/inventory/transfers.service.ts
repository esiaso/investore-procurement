import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DocumentType, Paginated, Permissions, SessionUser, StockTxnType, TransferStatus } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { NumberingService } from '../numbering/numbering.service';
import { assertBin, assertStore, loadItems, round4 } from './doc-helpers';
import { AdjustmentReason, StockTransfer, StockTransferAllocation, StockTransferLine } from './documents.entities';
import { CreateTransferDto, DispatchTransferDto, ReceiveTransferDto, TransferQueryDto } from './inventory.dto';
import { InventoryService } from './inventory.service';
import { allocateFefo, loadFefoCandidates, matchesFefo } from './fefo';
import { MovementLine, postMovements, StockRuleError } from './posting';

/**
 * Transfer workflow: REQUESTED (by the receiving store) → DISPATCHED (stock
 * leaves the source and sits in transit at the destination, batches picked by
 * FEFO) → RECEIVED, or RECEIVED_WITH_DISCREPANCY when less arrived (the
 * shortfall is written off from in-transit with a reason code).
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
  ) {}

  private get ds() {
    return this.inventory.dataSource;
  }

  /**
   * Normally raised by the receiving store. `pushedBySource` lets the sending
   * store raise it instead (redistributing near-expiry stock to a store that
   * uses more); it still goes through dispatch and receipt as usual.
   */
  async request(dto: CreateTransferDto, actor: SessionUser, opts: { pushedBySource?: boolean } = {}): Promise<StockTransfer> {
    if (dto.fromStoreId === dto.toStoreId) throw new BadRequestException('Source and destination must differ');
    const id = await this.ds.transaction(async (m) => {
      const [mine, other] = opts.pushedBySource ? [dto.fromStoreId, dto.toStoreId] : [dto.toStoreId, dto.fromStoreId];
      await assertStore(m, mine);
      const [from] = await m.query(`SELECT id, is_active FROM store WHERE id = $1`, [other]);
      if (!from?.is_active) throw new BadRequestException(`${opts.pushedBySource ? 'Destination' : 'Source'} store not found or inactive`);
      const items = await loadItems(m, dto.lines.map((l) => l.itemId));
      if (new Set(dto.lines.map((l) => l.itemId)).size !== dto.lines.length) {
        throw new BadRequestException('Each item may appear only once');
      }
      for (const item of items.values()) if (!item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
      const t = await m.save(
        m.create(StockTransfer, {
          number: await this.numbering.next(DocumentType.TRANSFER, { storeId: dto.toStoreId, manager: m }),
          fromStoreId: dto.fromStoreId,
          toStoreId: dto.toStoreId,
          notes: dto.notes ?? null,
          requestedBy: actor.id,
          status: TransferStatus.REQUESTED,
          lines: dto.lines.map((l) => m.create(StockTransferLine, { itemId: l.itemId, requestedQty: l.quantity })),
        }),
      );
      return t.id;
    });
    return this.get(id);
  }

  async dispatch(id: string, dto: DispatchTransferDto, actor: SessionUser): Promise<StockTransfer> {
    const pre = await this.get(id);
    const controlled = await this.inventory.anyControlled(this.ds.manager, pre.lines!.map((l) => l.itemId));
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;

    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TransferStatus.REQUESTED) throw new ConflictException(`Transfer is ${t.status}`);
      StoreScope.assert(t.fromStoreId);
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.TRANSFER, id: t.id, number: t.number }, undefined, witnessId, m);
      const lines = await m.find(StockTransferLine, { where: { transferId: t.id } });
      const byLine = new Map((dto.lines ?? []).map((l) => [l.lineId, l]));
      for (const lineId of byLine.keys()) {
        if (!lines.some((l) => l.id === lineId)) throw new BadRequestException(`Line ${lineId} is not on this transfer`);
      }

      const source: MovementLine[] = [];
      const plan: { line: StockTransferLine; batchId: string; binId: string | null; qty: number }[] = [];
      let overridden = false;
      for (const line of lines) {
        const req = byLine.get(line.id);
        const qty = round4(req?.quantity ?? line.requestedQty);
        if (qty === 0) continue;
        if (qty > line.requestedQty) throw new BadRequestException('Cannot dispatch more than requested');
        const candidates = await loadFefoCandidates(m, line.itemId, t.fromStoreId);
        const fefo = allocateFefo(candidates, qty, ctx.effectiveDate);
        let picks = fefo.allocations.map((a) => ({ batchId: a.batchId, binId: a.binId, quantity: a.quantity }));
        if (req?.picks?.length) {
          const total = round4(req.picks.reduce((s, p) => s + p.quantity, 0));
          if (total !== qty) throw new BadRequestException(`Picks for a line must add up to ${qty}`);
          const chosen = req.picks.map((p) => ({ batchId: p.batchId, binId: p.binId ?? null, quantity: p.quantity }));
          if (!matchesFefo(chosen, fefo.allocations)) overridden = true;
          picks = chosen;
        } else if (fefo.shortfall > 0) {
          throw new StockRuleError('INSUFFICIENT_STOCK', `Only ${fefo.allocated} usable in the source store for a line needing ${qty}`, {
            itemId: line.itemId,
            shortfall: fefo.shortfall,
          });
        }
        for (const p of picks) plan.push({ line, batchId: p.batchId, binId: p.binId, qty: p.quantity });
      }
      if (!plan.length) throw new BadRequestException('Nothing to dispatch');
      if (overridden) {
        if (!actor.permissions.includes(Permissions.INVENTORY_OVERRIDE_FEFO)) {
          throw new ForbiddenException('Picking batches out of FEFO order needs the inventory.override_fefo permission');
        }
        if (!dto.fefoOverrideReason?.trim()) throw new BadRequestException('A reason is required to override FEFO');
      }

      for (const p of plan) {
        source.push({
          txnType: StockTxnType.TRANSFER_DISPATCH,
          storeId: t.fromStoreId,
          binId: p.binId,
          itemId: p.line.itemId,
          batchId: p.batchId,
          quantity: -p.qty,
          counterpartStoreId: t.toStoreId,
          fefoOverrideReason: overridden ? dto.fefoOverrideReason!.trim() : null,
        });
      }
      const out = await postMovements(m, source, ctx);
      // Same cost on both sides so value moves exactly.
      await postMovements(
        m,
        plan.map((p, i) => ({
          txnType: StockTxnType.TRANSFER_DISPATCH,
          storeId: t.toStoreId,
          binId: null,
          itemId: p.line.itemId,
          batchId: p.batchId,
          quantity: 0,
          inTransitDelta: p.qty,
          unitCost: out[i].unitCost,
          counterpartStoreId: t.fromStoreId,
        })),
        ctx,
      );
      for (const [i, p] of plan.entries()) {
        await m.save(
          m.create(StockTransferAllocation, {
            lineId: p.line.id,
            batchId: p.batchId,
            fromBinId: p.binId,
            dispatchedQty: p.qty,
            unitCost: out[i].unitCost,
          }),
        );
      }
      t.status = TransferStatus.DISPATCHED;
      t.dispatchedBy = actor.id;
      t.dispatchedAt = new Date();
      await m.save(t);
    });
    return this.get(id);
  }

  async receive(id: string, dto: ReceiveTransferDto, actor: SessionUser): Promise<StockTransfer> {
    const pre = await this.get(id);
    const controlled = await this.inventory.anyControlled(this.ds.manager, pre.lines!.map((l) => l.itemId));
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;

    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TransferStatus.DISPATCHED) throw new ConflictException(`Transfer is ${t.status}`);
      StoreScope.assert(t.toStoreId);
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.TRANSFER, id: t.id, number: t.number }, undefined, witnessId, m);
      const allocations: (StockTransferAllocation & { item_id: string })[] = await m
        .getRepository(StockTransferAllocation)
        .createQueryBuilder('a')
        .innerJoin('a.line', 'l')
        .where('l.transfer_id = :id', { id: t.id })
        .getMany()
        .then(async (list) => {
          const lines = await m.find(StockTransferLine, { where: { transferId: t.id } });
          return list.map((a) => Object.assign(a, { item_id: lines.find((l) => l.id === a.lineId)!.itemId }));
        });
      const given = new Map((dto.allocations ?? []).map((a) => [a.allocationId, a]));
      for (const key of given.keys()) {
        if (!allocations.some((a) => a.id === key)) throw new BadRequestException(`Allocation ${key} is not on this transfer`);
      }
      const defaultBin = await assertBin(m, t.toStoreId, dto.toBinId);
      const reasons = new Set((await m.find(AdjustmentReason, { where: { isActive: true } })).map((r) => r.code));

      const movements: MovementLine[] = [];
      let discrepancy = false;
      for (const a of allocations) {
        const g = given.get(a.id);
        const received = round4(g?.receivedQty ?? a.dispatchedQty);
        if (received > a.dispatchedQty) throw new BadRequestException('Cannot receive more than was dispatched');
        const toBin = g?.toBinId !== undefined ? await assertBin(m, t.toStoreId, g.toBinId) : defaultBin;
        const short = round4(a.dispatchedQty - received);
        if (received > 0) {
          if (toBin === null) {
            movements.push({ txnType: StockTxnType.TRANSFER_RECEIPT, storeId: t.toStoreId, binId: null, itemId: a.item_id, batchId: a.batchId, quantity: received, inTransitDelta: -received, unitCost: a.unitCost, counterpartStoreId: t.fromStoreId });
          } else {
            movements.push({ txnType: StockTxnType.TRANSFER_RECEIPT, storeId: t.toStoreId, binId: null, itemId: a.item_id, batchId: a.batchId, quantity: 0, inTransitDelta: -received, unitCost: a.unitCost, counterpartStoreId: t.fromStoreId });
            movements.push({ txnType: StockTxnType.TRANSFER_RECEIPT, storeId: t.toStoreId, binId: toBin, itemId: a.item_id, batchId: a.batchId, quantity: received, unitCost: a.unitCost, counterpartStoreId: t.fromStoreId });
          }
        }
        if (short > 0) {
          discrepancy = true;
          if (!g?.discrepancyReasonCode || !reasons.has(g.discrepancyReasonCode)) {
            throw new BadRequestException('A valid discrepancy reason code is required for short receipts');
          }
          movements.push({
            txnType: StockTxnType.TRANSFER_DISCREPANCY,
            storeId: t.toStoreId,
            binId: null,
            itemId: a.item_id,
            batchId: a.batchId,
            quantity: 0,
            inTransitDelta: -short,
            unitCost: a.unitCost,
            counterpartStoreId: t.fromStoreId,
            reasonCode: g.discrepancyReasonCode,
          });
        }
        a.receivedQty = received;
        a.toBinId = toBin;
        a.discrepancyReasonCode = short > 0 ? g!.discrepancyReasonCode! : null;
        a.discrepancyNotes = g?.discrepancyNotes ?? null;
      }
      await postMovements(m, movements, ctx);
      for (const a of allocations) {
        const { item_id: _ignored, ...entity } = a;
        await m.save(StockTransferAllocation, entity);
      }
      t.status = discrepancy ? TransferStatus.RECEIVED_WITH_DISCREPANCY : TransferStatus.RECEIVED;
      t.receivedBy = actor.id;
      t.receivedAt = new Date();
      await m.save(t);
    });
    await this.inventory.stockArrived(pre.toStoreId, pre.lines!.map((l) => l.itemId));
    return this.get(id);
  }

  async cancel(id: string): Promise<StockTransfer> {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TransferStatus.REQUESTED) throw new ConflictException('Only requested (not dispatched) transfers can be cancelled');
      t.status = TransferStatus.CANCELLED;
      await m.save(t);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<StockTransfer> {
    const t = await m.findOne(StockTransfer, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!t) throw new NotFoundException('Transfer not found');
    return t;
  }

  /** Visible to users of either store. */
  async get(id: string): Promise<StockTransfer> {
    const t = await this.ds.getRepository(StockTransfer).findOne({
      where: { id },
      relations: { fromStore: true, toStore: true, lines: { item: true, allocations: { batch: true } } },
    });
    if (!t) throw new NotFoundException('Transfer not found');
    const scope = StoreScope.current();
    if (scope !== null && !scope.includes(t.fromStoreId) && !scope.includes(t.toStoreId)) {
      throw new NotFoundException('Transfer not found');
    }
    return t;
  }

  async list(query: TransferQueryDto): Promise<Paginated<StockTransfer>> {
    const qb = this.ds
      .getRepository(StockTransfer)
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.fromStore', 'fromStore')
      .leftJoinAndSelect('t.toStore', 'toStore')
      .orderBy('t.createdAt', 'DESC');
    const scope = StoreScope.current();
    if (scope !== null) {
      qb.andWhere('(t.from_store_id IN (:...scope) OR t.to_store_id IN (:...scope))', { scope: scope.length ? scope : ['00000000-0000-0000-0000-000000000000'] });
    }
    if (query.storeId) qb.andWhere('(t.from_store_id = :s OR t.to_store_id = :s)', { s: query.storeId });
    if (query.status) qb.andWhere('t.status = :st', { st: query.status });
    if (query.search) qb.andWhere('t.number ILIKE :q', { q: `%${query.search}%` });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}

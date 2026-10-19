import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DocumentType, Paginated, SessionUser, StockTakeStatus, StockTakeType, StockTxnType, ValuationMethod } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { NumberingService } from '../numbering/numbering.service';
import { assertBin, assertStore, loadItems, round2, round4 } from './doc-helpers';
import { StockTake, StockTakeLine } from './documents.entities';
import { Batch } from './inventory.entities';
import { CreateStockTakeDto, DocQueryDto, RecordCountsDto } from './inventory.dto';
import { InventoryService } from './inventory.service';
import { postMovements } from './posting';

export interface StockTakeView extends Omit<StockTake, 'lines'> {
  lines: (Omit<StockTakeLine, 'systemQty'> & { systemQty: number | null; variance: number | null; varianceValue: number | null })[];
}

/**
 * DRAFT → COUNTING (snapshot taken, stock frozen: a full count freezes the
 * store, a cycle count its items) → REVIEW (counts submitted, variances shown)
 * → POSTED (variances posted as STOCK_TAKE ledger rows by an approver who is
 * not the person who submitted the counts). CANCELLED unfreezes.
 */
@Injectable()
export class StockTakesService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
  ) {}

  private get ds() {
    return this.inventory.dataSource;
  }

  async create(dto: CreateStockTakeDto): Promise<StockTakeView> {
    const id = await this.ds.transaction(async (m) => {
      await assertStore(m, dto.storeId);
      const itemIds = [...new Set(dto.itemIds ?? [])];
      if (dto.type === StockTakeType.CYCLE && !itemIds.length) throw new BadRequestException('A cycle count needs at least one item');
      if (dto.type === StockTakeType.FULL && itemIds.length) throw new BadRequestException('A full count covers every item; do not list items');
      if (itemIds.length) await loadItems(m, itemIds);
      const st = await m.save(
        m.create(StockTake, {
          number: await this.numbering.next(DocumentType.STOCK_TAKE, { storeId: dto.storeId, manager: m }),
          storeId: dto.storeId,
          type: dto.type,
          blind: dto.blind ?? true,
          itemIds,
          notes: dto.notes ?? null,
          status: StockTakeStatus.DRAFT,
        }),
      );
      return st.id;
    });
    return this.get(id);
  }

  /** Takes the snapshot and freezes the stock in scope. */
  async freeze(id: string): Promise<StockTakeView> {
    await this.ds.transaction(async (m) => {
      const st = await this.lock(m, id);
      if (st.status !== StockTakeStatus.DRAFT) throw new ConflictException(`Stock take is ${st.status}`);
      // Serialise freezes per store so two counts cannot overlap.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stocktake:${st.storeId}`]);
      const active: StockTake[] = await m.query(
        `SELECT number, type, item_ids::text[] AS item_ids FROM stock_take WHERE store_id = $1 AND status IN ('COUNTING', 'REVIEW') AND id <> $2`,
        [st.storeId, st.id],
      );
      const clash = active.find(
        (a: StockTake & { item_ids?: string[] }) =>
          a.type === StockTakeType.FULL || st.type === StockTakeType.FULL || (a.item_ids ?? []).some((i) => st.itemIds.includes(i)),
      );
      if (clash) throw new ConflictException(`Stock take ${clash.number} is already counting overlapping stock`);

      const rows: { item_id: string; batch_id: string; bin_id: string | null; on_hand: string }[] = await m.query(
        `SELECT item_id, batch_id, bin_id, on_hand FROM stock_balance
          WHERE store_id = $1 AND on_hand > 0 ${st.type === StockTakeType.CYCLE ? 'AND item_id = ANY($2::uuid[])' : ''}`,
        st.type === StockTakeType.CYCLE ? [st.storeId, st.itemIds] : [st.storeId],
      );
      await m.save(
        rows.map((r) =>
          m.create(StockTakeLine, { stockTakeId: st.id, itemId: r.item_id, batchId: r.batch_id, binId: r.bin_id, systemQty: Number(r.on_hand) }),
        ),
      );
      st.status = StockTakeStatus.COUNTING;
      st.frozenAt = new Date();
      await m.save(st);
    });
    return this.get(id);
  }

  async recordCounts(id: string, dto: RecordCountsDto, actor: SessionUser): Promise<StockTakeView> {
    await this.ds.transaction(async (m) => {
      const st = await this.lock(m, id);
      if (st.status !== StockTakeStatus.COUNTING) throw new ConflictException(`Stock take is ${st.status}`);
      const lines = await m.find(StockTakeLine, { where: { stockTakeId: st.id } });
      for (const c of dto.lines ?? []) {
        const line = lines.find((l) => l.id === c.lineId);
        if (!line) throw new BadRequestException(`Line ${c.lineId} is not on this stock take`);
        line.countedQty = round4(c.countedQty);
        line.countedBy = actor.id;
        if (c.notes !== undefined) line.notes = c.notes;
        await m.save(line);
      }
      for (const f of dto.found ?? []) {
        if (st.type === StockTakeType.CYCLE && !st.itemIds.includes(f.itemId)) {
          throw new BadRequestException('Found stock must be an item in the scope of this count');
        }
        const batch = await m.findOneBy(Batch, { id: f.batchId });
        if (!batch || batch.itemId !== f.itemId) throw new BadRequestException('Batch does not belong to the item');
        const binId = await assertBin(m, st.storeId, f.binId);
        const existing = lines.find((l) => l.batchId === f.batchId && (l.binId ?? null) === binId);
        if (existing) throw new BadRequestException('That batch and bin is already on the count sheet');
        await m.save(
          m.create(StockTakeLine, { stockTakeId: st.id, itemId: f.itemId, batchId: f.batchId, binId, systemQty: 0, countedQty: f.countedQty, countedBy: actor.id }),
        );
      }
    });
    return this.get(id);
  }

  async submit(id: string, actor: SessionUser): Promise<StockTakeView> {
    await this.ds.transaction(async (m) => {
      const st = await this.lock(m, id);
      if (st.status !== StockTakeStatus.COUNTING) throw new ConflictException(`Stock take is ${st.status}`);
      const [{ missing }] = await m.query(
        `SELECT COUNT(*)::int AS missing FROM stock_take_line WHERE stock_take_id = $1 AND counted_qty IS NULL`,
        [st.id],
      );
      if (missing) throw new BadRequestException(`${missing} line(s) have not been counted`);
      st.status = StockTakeStatus.REVIEW;
      st.submittedBy = actor.id;
      await m.save(st);
    });
    return this.get(id);
  }

  /** Posts variances. The approver must not be the person who submitted the counts. */
  async approve(id: string, actor: SessionUser): Promise<StockTakeView> {
    await this.ds.transaction(async (m) => {
      const st = await this.lock(m, id);
      if (st.status !== StockTakeStatus.REVIEW) throw new ConflictException(`Stock take is ${st.status}`);
      if (st.submittedBy === actor.id) throw new ForbiddenException('Counts must be approved by someone other than the submitter');
      const lines = await m.find(StockTakeLine, { where: { stockTakeId: st.id } });
      const movements = lines
        .filter((l) => round4((l.countedQty ?? 0) - l.systemQty) !== 0)
        .map((l) => ({
          txnType: StockTxnType.STOCK_TAKE,
          storeId: st.storeId,
          binId: l.binId,
          itemId: l.itemId,
          batchId: l.batchId,
          quantity: round4((l.countedQty ?? 0) - l.systemQty),
        }));
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.STOCK_TAKE, id: st.id, number: st.number }, undefined, st.submittedBy, m);
      await postMovements(m, movements, ctx);
      st.status = StockTakeStatus.POSTED;
      st.approvedBy = actor.id;
      st.postedAt = new Date();
      await m.save(st);
    });
    return this.get(id);
  }

  async cancel(id: string): Promise<StockTakeView> {
    await this.ds.transaction(async (m) => {
      const st = await this.lock(m, id);
      if (st.status === StockTakeStatus.POSTED || st.status === StockTakeStatus.CANCELLED) {
        throw new ConflictException(`Stock take is ${st.status}`);
      }
      st.status = StockTakeStatus.CANCELLED;
      await m.save(st);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<StockTake> {
    const st = await m.findOne(StockTake, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!st) throw new NotFoundException('Stock take not found');
    StoreScope.assert(st.storeId);
    return st;
  }

  /** System quantities are hidden while a blind count is in progress. */
  async get(id: string): Promise<StockTakeView> {
    const st = await this.ds.getRepository(StockTake).findOne({
      where: { id },
      relations: { store: true, lines: { item: true, batch: true } },
      order: { lines: { item: { name: 'ASC' } } },
    });
    if (!st) throw new NotFoundException('Stock take not found');
    StoreScope.assert(st.storeId);
    const hide = st.blind && st.status === StockTakeStatus.COUNTING;
    const [{ value: method }] = await this.ds.query(`SELECT value FROM system_setting WHERE key = 'inventory.valuationMethod'`);
    const costRows: { id: string; unit_cost: string; avg_cost: string | null }[] = await this.ds.query(
      `SELECT b.id, b.unit_cost, c.avg_cost FROM batch b
         LEFT JOIN item_store_cost c ON c.store_id = $1 AND c.item_id = b.item_id
        WHERE b.id = ANY($2::uuid[])`,
      [st.storeId, (st.lines ?? []).map((l) => l.batchId)],
    );
    const costOf = new Map(
      costRows.map((r) => [r.id, Number(method === ValuationMethod.FIFO || r.avg_cost === null ? r.unit_cost : r.avg_cost)]),
    );
    const lines = [];
    for (const l of st.lines ?? []) {
      const variance = l.countedQty === null ? null : round4(l.countedQty - l.systemQty);
      const cost = hide || variance === null ? null : (costOf.get(l.batchId) ?? 0);
      lines.push({
        ...l,
        systemQty: hide ? null : l.systemQty,
        variance: hide ? null : variance,
        varianceValue: cost === null || variance === null ? null : round2(variance * cost),
      });
    }
    return { ...st, lines };
  }

  async list(query: DocQueryDto): Promise<Paginated<StockTake>> {
    const qb = this.ds.getRepository(StockTake).createQueryBuilder('s').leftJoinAndSelect('s.store', 'store').orderBy('s.createdAt', 'DESC');
    StoreScope.apply(qb, 's.store_id');
    if (query.storeId) qb.andWhere('s.store_id = :st', { st: query.storeId });
    if (query.status) qb.andWhere('s.status = :status', { status: query.status });
    if (query.search) qb.andWhere('s.number ILIKE :q', { q: `%${query.search}%` });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}

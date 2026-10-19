import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  AdjustmentDirection,
  AdjustmentStatus,
  AuditAction,
  DocumentType,
  Paginated,
  SessionUser,
  StockTxnType,
} from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { assertBin, assertStore, currentCost, loadItems, round2 } from './doc-helpers';
import { AdjustmentReason, StockAdjustment, StockAdjustmentLine } from './documents.entities';
import { Batch } from './inventory.entities';
import { CreateAdjustmentDto, DocQueryDto } from './inventory.dto';
import { InventoryService } from './inventory.service';
import { postMovements } from './posting';
import { NO_BATCH } from './receipts.service';

/**
 * Adjustment workflow: SUBMITTED → approved by someone other than the
 * submitter → posted. Above the configured value threshold, a second approver
 * (different from both) is needed: SUBMITTED → PARTIALLY_APPROVED → POSTED.
 * For controlled drugs, the submitter and final approver are the two signatories.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private get ds() {
    return this.inventory.dataSource;
  }

  listReasons(): Promise<AdjustmentReason[]> {
    return this.ds.getRepository(AdjustmentReason).find({ order: { name: 'ASC' } });
  }

  async create(dto: CreateAdjustmentDto, actor: SessionUser): Promise<StockAdjustment> {
    const id = await this.ds.transaction(async (m) => {
      await assertStore(m, dto.storeId);
      const reason = await m.findOneBy(AdjustmentReason, { code: dto.reasonCode, isActive: true });
      if (!reason) throw new BadRequestException(`Unknown or inactive reason code ${dto.reasonCode}`);
      const items = await loadItems(m, dto.lines.map((l) => l.itemId));
      const method = await this.settings.get('inventory.valuationMethod', m);

      const lines: Partial<StockAdjustmentLine>[] = [];
      for (const [i, l] of dto.lines.entries()) {
        const where = `Line ${i + 1}`;
        if (l.quantity === 0) throw new BadRequestException(`${where}: quantity cannot be zero`);
        if (reason.direction === AdjustmentDirection.DECREASE && l.quantity > 0) {
          throw new BadRequestException(`${where}: reason ${reason.code} only allows decreases`);
        }
        if (reason.direction === AdjustmentDirection.INCREASE && l.quantity < 0) {
          throw new BadRequestException(`${where}: reason ${reason.code} only allows increases`);
        }
        const item = items.get(l.itemId)!;
        const binId = await assertBin(m, dto.storeId, l.binId);
        let batchId = l.batchId;
        if (!batchId) {
          if (l.quantity < 0) throw new BadRequestException(`${where}: choose the batch to decrease`);
          // Found stock of a batch the system does not know yet.
          if (item.is_batch_tracked && (!l.newBatchNo || !l.newBatchExpiryDate)) {
            throw new BadRequestException(`${where}: batch number and expiry are required for ${item.code}`);
          }
          const batchNo = item.is_batch_tracked ? l.newBatchNo!.trim() : NO_BATCH;
          const existing = await m.findOneBy(Batch, { itemId: item.id, batchNo });
          const cost = existing ? Number(existing.unitCost) : await this.lastCost(m, dto.storeId, item.id);
          batchId = (
            existing ??
            (await m.save(
              m.create(Batch, { itemId: item.id, batchNo, expiryDate: item.is_batch_tracked ? l.newBatchExpiryDate! : null, unitCost: cost }),
            ))
          ).id;
        } else {
          const batch = await m.findOneBy(Batch, { id: batchId });
          if (!batch || batch.itemId !== item.id) throw new BadRequestException(`${where}: batch does not belong to ${item.code}`);
        }
        const unitCost = await currentCost(m, dto.storeId, item.id, batchId, method);
        lines.push({ itemId: item.id, batchId, binId, quantity: l.quantity, unitCost });
      }

      const totalValue = round2(lines.reduce((s, l) => s + Math.abs(l.quantity!) * l.unitCost!, 0));
      const threshold = await this.settings.get('inventory.adjustmentSecondApprovalThreshold', m);
      const date = dto.adjustmentDate ?? (await this.settings.today(m));
      const submit = dto.submit !== false;
      const adj = await m.save(
        m.create(StockAdjustment, {
          number: await this.numbering.next(DocumentType.STOCK_ADJUSTMENT, { storeId: dto.storeId, date, manager: m }),
          storeId: dto.storeId,
          reasonCode: reason.code,
          adjustmentDate: date,
          notes: dto.notes ?? null,
          status: submit ? AdjustmentStatus.SUBMITTED : AdjustmentStatus.DRAFT,
          submittedBy: submit ? actor.id : null,
          totalValue,
          requiresSecondApproval: totalValue > threshold,
          lines: lines.map((l) => m.create(StockAdjustmentLine, l)),
        }),
      );
      return adj.id;
    });
    return this.get(id);
  }

  /** Last known cost of an item in a store, for valuing found stock of a new batch. */
  private async lastCost(m: EntityManager, storeId: string, itemId: string): Promise<number> {
    const [r] = await m.query(
      `SELECT COALESCE((SELECT avg_cost FROM item_store_cost WHERE store_id = $1 AND item_id = $2),
                       (SELECT unit_cost FROM batch WHERE item_id = $2 ORDER BY received_at DESC LIMIT 1),
                       (SELECT unit_price FROM item WHERE id = $2)) AS cost`,
      [storeId, itemId],
    );
    return Number(r.cost ?? 0);
  }

  async submit(id: string, actor: SessionUser): Promise<StockAdjustment> {
    await this.ds.transaction(async (m) => {
      const adj = await this.lock(m, id);
      if (adj.status !== AdjustmentStatus.DRAFT) throw new ConflictException(`Adjustment is ${adj.status}`);
      adj.status = AdjustmentStatus.SUBMITTED;
      adj.submittedBy = actor.id;
      await m.save(adj);
    });
    return this.get(id);
  }

  async approve(id: string, actor: SessionUser): Promise<StockAdjustment> {
    await this.ds.transaction(async (m) => {
      const adj = await this.lock(m, id);
      if (adj.submittedBy === actor.id) throw new ForbiddenException('You cannot approve an adjustment you submitted');
      if (adj.status === AdjustmentStatus.SUBMITTED) {
        adj.firstApprovedBy = actor.id;
        adj.firstApprovedAt = new Date();
        if (adj.requiresSecondApproval) {
          adj.status = AdjustmentStatus.PARTIALLY_APPROVED;
          await m.save(adj);
          return;
        }
      } else if (adj.status === AdjustmentStatus.PARTIALLY_APPROVED) {
        if (adj.firstApprovedBy === actor.id) {
          throw new ForbiddenException('The second approval must come from a different approver');
        }
        adj.secondApprovedBy = actor.id;
        adj.secondApprovedAt = new Date();
      } else {
        throw new ConflictException(`Adjustment is ${adj.status}`);
      }
      await this.post(m, adj, actor);
    });
    return this.get(id);
  }

  private async post(m: EntityManager, adj: StockAdjustment, actor: SessionUser): Promise<void> {
    const lines = await m.find(StockAdjustmentLine, { where: { adjustmentId: adj.id } });
    // Submitter and final approver are the two signatories for controlled drugs.
    const ctx = await this.inventory.postingContext(
      actor,
      { type: DocumentType.STOCK_ADJUSTMENT, id: adj.id, number: adj.number },
      adj.adjustmentDate,
      adj.submittedBy,
      m,
    );
    await postMovements(
      m,
      lines.map((l) => ({
        txnType: StockTxnType.ADJUSTMENT,
        storeId: adj.storeId,
        binId: l.binId,
        itemId: l.itemId,
        batchId: l.batchId,
        quantity: l.quantity,
        reasonCode: adj.reasonCode,
      })),
      ctx,
    );
    adj.status = AdjustmentStatus.POSTED;
    adj.postedAt = new Date();
    await m.save(adj);
  }

  async reject(id: string, reason: string, actor: SessionUser): Promise<StockAdjustment> {
    await this.ds.transaction(async (m) => {
      const adj = await this.lock(m, id);
      if (![AdjustmentStatus.SUBMITTED, AdjustmentStatus.PARTIALLY_APPROVED, AdjustmentStatus.DRAFT].includes(adj.status)) {
        throw new ConflictException(`Adjustment is ${adj.status}`);
      }
      adj.status = AdjustmentStatus.REJECTED;
      adj.rejectedBy = actor.id;
      adj.rejectionReason = reason;
      await m.save(adj);
      await this.audit.record({ action: AuditAction.UPDATE, entityType: 'StockAdjustment', entityId: id, after: { rejected: reason } }, m);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<StockAdjustment> {
    const adj = await m.findOne(StockAdjustment, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!adj) throw new NotFoundException('Adjustment not found');
    StoreScope.assert(adj.storeId);
    return adj;
  }

  async get(id: string): Promise<StockAdjustment> {
    const adj = await this.ds.getRepository(StockAdjustment).findOne({
      where: { id },
      relations: { store: true, lines: { item: true, batch: true } },
    });
    if (!adj) throw new NotFoundException('Adjustment not found');
    StoreScope.assert(adj.storeId);
    return adj;
  }

  async list(query: DocQueryDto): Promise<Paginated<StockAdjustment>> {
    const qb = this.ds
      .getRepository(StockAdjustment)
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.store', 'store')
      .orderBy('a.createdAt', 'DESC');
    StoreScope.apply(qb, 'a.store_id');
    if (query.storeId) qb.andWhere('a.store_id = :s', { s: query.storeId });
    if (query.status) qb.andWhere('a.status = :st', { st: query.status });
    if (query.search) qb.andWhere('a.number ILIKE :q', { q: `%${query.search}%` });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}

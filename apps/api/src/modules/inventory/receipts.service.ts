import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, DocumentType, Paginated, SessionUser, StockReceiptType, StockTxnType } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { assertBin, assertStore, loadItems } from './doc-helpers';
import { StockReceipt, StockReceiptLine } from './documents.entities';
import { Batch } from './inventory.entities';
import { CreateReceiptDto, DocQueryDto } from './inventory.dto';
import { InventoryService } from './inventory.service';
import { MovementLine, postMovements } from './posting';

/** Placeholder batch number for items that are not batch-tracked. */
export const NO_BATCH = 'NOBATCH';

/** Opening balances and temporary stock-in receipts (until GRN arrives in slice 3). */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateReceiptDto, actor: SessionUser): Promise<StockReceipt> {
    const items = await loadItems(this.inventory.dataSource.manager, dto.lines.map((l) => l.itemId));
    const controlled = [...items.values()].some((i) => i.is_controlled);
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;

    const id = await this.inventory.dataSource.transaction(async (m) => {
      await assertStore(m, dto.storeId);
      const ctxDate = dto.receiptDate;
      const lines: { line: Partial<StockReceiptLine>; batch: Batch }[] = [];
      for (const l of dto.lines) {
        const item = items.get(l.itemId)!;
        if (!item.is_active) throw new BadRequestException(`Item ${item.code} is inactive`);
        if (item.is_batch_tracked && (!l.batchNo || !l.expiryDate)) {
          throw new BadRequestException(`Item ${item.code} is batch-tracked: batch number and expiry date are required`);
        }
        const batchNo = item.is_batch_tracked ? l.batchNo!.trim() : NO_BATCH;
        let batch = await m.findOneBy(Batch, { itemId: item.id, batchNo });
        if (batch) {
          if (item.is_batch_tracked && batch.expiryDate !== l.expiryDate) {
            throw new BadRequestException(`Batch ${batchNo} of ${item.code} already exists with expiry ${batch.expiryDate}`);
          }
        } else {
          batch = await m.save(
            m.create(Batch, {
              itemId: item.id,
              batchNo,
              expiryDate: item.is_batch_tracked ? l.expiryDate! : null,
              manufactureDate: l.manufactureDate ?? null,
              fundingSource: l.fundingSource ?? null,
              unitCost: l.unitCost,
            }),
          );
        }
        const binId = await assertBin(m, dto.storeId, l.binId);
        lines.push({ line: { itemId: item.id, batchId: batch.id, binId, quantity: l.quantity, unitCost: l.unitCost }, batch });
      }

      const number = await this.numbering.next(DocumentType.STOCK_RECEIPT, { storeId: dto.storeId, date: ctxDate, manager: m });
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.STOCK_RECEIPT, number }, ctxDate, witnessId, m);
      const receipt = await m.save(
        m.create(StockReceipt, {
          number,
          type: dto.type,
          storeId: dto.storeId,
          receiptDate: ctx.effectiveDate,
          notes: dto.notes ?? null,
          lines: lines.map((l) => m.create(StockReceiptLine, l.line)),
        }),
      );
      const movements: MovementLine[] = lines.map(({ line }) => ({
        txnType: dto.type === StockReceiptType.OPENING ? StockTxnType.OPENING : StockTxnType.RECEIPT,
        storeId: dto.storeId,
        binId: line.binId ?? null,
        itemId: line.itemId!,
        batchId: line.batchId!,
        quantity: line.quantity!,
        unitCost: line.unitCost!,
      }));
      await postMovements(m, movements, { ...ctx, sourceDocId: receipt.id });
      await this.audit.record(
        { action: AuditAction.UPDATE, entityType: 'StockReceipt', entityId: receipt.id, after: { posted: true, number, witnessId } },
        m,
      );
      return receipt.id;
    });
    return this.get(id);
  }

  async get(id: string): Promise<StockReceipt> {
    const r = await this.inventory.dataSource.getRepository(StockReceipt).findOne({
      where: { id },
      relations: { store: true, lines: { item: true, batch: true } },
    });
    if (!r) throw new NotFoundException('Receipt not found');
    StoreScope.assert(r.storeId);
    return r;
  }

  async list(query: DocQueryDto): Promise<Paginated<StockReceipt>> {
    const qb = this.inventory.dataSource
      .getRepository(StockReceipt)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.store', 'store')
      .orderBy('r.createdAt', 'DESC');
    StoreScope.apply(qb, 'r.store_id');
    if (query.storeId) qb.andWhere('r.store_id = :s', { s: query.storeId });
    if (query.search) qb.andWhere('r.number ILIKE :q', { q: `%${query.search}%` });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}

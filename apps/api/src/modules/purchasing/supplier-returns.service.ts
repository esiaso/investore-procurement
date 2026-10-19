import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import {
  DocumentType,
  Paginated,
  ReturnReasonKind,
  SessionUser,
  StockTxnType,
  SupplierReturnSource,
  SupplierReturnStatus,
} from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { DocumentLinksService } from '../approvals/document-links.service';
import { assertBin, currentCost } from '../inventory/doc-helpers';
import { ReturnReason } from '../inventory/documents.entities';
import { InventoryService } from '../inventory/inventory.service';
import { MovementLine, postMovements } from '../inventory/posting';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { CreateSupplierReturnDto, CreditNoteDto, DispatchSupplierReturnDto, DocListQueryDto } from './purchasing.dto';
import { GoodsReceivedNote, GrnLine, ReturnToSupplier, ReturnToSupplierLine } from './purchasing.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Returns to supplier. From stock: DRAFT → DISPATCHED (SUPPLIER_RETURN posted
 * out of stock at current cost; held, expired and quarantined stock may be
 * returned, reserved stock may not) → CREDITED when the supplier's credit note
 * is recorded. From GRN inspection rejects: created DISPATCHED on GRN posting
 * (the goods never entered stock). The note is the hospital's debit note.
 */
@Injectable()
export class SupplierReturnsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly inventory: InventoryService,
    private readonly settings: SettingsService,
    private readonly links: DocumentLinksService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.RETURN_TO_SUPPLIER, async (ids) => {
      const rows = await this.ds.getRepository(ReturnToSupplier).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.returnDate ?? r.createdAt.toISOString(), amount: r.totalValue }]));
    });
  }

  private async assertReason(m: EntityManager, code: string) {
    const ok = await m.findOne(ReturnReason, { where: { code, isActive: true, kind: In([ReturnReasonKind.SUPPLIER, ReturnReasonKind.BOTH]) } });
    if (!ok) throw new BadRequestException(`Unknown or inactive supplier return reason ${code}`);
  }

  /** Goods rejected at inspection: a dispatched return note, valued at the GRN cost. Called inside GRN posting. */
  async createFromGrnRejects(m: EntityManager, grn: GoodsReceivedNote, rejected: (GrnLine & { baseCost: number })[]): Promise<ReturnToSupplier> {
    const reasonCode = await this.settings.get('purchasing.grnRejectReturnReason', m);
    await this.assertReason(m, reasonCode);
    const lines = rejected.map((l) =>
      m.create(ReturnToSupplierLine, {
        itemId: l.itemId,
        batchId: null,
        batchNo: l.batchNo,
        binId: null,
        grnLineId: l.id,
        quantity: l.rejectedBaseQty,
        unitCost: l.baseCost,
        value: round2(l.rejectedBaseQty * l.baseCost),
        reason: l.rejectionReason,
      }),
    );
    const rts = await m.save(
      m.create(ReturnToSupplier, {
        number: await this.numbering.next(DocumentType.RETURN_TO_SUPPLIER, { storeId: grn.storeId, manager: m }),
        source: SupplierReturnSource.GRN_REJECT,
        status: SupplierReturnStatus.DISPATCHED,
        supplierId: grn.supplierId,
        storeId: grn.storeId,
        grnId: grn.id,
        purchaseOrderId: grn.purchaseOrderId,
        reasonCode,
        returnDate: grn.receivedDate,
        dispatchedAt: new Date(),
        totalValue: round2(lines.reduce((s, l) => s + l.value, 0)),
        lines,
      }),
    );
    await this.links.link(m, { type: DocumentType.GOODS_RECEIVED_NOTE, id: grn.id, no: grn.number }, { type: DocumentType.RETURN_TO_SUPPLIER, id: rts.id, no: rts.number });
    return rts;
  }

  async create(dto: CreateSupplierReturnDto) {
    StoreScope.assert(dto.storeId);
    const id = await this.ds.transaction(async (m) => {
      await this.assertReason(m, dto.reasonCode);
      const [supplier] = await m.query(`SELECT id FROM supplier WHERE id = $1`, [dto.supplierId]);
      if (!supplier) throw new NotFoundException('Supplier not found');
      const method = await this.settings.get('inventory.valuationMethod', m);
      let grn: GoodsReceivedNote | null = null;
      if (dto.grnId) {
        grn = await m.findOneBy(GoodsReceivedNote, { id: dto.grnId });
        if (!grn) throw new NotFoundException('GRN not found');
        if (grn.supplierId !== dto.supplierId) throw new BadRequestException(`GRN ${grn.number} is from another supplier`);
      }
      const lines: ReturnToSupplierLine[] = [];
      const grnIds = new Set<string>();
      for (const l of dto.lines) {
        const [b] = await m.query(`SELECT id, item_id, batch_no FROM batch WHERE id = $1`, [l.batchId]);
        if (!b) throw new NotFoundException('Batch not found');
        const binId = await assertBin(m, dto.storeId, l.binId);
        // The receipt this batch came on from this supplier (the given GRN, else the latest one).
        const [gl] = await m.query(
          `SELECT gl.id, gl.grn_id, gl.accepted_base_qty::float AS accepted
             FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id
            WHERE gl.batch_id = $1 AND g.supplier_id = $2 AND g.status = 'POSTED' ${grn ? 'AND g.id = $3' : ''}
            ORDER BY g.received_date DESC LIMIT 1`,
          grn ? [l.batchId, dto.supplierId, grn.id] : [l.batchId, dto.supplierId],
        );
        if (grn && !gl) throw new BadRequestException(`Batch ${b.batch_no} was not received on GRN ${grn.number}`);
        if (gl) grnIds.add(gl.grn_id);
        const cost = await currentCost(m, dto.storeId, b.item_id, b.id, method);
        lines.push(
          m.create(ReturnToSupplierLine, {
            itemId: b.item_id,
            batchId: b.id,
            batchNo: b.batch_no,
            binId,
            grnLineId: gl?.id ?? null,
            quantity: l.quantity,
            unitCost: cost,
            value: round2(l.quantity * cost),
            reason: l.reason ?? null,
          }),
        );
      }
      await this.assertWithinReceived(m, lines, null);
      // Link to the GRN (and its PO) when all lines came on one receipt.
      const grnId = grn?.id ?? (grnIds.size === 1 ? [...grnIds][0] : null);
      const linkedGrn = grnId ? (grn ?? (await m.findOneByOrFail(GoodsReceivedNote, { id: grnId }))) : null;
      const rts = await m.save(
        m.create(ReturnToSupplier, {
          number: await this.numbering.next(DocumentType.RETURN_TO_SUPPLIER, { storeId: dto.storeId, manager: m }),
          source: SupplierReturnSource.STOCK,
          status: SupplierReturnStatus.DRAFT,
          supplierId: dto.supplierId,
          storeId: dto.storeId,
          grnId: linkedGrn?.id ?? null,
          purchaseOrderId: linkedGrn?.purchaseOrderId ?? null,
          reasonCode: dto.reasonCode,
          notes: dto.notes ?? null,
          totalValue: round2(lines.reduce((s, l) => s + l.value, 0)),
          lines,
        }),
      );
      return rts.id;
    });
    return this.get(id);
  }

  /** A GRN line cannot be returned beyond what was accepted on it (across all live returns). */
  private async assertWithinReceived(m: EntityManager, lines: ReturnToSupplierLine[], exceptReturnId: string | null) {
    const byGrnLine = new Map<string, number>();
    for (const l of lines) if (l.grnLineId) byGrnLine.set(l.grnLineId, round4((byGrnLine.get(l.grnLineId) ?? 0) + l.quantity));
    for (const [grnLineId, qty] of byGrnLine) {
      const [r] = await m.query(
        `SELECT gl.accepted_base_qty::float AS accepted,
                COALESCE((SELECT SUM(x.quantity) FROM return_to_supplier_line x JOIN return_to_supplier rt ON rt.id = x.return_id
                           WHERE x.grn_line_id = gl.id AND x.batch_id IS NOT NULL AND rt.status <> 'CANCELLED'
                             AND ($2::uuid IS NULL OR rt.id <> $2)), 0)::float AS returned
           FROM grn_line gl WHERE gl.id = $1`,
        [grnLineId, exceptReturnId],
      );
      if (r && qty > round4(r.accepted - r.returned)) {
        throw new BadRequestException(`Only ${round4(r.accepted - r.returned)} of that receipt can still be returned`);
      }
    }
  }

  async dispatch(id: string, dto: DispatchSupplierReturnDto, actor: SessionUser) {
    const pre = await this.get(id);
    StoreScope.assert(pre.storeId);
    const controlled = await this.inventory.anyControlled(this.ds.manager, pre.lines!.map((l) => l.itemId));
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;
    await this.ds.transaction(async (m) => {
      const rts = await this.lock(m, id);
      if (rts.status !== SupplierReturnStatus.DRAFT) throw new ConflictException(`Return is ${rts.status}`);
      if (rts.source !== SupplierReturnSource.STOCK) throw new ConflictException('Only returns from stock are dispatched');
      const today = await this.settings.today(m);
      const date = dto.returnDate ?? today;
      if (date > today) throw new BadRequestException('The return date cannot be in the future');
      const lines = await m.find(ReturnToSupplierLine, { where: { returnId: id } });
      await this.assertWithinReceived(m, lines, rts.id);
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.RETURN_TO_SUPPLIER, id: rts.id, number: rts.number }, date, witnessId, m);
      const movements: MovementLine[] = lines.map((l) => ({
        txnType: StockTxnType.SUPPLIER_RETURN,
        storeId: rts.storeId,
        binId: l.binId,
        itemId: l.itemId,
        batchId: l.batchId!,
        quantity: -l.quantity,
        reasonCode: rts.reasonCode,
      }));
      const posted = await postMovements(m, movements, ctx);
      lines.forEach((l, i) => {
        l.unitCost = round6(posted[i].unitCost);
        l.value = round2(-posted[i].valueDelta);
      });
      await m.save(lines);
      rts.totalValue = round2(lines.reduce((s, l) => s + l.value, 0));
      rts.status = SupplierReturnStatus.DISPATCHED;
      rts.returnDate = date;
      rts.dispatchedBy = actor.id;
      rts.dispatchedAt = new Date();
      rts.witnessId = witnessId;
      await m.save(rts);
      if (rts.grnId) {
        const grn = await m.findOneByOrFail(GoodsReceivedNote, { id: rts.grnId });
        await this.links.link(m, { type: DocumentType.GOODS_RECEIVED_NOTE, id: grn.id, no: grn.number }, { type: DocumentType.RETURN_TO_SUPPLIER, id: rts.id, no: rts.number });
      }
    });
    return this.get(id);
  }

  /** Records the supplier's credit note against the return (debit note). */
  async recordCredit(id: string, dto: CreditNoteDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const rts = await this.lock(m, id);
      if (rts.status !== SupplierReturnStatus.DISPATCHED) throw new ConflictException(`Return is ${rts.status}; it must be dispatched first`);
      const dup = await m.findOne(ReturnToSupplier, { where: { supplierId: rts.supplierId, creditNoteNo: dto.creditNoteNo.trim(), id: Not(rts.id) } });
      if (dup) throw new ConflictException(`Credit note ${dto.creditNoteNo} is already recorded on ${dup.number}`);
      rts.creditNoteNo = dto.creditNoteNo.trim();
      rts.creditNoteDate = dto.creditNoteDate;
      rts.creditNoteAmount = dto.amount;
      rts.creditRecordedBy = actor.id;
      rts.status = SupplierReturnStatus.CREDITED;
      await m.save(rts);
    });
    return this.get(id);
  }

  async cancel(id: string) {
    await this.ds.transaction(async (m) => {
      const rts = await this.lock(m, id);
      if (rts.status !== SupplierReturnStatus.DRAFT) throw new ConflictException(`Return is ${rts.status}`);
      StoreScope.assert(rts.storeId);
      rts.status = SupplierReturnStatus.CANCELLED;
      await m.save(rts);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<ReturnToSupplier> {
    const r = await m.findOne(ReturnToSupplier, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Return not found');
    return r;
  }

  async get(id: string) {
    const r = await this.ds.getRepository(ReturnToSupplier).findOne({
      where: { id },
      relations: { supplier: true, store: true, grn: true, purchaseOrder: true, lines: { item: { baseUom: true } } },
    });
    if (!r) throw new NotFoundException('Return not found');
    StoreScope.assert(r.storeId);
    const variance = r.creditNoteAmount !== null ? round2(r.creditNoteAmount - r.totalValue) : null;
    return { ...r, creditVariance: variance };
  }

  async list(q: DocListQueryDto): Promise<Paginated<ReturnToSupplier>> {
    const qb = this.ds
      .getRepository(ReturnToSupplier)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.supplier', 'supplier')
      .leftJoinAndSelect('r.store', 'store')
      .leftJoinAndSelect('r.grn', 'grn')
      .orderBy('r.createdAt', 'DESC');
    StoreScope.apply(qb, 'r.store_id');
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.supplierId) qb.andWhere('r.supplier_id = :s', { s: q.supplierId });
    if (q.storeId) qb.andWhere('r.store_id = :store', { store: q.storeId });
    if (q.purchaseOrderId) qb.andWhere('r.purchase_order_id = :po', { po: q.purchaseOrderId });
    if (q.search) qb.andWhere('(r.number ILIKE :q OR supplier.name ILIKE :q OR r.credit_note_no ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  forGrn(grnId: string) {
    return this.ds.getRepository(ReturnToSupplier).find({ where: { grnId }, relations: { lines: true }, order: { createdAt: 'ASC' } });
  }
}

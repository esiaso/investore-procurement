import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  DocumentType,
  GrnStatus,
  Paginated,
  Permissions,
  RegularisationStatus,
  SessionUser,
  StockTxnType,
} from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { UnitsService } from '../catalog/units.service';
import { Batch } from '../inventory/inventory.entities';
import { InventoryService } from '../inventory/inventory.service';
import { postMovements } from '../inventory/posting';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { TaxService } from '../tax/tax.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SupplierReturnsService } from './supplier-returns.service';
import { CreateGrnDto, DocListQueryDto, InspectGrnDto, PostGrnDto } from './purchasing.dto';
import { GoodsReceivedNote, GrnLine, PurchaseOrder, PurchaseOrderLine, ReturnToSupplier } from './purchasing.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * GRN workflow: DRAFT (receiver records what arrived: batch, expiry, quantity
 * in the delivery unit) → INSPECTION (committee signs off accepted vs
 * rejected) → POSTED (accepted base quantities go to stock through
 * postMovements; rejections produce a return-to-supplier note).
 */
@Injectable()
export class GrnsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly orders: PurchaseOrdersService,
    private readonly suppliers: SuppliersService,
    private readonly inventory: InventoryService,
    private readonly units: UnitsService,
    private readonly tax: TaxService,
    private readonly settings: SettingsService,
    private readonly supplierReturns: SupplierReturnsService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.GOODS_RECEIVED_NOTE, async (ids) => {
      const rows = await this.ds.getRepository(GoodsReceivedNote).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.isEmergency ? `${r.status} (emergency: ${r.regularisationStatus})` : r.status, date: r.receivedDate }]));
    });
  }

  /** Receiver must not be the PR requester or a PO approver. */
  private async assertSegregation(m: EntityManager, po: PurchaseOrder | null, actor: SessionUser) {
    if (!po) return;
    if (po.requisitionId) {
      const [pr] = await m.query(`SELECT requested_by FROM purchase_requisition WHERE id = $1`, [po.requisitionId]);
      if (pr?.requested_by === actor.id) throw new ForbiddenException('You requested these goods and cannot receive them');
    }
    await this.orders.assertNotCreatorOrApprover(po.id, actor, 'receive against it');
  }

  async create(dto: CreateGrnDto, actor: SessionUser): Promise<GoodsReceivedNote> {
    const id = await this.ds.transaction(async (m) => {
      const today = await this.settings.today(m);
      const receivedDate = dto.receivedDate ?? today;
      if (receivedDate > today) throw new BadRequestException('Received date is in the future');
      let po: PurchaseOrder | null = null;
      let poLines: PurchaseOrderLine[] = [];
      if (dto.purchaseOrderId) {
        po = await m.findOne(PurchaseOrder, { where: { id: dto.purchaseOrderId }, lock: { mode: 'pessimistic_write' } });
        if (!po) throw new NotFoundException('Purchase order not found');
        if (!this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po.status}; it cannot be received against`);
        poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId: po.id } });
      } else {
        if (!actor.permissions.includes(Permissions.PURCHASING_EMERGENCY_RECEIPT)) {
          throw new ForbiddenException('Receiving without a purchase order needs the emergency-receipt permission');
        }
        if (!dto.supplierId || !dto.emergencyReason?.trim()) throw new BadRequestException('Emergency receipts need a supplier and a reason');
      }
      await this.assertSegregation(m, po, actor);
      const storeId = dto.storeId ?? po?.storeId;
      if (!storeId) throw new BadRequestException('storeId is required');
      StoreScope.assert(storeId);
      const supplierId = po?.supplierId ?? dto.supplierId!;

      const lines: Partial<GrnLine>[] = [];
      for (const [i, l] of dto.lines.entries()) {
        const where = `Line ${i + 1}`;
        const poLine = l.poLineId ? poLines.find((p) => p.id === l.poLineId) : undefined;
        if (po && !poLine) throw new BadRequestException(`${where}: choose the PO line being received`);
        const itemId = poLine?.itemId ?? l.itemId;
        if (!itemId) throw new BadRequestException(`${where}: item is required`);
        const [item] = await m.query(`SELECT id, code, is_batch_tracked, base_uom_id, tax_category_id FROM item WHERE id = $1`, [itemId]);
        if (!item) throw new NotFoundException(`${where}: item not found`);
        if (item.is_batch_tracked) {
          if (!l.batchNo?.trim() || !l.expiryDate) throw new BadRequestException(`${where}: ${item.code} needs batch number and expiry date`);
          if (l.expiryDate <= receivedDate) throw new BadRequestException(`${where}: batch ${l.batchNo} is already expired`);
        }
        const uomId = l.uomId ?? poLine?.uomId ?? item.base_uom_id;
        const factor = poLine && uomId === poLine.uomId ? poLine.conversionFactor : uomId === item.base_uom_id ? 1 : await this.units.factorToBase(itemId, uomId);
        const baseQty = round4(l.quantity * factor);
        if (poLine) {
          const ordered = round4(poLine.quantity * poLine.conversionFactor);
          const tolerance = (await this.settings.get('purchasing.overReceiptTolerancePct', m)) / 100;
          const pending: { q: string }[] = await m.query(
            `SELECT COALESCE(SUM(gl.received_base_qty), 0) AS q FROM grn_line gl JOIN goods_received_note g ON g.id = gl.grn_id
              WHERE gl.po_line_id = $1 AND g.status IN ('DRAFT', 'INSPECTION')`,
            [poLine.id],
          );
          const already = poLine.receivedBaseQty + Number(pending[0].q);
          if (already + baseQty > ordered * (1 + tolerance) + 1e-9) {
            throw new BadRequestException(`${where}: receiving ${baseQty} would exceed the ordered ${ordered} base units (${already} already received or pending)`);
          }
        }
        const unitPrice = l.unitPrice ?? (poLine ? round4((poLine.unitPrice * factor) / poLine.conversionFactor) : 0);
        const rate = poLine?.taxRatePercent ?? (await this.tax.rateFor(item.tax_category_id, receivedDate));
        lines.push({
          poLineId: poLine?.id ?? null,
          itemId,
          batchNo: l.batchNo?.trim() || null,
          manufactureDate: l.manufactureDate ?? null,
          expiryDate: l.expiryDate ?? null,
          uomId,
          conversionFactor: factor,
          quantity: l.quantity,
          receivedBaseQty: baseQty,
          unitPrice,
          taxRatePercent: rate,
          binId: l.binId ?? null,
        });
      }
      for (const l of lines) {
        if (l.binId) {
          const [bin] = await m.query(`SELECT store_id FROM bin WHERE id = $1`, [l.binId]);
          if (bin?.store_id !== storeId) throw new BadRequestException('Bin does not belong to the receiving store');
        }
      }
      const grn = await m.save(
        m.create(GoodsReceivedNote, {
          number: await this.numbering.next(DocumentType.GOODS_RECEIVED_NOTE, { storeId, date: receivedDate, manager: m }),
          purchaseOrderId: po?.id ?? null,
          supplierId,
          storeId,
          receivedDate,
          deliveryNoteNo: dto.deliveryNoteNo ?? null,
          receivedBy: actor.id,
          isEmergency: !po,
          regularisationStatus: po ? RegularisationStatus.NOT_REQUIRED : RegularisationStatus.PENDING,
          emergencyReason: po ? null : dto.emergencyReason!.trim(),
          notes: dto.notes ?? null,
          status: GrnStatus.DRAFT,
          lines: lines.map((l) => m.create(GrnLine, l)),
        }),
      );
      if (po) await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.GOODS_RECEIVED_NOTE, id: grn.id, no: grn.number });
      return grn.id;
    });
    return this.get(id);
  }

  async submitForInspection(id: string, actor: SessionUser): Promise<GoodsReceivedNote> {
    await this.ds.transaction(async (m) => {
      const grn = await this.lock(m, id);
      if (grn.status !== GrnStatus.DRAFT) throw new ConflictException(`GRN is ${grn.status}`);
      if (grn.receivedBy !== actor.id) throw new ForbiddenException('Only the receiver can submit this GRN');
      grn.status = GrnStatus.INSPECTION;
      await m.save(grn);
      const inspectors: { id: string }[] = await m.query(
        `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role_permission rp ON rp.role_id = ur.role_id
          WHERE rp.permission_code = $1 AND u.is_active AND u.id <> $2`,
        [Permissions.PURCHASING_INSPECT, actor.id],
      );
      await this.notifications.notify(m, inspectors.map((i) => i.id), { title: `Inspection needed: ${grn.number}`, link: `/grns/${grn.id}` });
    });
    return this.get(id);
  }

  /** A committee member records (or confirms) accepted / rejected quantities. */
  async inspect(id: string, dto: InspectGrnDto, actor: SessionUser): Promise<GoodsReceivedNote> {
    await this.ds.transaction(async (m) => {
      const grn = await this.lock(m, id, false);
      if (grn.status !== GrnStatus.INSPECTION) throw new ConflictException(`GRN is ${grn.status}`);
      if (grn.receivedBy === actor.id) throw new ForbiddenException('The receiver cannot sit on the inspection committee for their own GRN');
      const lines = await m.find(GrnLine, { where: { grnId: id } });
      if (dto.lines?.length) {
        for (const r of dto.lines) {
          const line = lines.find((l) => l.id === r.lineId);
          if (!line) throw new BadRequestException(`Line ${r.lineId} is not on this GRN`);
          if (round4(r.acceptedQty + r.rejectedQty) !== round4(line.receivedBaseQty)) {
            throw new BadRequestException(`Accepted + rejected must equal the ${line.receivedBaseQty} base units received`);
          }
          if (r.rejectedQty > 0 && !r.rejectionReason?.trim()) throw new BadRequestException('Give a reason for rejected quantities');
          line.acceptedBaseQty = r.acceptedQty;
          line.rejectedBaseQty = r.rejectedQty;
          line.rejectionReason = r.rejectedQty > 0 ? r.rejectionReason!.trim() : null;
          await m.save(line);
        }
        // New results: earlier sign-offs no longer apply.
        grn.inspectedBy = [actor.id];
      } else {
        if (!grn.inspectedBy.length) throw new BadRequestException('The first inspector must record accepted and rejected quantities');
        if (!grn.inspectedBy.includes(actor.id)) grn.inspectedBy = [...grn.inspectedBy, actor.id];
      }
      if (dto.notes) grn.inspectionNotes = [grn.inspectionNotes, dto.notes].filter(Boolean).join('\n');
      await m.save(grn);
    });
    return this.get(id, actor);
  }

  async post(id: string, dto: PostGrnDto, actor: SessionUser): Promise<GoodsReceivedNote> {
    const pre = await this.get(id);
    const controlled = await this.inventory.anyControlled(this.ds.manager, (pre.lines ?? []).map((l) => l.itemId));
    const witnessId = controlled && dto.witness ? await this.inventory.verifyWitness(dto.witness, actor) : null;

    await this.ds.transaction(async (m) => {
      const grn = await this.lock(m, id);
      if (grn.status !== GrnStatus.INSPECTION) throw new ConflictException(`GRN is ${grn.status}; it must pass inspection first`);
      StoreScope.assert(grn.storeId);
      const minMembers = await this.settings.get('purchasing.inspectionCommitteeMinMembers', m);
      if (grn.inspectedBy.length < minMembers) {
        throw new BadRequestException({ message: `${minMembers} inspection committee sign-offs are required (${grn.inspectedBy.length} so far)`, code: 'INSPECTION_INCOMPLETE' });
      }
      const po = grn.purchaseOrderId ? await m.findOneByOrFail(PurchaseOrder, { id: grn.purchaseOrderId }) : null;
      await this.assertSegregation(m, po, actor);
      const lines = await m.find(GrnLine, { where: { grnId: id }, relations: { item: true } });
      const includeVat = await this.settings.get('purchasing.costIncludesVat', m);

      // Controlled drugs: an inspector (not the poster) or a verified witness co-signs.
      const coSigner = witnessId ?? grn.inspectedBy.find((u) => u !== actor.id) ?? null;
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.GOODS_RECEIVED_NOTE, id: grn.id, number: grn.number }, grn.receivedDate, coSigner, m);

      const baseCostOf = (l: GrnLine) => round6((l.unitPrice / l.conversionFactor) * (includeVat ? 1 + l.taxRatePercent / 100 : 1));
      const movements = [];
      for (const l of lines) {
        if (l.acceptedBaseQty <= 0) continue;
        const baseCost = baseCostOf(l);
        const batchNo = l.item?.isBatchTracked ? l.batchNo! : 'NOBATCH';
        let batch = await m.findOneBy(Batch, { itemId: l.itemId, batchNo });
        if (batch && l.item?.isBatchTracked && batch.expiryDate !== l.expiryDate) {
          throw new BadRequestException(`Batch ${batchNo} of ${l.item?.code} already exists with expiry ${batch.expiryDate}`);
        }
        if (!batch) {
          batch = await m.save(
            m.create(Batch, { itemId: l.itemId, batchNo, expiryDate: l.item?.isBatchTracked ? l.expiryDate : null, manufactureDate: l.manufactureDate, unitCost: baseCost }),
          );
        }
        l.batchId = batch.id;
        await m.save(l);
        movements.push({
          txnType: StockTxnType.RECEIPT,
          storeId: grn.storeId,
          binId: l.binId,
          itemId: l.itemId,
          batchId: batch.id,
          quantity: l.acceptedBaseQty,
          unitCost: baseCost,
        });
      }
      await postMovements(m, movements, ctx);

      if (po) {
        await this.orders.applyReceipt(
          m,
          po.id,
          lines.filter((l) => l.poLineId && l.acceptedBaseQty > 0).map((l) => ({ poLineId: l.poLineId!, baseQty: l.acceptedBaseQty })),
        );
      }

      const rejected = lines.filter((l) => l.rejectedBaseQty > 0);
      if (rejected.length) {
        await this.supplierReturns.createFromGrnRejects(m, grn, rejected.map((l) => Object.assign(l, { baseCost: baseCostOf(l) })));
      }

      grn.status = GrnStatus.POSTED;
      grn.postedAt = new Date();
      await m.save(grn);
      await this.refreshSupplierPerformance(m, grn.supplierId);
    });
    await this.inventory.stockArrived(pre.storeId, (pre.lines ?? []).filter((l) => l.acceptedBaseQty > 0).map((l) => l.itemId));
    return this.get(id);
  }

  /** Links an emergency GRN to the PO raised afterwards. */
  async regularise(id: string, purchaseOrderId: string): Promise<GoodsReceivedNote> {
    await this.ds.transaction(async (m) => {
      const grn = await this.lock(m, id);
      if (!grn.isEmergency || grn.regularisationStatus !== RegularisationStatus.PENDING) throw new ConflictException('This GRN does not need regularising');
      if (grn.status !== GrnStatus.POSTED) throw new ConflictException('Post the GRN first');
      const po = await m.findOneBy(PurchaseOrder, { id: purchaseOrderId });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (po.supplierId !== grn.supplierId) throw new BadRequestException('The PO is for another supplier');
      if (!this.orders.isOpenForReceipt(po.status)) throw new ConflictException(`PO is ${po.status}`);
      const poLines = await m.find(PurchaseOrderLine, { where: { purchaseOrderId } });
      const lines = await m.find(GrnLine, { where: { grnId: id } });
      const received: { poLineId: string; baseQty: number }[] = [];
      for (const l of lines) {
        const pl = poLines.find((p) => p.itemId === l.itemId);
        if (!pl) throw new BadRequestException('The PO does not cover every item on the GRN');
        l.poLineId = pl.id;
        await m.save(l);
        received.push({ poLineId: pl.id, baseQty: l.acceptedBaseQty });
      }
      await this.orders.applyReceipt(m, po.id, received);
      grn.purchaseOrderId = po.id;
      grn.regularisationStatus = RegularisationStatus.REGULARISED;
      await m.save(grn);
      await this.links.link(m, { type: DocumentType.PURCHASE_ORDER, id: po.id, no: po.number }, { type: DocumentType.GOODS_RECEIVED_NOTE, id: grn.id, no: grn.number });
    });
    return this.get(id);
  }

  async cancel(id: string, actor: SessionUser): Promise<GoodsReceivedNote> {
    await this.ds.transaction(async (m) => {
      const grn = await this.lock(m, id);
      if (![GrnStatus.DRAFT, GrnStatus.INSPECTION].includes(grn.status)) throw new ConflictException(`GRN is ${grn.status}`);
      if (grn.receivedBy !== actor.id) throw new ForbiddenException('Only the receiver can cancel this GRN');
      grn.status = GrnStatus.CANCELLED;
      await m.save(grn);
    });
    return this.get(id);
  }

  /** On-time delivery, quality rejects and price variance from posted GRNs. */
  private async refreshSupplierPerformance(m: EntityManager, supplierId: string): Promise<void> {
    const [g] = await m.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(po.expected_delivery)::int AS with_date,
              COUNT(*) FILTER (WHERE po.expected_delivery IS NOT NULL AND grn.received_date <= po.expected_delivery)::int AS on_time
         FROM goods_received_note grn LEFT JOIN purchase_order po ON po.id = grn.purchase_order_id
        WHERE grn.supplier_id = $1 AND grn.status = 'POSTED'`,
      [supplierId],
    );
    const [l] = await m.query(
      `SELECT SUM(gl.received_base_qty)::float AS received, SUM(gl.rejected_base_qty)::float AS rejected,
              AVG(CASE WHEN pl.unit_price > 0 THEN ((gl.unit_price / gl.conversion_factor) - (pl.unit_price / pl.conversion_factor))
                                                   / (pl.unit_price / pl.conversion_factor) * 100 END)::float AS pv
         FROM grn_line gl JOIN goods_received_note grn ON grn.id = gl.grn_id
         LEFT JOIN purchase_order_line pl ON pl.id = gl.po_line_id
        WHERE grn.supplier_id = $1 AND grn.status = 'POSTED'`,
      [supplierId],
    );
    await this.suppliers.updatePerformance(m, supplierId, {
      grnCount: g.n,
      onTimeDeliveryRate: g.with_date ? Math.round((g.on_time / g.with_date) * 10_000) / 10_000 : null,
      qualityRejectRate: l.received ? Math.round((l.rejected / l.received) * 10_000) / 10_000 : null,
      avgPriceVariancePct: l.pv === null ? null : Math.round(l.pv * 10_000) / 10_000,
    });
  }

  /** Inspection committee members need not belong to the receiving store. */
  private async lock(m: EntityManager, id: string, scoped = true): Promise<GoodsReceivedNote> {
    const grn = await m.findOne(GoodsReceivedNote, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!grn) throw new NotFoundException('GRN not found');
    if (scoped) StoreScope.assert(grn.storeId);
    return grn;
  }

  async get(id: string, actor?: SessionUser): Promise<GoodsReceivedNote & { returns?: ReturnToSupplier[] }> {
    const grn = await this.ds.getRepository(GoodsReceivedNote).findOne({
      where: { id },
      relations: { supplier: true, store: true, purchaseOrder: true, lines: { item: { baseUom: true } } },
    });
    if (!grn) throw new NotFoundException('GRN not found');
    if (!actor?.permissions.includes(Permissions.PURCHASING_INSPECT)) StoreScope.assert(grn.storeId);
    const returns = await this.supplierReturns.forGrn(id);
    return { ...grn, returns } as GoodsReceivedNote & { returns: ReturnToSupplier[] };
  }

  async list(q: DocListQueryDto, actor?: SessionUser): Promise<Paginated<GoodsReceivedNote>> {
    const qb = this.ds
      .getRepository(GoodsReceivedNote)
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.supplier', 'supplier')
      .leftJoinAndSelect('g.store', 'store')
      .leftJoinAndSelect('g.purchaseOrder', 'po')
      .orderBy('g.createdAt', 'DESC');
    if (!actor?.permissions.includes(Permissions.PURCHASING_INSPECT)) StoreScope.apply(qb, 'g.store_id');
    if (q.status) qb.andWhere('g.status = :st', { st: q.status });
    if (q.supplierId) qb.andWhere('g.supplier_id = :s', { s: q.supplierId });
    if (q.storeId) qb.andWhere('g.store_id = :store', { store: q.storeId });
    if (q.purchaseOrderId) qb.andWhere('g.purchase_order_id = :po', { po: q.purchaseOrderId });
    if (q.search) qb.andWhere('(g.number ILIKE :q OR supplier.name ILIKE :q OR g.delivery_note_no ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

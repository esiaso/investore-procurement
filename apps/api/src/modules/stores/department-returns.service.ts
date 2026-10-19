import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  BatchHoldStatus,
  DepartmentReturnStatus,
  DocumentType,
  Paginated,
  Permissions,
  ReturnCondition,
  ReturnReasonKind,
  SessionUser,
  StockTxnType,
} from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { DocumentLinksService } from '../approvals/document-links.service';
import { assertBin, quarantineBin } from '../inventory/doc-helpers';
import { ReturnReason } from '../inventory/documents.entities';
import { InventoryService } from '../inventory/inventory.service';
import { MovementLine, postMovements } from '../inventory/posting';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { assertCanSee, assertOwnDepartment, scopeClause } from './access';
import { CreateDepartmentReturnDto, DocQueryDto, PostDepartmentReturnDto } from './stores.dto';
import { DepartmentReturn, DepartmentReturnLine, IssueVoucher, IssueVoucherLine } from './stores.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Stock coming back from a department: DRAFT (raised by the department or
 * the store) → POSTED by the store. Resaleable stock goes back to the same
 * batch (and a usable bin); damaged or expired stock goes to the store's
 * quarantine bin. The value is credited to the department at the cost it was
 * charged on issue.
 */
@Injectable()
export class DepartmentReturnsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly inventory: InventoryService,
    private readonly settings: SettingsService,
    private readonly links: DocumentLinksService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.DEPARTMENT_RETURN, async (ids) => {
      const rows = await this.ds.getRepository(DepartmentReturn).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.returnDate ?? r.createdAt.toISOString(), amount: r.totalValue }]));
    });
  }

  async create(dto: CreateDepartmentReturnDto, actor: SessionUser) {
    const isStore = actor.permissions.includes(Permissions.INVENTORY_DEPT_RETURN) && StoreScope.allows(actor.storeIds, dto.storeId);
    if (!isStore) assertOwnDepartment(actor, dto.departmentId);
    const id = await this.ds.transaction(async (m) => {
      const [store] = await m.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
      if (!store) throw new BadRequestException('Store not found or inactive');
      const [dept] = await m.query(`SELECT id FROM department WHERE id = $1 AND is_active`, [dto.departmentId]);
      if (!dept) throw new BadRequestException('Department not found or inactive');
      await this.validateLines(m, dto.storeId, dto.lines, await this.settings.today(m));
      const ret = await m.save(
        m.create(DepartmentReturn, {
          number: await this.numbering.next(DocumentType.DEPARTMENT_RETURN, { storeId: dto.storeId, manager: m }),
          departmentId: dto.departmentId,
          storeId: dto.storeId,
          requestedBy: actor.id,
          notes: dto.notes ?? null,
          status: DepartmentReturnStatus.DRAFT,
          lines: dto.lines.map((l) =>
            m.create(DepartmentReturnLine, {
              itemId: l.itemId,
              batchId: l.batchId,
              issueVoucherLineId: l.issueVoucherLineId ?? null,
              quantity: l.quantity,
              reasonCode: l.reasonCode,
              condition: l.condition,
              binId: l.binId ?? null,
              patientRef: l.patientRef?.trim() || null,
            }),
          ),
        }),
      );
      return ret.id;
    });
    return this.get(id, actor);
  }

  private async validateLines(
    m: EntityManager,
    storeId: string,
    lines: { itemId: string; batchId: string; reasonCode: string; condition: ReturnCondition; binId?: string | null }[],
    today: string,
  ) {
    const reasons = await m.find(ReturnReason, { where: { isActive: true, kind: In([ReturnReasonKind.DEPARTMENT, ReturnReasonKind.BOTH]) } });
    for (const l of lines) {
      if (!reasons.some((r) => r.code === l.reasonCode)) throw new BadRequestException(`Unknown or inactive return reason ${l.reasonCode}`);
      const [b] = await m.query(
        `SELECT item_id, batch_no, hold_status, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date FROM batch WHERE id = $1`,
        [l.batchId],
      );
      if (!b) throw new NotFoundException('Batch not found');
      if (b.item_id !== l.itemId) throw new BadRequestException(`Batch ${b.batch_no} belongs to another item`);
      if (l.condition === ReturnCondition.RESALEABLE) {
        if (b.hold_status !== BatchHoldStatus.NONE) throw new BadRequestException(`Batch ${b.batch_no} is on hold: return it as damaged or expired`);
        if (b.expiry_date && b.expiry_date <= today) throw new BadRequestException(`Batch ${b.batch_no} has expired: return it as expired`);
        if (l.binId) {
          await assertBin(m, storeId, l.binId);
          const [bin] = await m.query(`SELECT is_quarantine FROM bin WHERE id = $1`, [l.binId]);
          if (bin?.is_quarantine) throw new BadRequestException('Resaleable stock cannot go to a quarantine bin');
        }
      }
    }
  }

  async post(id: string, dto: PostDepartmentReturnDto, actor: SessionUser) {
    const pre = await this.get(id, actor);
    StoreScope.assert(pre.storeId);
    const controlled = await this.inventory.anyControlled(this.ds.manager, pre.lines!.map((l) => l.itemId));
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;

    await this.ds.transaction(async (m) => {
      const ret = await this.lock(m, id);
      if (ret.status !== DepartmentReturnStatus.DRAFT) throw new ConflictException(`Return is ${ret.status}`);
      StoreScope.assert(ret.storeId);
      const today = await this.settings.today(m);
      const date = dto.returnDate ?? today;
      if (date > today) throw new BadRequestException('The return date cannot be in the future');
      const lines = await m.find(DepartmentReturnLine, { where: { returnId: id } });
      await this.validateLines(m, ret.storeId, lines, date);

      // Quantities and cost: from the issue line when given, else from what was issued to the department.
      const byIssueLine = new Map<string, number>();
      const byBatch = new Map<string, number>();
      for (const l of lines) {
        if (l.issueVoucherLineId) byIssueLine.set(l.issueVoucherLineId, round4((byIssueLine.get(l.issueVoucherLineId) ?? 0) + l.quantity));
        else byBatch.set(l.batchId, round4((byBatch.get(l.batchId) ?? 0) + l.quantity));
      }
      const issueLines = byIssueLine.size
        ? await m.find(IssueVoucherLine, { where: { id: In([...byIssueLine.keys()]) }, lock: { mode: 'pessimistic_write' } })
        : [];
      for (const [ivlId, qty] of byIssueLine) {
        const ivl = issueLines.find((x) => x.id === ivlId);
        if (!ivl) throw new BadRequestException('Issue line not found');
        const voucher = await m.findOneByOrFail(IssueVoucher, { id: ivl.voucherId });
        if (voucher.departmentId !== ret.departmentId || voucher.storeId !== ret.storeId) {
          throw new BadRequestException(`Issue ${voucher.number} was not from this store to this department`);
        }
        const left = round4(ivl.quantity - ivl.returnedQty);
        if (qty > left) throw new BadRequestException(`Only ${left} of the stock issued on ${voucher.number} can still be returned`);
      }
      const batchCost = new Map<string, number>();
      for (const [batchId, qty] of byBatch) {
        const [r] = await m.query(
          `SELECT COALESCE(SUM(-quantity) FILTER (WHERE txn_type = 'ISSUE'), 0)::float AS issued,
                  COALESCE(SUM(-value_delta) FILTER (WHERE txn_type = 'ISSUE'), 0)::float AS issued_value,
                  COALESCE(SUM(quantity) FILTER (WHERE txn_type = 'RETURN_IN'), 0)::float AS returned
             FROM stock_transaction WHERE store_id = $1 AND department_id = $2 AND batch_id = $3`,
          [ret.storeId, ret.departmentId, batchId],
        );
        const left = round4(r.issued - r.returned);
        if (qty > left) {
          const [b] = await m.query(`SELECT batch_no FROM batch WHERE id = $1`, [batchId]);
          throw new BadRequestException(`Only ${left} of batch ${b?.batch_no} was issued to this department and not yet returned`);
        }
        batchCost.set(batchId, r.issued > 0 ? r.issued_value / r.issued : 0);
      }

      const quarantineCode = await this.settings.get('inventory.quarantineBinCode', m);
      let quarantine: string | null = null;
      const movements: MovementLine[] = [];
      for (const l of lines) {
        const ivl = l.issueVoucherLineId ? issueLines.find((x) => x.id === l.issueVoucherLineId)! : null;
        l.unitCost = ivl ? ivl.unitCost : batchCost.get(l.batchId)!;
        l.value = round2(l.quantity * l.unitCost);
        if (l.condition !== ReturnCondition.RESALEABLE) {
          quarantine ??= await quarantineBin(m, ret.storeId, quarantineCode);
          l.binId = quarantine;
        }
        movements.push({
          txnType: StockTxnType.RETURN_IN,
          storeId: ret.storeId,
          binId: l.binId,
          itemId: l.itemId,
          batchId: l.batchId,
          quantity: l.quantity,
          unitCost: l.unitCost,
          departmentId: ret.departmentId,
          reasonCode: l.reasonCode,
          patientRef: l.patientRef ?? ivl?.patientRef ?? null,
        });
      }
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.DEPARTMENT_RETURN, id: ret.id, number: ret.number }, date, witnessId, m);
      await postMovements(m, movements, ctx);
      await m.save(lines);
      for (const ivl of issueLines) {
        ivl.returnedQty = round4(ivl.returnedQty + byIssueLine.get(ivl.id)!);
        await m.save(ivl);
        const voucher = await m.findOneByOrFail(IssueVoucher, { id: ivl.voucherId });
        await this.links.link(m, { type: DocumentType.ISSUE_NOTE, id: voucher.id, no: voucher.number }, { type: DocumentType.DEPARTMENT_RETURN, id: ret.id, no: ret.number });
      }
      ret.status = DepartmentReturnStatus.POSTED;
      ret.returnDate = date;
      ret.receivedBy = actor.id;
      ret.witnessId = witnessId;
      ret.postedAt = new Date();
      ret.totalValue = round2(lines.reduce((s, l) => s + l.value, 0));
      await m.save(ret);
    });
    await this.inventory.stockArrived(pre.storeId, pre.lines!.filter((l) => l.condition === ReturnCondition.RESALEABLE).map((l) => l.itemId));
    return this.get(id, actor);
  }

  async cancel(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const ret = await this.lock(m, id);
      if (ret.status !== DepartmentReturnStatus.DRAFT) throw new ConflictException(`Return is ${ret.status}`);
      const isStore = actor.permissions.includes(Permissions.INVENTORY_DEPT_RETURN) && StoreScope.allows(actor.storeIds, ret.storeId);
      if (ret.requestedBy !== actor.id && !isStore) throw new ForbiddenException('Only the person who raised it or the store can cancel this return');
      ret.status = DepartmentReturnStatus.CANCELLED;
      await m.save(ret);
    });
    return this.get(id, actor);
  }

  private async lock(m: EntityManager, id: string): Promise<DepartmentReturn> {
    const r = await m.findOne(DepartmentReturn, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Return not found');
    return r;
  }

  async get(id: string, actor: SessionUser) {
    const r = await this.ds.getRepository(DepartmentReturn).findOne({
      where: { id },
      relations: { department: true, store: true, lines: { item: { baseUom: true }, batch: true } },
    });
    if (!r) throw new NotFoundException('Return not found');
    assertCanSee(actor, r, 'Return');
    return r;
  }

  async list(q: DocQueryDto, actor: SessionUser): Promise<Paginated<DepartmentReturn>> {
    const qb = this.ds
      .getRepository(DepartmentReturn)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.department', 'department')
      .leftJoinAndSelect('r.store', 'store')
      .orderBy('r.createdAt', 'DESC');
    const scope = scopeClause(actor, 'r');
    if (scope) qb.andWhere(scope.sql, scope.params);
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.storeId) qb.andWhere('r.store_id = :s', { s: q.storeId });
    if (q.departmentId) qb.andWhere('r.department_id = :d', { d: q.departmentId });
    if (q.search) qb.andWhere('r.number ILIKE :q', { q: `%${q.search}%` });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Issued lines a department can still return (for the return form). */
  async returnable(departmentId: string, storeId: string, actor: SessionUser) {
    assertCanSee(actor, { departmentId, storeId }, 'Department');
    return this.ds.query(
      `SELECT l.id AS "issueVoucherLineId", v.number AS "voucherNo", to_char(v.issue_date, 'YYYY-MM-DD') AS "issueDate",
              l.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName", u.code AS uom,
              l.batch_id AS "batchId", b.batch_no AS "batchNo", to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
              (l.quantity - l.returned_qty)::float AS "returnableQty", l.unit_cost::float AS "unitCost", l.patient_ref AS "patientRef"
         FROM issue_voucher_line l
         JOIN issue_voucher v ON v.id = l.voucher_id
         JOIN item i ON i.id = l.item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         JOIN batch b ON b.id = l.batch_id
        WHERE v.department_id = $1 AND v.store_id = $2 AND l.quantity > l.returned_qty
        ORDER BY v.issue_date DESC, i.name
        LIMIT 500`,
      [departmentId, storeId],
    );
  }
}

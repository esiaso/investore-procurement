import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DocumentType, HoldReason, HoldStatus, Permissions, RecallClass, RecallReturnSource, RecallSource, RecallStatus, SessionUser, StockTxnType } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { postMovements } from '../inventory/posting';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { HoldsService } from './holds.service';
import { Recall, RecallReturn } from './quality.entities';

export interface RecallInput {
  source: RecallSource;
  noticeReference?: string | null;
  noticeDate: string;
  classification: RecallClass;
  itemId: string;
  batchNos?: string[];
  reason: string;
  instructions?: string | null;
  patientLevel?: boolean;
}

/**
 * Recall management: the notice quarantines every affected batch in every
 * store at once; the trace lists every store holding the batches and every
 * issue, dispense, sale and transfer of them (with patients); returns and
 * outcomes are recorded until the recall is closed.
 */
@Injectable()
export class RecallsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly holds: HoldsService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
  ) {}

  async create(dto: RecallInput, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const [item] = await m.query(`SELECT id, name FROM item WHERE id = $1`, [dto.itemId]);
      if (!item) throw new NotFoundException('Item not found');
      const batchNos = [...new Set((dto.batchNos ?? []).map((b) => b.trim()).filter(Boolean))];
      const batches: { id: string; batch_no: string }[] = await m.query(
        `SELECT id, batch_no FROM batch WHERE item_id = $1 ${batchNos.length ? 'AND batch_no = ANY($2::text[])' : ''}`,
        batchNos.length ? [dto.itemId, batchNos] : [dto.itemId],
      );
      const r = await m.save(
        m.create(Recall, {
          number: await this.numbering.next(DocumentType.RECALL, { manager: m }),
          source: dto.source,
          noticeReference: dto.noticeReference ?? null,
          noticeDate: dto.noticeDate,
          classification: dto.classification,
          itemId: dto.itemId,
          batchNos,
          batchIds: batches.map((b) => b.id),
          reason: dto.reason,
          instructions: dto.instructions ?? null,
          patientLevel: dto.patientLevel ?? dto.classification === RecallClass.CLASS_I,
          status: RecallStatus.OPEN,
        }),
      );
      for (const b of batches) {
        await this.holds.place(m, { batchId: b.id, storeId: null, reason: HoldReason.RECALL, details: `Recall ${r.number} (${dto.source}${dto.noticeReference ? ` ${dto.noticeReference}` : ''}): ${dto.reason}`, sourceType: 'RECALL', sourceId: r.id }, actor.id);
      }
      // Everyone who holds or handles the stock is told at once.
      const users: { id: string }[] = await m.query(
        `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role_permission rp ON rp.role_id = ur.role_id
          WHERE u.is_active AND rp.permission_code = ANY($1::text[])`,
        [[Permissions.RECALLS_MANAGE, Permissions.QUALITY_RELEASE, Permissions.INVENTORY_ALERTS, Permissions.PHARMACY_DISPENSE]],
      );
      await this.notifications.notify(m, users.map((u) => u.id), {
        title: `RECALL ${r.number}: ${item.name}${batchNos.length ? ` batch ${batchNos.join(', ')}` : ' (all batches)'}`,
        body: `${dto.classification.replace('_', ' ')} · ${dto.reason}. Stop issuing and dispensing; the batches are quarantined.`,
        link: `/recalls/${r.id}`,
      });
      return r.id;
    });
    return this.get(id);
  }

  /** Every store holding the batches and every movement out of them, with patients. */
  async trace(id: string) {
    const r = await this.ds.getRepository(Recall).findOneBy({ id });
    if (!r) throw new NotFoundException('Recall not found');
    const ids = r.batchIds;
    if (!ids.length) return { recall: r, holdings: [], issues: [], dispenses: [], sales: [], transfers: [], otherMovements: [], patients: [], totals: { onHand: 0, inTransit: 0, issued: 0, dispensed: 0, sold: 0, returned: 0 } };
    const holdings = await this.ds.query(
      `SELECT s.id AS "storeId", s.code AS "storeCode", s.name AS "storeName", b.batch_no AS "batchNo", bn.code AS "binCode",
              sb.on_hand::float AS "onHand", sb.reserved::float AS "reserved", sb.in_transit::float AS "inTransit"
         FROM stock_balance sb JOIN store s ON s.id = sb.store_id JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
        WHERE sb.batch_id = ANY($1::uuid[]) AND (sb.on_hand <> 0 OR sb.in_transit <> 0)
        ORDER BY s.name, b.batch_no`,
      [ids],
    );
    const issues = await this.ds.query(
      `SELECT t.id, to_char(t.effective_date, 'YYYY-MM-DD') AS date, t.source_doc_type AS "docType", t.source_doc_no AS "docNo", s.name AS "fromStore",
              d.id AS "departmentId", d.name AS department, b.batch_no AS "batchNo", (-t.quantity)::float AS quantity, t.patient_ref AS "patientRef"
         FROM stock_transaction t JOIN store s ON s.id = t.store_id JOIN batch b ON b.id = t.batch_id LEFT JOIN department d ON d.id = t.department_id
        WHERE t.batch_id = ANY($1::uuid[]) AND t.txn_type = 'ISSUE' ORDER BY t.posted_at`,
      [ids],
    );
    const dispenses = await this.ds.query(
      `SELECT dl.id, dp.number AS "dispenseNo", dp.dispensed_at AS "dispensedAt", s.name AS store, b.batch_no AS "batchNo",
              dl.quantity::float AS quantity, dl.returned_qty::float AS "returnedQty",
              p.id AS "patientId", p.hospital_no AS "hospitalNo", p.name AS "patientName", p.phone AS "patientPhone"
         FROM dispense_line dl JOIN dispense dp ON dp.id = dl.dispense_id JOIN store s ON s.id = dp.store_id JOIN batch b ON b.id = dl.batch_id
         JOIN patient p ON p.id = dp.patient_id
        WHERE dl.batch_id = ANY($1::uuid[]) ORDER BY dp.dispensed_at`,
      [ids],
    );
    const sales = await this.ds.query(
      `SELECT si.id AS "invoiceId", si.number AS "invoiceNo", si.issued_at AS "issuedAt", s.name AS store, a->>'batchId' AS "batchId", b.batch_no AS "batchNo",
              (a->>'quantity')::float AS quantity, p.id AS "patientId", p.hospital_no AS "hospitalNo", COALESCE(p.name, si.customer_name) AS "customerName",
              COALESCE(p.phone, si.customer_phone) AS phone
         FROM sales_invoice si JOIN sales_invoice_line l ON l.invoice_id = si.id CROSS JOIN LATERAL jsonb_array_elements(l.allocations) a
         JOIN store s ON s.id = si.store_id JOIN batch b ON b.id = (a->>'batchId')::uuid LEFT JOIN patient p ON p.id = si.patient_id
        WHERE si.status = 'ISSUED' AND si.doc_type = 'INVOICE' AND (a->>'batchId')::uuid = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM dispense d WHERE d.invoice_id = si.id)
        ORDER BY si.issued_at`,
      [ids],
    );
    const transfers = await this.ds.query(
      `SELECT t.id, to_char(t.effective_date, 'YYYY-MM-DD') AS date, t.source_doc_no AS "docNo", s.name AS "fromStore", cs.name AS "toStore", b.batch_no AS "batchNo", (-t.quantity)::float AS quantity
         FROM stock_transaction t JOIN store s ON s.id = t.store_id LEFT JOIN store cs ON cs.id = t.counterpart_store_id JOIN batch b ON b.id = t.batch_id
        WHERE t.batch_id = ANY($1::uuid[]) AND t.txn_type = 'TRANSFER_DISPATCH' AND t.quantity < 0 ORDER BY t.posted_at`,
      [ids],
    );
    const otherMovements = await this.ds.query(
      `SELECT t.id, t.txn_type AS "txnType", to_char(t.effective_date, 'YYYY-MM-DD') AS date, t.source_doc_no AS "docNo", s.name AS store, b.batch_no AS "batchNo", t.quantity::float AS quantity, t.reason_code AS "reasonCode"
         FROM stock_transaction t JOIN store s ON s.id = t.store_id JOIN batch b ON b.id = t.batch_id
        WHERE t.batch_id = ANY($1::uuid[]) AND t.txn_type NOT IN ('ISSUE', 'DISPENSE', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT') ORDER BY t.posted_at`,
      [ids],
    );
    const patientMap = new Map<string, { patientId: string; hospitalNo: string; name: string; phone: string | null; quantity: number; via: string[] }>();
    for (const d of dispenses) {
      const p = patientMap.get(d.patientId) ?? { patientId: d.patientId, hospitalNo: d.hospitalNo, name: d.patientName, phone: d.patientPhone, quantity: 0, via: [] as string[] };
      p.quantity += d.quantity - d.returnedQty;
      p.via.push(d.dispenseNo);
      patientMap.set(d.patientId, p);
    }
    for (const s of sales.filter((x: { patientId: string | null }) => x.patientId)) {
      const p = patientMap.get(s.patientId) ?? { patientId: s.patientId, hospitalNo: s.hospitalNo, name: s.customerName, phone: s.phone, quantity: 0, via: [] as string[] };
      p.quantity += s.quantity;
      p.via.push(s.invoiceNo);
      patientMap.set(s.patientId, p);
    }
    const [ret] = await this.ds.query(`SELECT COALESCE(SUM(quantity), 0)::float AS q FROM recall_return WHERE recall_id = $1`, [id]);
    const sum = (rows: { quantity: number }[]) => Math.round(rows.reduce((s, x) => s + x.quantity, 0) * 10_000) / 10_000;
    return {
      recall: r,
      holdings,
      issues,
      dispenses,
      sales,
      transfers,
      otherMovements,
      patients: [...patientMap.values()],
      // Walk-in buyers without a patient record, shown so they can be contacted from the receipt.
      unidentifiedSales: sales.filter((x: { patientId: string | null }) => !x.patientId).length,
      totals: {
        onHand: sum(holdings.map((h: { onHand: number }) => ({ quantity: h.onHand }))),
        inTransit: sum(holdings.map((h: { inTransit: number }) => ({ quantity: h.inTransit }))),
        issued: sum(issues),
        dispensed: sum(dispenses),
        sold: sum(sales),
        returned: ret.q,
      },
    };
  }

  /**
   * Records stock recovered for the recall. When `intoStoreId` is given the
   * quantity is posted back into that store (department return / patient
   * return); the batch stays on recall hold.
   */
  async recordReturn(id: string, dto: { batchId: string; source: RecallReturnSource; fromId?: string | null; fromName?: string | null; quantity: number; intoStoreId?: string | null; outcome?: string | null; notes?: string | null; returnedOn?: string }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await m.findOne(Recall, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw new NotFoundException('Recall not found');
      if (r.status !== RecallStatus.OPEN) throw new ConflictException('The recall is closed');
      if (!r.batchIds.includes(dto.batchId)) throw new BadRequestException('That batch is not part of this recall');
      if (dto.quantity <= 0) throw new BadRequestException('Quantity must be positive');
      const row = await m.save(
        m.create(RecallReturn, {
          recallId: id,
          batchId: dto.batchId,
          source: dto.source,
          fromId: dto.fromId ?? null,
          fromName: dto.fromName ?? null,
          quantity: dto.quantity,
          intoStoreId: dto.intoStoreId ?? null,
          outcome: dto.outcome ?? null,
          notes: dto.notes ?? null,
          returnedOn: dto.returnedOn ?? (await this.settings.today(m)),
        }),
      );
      if (dto.intoStoreId && dto.source !== RecallReturnSource.STORE) {
        const [b] = await m.query(`SELECT item_id, unit_cost::float AS unit_cost FROM batch WHERE id = $1`, [dto.batchId]);
        const ctx = await this.inventory.postingContext(actor, { type: DocumentType.RECALL, id: r.id, number: r.number }, undefined, null, m);
        await postMovements(
          m,
          [{
            txnType: dto.source === RecallReturnSource.PATIENT ? StockTxnType.DISPENSE_RETURN : StockTxnType.RETURN_IN,
            storeId: dto.intoStoreId,
            binId: null,
            itemId: b.item_id,
            batchId: dto.batchId,
            quantity: dto.quantity,
            unitCost: b.unit_cost,
            departmentId: dto.source === RecallReturnSource.DEPARTMENT ? (dto.fromId ?? null) : null,
            patientRef: dto.source === RecallReturnSource.PATIENT ? (dto.fromName ?? dto.fromId ?? null) : null,
            reasonCode: 'RECALL',
          }],
          ctx,
        );
      }
      return row;
    });
    return this.get(id);
  }

  /** Closes the recall: its holds are closed as rejected (the stock stays unusable until disposed of) or released (recall withdrawn). */
  async close(id: string, dto: { outcome: string; withdrawn?: boolean }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await m.findOne(Recall, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw new NotFoundException('Recall not found');
      if (r.status !== RecallStatus.OPEN) throw new ConflictException('Already closed');
      await this.holds.closeForSource(m, 'RECALL', r.id, dto.withdrawn ? HoldStatus.RELEASED : HoldStatus.REJECTED, dto.outcome, actor.id);
      if (!dto.withdrawn) {
        // Remaining stock stays quarantined for disposal / return to supplier.
        for (const b of r.batchIds) {
          await m.query(`UPDATE batch SET hold_status = 'RECALL', hold_reason = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM stock_balance WHERE batch_id = $1 AND on_hand > 0)`, [b, `Recalled (${r.number}), awaiting disposal or return`]);
        }
      }
      Object.assign(r, { status: RecallStatus.CLOSED, outcome: dto.outcome, closedAt: new Date() });
      await m.save(r);
    });
    return this.get(id);
  }

  async get(id: string) {
    const r = await this.ds.getRepository(Recall).findOne({ where: { id }, relations: { item: true, returns: true } });
    if (!r) throw new NotFoundException('Recall not found');
    const holds = await this.ds.query(
      `SELECT h.id, h.number, h.status, h.quantity_at_hold::float AS "quantityAtHold", b.batch_no AS "batchNo" FROM quality_hold h JOIN batch b ON b.id = h.batch_id
        WHERE h.source_type = 'RECALL' AND h.source_id = $1 ORDER BY b.batch_no`,
      [id],
    );
    return { ...r, holds };
  }

  list(q: { status?: string }) {
    return this.ds.getRepository(Recall).find({ where: q.status ? { status: q.status as RecallStatus } : {}, relations: { item: true }, order: { noticeDate: 'DESC' }, take: 500 });
  }

  /** Open recalls with quantity still on hand, out with patients/departments and recovered. */
  async dashboard() {
    const open = await this.ds.getRepository(Recall).find({ where: { status: RecallStatus.OPEN }, relations: { item: true }, order: { noticeDate: 'DESC' } });
    const rows = [];
    for (const r of open) {
      const t = await this.trace(r.id);
      rows.push({
        id: r.id,
        number: r.number,
        item: r.item?.name,
        classification: r.classification,
        noticeDate: r.noticeDate,
        batches: r.batchNos.length ? r.batchNos : ['all'],
        storesHolding: new Set(t.holdings.filter((h: { onHand: number }) => h.onHand > 0).map((h: { storeId: string }) => h.storeId)).size,
        onHand: t.totals.onHand,
        distributed: t.totals.issued + t.totals.dispensed + t.totals.sold,
        returned: t.totals.returned,
        patients: t.patients.length,
      });
    }
    const [closed] = await this.ds.query(`SELECT count(*)::int AS n FROM recall WHERE status = 'CLOSED' AND closed_at >= now() - interval '365 days'`);
    return { open: rows, closedLastYear: closed.n };
  }
}

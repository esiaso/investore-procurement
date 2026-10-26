import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PatientChargeSource } from '@sil/shared';
import { Encounter } from '../hmis/hmis.entities';
import { PatientChargesService } from '../hmis/patient-charges.service';
import { Patient } from '../pharmacy/pharmacy.entities';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, Paginated, Permissions, SessionUser, StockTxnType } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { allocateFefo, fefoCompare, isUsable, loadFefoCandidates, matchesFefo } from '../inventory/fefo';
import { InventoryService } from '../inventory/inventory.service';
import { MovementLine, postMovements, StockRuleError } from '../inventory/posting';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { assertCanSee, scopeClause } from './access';
import { renderIssueVoucherHtml } from './issue-pdf';
import { outstanding, ReservationsService } from './reservations.service';
import { ISSUABLE, StoreRequisitionsService } from './store-requisitions.service';
import { CreateIssueDto, IssueQueryDto } from './stores.dto';
import { IssueVoucher, IssueVoucherLine, StoreRequisition, StoreRequisitionLine } from './stores.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface Pick {
  line: StoreRequisitionLine;
  batchId: string;
  binId: string | null;
  quantity: number;
  scanConfirmed: boolean;
}

/**
 * Issue vouchers against approved internal requisitions. Batches are picked
 * FEFO (other picks need inventory.override_fefo and a reason); whatever
 * cannot be issued stays on back-order and is reserved again. Stock is posted
 * as ISSUE to the department at WAC (or FIFO cost, per settings).
 */
@Injectable()
export class IssuesService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly inventory: InventoryService,
    private readonly settings: SettingsService,
    private readonly reservations: ReservationsService,
    private readonly requisitions: StoreRequisitionsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly pdf: PdfService,
    private readonly charges: PatientChargesService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.ISSUE_NOTE, async (ids) => {
      const rows = await this.ds.getRepository(IssueVoucher).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: 'POSTED', date: r.issueDate, amount: r.totalValue }]));
    });
  }

  /** FEFO suggestion per outstanding line, from stock available to this requisition (its own reservations count). */
  async suggest(requisitionId: string, actor: SessionUser) {
    const sr = await this.requisitions.get(requisitionId, actor);
    StoreScope.assert(sr.storeId);
    const today = await this.settings.today();
    const scanConfirm = await this.settings.get('inventory.issueScanConfirm');
    // Plan as if this requisition's reservations were released (as issue() does), then roll back.
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const m = qr.manager;
      await this.reservations.release(m, requisitionId);
      const lines = [];
      for (const l of sr.lines) {
        const need = outstanding(l);
        const candidates = need > 0 ? (await loadFefoCandidates(m, l.itemId, sr.storeId, { purpose: 'ISSUE', departmentId: sr.departmentId })).filter((c) => isUsable(c, today)).sort(fefoCompare) : [];
        const fefo = allocateFefo(candidates, need, today);
        const binIds = [...new Set(candidates.map((c) => c.binId).filter(Boolean))];
        const bins: { id: string; code: string }[] = binIds.length ? await m.query(`SELECT id, code FROM bin WHERE id = ANY($1::uuid[])`, [binIds]) : [];
        const binCode = (id: string | null) => bins.find((b) => b.id === id)?.code ?? null;
        lines.push({
          requisitionLineId: l.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          itemCode: l.item?.code,
          itemName: l.item?.name,
          barcode: l.item?.barcode ?? null,
          gtin: l.item?.gtin ?? null,
          isControlled: l.item?.isControlled ?? false,
          isColdChain: l.item?.isColdChain ?? false,
          uom: l.item?.baseUom?.code,
          patientRef: l.patientRef,
          outstandingQty: need,
          shortfall: fefo.shortfall,
          picks: fefo.allocations.map((a) => ({ ...a, binCode: binCode(a.binId) })),
          // Every usable batch/bin in FEFO order, for manual picks.
          candidates: candidates.map((c) => ({ ...c, binCode: binCode(c.binId) })),
        });
      }
      return { requisitionId, scanConfirm, lines };
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }

  async issue(requisitionId: string, dto: CreateIssueDto, actor: SessionUser) {
    const pre = await this.requisitions.get(requisitionId, actor);
    StoreScope.assert(pre.storeId);
    const itemIds = (dto.lines?.length ? pre.lines.filter((l) => dto.lines!.some((d) => d.requisitionLineId === l.id)) : pre.lines).map((l) => l.itemId);
    const controlled = await this.inventory.anyControlled(this.ds.manager, itemIds);
    const witnessId = controlled ? await this.inventory.verifyWitness(dto.witness, actor) : null;
    const scanMode = await this.settings.get('inventory.issueScanConfirm');

    const { voucherId, charged } = await this.ds.transaction(async (m) => {
      const sr = await this.requisitions.lock(m, requisitionId);
      if (!ISSUABLE.includes(sr.status)) throw new ConflictException(`Requisition is ${sr.status}`);
      StoreScope.assert(sr.storeId);
      const today = await this.settings.today(m);
      const lines = await m.find(StoreRequisitionLine, { where: { requisitionId }, relations: { item: true }, order: { lineNo: 'ASC' } });
      const wanted = new Map((dto.lines ?? []).map((l) => [l.requisitionLineId, l]));
      for (const lineId of wanted.keys()) if (!lines.some((l) => l.id === lineId)) throw new BadRequestException(`Line ${lineId} is not on this requisition`);

      // This requisition's own reservations become available to it.
      await this.reservations.release(m, sr.id);

      const plan: Pick[] = [];
      let overridden = false;
      for (const line of lines) {
        if (dto.lines?.length && !wanted.has(line.id)) continue;
        const req = wanted.get(line.id);
        const owed = outstanding(line);
        if (owed <= 0) {
          if (req?.quantity || req?.picks?.length) throw new BadRequestException(`Line ${line.lineNo} has nothing outstanding`);
          continue;
        }
        const pickTotal = req?.picks?.length ? round4(req.picks.reduce((s, p) => s + p.quantity, 0)) : null;
        const qty = round4(req?.quantity ?? pickTotal ?? owed);
        if (qty === 0) continue;
        if (qty > owed) throw new BadRequestException(`Line ${line.lineNo}: only ${owed} outstanding`);
        const fefo = allocateFefo(await loadFefoCandidates(m, line.itemId, sr.storeId, { purpose: 'ISSUE', departmentId: sr.departmentId }), qty, today);
        let picks: { batchId: string; binId: string | null; quantity: number; scannedCode?: string }[];
        if (req?.picks?.length) {
          if (pickTotal !== qty) throw new BadRequestException(`Line ${line.lineNo}: picks must add up to ${qty}`);
          picks = req.picks.map((p) => ({ batchId: p.batchId, binId: p.binId ?? null, quantity: p.quantity, scannedCode: p.scannedCode }));
          if (!matchesFefo(picks, fefo.allocations)) overridden = true;
        } else {
          if (fefo.shortfall > 0 && req?.quantity !== undefined) {
            throw new StockRuleError('INSUFFICIENT_STOCK', `Line ${line.lineNo}: only ${fefo.allocated} usable and unreserved`, {
              itemId: line.itemId,
              shortfall: fefo.shortfall,
            });
          }
          picks = fefo.allocations.map((a) => ({ batchId: a.batchId, binId: a.binId, quantity: a.quantity }));
        }
        for (const p of picks) {
          const scanConfirmed = await this.checkScan(m, line, p.batchId, p.scannedCode);
          if (scanMode === 'REQUIRED' && !scanConfirmed) {
            throw new BadRequestException({ code: 'SCAN_REQUIRED', message: `Line ${line.lineNo}: every pick must be confirmed by scanning` });
          }
          plan.push({ line, batchId: p.batchId, binId: p.binId, quantity: p.quantity, scanConfirmed });
        }
      }
      if (!plan.length) throw new BadRequestException({ code: 'NOTHING_TO_ISSUE', message: 'Nothing can be issued: no usable, unreserved stock for the outstanding lines' });
      if (overridden) {
        if (!actor.permissions.includes(Permissions.INVENTORY_OVERRIDE_FEFO)) {
          throw new ForbiddenException('Picking batches out of FEFO order needs the inventory.override_fefo permission');
        }
        if (!dto.fefoOverrideReason?.trim()) throw new BadRequestException('A reason is required to override FEFO');
      }

      const voucher = await m.save(
        m.create(IssueVoucher, {
          number: await this.numbering.next(DocumentType.ISSUE_NOTE, { storeId: sr.storeId, manager: m }),
          requisitionId: sr.id,
          storeId: sr.storeId,
          departmentId: sr.departmentId,
          issueDate: today,
          issuedBy: actor.id,
          collectedBy: dto.collectedBy ?? null,
          witnessId,
          fefoOverrideReason: overridden ? dto.fefoOverrideReason!.trim() : null,
          notes: dto.notes ?? null,
        }),
      );
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.ISSUE_NOTE, id: voucher.id, number: voucher.number }, today, witnessId, m);
      const movements: MovementLine[] = plan.map((p) => ({
        txnType: StockTxnType.ISSUE,
        storeId: sr.storeId,
        binId: p.binId,
        itemId: p.line.itemId,
        batchId: p.batchId,
        quantity: -p.quantity,
        departmentId: sr.departmentId,
        patientRef: p.line.patientRef,
        fefoOverrideReason: overridden ? dto.fefoOverrideReason!.trim() : null,
      }));
      const posted = await postMovements(m, movements, ctx);

      const voucherLines = plan.map((p, i) =>
        m.create(IssueVoucherLine, {
          voucherId: voucher.id,
          requisitionLineId: p.line.id,
          itemId: p.line.itemId,
          batchId: p.batchId,
          binId: p.binId,
          quantity: p.quantity,
          unitCost: posted[i].unitCost,
          value: round2(-posted[i].valueDelta),
          fefoOverridden: overridden,
          scanConfirmed: p.scanConfirmed,
          patientRef: p.line.patientRef,
        }),
      );
      await m.save(voucherLines);
      voucher.totalValue = round2(voucherLines.reduce((s, l) => s + l.value, 0));
      await m.save(voucher);

      // Consumables issued for an admitted patient are charged to the encounter.
      const charged: { messageIds: string[]; outboxId: string | null }[] = [];
      const byEncounter = new Map<string, IssueVoucherLine[]>();
      plan.forEach((p, i) => p.line.encounterId && byEncounter.set(p.line.encounterId, [...(byEncounter.get(p.line.encounterId) ?? []), voucherLines[i]]));
      for (const [encounterId, vls] of byEncounter) {
        const encounter = await m.findOneByOrFail(Encounter, { id: encounterId });
        const patient = await m.findOneByOrFail(Patient, { id: encounter.patientId });
        charged.push(
          await this.charges.chargeEncounter(
            m,
            { source: PatientChargeSource.ISSUE, sourceId: voucher.id, sourceNo: voucher.number, storeId: sr.storeId, departmentId: sr.departmentId, patient, encounter, lines: vls.map((v) => ({ sourceLineId: v.id, itemId: v.itemId, quantity: v.quantity })) },
            actor,
            `Consumables ${voucher.number} for encounter ${encounter.externalId}`,
          ),
        );
      }

      for (const line of lines) {
        const q = round4(plan.filter((p) => p.line.id === line.id).reduce((s, p) => s + p.quantity, 0));
        if (q > 0) {
          line.issuedQty = round4(line.issuedQty + q);
          await m.save(StoreRequisitionLine, { ...line, item: undefined });
        }
      }
      const status = await this.requisitions.refreshStatus(m, sr);
      // Whatever is still owed is reserved again from what is left.
      if (await this.settings.get('inventory.reserveOnApproval', m)) await this.reservations.reserve(m, sr, today);
      await this.links.link(m, { type: DocumentType.STORE_REQUISITION, id: sr.id, no: sr.number }, { type: DocumentType.ISSUE_NOTE, id: voucher.id, no: voucher.number });
      await this.notifications.notify(m, [sr.requestedBy].filter((u) => u !== actor.id), {
        title: `${sr.number}: ${status === 'PARTIALLY_ISSUED' ? 'partly issued' : 'issued'} (${voucher.number})`,
        body: status === 'PARTIALLY_ISSUED' ? 'The rest is on back-order' : undefined,
        link: `/store-requisitions/${sr.id}`,
      });
      return { voucherId: voucher.id, charged };
    });
    for (const c of charged) await this.charges.deliver(c);
    return this.get(voucherId, actor);
  }

  /** A scan confirms a pick when it matches the item's barcode, GTIN or code, or the batch number. */
  private async checkScan(m: EntityManager, line: StoreRequisitionLine, batchId: string, code: string | undefined): Promise<boolean> {
    if (!code?.trim()) return false;
    const c = code.trim().toLowerCase();
    const [b] = await m.query(`SELECT batch_no, item_id FROM batch WHERE id = $1`, [batchId]);
    if (!b) throw new BadRequestException('Batch not found');
    const item = line.item!;
    const matches = [item.barcode, item.gtin, item.code, b.batch_no].filter(Boolean).map((v) => String(v).toLowerCase());
    if (!matches.includes(c)) {
      throw new BadRequestException({ code: 'SCAN_MISMATCH', message: `Scanned code ${code} does not match ${item.code} batch ${b.batch_no}` });
    }
    return true;
  }

  async get(id: string, actor: SessionUser) {
    const v = await this.ds.getRepository(IssueVoucher).findOne({
      where: { id },
      relations: { requisition: true, store: true, department: true, lines: { item: { baseUom: true }, batch: true } },
    });
    if (!v) throw new NotFoundException('Issue voucher not found');
    assertCanSee(actor, v, 'Issue voucher');
    const users = await this.ds.query(`SELECT id, full_name, username FROM app_user WHERE id = ANY($1::uuid[])`, [[v.issuedBy, v.witnessId].filter(Boolean)]);
    const name = (uid: string | null) => users.find((u: { id: string }) => u.id === uid)?.full_name ?? null;
    const bins = await this.ds.query(`SELECT id, code FROM bin WHERE id = ANY($1::uuid[])`, [(v.lines ?? []).map((l) => l.binId).filter(Boolean)]);
    return {
      ...v,
      issuedByName: name(v.issuedBy),
      witnessName: name(v.witnessId),
      lines: (v.lines ?? []).map((l) => ({ ...l, binCode: bins.find((b: { id: string }) => b.id === l.binId)?.code ?? null })),
    };
  }

  async list(q: IssueQueryDto, actor: SessionUser): Promise<Paginated<IssueVoucher>> {
    const qb = this.ds
      .getRepository(IssueVoucher)
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.department', 'department')
      .leftJoinAndSelect('v.store', 'store')
      .leftJoinAndSelect('v.requisition', 'requisition')
      .orderBy('v.createdAt', 'DESC');
    const scope = scopeClause(actor, 'v');
    if (scope) qb.andWhere(scope.sql, scope.params);
    if (q.storeId) qb.andWhere('v.store_id = :s', { s: q.storeId });
    if (q.departmentId) qb.andWhere('v.department_id = :d', { d: q.departmentId });
    if (q.requisitionId) qb.andWhere('v.requisition_id = :r', { r: q.requisitionId });
    if (q.search) qb.andWhere('(v.number ILIKE :q OR requisition.number ILIKE :q)', { q: `%${q.search}%` });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async renderPdf(id: string, actor: SessionUser): Promise<{ number: string; pdf: Buffer }> {
    const v = await this.get(id, actor);
    const [facility] = await this.ds.query(`SELECT f.name, f.address, f.phone, f.email FROM facility f JOIN store s ON s.facility_id = f.id WHERE s.id = $1`, [v.storeId]);
    const [requester] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [(v.requisition as StoreRequisition).requestedBy]);
    const html = renderIssueVoucherHtml(v, facility, {
      requestedBy: requester?.full_name ?? null,
      currency: await this.settings.get('locale.currency'),
      dateFormat: await this.settings.get('locale.dateFormat'),
      timezone: await this.settings.get('locale.timezone'),
    });
    return { number: v.number, pdf: await this.pdf.render(html) };
  }
}

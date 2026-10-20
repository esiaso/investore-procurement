import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, Paginated, Permissions, PrescriptionStatus, SalesSource, SessionUser } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { BillingService } from '../billing/billing.service';
import { SalesInvoice } from '../billing/billing.entities';
import { takeStock } from '../billing/dispense-stock';
import { EtimsService } from '../etims/etims.service';
import { InventoryService } from '../inventory/inventory.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { AlertDraft, ageInYears, InteractionSource, InternalInteractionSource, MedForCheck, runChecks, termsOf } from './interactions';
import { ClinicalAlert, Dispense, DispenseLine, InteractionOverride, Patient, Prescription, PrescriptionLine } from './pharmacy.entities';
import { CancelLinesDto, CreatePrescriptionDto, DispenseDto, DispenseReturnDto, PatientDto, PatientQueryDto, WorklistQueryDto } from './pharmacy.dto';

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
/** Same rules as FEFO: unreserved, not held, not quarantined, not expired. */
const USABLE = `sb.on_hand - sb.reserved > 0 AND b.hold_status = 'NONE' AND NOT COALESCE(bn.is_quarantine, false) AND (b.expiry_date IS NULL OR b.expiry_date >= CURRENT_DATE)`;
const OPEN = [PrescriptionStatus.RECEIVED, PrescriptionStatus.VERIFIED, PrescriptionStatus.PARTIALLY_DISPENSED];

export interface AlertView extends ClinicalAlert {
  override: InteractionOverride | null;
}

/**
 * Pharmacy: cached patients, generic-level prescriptions with a worklist per
 * outlet, clinical checks with pharmacist overrides, dispensing (brand choice
 * within the generic, FEFO batches, partial supply) invoiced through billing,
 * and returns of dispensed medicines.
 */
@Injectable()
export class PharmacyService {
  /** Swap for a licensed knowledge base by providing another InteractionSource. */
  private readonly source: InteractionSource = new InternalInteractionSource();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
    private readonly billing: BillingService,
    private readonly etims: EtimsService,
  ) {}

  // ------------------------------------------------------------------ patients

  patients(q: PatientQueryDto): Promise<Paginated<Patient>> {
    const qb = this.ds.getRepository(Patient).createQueryBuilder('p').leftJoinAndSelect('p.payer', 'payer').orderBy('p.name');
    if (q.search) qb.andWhere('(p.name ILIKE :q OR p.hospital_no ILIKE :q)', { q: likeTerm(q.search) });
    return paginate(qb, q);
  }

  async patient(id: string) {
    const p = await this.ds.getRepository(Patient).findOne({ where: { id }, relations: { payer: true } });
    if (!p) throw new NotFoundException('Patient not found');
    return p;
  }

  async savePatient(id: string | null, dto: PatientDto) {
    const repo = this.ds.getRepository(Patient);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Patient not found');
    Object.assign(row, { ...dto, allergies: (dto.allergies ?? row.allergies ?? []).map((a) => a.trim()).filter(Boolean) });
    if (row.sex !== 'F') row.isPregnant = false;
    return repo.save(row);
  }

  // ------------------------------------------------------------------ prescriptions

  async createPrescription(dto: CreatePrescriptionDto) {
    StoreScope.assert(dto.storeId);
    if (dto.externalRef) {
      const dup = await this.ds.getRepository(Prescription).findOneBy({ externalRef: dto.externalRef });
      if (dup) throw new ConflictException({ code: 'DUPLICATE_EXTERNAL_REF', message: `Already received as ${dup.number}`, prescriptionId: dup.id });
    }
    const id = await this.ds.transaction(async (m) => {
      const patient = await m.findOneBy(Patient, { id: dto.patientId });
      if (!patient) throw new BadRequestException('Patient not found');
      const generics: { id: string; is_active: boolean }[] = await m.query(`SELECT id, is_active FROM generic WHERE id = ANY($1::uuid[])`, [dto.lines.map((l) => l.genericId)]);
      for (const l of dto.lines) {
        if (!generics.find((g) => g.id === l.genericId && g.is_active)) throw new BadRequestException('A prescribed generic is unknown or inactive');
        if (l.preferredItemId) {
          const [it] = await m.query(`SELECT generic_id FROM item WHERE id = $1`, [l.preferredItemId]);
          if (it?.generic_id !== l.genericId) throw new BadRequestException('The preferred brand is not an item of the prescribed generic');
        }
      }
      const rx = await m.save(
        m.create(Prescription, {
          number: await this.numbering.next(DocumentType.PRESCRIPTION, { storeId: dto.storeId, manager: m }),
          patientId: dto.patientId,
          storeId: dto.storeId,
          prescriber: dto.prescriber,
          prescriberRegNo: dto.prescriberRegNo ?? null,
          encounterRef: dto.encounterRef ?? null,
          externalRef: dto.externalRef ?? null,
          notes: dto.notes ?? null,
          status: PrescriptionStatus.RECEIVED,
          receivedAt: new Date(),
          lines: dto.lines.map((l, i) =>
            m.create(PrescriptionLine, {
              lineNo: i + 1,
              genericId: l.genericId,
              preferredItemId: l.preferredItemId ?? null,
              dose: l.dose,
              frequency: l.frequency,
              duration: l.duration ?? null,
              route: l.route ?? null,
              quantity: l.quantity,
              instructions: l.instructions ?? null,
            }),
          ),
        }),
      );
      await this.check(m, rx.id);
      return rx.id;
    });
    return this.get(id);
  }

  async worklist(q: WorklistQueryDto) {
    const qb = this.ds
      .getRepository(Prescription)
      .createQueryBuilder('rx')
      .leftJoinAndSelect('rx.patient', 'patient')
      .leftJoinAndSelect('rx.store', 'store')
      .orderBy('rx.receivedAt', 'ASC');
    StoreScope.apply(qb, 'rx.store_id');
    if (q.storeId) qb.andWhere('rx.store_id = :st', { st: q.storeId });
    const statuses = q.status ? (Array.isArray(q.status) ? q.status : [q.status]) : OPEN;
    qb.andWhere('rx.status IN (:...ss)', { ss: statuses });
    if (q.patientId) qb.andWhere('rx.patient_id = :p', { p: q.patientId });
    if (q.search) qb.andWhere('(rx.number ILIKE :q OR patient.name ILIKE :q OR patient.hospital_no ILIKE :q)', { q: likeTerm(q.search) });
    const page = await paginate(qb, q);
    // Alert badge per prescription: highest active severity and unresolved blocking count.
    const ids = page.items.map((r) => r.id);
    const blocking = await this.settings.get('pharmacy.blockingSeverities');
    const counts: { prescription_id: string; severity: string; open_blocking: number; n: number }[] = ids.length
      ? await this.ds.query(
          `SELECT a.prescription_id, (array_agg(a.severity ORDER BY CASE a.severity WHEN 'CONTRAINDICATED' THEN 4 WHEN 'MAJOR' THEN 3 WHEN 'MODERATE' THEN 2 ELSE 1 END DESC))[1] AS severity,
                  count(*) FILTER (WHERE a.severity = ANY($2::interaction_severity[]) AND o.id IS NULL)::int AS open_blocking, count(*)::int AS n
             FROM clinical_alert a LEFT JOIN interaction_override o ON o.alert_id = a.id
            WHERE a.is_active AND a.prescription_id = ANY($1::uuid[]) GROUP BY a.prescription_id`,
          [ids, blocking],
        )
      : [];
    return {
      ...page,
      items: page.items.map((r) => {
        const c = counts.find((x) => x.prescription_id === r.id);
        return { ...r, waitingMinutes: Math.round((Date.now() - r.receivedAt.getTime()) / 60_000), alerts: c ? { highest: c.severity, openBlocking: c.open_blocking, total: c.n } : null };
      }),
    };
  }

  async get(id: string) {
    const rx = await this.ds.getRepository(Prescription).findOne({
      where: { id },
      relations: { patient: { payer: true }, store: true, lines: { generic: true } },
      order: { lines: { lineNo: 'ASC' } },
    });
    if (!rx) throw new NotFoundException('Prescription not found');
    StoreScope.assert(rx.storeId);
    const dispenses = await this.ds.getRepository(Dispense).find({ where: { prescriptionId: id }, relations: { lines: { item: true, batch: true } }, order: { dispensedAt: 'ASC' } });
    const invoices = dispenses.length ? await this.ds.getRepository(SalesInvoice).find({ where: [{ sourceId: In(dispenses.map((d) => d.id)) }], order: { createdAt: 'ASC' } }) : [];
    return { ...rx, alerts: await this.alerts(id), dispenses, invoices: invoices.map((i) => ({ id: i.id, number: i.number, docType: i.docType, totalAmount: i.totalAmount, etimsStatus: i.etimsStatus, cuInvoiceNo: i.cuInvoiceNo, sourceId: i.sourceId })) };
  }

  /** Brands of each prescribed generic with usable stock at the outlet (for brand selection / substitution). */
  async options(id: string) {
    const rx = await this.ds.getRepository(Prescription).findOne({ where: { id }, relations: { lines: true } });
    if (!rx) throw new NotFoundException('Prescription not found');
    StoreScope.assert(rx.storeId);
    const rows: { generic_id: string; item_id: string; code: string; name: string; brand_name: string | null; available: number; earliest_expiry: string | null }[] = await this.ds.query(
      `SELECT i.generic_id, i.id AS item_id, i.code, i.name, i.brand_name,
              COALESCE(SUM(sb.on_hand - sb.reserved) FILTER (WHERE ${USABLE}), 0)::float AS available,
              to_char(MIN(b.expiry_date) FILTER (WHERE ${USABLE}), 'YYYY-MM-DD') AS earliest_expiry
         FROM item i
         LEFT JOIN stock_balance sb ON sb.item_id = i.id AND sb.store_id = $2
         LEFT JOIN batch b ON b.id = sb.batch_id
         LEFT JOIN bin bn ON bn.id = sb.bin_id
        WHERE i.generic_id = ANY($1::uuid[]) AND i.is_active
        GROUP BY i.id ORDER BY i.name`,
      [rx.lines!.map((l) => l.genericId), rx.storeId],
    );
    return rx.lines!.map((l) => ({
      prescriptionLineId: l.id,
      genericId: l.genericId,
      remaining: r4(l.quantity - l.dispensedQty - l.cancelledQty),
      preferredItemId: l.preferredItemId,
      brands: rows.filter((r) => r.generic_id === l.genericId).map((r) => ({ itemId: r.item_id, code: r.code, name: r.name, brandName: r.brand_name, available: r.available, earliestExpiry: r.earliest_expiry, preferred: r.item_id === l.preferredItemId })),
    }));
  }

  // ------------------------------------------------------------------ clinical checks

  private async medsFor(m: EntityManager, rx: Prescription): Promise<{ lines: MedForCheck[]; active: MedForCheck[] }> {
    const lineRows: { id: string; generic_id: string; inn_name: string; strength: string; therapeutic_class: string | null; pregnancy_contraindicated: boolean; min_age_years: string | null; open: number }[] = await m.query(
      `SELECT l.id, l.generic_id, g.inn_name, g.strength, g.therapeutic_class, g.pregnancy_contraindicated, g.min_age_years,
              (l.quantity - l.cancelled_qty)::float AS open
         FROM prescription_line l JOIN generic g ON g.id = l.generic_id WHERE l.prescription_id = $1 ORDER BY l.line_no`,
      [rx.id],
    );
    const days = await this.settings.get('pharmacy.activeMedicationDays', m);
    // Active medications: dispensed to the patient recently on other prescriptions (net of returns).
    const activeRows: { generic_id: string; inn_name: string; strength: string; therapeutic_class: string | null; pregnancy_contraindicated: boolean; min_age_years: string | null }[] = await m.query(
      `SELECT DISTINCT g.id AS generic_id, g.inn_name, g.strength, g.therapeutic_class, g.pregnancy_contraindicated, g.min_age_years
         FROM dispense d JOIN dispense_line dl ON dl.dispense_id = d.id JOIN item i ON i.id = dl.item_id JOIN generic g ON g.id = i.generic_id
        WHERE d.patient_id = $1 AND d.prescription_id <> $2 AND d.dispensed_at >= now() - ($3 || ' days')::interval AND dl.quantity > dl.returned_qty`,
      [rx.patientId, rx.id, String(days)],
    );
    const med = (r: { generic_id: string; inn_name: string; strength: string; therapeutic_class: string | null; pregnancy_contraindicated: boolean; min_age_years: string | null }, lineId: string | null): MedForCheck => ({
      lineId,
      genericId: r.generic_id,
      inn: r.inn_name,
      therapeuticClass: r.therapeutic_class,
      pregnancyContraindicated: r.pregnancy_contraindicated,
      minAgeYears: r.min_age_years === null ? null : Number(r.min_age_years),
      label: `${r.inn_name}${r.strength ? ` ${r.strength}` : ''}`,
    });
    return { lines: lineRows.filter((r) => r.open > 0).map((r) => med(r, r.id)), active: activeRows.map((r) => med(r, null)) };
  }

  /**
   * Runs all checks and stores the results: new alerts are raised, alerts no
   * longer produced are deactivated, existing ones (and their overrides) kept.
   */
  async check(m: EntityManager, prescriptionId: string): Promise<AlertDraft[]> {
    const rx = await m.findOneByOrFail(Prescription, { id: prescriptionId });
    const patient = await m.findOneByOrFail(Patient, { id: rx.patientId });
    const { lines, active } = await this.medsFor(m, rx);
    const terms = [...new Set([...lines, ...active].flatMap(termsOf))];
    const pairs = await this.source.find(m, terms);
    const drafts = runChecks({ ageYears: ageInYears(patient.dateOfBirth, await this.settings.today(m)), isPregnant: patient.isPregnant, allergies: patient.allergies }, lines, active, pairs);
    const blocking = new Set(await this.settings.get('pharmacy.blockingSeverities', m));
    const existing = await m.find(ClinicalAlert, { where: { prescriptionId } });
    for (const d of drafts) {
      const hit = existing.find((e) => e.fingerprint === d.fingerprint);
      if (hit) {
        if (!hit.isActive || hit.severity !== d.severity || hit.blocking !== blocking.has(d.severity)) {
          Object.assign(hit, { isActive: true, severity: d.severity, message: d.message, management: d.management, blocking: blocking.has(d.severity) });
          await m.save(hit);
        }
      } else {
        await m.save(m.create(ClinicalAlert, { ...d, prescriptionId, patientId: rx.patientId, blocking: blocking.has(d.severity), isActive: true }));
      }
    }
    const stale = existing.filter((e) => e.isActive && !drafts.some((d) => d.fingerprint === e.fingerprint));
    if (stale.length) await m.update(ClinicalAlert, { id: In(stale.map((s) => s.id)) }, { isActive: false });
    return drafts;
  }

  async alerts(prescriptionId: string, m: EntityManager = this.ds.manager): Promise<AlertView[]> {
    const rows = await m.find(ClinicalAlert, { where: { prescriptionId, isActive: true }, order: { createdAt: 'ASC' } });
    const overrides = rows.length ? await m.find(InteractionOverride, { where: { alertId: In(rows.map((r) => r.id)) } }) : [];
    const rank: Record<string, number> = { CONTRAINDICATED: 4, MAJOR: 3, MODERATE: 2, MINOR: 1 };
    return rows.map((r) => ({ ...r, override: overrides.find((o) => o.alertId === r.id) ?? null })).sort((a, b) => rank[b.severity] - rank[a.severity]);
  }

  private async assertNoOpenBlocking(m: EntityManager, prescriptionId: string) {
    await this.check(m, prescriptionId);
    const open = (await this.alerts(prescriptionId, m)).filter((a) => a.blocking && !a.override);
    if (open.length) {
      throw new ConflictException({
        code: 'INTERACTION_BLOCKED',
        message: `${open.length} clinical alert(s) need a pharmacist override before this prescription can proceed`,
        alerts: open.map((a) => ({ id: a.id, type: a.type, severity: a.severity, message: a.message })),
      });
    }
  }

  /** Re-run the checks (e.g. after the patient's allergies changed). */
  async recheck(id: string) {
    const rx = await this.ds.getRepository(Prescription).findOneBy({ id });
    if (!rx) throw new NotFoundException('Prescription not found');
    StoreScope.assert(rx.storeId);
    await this.ds.transaction((m) => this.check(m, id));
    return this.alerts(id);
  }

  async override(alertId: string, reason: string, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const alert = await m.findOne(ClinicalAlert, { where: { id: alertId }, lock: { mode: 'pessimistic_write' } });
      if (!alert || !alert.isActive) throw new NotFoundException('Alert not found');
      const rx = await m.findOneByOrFail(Prescription, { id: alert.prescriptionId });
      StoreScope.assert(rx.storeId);
      if (await m.existsBy(InteractionOverride, { alertId })) throw new ConflictException('Already overridden');
      return m.save(m.create(InteractionOverride, { alertId, prescriptionId: alert.prescriptionId, pharmacistId: actor.id, reason: reason.trim() }));
    });
  }

  /** Pharmacist verification: blocked while a contraindicated/major alert has no override. */
  async verify(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const rx = await m.findOne(Prescription, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!rx) throw new NotFoundException('Prescription not found');
      StoreScope.assert(rx.storeId);
      if (rx.status !== PrescriptionStatus.RECEIVED) throw new ConflictException(`Prescription is ${rx.status}`);
      await this.assertNoOpenBlocking(m, id);
      Object.assign(rx, { status: PrescriptionStatus.VERIFIED, verifiedAt: new Date(), verifiedBy: actor.id });
      await m.save(rx);
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ dispensing

  /**
   * Dispenses (part of) a verified prescription: chosen brand per line (any
   * item of the prescribed generic), FEFO batches unless picked (with reason
   * and permission), DISPENSE stock movements per patient, the sales invoice
   * (payer split) and eTIMS. Records each batch given.
   */
  async dispense(id: string, dto: DispenseDto, actor: SessionUser) {
    const r = await this.ds.transaction(async (m) => {
      const rx = await m.findOne(Prescription, { where: { id }, relations: { lines: true, patient: true }, lock: { mode: 'pessimistic_write', tables: ['prescription'] } });
      if (!rx) throw new NotFoundException('Prescription not found');
      StoreScope.assert(rx.storeId);
      if (rx.status !== PrescriptionStatus.VERIFIED && rx.status !== PrescriptionStatus.PARTIALLY_DISPENSED) {
        throw new ConflictException(rx.status === PrescriptionStatus.RECEIVED ? 'Verify the prescription before dispensing' : `Prescription is ${rx.status}`);
      }
      await this.assertNoOpenBlocking(m, id);
      const byLine = new Map(rx.lines!.map((l) => [l.id, l]));
      const want = new Map<string, number>();
      for (const d of dto.lines) {
        const line = byLine.get(d.prescriptionLineId);
        if (!line) throw new BadRequestException('A line is not on this prescription');
        const [it] = await m.query(`SELECT generic_id, name FROM item WHERE id = $1 AND is_active`, [d.itemId]);
        if (!it) throw new BadRequestException('Item not found or inactive');
        if (it.generic_id !== line.genericId) throw new BadRequestException(`${it.name} is not a brand of the prescribed generic (line ${line.lineNo})`);
        want.set(line.id, r4((want.get(line.id) ?? 0) + d.quantity));
      }
      for (const [lineId, q] of want) {
        const l = byLine.get(lineId)!;
        const remaining = r4(l.quantity - l.dispensedQty - l.cancelledQty);
        if (q > remaining) throw new BadRequestException(`Line ${l.lineNo}: only ${remaining} left to dispense`);
      }
      const dispenseId = randomUUID();
      const number = await this.numbering.next(DocumentType.DISPENSE, { storeId: rx.storeId, manager: m });
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.DISPENSE, id: dispenseId, number }, undefined, dto.witnessId ?? null, m);
      const { allocations, overridden } = await takeStock(
        m,
        ctx,
        rx.storeId,
        dto.lines.map((l, i) => ({ key: String(i), itemId: l.itemId, quantity: l.quantity, patientRef: rx.patient!.hospitalNo, picks: l.picks?.map((p) => ({ batchId: p.batchId, binId: p.binId ?? null, quantity: p.quantity })), fefoOverrideReason: dto.fefoOverrideReason ?? null })),
      );
      if (overridden) {
        if (!actor.permissions.includes(Permissions.INVENTORY_OVERRIDE_FEFO)) throw new ForbiddenException('Choosing batches other than FEFO needs the override permission');
        if (!dto.fefoOverrideReason?.trim()) throw new BadRequestException('Give a reason for not following FEFO');
      }
      const now = new Date();
      const dispense = await m.save(
        m.create(Dispense, {
          id: dispenseId,
          number,
          prescriptionId: rx.id,
          patientId: rx.patientId,
          storeId: rx.storeId,
          dispensedBy: actor.id,
          dispensedAt: now,
          witnessId: dto.witnessId ?? null,
          fefoOverrideReason: overridden ? dto.fefoOverrideReason!.trim() : null,
          lines: dto.lines.flatMap((l, i) =>
            (allocations.get(String(i)) ?? []).map((a) =>
              m.create(DispenseLine, {
                prescriptionLineId: l.prescriptionLineId,
                itemId: l.itemId,
                substituted: !!byLine.get(l.prescriptionLineId)!.preferredItemId && byLine.get(l.prescriptionLineId)!.preferredItemId !== l.itemId,
                batchId: a.batchId,
                binId: a.binId,
                quantity: a.quantity,
                unitCost: a.unitCost,
              }),
            ),
          ),
        }),
      );
      for (const [lineId, q] of want) {
        const l = byLine.get(lineId)!;
        l.dispensedQty = r4(l.dispensedQty + q);
        await m.update(PrescriptionLine, l.id, { dispensedQty: l.dispensedQty });
      }
      this.applyStatus(rx, now);
      await m.update(Prescription, rx.id, { status: rx.status, firstDispensedAt: rx.firstDispensedAt, completedAt: rx.completedAt });

      const inv = await this.billing.createInvoice(
        m,
        {
          storeId: rx.storeId,
          source: SalesSource.DISPENSE,
          sourceId: dispense.id,
          patientId: rx.patientId,
          customerName: rx.patient!.name,
          customerPin: rx.patient!.kraPin,
          customerPhone: rx.patient!.phone,
          payerId: rx.patient!.payerId,
          payments: dto.payments,
          notes: `${rx.number} / ${number}`,
          lines: dto.lines.map((l, i) => ({ itemId: l.itemId, quantity: l.quantity, sourceLineId: l.prescriptionLineId, allocations: allocations.get(String(i)) ?? [] })),
        },
        actor,
      );
      await m.update(Dispense, dispense.id, { invoiceId: inv.invoice.id });
      return { dispenseId: dispense.id, invoiceId: inv.invoice.id, outboxId: inv.outboxId, change: inv.change };
    });
    if (r.outboxId) await this.etims.trySendNow(r.outboxId);
    return { ...(await this.get(id)), dispenseId: r.dispenseId, invoiceId: r.invoiceId, change: r.change };
  }

  private applyStatus(rx: Prescription, now: Date) {
    const lines = rx.lines!;
    const anyGiven = lines.some((l) => l.dispensedQty > 0);
    const allDone = lines.every((l) => r4(l.quantity - l.dispensedQty - l.cancelledQty) <= 0);
    if (anyGiven && !rx.firstDispensedAt) rx.firstDispensedAt = now;
    if (allDone) {
      rx.status = anyGiven ? PrescriptionStatus.DISPENSED : PrescriptionStatus.CANCELLED;
      rx.completedAt = rx.completedAt ?? now;
    } else if (anyGiven) {
      rx.status = PrescriptionStatus.PARTIALLY_DISPENSED;
      rx.completedAt = null;
    }
  }

  /** Stops the undispensed balance of lines (patient declined, therapy changed). */
  async cancelLines(id: string, dto: CancelLinesDto) {
    await this.ds.transaction(async (m) => {
      const rx = await m.findOne(Prescription, { where: { id }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['prescription'] } });
      if (!rx) throw new NotFoundException('Prescription not found');
      StoreScope.assert(rx.storeId);
      if (!OPEN.includes(rx.status)) throw new ConflictException(`Prescription is ${rx.status}`);
      for (const lineId of dto.lineIds) {
        const l = rx.lines!.find((x) => x.id === lineId);
        if (!l) throw new BadRequestException('A line is not on this prescription');
        l.cancelledQty = r4(l.quantity - l.dispensedQty);
        await m.update(PrescriptionLine, l.id, { cancelledQty: l.cancelledQty });
      }
      rx.notes = `${rx.notes ? `${rx.notes}\n` : ''}Cancelled balance: ${dto.reason}`.slice(0, 1000);
      this.applyStatus(rx, new Date());
      await m.update(Prescription, rx.id, { status: rx.status, completedAt: rx.completedAt, notes: rx.notes });
    });
    return this.get(id);
  }

  /**
   * Medicines brought back unused: credit note against the dispense invoice
   * (eTIMS), stock back on the same batches (restock) and the dispense records
   * reduced. The returned quantity becomes dispensable again only if the
   * prescription is still open.
   */
  async returnDispense(dispenseId: string, dto: DispenseReturnDto, actor: SessionUser) {
    const d = await this.ds.getRepository(Dispense).findOne({ where: { id: dispenseId }, relations: { lines: true } });
    if (!d) throw new NotFoundException('Dispense not found');
    StoreScope.assert(d.storeId);
    if (!d.invoiceId) throw new ConflictException('This dispense has no invoice');
    const inv = await this.billing.get(d.invoiceId);
    const creditLines = dto.lines.map((l) => {
      const il = (inv.lines ?? []).find((x) => x.sourceLineId === l.prescriptionLineId);
      if (!il) throw new BadRequestException('A line was not dispensed on this dispense');
      return { invoiceLineId: il.id, quantity: l.quantity };
    });
    await this.billing.creditNote(d.invoiceId, { lines: creditLines, reason: dto.reason, restock: dto.restock ?? true }, actor, async (m) => {
      const lines = await m.find(DispenseLine, { where: { dispenseId }, order: { createdAt: 'ASC' } });
      for (const r of dto.lines) {
        let left = r.quantity;
        for (const dl of lines.filter((x) => x.prescriptionLineId === r.prescriptionLineId)) {
          if (left <= 0) break;
          const q = Math.min(r4(dl.quantity - dl.returnedQty), left);
          if (q <= 0) continue;
          dl.returnedQty = r4(dl.returnedQty + q);
          await m.update(DispenseLine, dl.id, { returnedQty: dl.returnedQty });
          left = r4(left - q);
        }
        if (left > 0) throw new BadRequestException('Cannot return more than was dispensed');
        await m.query(`UPDATE prescription_line SET dispensed_qty = dispensed_qty - $2 WHERE id = $1`, [r.prescriptionLineId, r.quantity]);
      }
      const rx = await m.findOneOrFail(Prescription, { where: { id: d.prescriptionId }, relations: { lines: true } });
      if (rx.status === PrescriptionStatus.DISPENSED || rx.status === PrescriptionStatus.PARTIALLY_DISPENSED) {
        // Returned medicines are not re-supplied automatically: close the returned balance.
        for (const r of dto.lines) await m.query(`UPDATE prescription_line SET cancelled_qty = LEAST(quantity - dispensed_qty, cancelled_qty + $2) WHERE id = $1`, [r.prescriptionLineId, r.quantity]);
        const fresh = await m.findOneOrFail(Prescription, { where: { id: d.prescriptionId }, relations: { lines: true } });
        this.applyStatus(fresh, new Date());
        await m.update(Prescription, fresh.id, { status: fresh.status, completedAt: fresh.completedAt });
      }
    });
    return this.get(d.prescriptionId);
  }

  // ------------------------------------------------------------------ reports

  /** Interaction / clinical alerts raised vs overridden over a period. */
  async alertReport(q: { from: string; to: string; storeId?: string }) {
    const params: unknown[] = [q.from, q.to];
    let storeFilter = '';
    const allowed = StoreScope.current();
    if (q.storeId) {
      params.push(q.storeId);
      storeFilter += ` AND rx.store_id = $${params.length}`;
    }
    if (allowed !== null) {
      params.push(allowed);
      storeFilter += ` AND rx.store_id = ANY($${params.length}::uuid[])`;
    }
    const summary = await this.ds.query(
      `SELECT a.type, a.severity, count(*)::int AS raised, count(o.id)::int AS overridden, count(*) FILTER (WHERE a.blocking)::int AS blocking
         FROM clinical_alert a JOIN prescription rx ON rx.id = a.prescription_id LEFT JOIN interaction_override o ON o.alert_id = a.id
        WHERE a.created_at >= $1::date AND a.created_at < $2::date + 1 ${storeFilter}
        GROUP BY a.type, a.severity ORDER BY a.type, a.severity`,
      params,
    );
    const overrides = await this.ds.query(
      `SELECT o.at, rx.number AS prescription, p.hospital_no, p.name AS patient, a.type, a.severity, a.message, o.reason, u.full_name AS pharmacist, s.name AS store
         FROM interaction_override o JOIN clinical_alert a ON a.id = o.alert_id JOIN prescription rx ON rx.id = o.prescription_id
         JOIN patient p ON p.id = rx.patient_id JOIN app_user u ON u.id = o.pharmacist_id JOIN store s ON s.id = rx.store_id
        WHERE o.at >= $1::date AND o.at < $2::date + 1 ${storeFilter}
        ORDER BY o.at DESC`,
      params,
    );
    return { summary, overrides };
  }

  /** Received → first dispensed → completed times (turnaround). */
  async turnaround(q: { from: string; to: string; storeId?: string }) {
    const params: unknown[] = [q.from, q.to];
    let f = '';
    if (q.storeId) {
      params.push(q.storeId);
      f = ` AND store_id = $3`;
    }
    const [r] = await this.ds.query(
      `SELECT count(*)::int AS prescriptions,
              round(avg(extract(epoch FROM first_dispensed_at - received_at) / 60)::numeric, 1)::float AS avg_minutes_to_first_dispense,
              round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_dispensed_at - received_at) / 60))::numeric, 1)::float AS p90_minutes
         FROM prescription WHERE first_dispensed_at IS NOT NULL AND received_at >= $1::date AND received_at < $2::date + 1 ${f}`,
      params,
    );
    return r;
  }
}

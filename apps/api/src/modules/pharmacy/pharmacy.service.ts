import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { DocumentType, EncounterStatus, HmisBillingMode, HmisMessageType, Paginated, PatientChargeSource, Permissions, PrescriptionStatus, SalesSource, SessionUser, SupplyMode } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { BillingService } from '../billing/billing.service';
import { SalesInvoice } from '../billing/billing.entities';
import { returnStock, takeStock } from '../billing/dispense-stock';
import { EtimsService } from '../etims/etims.service';
import type { DispenseOut } from '../hmis/fhir';
import { Encounter, PatientCharge } from '../hmis/hmis.entities';
import { HmisService } from '../hmis/hmis.service';
import { PatientChargesService } from '../hmis/patient-charges.service';
import { InventoryService } from '../inventory/inventory.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { AlertDraft, ageInYears, InteractionSource, InternalInteractionSource, MedForCheck, runChecks, termsOf } from './interactions';
import { ClinicalAlert, Dispense, DispenseLine, InteractionOverride, Patient, Prescription, PrescriptionLine } from './pharmacy.entities';
import { CancelLinesDto, CreatePrescriptionDto, DispenseDto, DispenseReturnDto, PatientDto, PatientQueryDto, WardSupplyDto, WardSupplyQueryDto, WorklistQueryDto } from './pharmacy.dto';

/** HMIS details of a line created from an order (not part of the public DTO). */
export interface HmisLineMeta {
  externalRef: string;
  hmisDrugCode: string | null;
}

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
    private readonly hmis: HmisService,
    private readonly charges: PatientChargesService,
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
    const id = await this.ds.transaction((m) => this.createInTx(m, dto));
    return this.get(id);
  }

  private async assertLines(m: EntityManager, lines: CreatePrescriptionDto['lines']) {
    const generics: { id: string; is_active: boolean }[] = await m.query(`SELECT id, is_active FROM generic WHERE id = ANY($1::uuid[])`, [lines.map((l) => l.genericId)]);
    for (const l of lines) {
      if (!generics.find((g) => g.id === l.genericId && g.is_active)) throw new BadRequestException('A prescribed generic is unknown or inactive');
      if (l.preferredItemId) {
        const [it] = await m.query(`SELECT generic_id FROM item WHERE id = $1`, [l.preferredItemId]);
        if (it?.generic_id !== l.genericId) throw new BadRequestException('The preferred brand is not an item of the prescribed generic');
      }
    }
  }

  private lineOf(m: EntityManager, l: CreatePrescriptionDto['lines'][number], lineNo: number, meta?: HmisLineMeta) {
    return m.create(PrescriptionLine, {
      lineNo,
      genericId: l.genericId,
      preferredItemId: l.preferredItemId ?? null,
      dose: l.dose,
      frequency: l.frequency,
      duration: l.duration ?? null,
      route: l.route ?? null,
      quantity: l.quantity,
      dailyQuantity: l.dailyQuantity ?? null,
      instructions: l.instructions ?? null,
      externalRef: meta?.externalRef ?? null,
      hmisDrugCode: meta?.hmisDrugCode ?? null,
    });
  }

  /**
   * Creates a prescription in the caller's transaction (also used for orders
   * received from the HMIS, whose lines carry the order ids).
   */
  async createInTx(m: EntityManager, dto: CreatePrescriptionDto, lineMeta?: HmisLineMeta[]): Promise<string> {
    if (dto.externalRef) {
      const dup = await m.findOneBy(Prescription, { externalRef: dto.externalRef });
      if (dup) throw new ConflictException({ code: 'DUPLICATE_EXTERNAL_REF', message: `Already received as ${dup.number}`, prescriptionId: dup.id });
    }
    const patient = await m.findOneBy(Patient, { id: dto.patientId });
    if (!patient) throw new BadRequestException('Patient not found');
    let encounter: Encounter | null = null;
    if (dto.encounterId) {
      encounter = await m.findOneBy(Encounter, { id: dto.encounterId });
      if (!encounter || encounter.patientId !== patient.id) throw new BadRequestException('The encounter is not a visit of this patient');
    }
    const supplyMode = dto.supplyMode ?? SupplyMode.STANDARD;
    if (supplyMode !== SupplyMode.STANDARD && dto.lines.some((l) => !l.dailyQuantity)) throw new BadRequestException('Daily / unit-dose supply needs a daily quantity on every line');
    await this.assertLines(m, dto.lines);
    const rx = await m.save(
      m.create(Prescription, {
        number: await this.numbering.next(DocumentType.PRESCRIPTION, { storeId: dto.storeId, manager: m }),
        patientId: dto.patientId,
        storeId: dto.storeId,
        prescriber: dto.prescriber,
        prescriberRegNo: dto.prescriberRegNo ?? null,
        encounterId: encounter?.id ?? null,
        encounterRef: dto.encounterRef ?? encounter?.externalId ?? null,
        externalRef: dto.externalRef ?? null,
        supplyMode,
        notes: dto.notes ?? null,
        status: PrescriptionStatus.RECEIVED,
        receivedAt: new Date(),
        lines: dto.lines.map((l, i) => this.lineOf(m, l, i + 1, lineMeta?.[i])),
      }),
    );
    await this.check(m, rx.id);
    return rx.id;
  }

  /** Adds lines (HMIS orders of the same group arriving later) to an open prescription and re-runs the checks. */
  async addLinesInTx(m: EntityManager, prescriptionId: string, lines: CreatePrescriptionDto['lines'], lineMeta: HmisLineMeta[]) {
    const rx = await m.findOne(Prescription, { where: { id: prescriptionId }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['prescription'] } });
    if (!rx || !OPEN.includes(rx.status)) throw new ConflictException('The prescription is no longer open');
    await this.assertLines(m, lines);
    let no = Math.max(0, ...rx.lines!.map((l) => l.lineNo));
    for (const [i, l] of lines.entries()) await m.save(Object.assign(this.lineOf(m, l, ++no, lineMeta[i]), { prescriptionId }));
    await this.check(m, rx.id);
  }

  /** The HMIS stopped / cancelled an order: its undispensed balance is cancelled. */
  async cancelOrderLineInTx(m: EntityManager, externalRef: string, reason: string): Promise<boolean> {
    const line = await m.findOneBy(PrescriptionLine, { externalRef });
    if (!line) return false;
    const rx = await m.findOne(Prescription, { where: { id: line.prescriptionId }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['prescription'] } });
    if (!rx || !OPEN.includes(rx.status)) return true;
    const l = rx.lines!.find((x) => x.id === line.id)!;
    l.cancelledQty = r4(l.quantity - l.dispensedQty);
    await m.update(PrescriptionLine, l.id, { cancelledQty: l.cancelledQty });
    rx.notes = `${rx.notes ? `${rx.notes}\n` : ''}Line ${l.lineNo}: ${reason}`.slice(0, 1000);
    this.applyStatus(rx, new Date());
    await m.update(Prescription, rx.id, { status: rx.status, completedAt: rx.completedAt, notes: rx.notes });
    await this.check(m, rx.id);
    return true;
  }

  async worklist(q: WorklistQueryDto) {
    const qb = this.ds
      .getRepository(Prescription)
      .createQueryBuilder('rx')
      .leftJoinAndSelect('rx.patient', 'patient')
      .leftJoinAndSelect('rx.store', 'store')
      .leftJoinAndSelect('rx.encounter', 'encounter')
      .leftJoinAndSelect('encounter.department', 'ward')
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
      relations: { patient: { payer: true }, store: true, lines: { generic: true }, encounter: { department: true, payer: true } },
      order: { lines: { lineNo: 'ASC' } },
    });
    if (!rx) throw new NotFoundException('Prescription not found');
    StoreScope.assert(rx.storeId);
    const dispenses = await this.ds.getRepository(Dispense).find({ where: { prescriptionId: id }, relations: { lines: { item: true, batch: true } }, order: { dispensedAt: 'ASC' } });
    const dispenseIds = dispenses.map((d) => d.id);
    const invoices = dispenses.length ? await this.ds.getRepository(SalesInvoice).find({ where: [{ sourceId: In(dispenseIds) }], order: { createdAt: 'ASC' } }) : [];
    const charges = dispenses.length ? await this.ds.getRepository(PatientCharge).find({ where: { sourceId: In(dispenseIds) }, order: { createdAt: 'ASC' } }) : [];
    const hmisMessages = (await this.hmis.outboundFor(dispenseIds)).map((x) => ({ id: x.id, type: x.type, status: x.status, localDocNo: x.localDocNo, externalId: x.externalId, attempts: x.attempts, error: x.error, createdAt: x.createdAt, processedAt: x.processedAt }));
    return {
      ...rx,
      /** Who bills the next dispense: the HMIS for an HMIS patient's visit when the link bills there. */
      billingMode: rx.encounterId && rx.patient?.externalId ? await this.hmis.billingMode() : HmisBillingMode.LOCAL,
      alerts: await this.alerts(id),
      dispenses,
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, docType: i.docType, totalAmount: i.totalAmount, etimsStatus: i.etimsStatus, cuInvoiceNo: i.cuInvoiceNo, sourceId: i.sourceId })),
      charges: charges.map((c) => ({ id: c.id, sourceId: c.sourceId, description: c.description, quantity: c.quantity, amount: c.amount, status: c.status, externalId: c.externalId, reversesId: c.reversesId })),
      hmisMessages,
    };
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
   * and permission), DISPENSE stock movements per patient, and billing:
   * a sales invoice (payer split) and eTIMS, or — for an HMIS encounter with
   * billing mode HMIS — charges posted to the patient's HMIS bill. Records each
   * batch given, and sends the dispense records back to the HMIS for orders
   * that came from it.
   */
  async dispense(id: string, dto: DispenseDto, actor: SessionUser) {
    const r = await this.ds.transaction((m) => this.dispenseInTx(m, id, dto, actor));
    if (r.outboxId) await this.etims.trySendNow(r.outboxId);
    await this.hmis.trySendNow(r.hmisMessageIds);
    return { ...(await this.get(id)), dispenseId: r.dispenseId, invoiceId: r.invoiceId, change: r.change };
  }

  private async dispenseInTx(m: EntityManager, id: string, dto: DispenseDto, actor: SessionUser) {
    {
      const rx = await m.findOne(Prescription, { where: { id }, relations: { lines: true, patient: true }, lock: { mode: 'pessimistic_write', tables: ['prescription'] } });
      if (!rx) throw new NotFoundException('Prescription not found');
      StoreScope.assert(rx.storeId);
      if (rx.status !== PrescriptionStatus.VERIFIED && rx.status !== PrescriptionStatus.PARTIALLY_DISPENSED) {
        throw new ConflictException(rx.status === PrescriptionStatus.RECEIVED ? 'Verify the prescription before dispensing' : `Prescription is ${rx.status}`);
      }
      const encounter = rx.encounterId ? await m.findOneByOrFail(Encounter, { id: rx.encounterId }) : null;
      const billingMode = encounter && rx.patient!.externalId ? await this.hmis.billingMode(m) : HmisBillingMode.LOCAL;
      if (billingMode === HmisBillingMode.HMIS && dto.payments?.some((p) => p.amount > 0)) throw new BadRequestException('This patient is billed in the HMIS: take payments there');
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
          billingMode,
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

      // Charges are per batch line given; invoice line i+1 holds dto line i.
      const made: { dtoIndex: number; line: DispenseLine }[] = [];
      let k = 0;
      dto.lines.forEach((_, i) => (allocations.get(String(i)) ?? []).forEach(() => made.push({ dtoIndex: i, line: dispense.lines![k++] })));
      const chargeInput = {
        source: PatientChargeSource.DISPENSE,
        sourceId: dispense.id,
        sourceNo: number,
        storeId: rx.storeId,
        departmentId: encounter?.departmentId ?? null,
        patient: rx.patient!,
        encounter,
        lines: made.map((x) => ({ sourceLineId: x.line.id, itemId: x.line.itemId, quantity: x.line.quantity, invoiceLineNo: x.dtoIndex + 1 })),
      };
      const hmisMessageIds = rx.encounterId ? await this.queueDispenseRecords(m, rx, dispense, actor) : [];
      if (billingMode === HmisBillingMode.HMIS) {
        hmisMessageIds.push(...(await this.charges.postToHmis(m, chargeInput, actor)));
        return { dispenseId: dispense.id, invoiceId: null as string | null, outboxId: null as string | null, change: 0, hmisMessageIds };
      }

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
          payerId: encounter ? encounter.payerId : rx.patient!.payerId,
          payments: dto.payments,
          notes: `${rx.number} / ${number}`,
          lines: dto.lines.map((l, i) => ({ itemId: l.itemId, quantity: l.quantity, sourceLineId: l.prescriptionLineId, allocations: allocations.get(String(i)) ?? [] })),
        },
        actor,
      );
      await m.update(Dispense, dispense.id, { invoiceId: inv.invoice.id });
      if (encounter) await this.charges.recordInvoiced(m, chargeInput, inv.invoice.id);
      return { dispenseId: dispense.id, invoiceId: inv.invoice.id as string | null, outboxId: inv.outboxId, change: inv.change, hmisMessageIds };
    }
  }

  /** MedicationDispense records (one per batch given) for the HMIS, when the order came from it. */
  private async queueDispenseRecords(m: EntityManager, rx: Prescription, dispense: Dispense, actor: SessionUser, update?: { lineIds: string[]; note: string }): Promise<string[]> {
    const conn = await this.hmis.connection(m);
    if (!conn?.sendDispenses || !rx.patient?.externalId) return [];
    const encounter = rx.encounterId ? await m.findOneBy(Encounter, { id: rx.encounterId }) : null;
    const rows: { id: string; prescription_line_id: string; item_id: string; quantity: string; returned_qty: string; substituted: boolean; code: string; name: string; uom: string | null; batch_no: string; expiry: string | null; external_ref: string | null; hmis_drug_code: string | null }[] = await m.query(
      `SELECT dl.id, dl.prescription_line_id, dl.item_id, dl.quantity, dl.returned_qty, dl.substituted, i.code, i.name, u.code AS uom, b.batch_no,
              to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry, pl.external_ref, pl.hmis_drug_code
         FROM dispense_line dl JOIN item i ON i.id = dl.item_id LEFT JOIN unit_of_measure u ON u.id = i.base_uom_id
         JOIN batch b ON b.id = dl.batch_id JOIN prescription_line pl ON pl.id = dl.prescription_line_id
        WHERE dl.dispense_id = $1 ORDER BY dl.created_at`,
      [dispense.id],
    );
    const ids: string[] = [];
    for (const r of rows) {
      if (update && !update.lineIds.includes(r.id)) continue;
      const net = r4(Number(r.quantity) - Number(r.returned_qty));
      const payload: DispenseOut = {
        dispenseLineId: r.id,
        dispenseNo: dispense.number,
        status: 'completed',
        orderExternalId: r.external_ref,
        patientExternalId: rx.patient.externalId,
        encounterExternalId: encounter?.externalId ?? null,
        hmisDrugCode: r.hmis_drug_code,
        itemCode: r.code,
        itemName: r.name,
        quantity: update ? net : Number(r.quantity),
        unit: r.uom,
        batchNo: r.batch_no,
        expiryDate: r.expiry,
        dispensedAt: dispense.dispensedAt.toISOString(),
        dispensedBy: actor.fullName,
        substituted: r.substituted,
        note: update?.note ?? null,
      };
      // An update is a new message keyed on the original (the HMIS record is PUT).
      const base = `MD|${r.id}`;
      const key = update ? `${base}#${Date.now()}` : base;
      const msg = await this.hmis.enqueue(m, { type: HmisMessageType.MEDICATION_DISPENSE, key, payload, docType: 'DISPENSE', docId: dispense.id, docNo: dispense.number, patientId: rx.patientId, encounterId: rx.encounterId });
      ids.push(msg.id);
    }
    return ids;
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
   * Medicines brought back unused: stock back on the same batches (restock)
   * and the dispense records reduced. Billed here: a credit note against the
   * dispense invoice (eTIMS). Billed in the HMIS: a negative charge against
   * the original HMIS charge. Dispense records already in the HMIS are
   * updated with the net quantity. The returned quantity is not re-supplied
   * automatically.
   */
  async returnDispense(dispenseId: string, dto: DispenseReturnDto, actor: SessionUser) {
    const d = await this.ds.getRepository(Dispense).findOne({ where: { id: dispenseId }, relations: { lines: true } });
    if (!d) throw new NotFoundException('Dispense not found');
    StoreScope.assert(d.storeId);
    let hmisIds: string[] = [];
    if (d.billingMode === HmisBillingMode.HMIS) {
      hmisIds = await this.ds.transaction(async (m) => {
        const touched = await this.applyReturn(m, d, dto);
        if (dto.restock ?? true) {
          const ctx = await this.inventory.postingContext(actor, { type: DocumentType.DISPENSE, id: d.id, number: d.number }, undefined, null, m);
          const lines = await m.find(DispenseLine, { where: { dispenseId } });
          const [p] = await m.query(`SELECT hospital_no FROM patient WHERE id = $1`, [d.patientId]);
          await returnStock(
            m,
            ctx,
            d.storeId,
            touched.map((t) => {
              const dl = lines.find((x) => x.id === t.dispenseLineId)!;
              return { itemId: dl.itemId, quantity: t.quantity, patientRef: p.hospital_no, allocations: [{ batchId: dl.batchId, binId: dl.binId, quantity: t.quantity, unitCost: dl.unitCost }] };
            }),
          );
        }
        return this.afterReturn(m, d, touched, dto.reason, actor, null);
      });
    } else {
      if (!d.invoiceId) throw new ConflictException('This dispense has no invoice');
      const inv = await this.billing.get(d.invoiceId);
      const creditLines = dto.lines.map((l) => {
        const il = (inv.lines ?? []).find((x) => x.sourceLineId === l.prescriptionLineId);
        if (!il) throw new BadRequestException('A line was not dispensed on this dispense');
        return { invoiceLineId: il.id, quantity: l.quantity };
      });
      await this.billing.creditNote(d.invoiceId, { lines: creditLines, reason: dto.reason, restock: dto.restock ?? true }, actor, async (m, cn) => {
        const touched = await this.applyReturn(m, d, dto);
        hmisIds = await this.afterReturn(m, d, touched, dto.reason, actor, cn.id);
      });
    }
    await this.hmis.trySendNow(hmisIds);
    return this.get(d.prescriptionId);
  }

  /** Reduces the dispense and prescription records; returns the quantity taken back per dispense (batch) line. */
  private async applyReturn(m: EntityManager, d: Dispense, dto: DispenseReturnDto) {
    const lines = await m.find(DispenseLine, { where: { dispenseId: d.id }, order: { createdAt: 'ASC' }, lock: { mode: 'pessimistic_write' } });
    const touched: { dispenseLineId: string; quantity: number }[] = [];
    for (const r of dto.lines) {
      let left = r.quantity;
      const mine = lines.filter((x) => x.prescriptionLineId === r.prescriptionLineId);
      if (!mine.length) throw new BadRequestException('A line was not dispensed on this dispense');
      for (const dl of mine) {
        if (left <= 0) break;
        const q = Math.min(r4(dl.quantity - dl.returnedQty), left);
        if (q <= 0) continue;
        dl.returnedQty = r4(dl.returnedQty + q);
        await m.update(DispenseLine, dl.id, { returnedQty: dl.returnedQty });
        touched.push({ dispenseLineId: dl.id, quantity: q });
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
    return touched;
  }

  /** Encounter charges reversed and HMIS dispense records updated after a return. */
  private async afterReturn(m: EntityManager, d: Dispense, touched: { dispenseLineId: string; quantity: number }[], reason: string, actor: SessionUser, creditNoteId: string | null): Promise<string[]> {
    const ids: string[] = [];
    for (const t of touched) {
      const id = await this.charges.reverse(m, { source: PatientChargeSource.DISPENSE, sourceId: d.id, sourceLineId: t.dispenseLineId, quantity: t.quantity, reason, creditNoteId }, actor);
      if (id) ids.push(id);
    }
    const rx = await m.findOneOrFail(Prescription, { where: { id: d.prescriptionId }, relations: { patient: true } });
    if (rx.encounterId) {
      const sent = await m.query(`SELECT 1 FROM hmis_message WHERE local_doc_id = $1 AND type = 'MEDICATION_DISPENSE' LIMIT 1`, [d.id]);
      if (sent.length) ids.push(...(await this.queueDispenseRecords(m, rx, d, actor, { lineIds: touched.map((t) => t.dispenseLineId), note: `Returned: ${reason}`.slice(0, 300) })));
    }
    return ids;
  }

  // ------------------------------------------------------------------ ward supply (inpatients)

  /**
   * Admitted patients' daily / unit-dose lines at an outlet (optionally one
   * ward): what is due today = daily quantity less what was given today,
   * capped at the balance left on the order.
   */
  async wardSupplyList(q: WardSupplyQueryDto) {
    StoreScope.assert(q.storeId);
    const today = await this.settings.today();
    const tz = await this.settings.get('locale.timezone');
    const rows: {
      prescription_id: string; number: string; status: string; supply_mode: string; patient_id: string; patient: string; hospital_no: string; bed: string | null; ward: string | null; department_id: string | null;
      line_id: string; line_no: number; generic_id: string; generic: string; dose: string; frequency: string; route: string | null; daily_quantity: number; remaining: number; given_today: number;
    }[] = await this.ds.query(
      `SELECT rx.id AS prescription_id, rx.number, rx.status, rx.supply_mode, p.id AS patient_id, p.name AS patient, p.hospital_no, e.bed, d.name AS ward, e.department_id,
              l.id AS line_id, l.line_no, l.generic_id, g.inn_name || COALESCE(' ' || NULLIF(g.strength, ''), '') AS generic, l.dose, l.frequency, l.route,
              l.daily_quantity::float AS daily_quantity, (l.quantity - l.dispensed_qty - l.cancelled_qty)::float AS remaining,
              COALESCE((SELECT SUM(dl.quantity - dl.returned_qty) FROM dispense_line dl JOIN dispense ds ON ds.id = dl.dispense_id
                         WHERE dl.prescription_line_id = l.id AND (ds.dispensed_at AT TIME ZONE $3)::date = $2::date), 0)::float AS given_today
         FROM prescription rx
         JOIN prescription_line l ON l.prescription_id = rx.id
         JOIN generic g ON g.id = l.generic_id
         JOIN patient p ON p.id = rx.patient_id
         JOIN encounter e ON e.id = rx.encounter_id
         LEFT JOIN department d ON d.id = e.department_id
        WHERE rx.store_id = $1 AND rx.supply_mode <> 'STANDARD' AND rx.status IN ('RECEIVED', 'VERIFIED', 'PARTIALLY_DISPENSED')
          AND e.status = 'ACTIVE' AND ($4::uuid IS NULL OR e.department_id = $4)
          AND l.quantity - l.dispensed_qty - l.cancelled_qty > 0
        ORDER BY d.name NULLS LAST, e.bed NULLS LAST, p.name, rx.number, l.line_no`,
      [q.storeId, today, tz, q.departmentId ?? null],
    );
    const patients = new Map<string, { patientId: string; patient: string; hospitalNo: string; ward: string | null; bed: string | null; lines: unknown[] }>();
    for (const r of rows) {
      const due = r4(Math.max(0, Math.min((r.daily_quantity ?? 0) - r.given_today, r.remaining)));
      const p = patients.get(r.patient_id) ?? { patientId: r.patient_id, patient: r.patient, hospitalNo: r.hospital_no, ward: r.ward, bed: r.bed, lines: [] };
      p.lines.push({
        prescriptionId: r.prescription_id, prescriptionNo: r.number, status: r.status, supplyMode: r.supply_mode, prescriptionLineId: r.line_id, lineNo: r.line_no,
        genericId: r.generic_id, generic: r.generic, dose: r.dose, frequency: r.frequency, route: r.route,
        dailyQuantity: r.daily_quantity, givenToday: r.given_today, remaining: r.remaining, due, needsVerification: r.status === PrescriptionStatus.RECEIVED,
      });
      patients.set(r.patient_id, p);
    }
    return { date: today, patients: [...patients.values()] };
  }

  /** Dispenses a ward round: one dispense per prescription (each in its own transaction); reports per prescription. */
  async wardSupply(dto: WardSupplyDto, actor: SessionUser) {
    StoreScope.assert(dto.storeId);
    const lineIds = dto.lines.map((l) => l.prescriptionLineId);
    const owners: { id: string; prescription_id: string; store_id: string }[] = await this.ds.query(
      `SELECT l.id, l.prescription_id, rx.store_id FROM prescription_line l JOIN prescription rx ON rx.id = l.prescription_id WHERE l.id = ANY($1::uuid[])`,
      [lineIds],
    );
    if (owners.length !== new Set(lineIds).size) throw new BadRequestException('A line was not found');
    if (owners.some((o) => o.store_id !== dto.storeId)) throw new BadRequestException('All lines must be for prescriptions at this outlet');
    const byRx = new Map<string, typeof dto.lines>();
    for (const l of dto.lines) {
      const rxId = owners.find((o) => o.id === l.prescriptionLineId)!.prescription_id;
      byRx.set(rxId, [...(byRx.get(rxId) ?? []), l]);
    }
    const results: { prescriptionId: string; ok: boolean; dispenseId?: string; error?: string }[] = [];
    for (const [rxId, lines] of byRx) {
      try {
        const r = await this.dispense(rxId, { lines, witnessId: dto.witnessId, fefoOverrideReason: dto.fefoOverrideReason }, actor);
        results.push({ prescriptionId: rxId, ok: true, dispenseId: r.dispenseId });
      } catch (e) {
        const resp = (e as { getResponse?: () => unknown }).getResponse?.();
        results.push({ prescriptionId: rxId, ok: false, error: typeof resp === 'object' && resp && 'message' in resp ? String((resp as { message: unknown }).message) : (e as Error).message });
      }
    }
    return { results, dispensed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
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

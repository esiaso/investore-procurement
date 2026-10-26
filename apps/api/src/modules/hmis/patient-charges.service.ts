import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { EncounterStatus, HmisBillingMode, HmisMessageType, Paginated, PatientChargeSource, PatientChargeStatus, SalesSource, SessionUser } from '@sil/shared';
import { Payer, PriceList, SalesInvoice } from '../billing/billing.entities';
import { BillingService } from '../billing/billing.service';
import { round2 } from '../billing/tax-calc';
import { EtimsService } from '../etims/etims.service';
import { Patient } from '../pharmacy/pharmacy.entities';
import { SettingsService } from '../settings/settings.service';
import type { ChargeOut } from './fhir';
import { ChargeQueryDto, ReverseChargeDto, WardConsumptionDto } from './hmis.dto';
import { Encounter, PatientCharge } from './hmis.entities';
import { HmisService } from './hmis.service';

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface ChargeInput {
  source: PatientChargeSource;
  sourceId: string;
  sourceNo: string | null;
  storeId: string | null;
  departmentId?: string | null;
  patient: Patient;
  encounter: Encounter | null;
  /** invoiceLineNo: the invoice line holding this charge (LOCAL billing; default: matched by item). */
  lines: { sourceLineId: string; itemId: string; quantity: number; invoiceLineNo?: number }[];
}

/**
 * Charges to a patient's encounter. With billing mode HMIS they are priced
 * from the payer's price list and posted to the HMIS bill (outbound CHARGE);
 * with LOCAL they are invoiced here (sales invoice, eTIMS) and recorded for
 * the encounter. A source line is charged once (unique key); returns become
 * negative charges against the original.
 */
@Injectable()
export class PatientChargesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly hmis: HmisService,
    private readonly billing: BillingService,
    private readonly etims: EtimsService,
    private readonly settings: SettingsService,
  ) {}

  private async priceList(m: EntityManager, patient: Patient, encounter: Encounter | null): Promise<{ list: PriceList; payerId: string | null }> {
    const payerId = encounter ? (encounter.payerId ?? null) : (patient.payerId ?? null);
    const payer = payerId ? await m.findOneBy(Payer, { id: payerId, isActive: true }) : null;
    const list = payer?.priceListId ? await m.findOneByOrFail(PriceList, { id: payer.priceListId }) : await this.billing.defaultPriceList(m);
    return { list, payerId: payer?.id ?? null };
  }

  private async assertNotCharged(m: EntityManager, input: ChargeInput) {
    for (const l of input.lines) {
      const dup = await m.findOneBy(PatientCharge, { source: input.source, sourceId: input.sourceId, sourceLineId: l.sourceLineId, reversesId: IsNull() });
      if (dup) throw new ConflictException({ code: 'ALREADY_CHARGED', message: `${input.sourceNo ?? input.source} line was already charged`, chargeId: dup.id });
    }
  }

  /** Billing mode HMIS: prices the lines and queues them for the patient's HMIS bill. Returns outbound message ids. */
  async postToHmis(m: EntityManager, input: ChargeInput, actor: SessionUser): Promise<string[]> {
    if (!input.patient.externalId) throw new BadRequestException(`${input.patient.name} is not an HMIS patient; charges cannot go to the HMIS bill`);
    await this.assertNotCharged(m, input);
    const { list } = await this.priceList(m, input.patient, input.encounter);
    const currency = await this.settings.get('locale.currency', m);
    const ids: string[] = [];
    for (const l of input.lines) {
      const p = await this.billing.priceFor(m, list, l.itemId);
      const [it] = await m.query(`SELECT code FROM item WHERE id = $1`, [l.itemId]);
      const charge = await m.save(
        m.create(PatientCharge, {
          patientId: input.patient.id,
          encounterId: input.encounter?.id ?? null,
          source: input.source,
          sourceId: input.sourceId,
          sourceNo: input.sourceNo,
          sourceLineId: l.sourceLineId,
          storeId: input.storeId,
          departmentId: input.departmentId ?? null,
          itemId: l.itemId,
          description: p.name.slice(0, 200),
          quantity: l.quantity,
          unitPrice: p.price,
          amount: round2(p.price * l.quantity),
          status: PatientChargeStatus.PENDING,
        }),
      );
      const payload: ChargeOut = {
        chargeId: charge.id,
        reversesExternalId: null,
        patientExternalId: input.patient.externalId,
        encounterExternalId: input.encounter?.externalId ?? null,
        source: input.source,
        sourceNo: input.sourceNo,
        itemCode: it.code,
        description: charge.description,
        quantity: charge.quantity,
        unitPrice: charge.unitPrice,
        amount: charge.amount,
        currency,
        occurredAt: new Date().toISOString(),
        enteredBy: actor.fullName,
      };
      const msg = await this.hmis.enqueue(m, { type: HmisMessageType.CHARGE, key: `CHARGE|${charge.id}`, payload, docType: input.source, docId: input.sourceId, docNo: input.sourceNo, patientId: input.patient.id, encounterId: input.encounter?.id ?? null });
      await m.update(PatientCharge, charge.id, { messageId: msg.id });
      ids.push(msg.id);
    }
    return ids;
  }

  /** Billing mode LOCAL: records the encounter's charges as invoiced (priced as on the invoice line). */
  async recordInvoiced(m: EntityManager, input: ChargeInput, invoiceId: string) {
    await this.assertNotCharged(m, input);
    const lines: { line_no: number; item_id: string; description: string; quantity: string; unit_price: string; gross_amount: string }[] = await m.query(
      `SELECT line_no, item_id, description, quantity, unit_price, gross_amount FROM sales_invoice_line WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );
    for (const l of input.lines) {
      const il = (l.invoiceLineNo ? lines.find((x) => x.line_no === l.invoiceLineNo) : undefined) ?? lines.find((x) => x.item_id === l.itemId);
      const share = il && Number(il.quantity) ? l.quantity / Number(il.quantity) : 0;
      await m.save(
        m.create(PatientCharge, {
          patientId: input.patient.id,
          encounterId: input.encounter?.id ?? null,
          source: input.source,
          sourceId: input.sourceId,
          sourceNo: input.sourceNo,
          sourceLineId: l.sourceLineId,
          storeId: input.storeId,
          departmentId: input.departmentId ?? null,
          itemId: l.itemId,
          description: (il?.description ?? 'Charge').slice(0, 200),
          quantity: l.quantity,
          unitPrice: il ? Number(il.unit_price) : 0,
          amount: il ? round2(Number(il.gross_amount) * share) : 0,
          status: PatientChargeStatus.INVOICED,
          invoiceId,
        }),
      );
    }
  }

  /**
   * A negative charge against the original (return of a dispensed medicine,
   * unused consumable). HMIS charges are posted as a credit referencing the
   * original HMIS charge; local ones point at the credit note.
   */
  async reverse(m: EntityManager, r: { source: PatientChargeSource; sourceId: string; sourceLineId: string; quantity: number; reason: string; creditNoteId?: string | null }, actor: SessionUser): Promise<string | null> {
    const orig = await m.findOneBy(PatientCharge, { source: r.source, sourceId: r.sourceId, sourceLineId: r.sourceLineId, reversesId: IsNull() });
    if (!orig) return null;
    return this.reverseCharge(m, orig, r.quantity, r.reason, actor, r.creditNoteId ?? null);
  }

  private async reverseCharge(m: EntityManager, orig: PatientCharge, quantity: number, reason: string, actor: SessionUser, creditNoteId: string | null): Promise<string | null> {
    const [{ reversed }] = await m.query(`SELECT COALESCE(-SUM(quantity), 0)::float AS reversed FROM patient_charge WHERE reverses_id = $1`, [orig.id]);
    const left = r4(orig.quantity - reversed);
    if (quantity > left) throw new BadRequestException(`Only ${left} of ${orig.description} can still be reversed`);
    const local = orig.status === PatientChargeStatus.INVOICED;
    const neg = await m.save(
      m.create(PatientCharge, {
        ...orig,
        id: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        quantity: -quantity,
        amount: -round2(orig.unitPrice * quantity),
        status: local ? PatientChargeStatus.INVOICED : PatientChargeStatus.PENDING,
        invoiceId: local ? creditNoteId : null,
        messageId: null,
        externalId: null,
        reversesId: orig.id,
        note: reason.slice(0, 500),
      }),
    );
    if (local) return null;
    const patient = await m.findOneByOrFail(Patient, { id: orig.patientId });
    const encounter = orig.encounterId ? await m.findOneBy(Encounter, { id: orig.encounterId }) : null;
    const [it] = await m.query(`SELECT code FROM item WHERE id = $1`, [orig.itemId]);
    const payload: ChargeOut & { reversesChargeId: string } = {
      chargeId: neg.id,
      reversesChargeId: orig.id,
      reversesExternalId: orig.externalId,
      patientExternalId: patient.externalId!,
      encounterExternalId: encounter?.externalId ?? null,
      source: orig.source,
      sourceNo: orig.sourceNo,
      itemCode: it.code,
      description: `Reversal: ${orig.description}`.slice(0, 200),
      quantity: -quantity,
      unitPrice: orig.unitPrice,
      amount: neg.amount,
      currency: await this.settings.get('locale.currency', m),
      occurredAt: new Date().toISOString(),
      enteredBy: actor.fullName,
    };
    const msg = await this.hmis.enqueue(m, { type: HmisMessageType.CHARGE, key: `CHARGE|${neg.id}`, payload, docType: orig.source, docId: orig.sourceId, docNo: orig.sourceNo, patientId: orig.patientId, encounterId: orig.encounterId });
    await m.update(PatientCharge, neg.id, { messageId: msg.id });
    return msg.id;
  }

  /** Manual reversal of a charge posted to the HMIS (local charges are corrected with a credit note). */
  async reverseById(id: string, dto: ReverseChargeDto, actor: SessionUser) {
    const msgId = await this.ds.transaction(async (m) => {
      const orig = await m.findOne(PatientCharge, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!orig) throw new NotFoundException('Charge not found');
      // Same rule as charging: the ward the charge belongs to, or the store that supplied it.
      if (actor.storeIds !== null && actor.departmentId !== orig.departmentId && !(orig.storeId && actor.storeIds.includes(orig.storeId))) {
        throw new ForbiddenException('You can reverse charges of your own department (or your store) only');
      }
      if (orig.reversesId) throw new BadRequestException('A reversal cannot be reversed');
      if (orig.status === PatientChargeStatus.INVOICED) throw new BadRequestException('This charge was invoiced here: raise a credit note on the invoice instead');
      return this.reverseCharge(m, orig, dto.quantity, dto.reason, actor, null);
    });
    if (msgId) await this.hmis.trySendNow([msgId]);
    return this.ds.getRepository(PatientCharge).find({ where: [{ id }, { reversesId: id }], order: { createdAt: 'ASC' } });
  }

  /**
   * Charges stock already moved (issued to the patient's ward, or used from
   * ward stock): to the HMIS bill (billing mode HMIS), or on a local invoice
   * without stock movement. Returns what to send after the transaction.
   */
  async chargeEncounter(m: EntityManager, input: ChargeInput, actor: SessionUser, notes: string): Promise<{ messageIds: string[]; outboxId: string | null }> {
    if (!input.storeId) throw new BadRequestException('A charge needs the store that supplied the stock');
    if ((await this.hmis.billingMode(m)) === HmisBillingMode.HMIS && input.patient.externalId) return { messageIds: await this.postToHmis(m, input, actor), outboxId: null };
    const inv = await this.billing.createInvoice(
      m,
      {
        storeId: input.storeId,
        source: SalesSource.CONSUMABLE,
        sourceId: input.sourceId,
        patientId: input.patient.id,
        customerName: input.patient.name,
        customerPin: input.patient.kraPin,
        customerPhone: input.patient.phone,
        payerId: input.encounter ? input.encounter.payerId : input.patient.payerId,
        notes: notes.slice(0, 1000),
        lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, sourceLineId: l.sourceLineId })),
      },
      actor,
    );
    await this.recordInvoiced(m, { ...input, lines: input.lines.map((l, i) => ({ ...l, invoiceLineNo: i + 1 })) }, inv.invoice.id);
    return { messageIds: [], outboxId: inv.outboxId };
  }

  /** After the charging transaction: eTIMS for a local invoice, the HMIS for posted charges. */
  async deliver(r: { messageIds: string[]; outboxId: string | null }) {
    if (r.outboxId) await this.etims.trySendNow(r.outboxId);
    await this.hmis.trySendNow(r.messageIds);
  }

  /**
   * Ward / theatre stock used on an admitted patient. The stock was issued to
   * the ward already (its cost sits with the ward), so nothing moves: the
   * patient is charged (HMIS bill, or a local invoice without stock movement).
   */
  async wardConsumption(dto: WardConsumptionDto, actor: SessionUser) {
    // Ward staff charge for their own ward; store staff for stock their store issued.
    if (actor.storeIds !== null && actor.departmentId !== dto.departmentId && !actor.storeIds.includes(dto.storeId)) {
      throw new ForbiddenException('You can charge consumables used in your own department (or issued by your store) only');
    }
    const batchId = randomUUID();
    const r = await this.ds.transaction(async (m) => {
      const encounter = await m.findOneBy(Encounter, { id: dto.encounterId });
      if (!encounter) throw new NotFoundException('Encounter not found');
      if (encounter.status !== EncounterStatus.ACTIVE) throw new ConflictException('The encounter is closed in the HMIS');
      const patient = await m.findOneByOrFail(Patient, { id: encounter.patientId });
      const [dept] = await m.query(`SELECT id FROM department WHERE id = $1`, [dto.departmentId]);
      if (!dept) throw new BadRequestException('Department not found');
      const lines = dto.lines.map((l) => ({ sourceLineId: randomUUID(), itemId: l.itemId, quantity: l.quantity }));
      const input: ChargeInput = { source: PatientChargeSource.WARD_CONSUMPTION, sourceId: batchId, sourceNo: dto.note?.slice(0, 60) ?? null, storeId: dto.storeId, departmentId: dto.departmentId, patient, encounter, lines };
      return this.chargeEncounter(m, input, actor, `Ward consumables, encounter ${encounter.externalId}${dto.note ? ` — ${dto.note}` : ''}`);
    });
    await this.deliver(r);
    return this.ds.getRepository(PatientCharge).find({ where: { sourceId: batchId }, relations: { item: true }, order: { createdAt: 'ASC' } });
  }

  async list(q: ChargeQueryDto): Promise<Paginated<PatientCharge>> {
    const qb = this.ds
      .getRepository(PatientCharge)
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.item', 'item')
      .leftJoinAndSelect('c.patient', 'patient')
      .leftJoinAndSelect('c.encounter', 'encounter')
      .orderBy('c.createdAt', 'DESC');
    if (q.encounterId) qb.andWhere('c.encounter_id = :e', { e: q.encounterId });
    if (q.patientId) qb.andWhere('c.patient_id = :p', { p: q.patientId });
    const [items, total] = await qb
      .skip((q.page - 1) * q.pageSize)
      .take(q.pageSize)
      .getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Invoice of a LOCAL charge, for links. */
  invoiceOf(invoiceId: string) {
    return this.ds.getRepository(SalesInvoice).findOneBy({ id: invoiceId });
  }
}

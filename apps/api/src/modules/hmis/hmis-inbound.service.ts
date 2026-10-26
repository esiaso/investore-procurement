import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { HmisMappingKind, HmisMessageStatus, HmisMessageType, PrescriptionStatus, SupplyMode } from '@sil/shared';
import { JobsService } from '../jobs/jobs.service';
import { Patient, Prescription, PrescriptionLine } from '../pharmacy/pharmacy.entities';
import { PharmacyService } from '../pharmacy/pharmacy.service';
import { SettingsService } from '../settings/settings.service';
import type { AllergyInfo, EncounterInfo, FhirResource, MedicationOrder, PatientInfo } from './fhir';
import { HmisUnavailableError, InboundItem, itemsFromFhir, itemsFromRest } from './hmis-adapter';
import { HmisConnection, HmisMessage } from './hmis.entities';
import { HmisService } from './hmis.service';

const OPEN = [PrescriptionStatus.RECEIVED, PrescriptionStatus.VERIFIED, PrescriptionStatus.PARTIALLY_DISPENSED];
const STOPPED = new Set(['cancelled', 'stopped', 'entered-in-error', 'completed']);
const REST_TYPE: Partial<Record<HmisMessageType, string>> = {
  [HmisMessageType.PATIENT]: 'patient',
  [HmisMessageType.ENCOUNTER]: 'encounter',
  [HmisMessageType.ALLERGY]: 'allergy',
  [HmisMessageType.MEDICATION_REQUEST]: 'order',
};

/** What an inbound message was applied to. */
type Outcome = Partial<Pick<HmisMessage, 'localDocType' | 'localDocId' | 'localDocNo' | 'patientId' | 'encounterId'>>;

/** A business reason the message cannot be applied (not worth retrying until something changes). */
class InboundRejected extends Error {}
/** Processed, but nothing to do. */
class InboundIgnored extends Error {}

/**
 * Messages from the HMIS: patients, encounters, allergies and medication
 * orders, pushed (webhook) or polled (job hmis.poll). Each version is logged
 * once and processed: orders become prescriptions on the outlet's worklist
 * (drug codes mapped to the generic/brand master), stopped orders cancel
 * their undispensed balance. When the HMIS cannot be read the message waits
 * and is retried by hmis.dispatch.
 */
@Injectable()
export class HmisInboundService implements OnModuleInit {
  private readonly log = new Logger('HMIS-in');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly hmis: HmisService,
    private readonly pharmacy: PharmacyService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.hmis.setInboundProcessor((id) => this.process(id));
    this.jobs.register('hmis.poll', 'Fetch new and changed medication orders from the HMIS', () => this.poll());
  }

  // ------------------------------------------------------------------ receiving

  /** FHIR body (Bundle or resource) pushed by the HMIS. */
  async receiveFhir(body: FhirResource, via = 'WEBHOOK') {
    if (!body || typeof body !== 'object' || typeof body.resourceType !== 'string') throw new BadRequestException('Send a FHIR resource or Bundle');
    const conn = await this.hmis.connection();
    if (!conn) throw new BadRequestException('No HMIS connection is configured');
    return this.receive(itemsFromFhir(body, conn.hospitalNoSystem), via);
  }

  /** Generic REST event pushed by the HMIS. */
  async receiveRest(event: { type?: string; data?: unknown }, via = 'WEBHOOK') {
    if (!(await this.hmis.connection())) throw new BadRequestException('No HMIS connection is configured');
    return this.receive(itemsFromRest(event ?? {}), via);
  }

  /** Logs each item once (per version), then processes it. Patients and encounters go before orders. */
  async receive(items: InboundItem[], via: string) {
    const rank = (t: HmisMessageType) => (t === HmisMessageType.PATIENT ? 0 : t === HmisMessageType.ENCOUNTER ? 1 : t === HmisMessageType.ALLERGY ? 2 : 3);
    const results: { type: HmisMessageType; externalId: string | null; messageId: string; status: HmisMessageStatus; duplicate: boolean; localDocNo: string | null; error: string | null }[] = [];
    for (const item of [...items].sort((a, b) => rank(a.type) - rank(b.type))) {
      const { message, duplicate } = await this.hmis.logInbound(item, via);
      let status = message.status;
      if (!duplicate && status === HmisMessageStatus.PENDING) status = await this.process(message.id);
      const fresh = duplicate || status !== message.status ? await this.hmis.message(message.id) : message;
      results.push({ type: item.type, externalId: item.externalId, messageId: message.id, status: fresh.status, duplicate, localDocNo: fresh.localDocNo, error: fresh.error });
    }
    return {
      received: results.length,
      processed: results.filter((r) => r.status === HmisMessageStatus.PROCESSED).length,
      failed: results.filter((r) => r.status === HmisMessageStatus.FAILED).length,
      duplicates: results.filter((r) => r.duplicate).length,
      results,
    };
  }

  /** Polls the HMIS for orders changed since the last poll (job hmis.poll). */
  async poll(): Promise<Record<string, unknown>> {
    const conn = await this.hmis.connection();
    if (!conn?.pollOrders) return { skipped: true };
    try {
      const { adapter, timeoutMs } = await this.hmis.adapter();
      // First poll: the last day only. Afterwards a second of overlap (repeats are recognised by version).
      const since = conn.lastPolledAt ? new Date(conn.lastPolledAt.getTime() - 1000) : new Date(Date.now() - 86_400_000);
      const { items, cursor } = await adapter.pollOrders(since, timeoutMs);
      const r = await this.receive(items, 'POLL');
      await this.ds.getRepository(HmisConnection).update(conn.id, { lastPolledAt: cursor && cursor > since ? cursor : (conn.lastPolledAt ?? since), lastPollError: null });
      return { received: r.received, processed: r.processed, failed: r.failed };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 1000);
      await this.ds.getRepository(HmisConnection).update(conn.id, { lastPollError: msg });
      if (e instanceof HmisUnavailableError) return { error: msg };
      throw e;
    }
  }

  /** Looks patients up in the HMIS (hospital number or name); marks those already cached. */
  async searchPatients(q: string) {
    const { adapter, timeoutMs } = await this.hmis.adapter();
    let items: InboundItem[];
    try {
      items = await adapter.searchPatients(q, timeoutMs);
    } catch (e) {
      if (e instanceof HmisUnavailableError) throw new BadRequestException(`The HMIS did not answer: ${e.message}`);
      throw e;
    }
    const found = items.flatMap((i) => (i.type === HmisMessageType.PATIENT && i.data ? [i.data as PatientInfo] : []));
    const cached: { id: string; external_id: string }[] = found.length
      ? await this.ds.query(`SELECT id, external_id FROM patient WHERE external_id = ANY($1::varchar[])`, [found.map((f) => f.externalId)])
      : [];
    return found.map((f) => ({ ...f, patientId: cached.find((c) => c.external_id === f.externalId)?.id ?? null }));
  }

  /** Reads the patient (with allergies) from the HMIS into the cache; logged like any inbound message. */
  async importPatient(externalId: string) {
    const { adapter, timeoutMs } = await this.hmis.adapter();
    let items: InboundItem[];
    try {
      items = await adapter.fetchPatient(externalId, timeoutMs);
    } catch (e) {
      if (e instanceof HmisUnavailableError) throw new BadRequestException(`The HMIS did not answer: ${e.message}`);
      throw e;
    }
    if (!items.some((i) => i.type === HmisMessageType.PATIENT)) throw new NotFoundException(`Patient ${externalId} was not found in the HMIS`);
    // A fresh read is authoritative for allergies: replace the list.
    const allergies = items.flatMap((i) => (i.type === HmisMessageType.ALLERGY && i.data && (i.data as AllergyInfo).active ? [(i.data as AllergyInfo).substance] : []));
    const r = await this.receive(items, 'IMPORT');
    const patientResult = r.results.find((x) => x.type === HmisMessageType.PATIENT)!;
    if (patientResult.status === HmisMessageStatus.FAILED) throw new BadRequestException(patientResult.error ?? 'The patient could not be imported');
    const patient = await this.ds.getRepository(Patient).findOneByOrFail({ externalId });
    patient.allergies = [...new Set(allergies)];
    patient.syncedAt = new Date();
    return this.ds.getRepository(Patient).save(patient);
  }

  // ------------------------------------------------------------------ processing

  private parse(msg: HmisMessage, hospitalNoSystem: string): InboundItem {
    const items = msg.idempotencyKey.startsWith('REST:')
      ? itemsFromRest({ type: REST_TYPE[msg.type], data: msg.payload })
      : itemsFromFhir(msg.payload as FhirResource, hospitalNoSystem);
    const item = items[0];
    if (!item) throw new InboundRejected('The message holds nothing this system reads');
    return item;
  }

  /**
   * Processes one inbound message. It is claimed first (pushed back in the
   * queue) so a concurrent dispatcher leaves it alone; the business change
   * runs in its own transaction and the outcome is recorded after.
   */
  async process(messageId: string): Promise<HmisMessageStatus> {
    const claimed: { id: string }[] = await this.ds.query(
      `UPDATE hmis_message SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
        WHERE id = $1 AND direction = 'IN' AND status = 'PENDING' RETURNING id`,
      [messageId],
    );
    if (!claimed.length) return (await this.hmis.message(messageId)).status;
    const msg = await this.hmis.message(messageId);
    const conn = await this.hmis.connection();
    try {
      if (!conn) throw new HmisUnavailableError('No HMIS connection is configured');
      const outcome = await this.ds.transaction((m) => this.apply(m, msg, this.parse(msg, conn.hospitalNoSystem)));
      await this.ds.getRepository(HmisMessage).update(msg.id, { status: HmisMessageStatus.PROCESSED, processedAt: new Date(), error: null, ...outcome });
      return HmisMessageStatus.PROCESSED;
    } catch (e) {
      const err = e as Error;
      if (err instanceof InboundIgnored) {
        await this.ds.getRepository(HmisMessage).update(msg.id, { status: HmisMessageStatus.IGNORED, processedAt: new Date(), error: err.message.slice(0, 1000) });
        return HmisMessageStatus.IGNORED;
      }
      if (err instanceof HmisUnavailableError) {
        const max = await this.settings.get('hmis.maxAttempts');
        if (msg.attempts + 1 < max) {
          await this.ds.getRepository(HmisMessage).update(msg.id, { error: `Waiting for the HMIS: ${err.message}`.slice(0, 1000), nextAttemptAt: await this.hmis.backoff(this.ds.manager, msg.attempts + 1) });
          return HmisMessageStatus.PENDING;
        }
      }
      const text = err instanceof HttpException ? this.httpMessage(err) : err.message;
      if (!(err instanceof InboundRejected) && !(err instanceof HttpException) && !(err instanceof HmisUnavailableError)) this.log.error(`inbound ${msg.id} failed: ${err.stack ?? err.message}`);
      await this.ds.getRepository(HmisMessage).update(msg.id, { status: HmisMessageStatus.FAILED, processedAt: new Date(), error: text.slice(0, 1000) });
      return HmisMessageStatus.FAILED;
    }
  }

  private httpMessage(e: HttpException): string {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const m = (r as { message?: unknown }).message;
    return Array.isArray(m) ? m.join('; ') : String(m ?? e.message);
  }

  private async apply(m: EntityManager, msg: HmisMessage, item: InboundItem): Promise<Outcome> {
    if ('error' in item && item.error) throw new InboundRejected(item.error);
    switch (item.type) {
      case HmisMessageType.PATIENT: {
        const p = await this.hmis.upsertPatient(m, item.data as PatientInfo, (item as { allergies?: string[] }).allergies);
        return { localDocType: 'PATIENT', localDocId: p.id, localDocNo: p.hospitalNo, patientId: p.id };
      }
      case HmisMessageType.ENCOUNTER: {
        const info = item.data as EncounterInfo;
        const { patient } = await this.hmis.ensurePatient(m, info.patientExternalId, null);
        const e = await this.hmis.upsertEncounter(m, info, patient.id);
        return { localDocType: 'ENCOUNTER', localDocId: e.id, localDocNo: e.externalId, patientId: patient.id, encounterId: e.id };
      }
      case HmisMessageType.ALLERGY: {
        const a = item.data as AllergyInfo;
        const p = await this.hmis.applyAllergy(m, a.patientExternalId, a.substance, a.active);
        if (!p) throw new InboundIgnored('Patient not cached yet; allergies are read with the patient');
        return { localDocType: 'PATIENT', localDocId: p.id, localDocNo: p.hospitalNo, patientId: p.id };
      }
      case HmisMessageType.MEDICATION_REQUEST:
        return this.applyOrder(m, item.data as MedicationOrder);
      default:
        throw new InboundIgnored(`${msg.type} messages are not read`);
    }
  }

  private async applyOrder(m: EntityManager, o: MedicationOrder): Promise<Outcome> {
    const existing = await m.findOneBy(PrescriptionLine, { externalRef: o.externalId });
    if (STOPPED.has(o.status)) {
      if (!existing) throw new InboundIgnored(`Order ${o.externalId} is ${o.status} and was never received`);
      await this.pharmacy.cancelOrderLineInTx(m, o.externalId, `${o.status} in the HMIS`);
      const rx = await m.findOneByOrFail(Prescription, { id: existing.prescriptionId });
      return { localDocType: 'PRESCRIPTION', localDocId: rx.id, localDocNo: rx.number, patientId: rx.patientId, encounterId: rx.encounterId };
    }
    if (o.status !== 'active') throw new InboundIgnored(`Order is ${o.status}; only active orders are dispensed`);
    if (existing) {
      const rx = await m.findOneByOrFail(Prescription, { id: existing.prescriptionId });
      throw new InboundIgnored(`Already received as ${rx.number}; changes to an order after receipt are not applied (stop it and write a new one)`);
    }

    const { patient, encounter } = await this.hmis.ensurePatient(m, o.patientExternalId, o.encounterExternalId);
    if (o.encounterExternalId && !encounter) throw new InboundRejected(`Encounter ${o.encounterExternalId} was not found in the HMIS`);

    // Drug: a mapped code (generic or brand), else an item whose code or GTIN is the HMIS code.
    let genericId: string | null = null;
    let preferredItemId: string | null = null;
    let usedCode: string | null = null;
    for (const c of o.drugCodes) {
      const map = await this.hmis.resolve(m, HmisMappingKind.DRUG, c.code);
      if (map) {
        usedCode = c.code;
        if (map.isItem) {
          const [it] = await m.query(`SELECT id, generic_id FROM item WHERE id = $1`, [map.localId]);
          genericId = it?.generic_id ?? null;
          preferredItemId = it?.id ?? null;
        } else genericId = map.localId;
        break;
      }
      const [it] = await m.query(`SELECT id, generic_id FROM item WHERE (code = $1 OR gtin = $1) AND is_active AND generic_id IS NOT NULL LIMIT 1`, [c.code]);
      if (it) {
        usedCode = c.code;
        genericId = it.generic_id;
        preferredItemId = it.id;
        break;
      }
    }
    if (!genericId) {
      const first = o.drugCodes[0];
      throw new InboundRejected(`Unmapped drug code ${first?.code ?? '(none)'} (${first?.display ?? o.drugText ?? 'no name'})`);
    }

    // Outlet: the mapped dispensing location, else the default for the encounter class.
    let storeId: string | null = (await this.hmis.resolve(m, HmisMappingKind.LOCATION, o.locationCode))?.localId ?? null;
    if (!storeId) {
      const defaults = await this.settings.get('hmis.defaultOutlets', m);
      const code = defaults[encounter?.class ?? 'OPD'];
      const [st] = code ? await m.query(`SELECT id FROM store WHERE code = $1 AND is_active`, [code]) : [];
      storeId = st?.id ?? null;
      if (!storeId) throw new InboundRejected(`No pharmacy for location ${o.locationCode ?? '(none)'} — map the location or set hmis.defaultOutlets`);
    }

    const daily = o.supplyMode !== SupplyMode.STANDARD;
    if (daily && !o.dailyQuantity) throw new InboundRejected('A daily / unit-dose order needs a daily quantity (count dose units, or the daily-quantity extension)');
    const quantity = o.quantity;
    if (!quantity || quantity <= 0) throw new InboundRejected('The order has no quantity to supply (dispenseRequest.quantity, or a countable dose with a duration)');

    const line = {
      genericId,
      preferredItemId: preferredItemId ?? undefined,
      dose: o.dose,
      frequency: o.frequency,
      duration: o.duration ?? undefined,
      route: o.route ?? undefined,
      quantity,
      dailyQuantity: o.dailyQuantity ?? undefined,
      instructions: o.instructions ?? undefined,
    };
    const meta = { externalRef: o.externalId, hmisDrugCode: usedCode };

    // Orders written together (same group) share a prescription while it is open.
    const group = await m.findOneBy(Prescription, { externalRef: o.groupId });
    let rxId: string;
    if (group && OPEN.includes(group.status) && group.storeId === storeId && group.supplyMode === o.supplyMode) {
      await this.pharmacy.addLinesInTx(m, group.id, [line], [meta]);
      rxId = group.id;
    } else {
      rxId = await this.pharmacy.createInTx(
        m,
        {
          patientId: patient.id,
          storeId,
          prescriber: o.prescriber,
          prescriberRegNo: o.prescriberRegNo ?? undefined,
          encounterId: encounter?.id,
          externalRef: group ? `${o.groupId}/${o.externalId}` : o.groupId,
          supplyMode: o.supplyMode,
          notes: 'Received from the HMIS',
          lines: [line],
        },
        [meta],
      );
    }
    const rx = await m.findOneByOrFail(Prescription, { id: rxId });
    return { localDocType: 'PRESCRIPTION', localDocId: rx.id, localDocNo: rx.number, patientId: patient.id, encounterId: encounter?.id ?? null };
  }
}

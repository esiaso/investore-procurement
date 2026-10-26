import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  EncounterStatus,
  HmisAdapterKind,
  HmisBillingMode,
  HmisDirection,
  HmisMappingKind,
  HmisMessageStatus,
  HmisMessageType,
  NotificationCategory,
  Paginated,
  PatientChargeStatus,
  Permissions,
} from '@sil/shared';
import { decryptField, encryptField } from '../../common/crypto';
import { likeTerm } from '../../common/pagination';
import { loadEnv } from '../../config/env';
import { NotificationsService } from '../approvals/notifications.service';
import { JobsService } from '../jobs/jobs.service';
import { Patient } from '../pharmacy/pharmacy.entities';
import { SettingsService } from '../settings/settings.service';
import type { ChargeOut, DispenseOut, EncounterInfo, PatientInfo } from './fhir';
import { createHmisAdapter, HmisAdapter, InboundItem, OutboundRequest } from './hmis-adapter';
import { ConnectionDto, MappingDto, MessageQueryDto } from './hmis.dto';
import { Encounter, HmisCodeMapping, HmisConnection, HmisMessage, PatientCharge } from './hmis.entities';

const CONNECTION_CODE = 'HMIS';

/** Inbound processing lives with the pharmacy (orders become prescriptions); it registers here. */
export type InboundProcessor = (messageId: string) => Promise<HmisMessageStatus>;

/**
 * The HMIS link: one connection (FHIR R4, generic REST or the mock), code
 * mappings, patients and encounters cached from the HMIS (the HMIS stays the
 * master), the log of every message in and out, and the outbound outbox
 * (dispense records and patient charges) with retries.
 */
@Injectable()
export class HmisService implements OnModuleInit {
  private readonly log = new Logger('HMIS');
  private inbound: InboundProcessor | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.jobs.register('hmis.dispatch', 'Send dispense records and charges to the HMIS; retry inbound messages waiting on the HMIS', () => this.dispatch());
    this.jobs.register('hmis.monitor', 'Alert integration admins about HMIS messages failed or unsent', () => this.monitor());
  }

  setInboundProcessor(fn: InboundProcessor) {
    this.inbound = fn;
  }

  // ------------------------------------------------------------------ connection

  /** The active connection, or null when no HMIS is linked. */
  async connection(m: EntityManager = this.ds.manager): Promise<HmisConnection | null> {
    return m.findOneBy(HmisConnection, { code: CONNECTION_CODE, isActive: true });
  }

  async getConnection() {
    const c = await this.ds.getRepository(HmisConnection).createQueryBuilder('c').addSelect('c.authTokenEnc').where('c.code = :code', { code: CONNECTION_CODE }).getOne();
    if (!c) return null;
    const { authTokenEnc, ...rest } = c;
    return { ...rest, hasToken: !!authTokenEnc };
  }

  async saveConnection(dto: ConnectionDto) {
    if (dto.adapter !== HmisAdapterKind.MOCK && !dto.baseUrl) throw new BadRequestException(`${dto.adapter} needs the HMIS base URL`);
    if (dto.baseUrl && !/^https?:\/\//.test(dto.baseUrl)) throw new BadRequestException('The base URL must start with http:// or https://');
    const repo = this.ds.getRepository(HmisConnection);
    const row = (await repo.findOneBy({ code: CONNECTION_CODE })) ?? repo.create({ code: CONNECTION_CODE });
    Object.assign(row, {
      name: dto.name,
      adapter: dto.adapter,
      baseUrl: dto.baseUrl?.trim() || null,
      authHeader: dto.authHeader?.trim() || 'Authorization',
      hospitalNoSystem: dto.hospitalNoSystem?.trim() || 'urn:sil:hospital-no',
      billingMode: dto.billingMode,
      sendDispenses: dto.sendDispenses ?? true,
      pollOrders: dto.pollOrders ?? true,
      isActive: dto.isActive ?? true,
    });
    if (dto.authToken !== undefined) row.authTokenEnc = dto.authToken ? encryptField(loadEnv().dataEncryptionKey, dto.authToken) : null;
    await repo.save(row);
    return this.getConnection();
  }

  /** Adapter for the active connection (token decrypted only here). */
  async adapter(m: EntityManager = this.ds.manager): Promise<{ adapter: HmisAdapter; connection: HmisConnection; timeoutMs: number }> {
    const c = await m.getRepository(HmisConnection).createQueryBuilder('c').addSelect('c.authTokenEnc').where('c.code = :code AND c.is_active', { code: CONNECTION_CODE }).getOne();
    if (!c) throw new ConflictException({ code: 'HMIS_NOT_CONFIGURED', message: 'No HMIS connection is configured' });
    const token = c.authTokenEnc ? decryptField(loadEnv().dataEncryptionKey, c.authTokenEnc) : null;
    return { adapter: createHmisAdapter({ adapter: c.adapter, baseUrl: c.baseUrl, token, authHeader: c.authHeader, hospitalNoSystem: c.hospitalNoSystem }), connection: c, timeoutMs: await this.settings.get('hmis.requestTimeoutMs', m) };
  }

  async test() {
    const { adapter, timeoutMs } = await this.adapter();
    const started = Date.now();
    const r = await adapter.ping(timeoutMs);
    return { ...r, adapter: adapter.kind, ms: Date.now() - started };
  }

  /** Who bills charges for HMIS encounters: LOCAL when no HMIS is linked. */
  async billingMode(m: EntityManager = this.ds.manager): Promise<HmisBillingMode> {
    return (await this.connection(m))?.billingMode ?? HmisBillingMode.LOCAL;
  }

  // ------------------------------------------------------------------ mappings

  mappings(kind?: HmisMappingKind) {
    return this.ds.query(
      `SELECT mp.id, mp.kind, mp.external_code AS "externalCode", mp.external_display AS "externalDisplay", mp.local_id AS "localId", mp.is_item AS "isItem",
              COALESCE(i.name, g.inn_name || COALESCE(' ' || NULLIF(g.strength, ''), ''), s.name, d.name, p.name) AS "localName",
              COALESCE(i.code, s.code, d.code, p.code) AS "localCode"
         FROM hmis_code_mapping mp
         LEFT JOIN item i ON mp.kind = 'DRUG' AND mp.is_item AND i.id = mp.local_id
         LEFT JOIN generic g ON mp.kind = 'DRUG' AND NOT mp.is_item AND g.id = mp.local_id
         LEFT JOIN store s ON mp.kind = 'LOCATION' AND s.id = mp.local_id
         LEFT JOIN department d ON mp.kind = 'WARD' AND d.id = mp.local_id
         LEFT JOIN payer p ON mp.kind = 'PAYER' AND p.id = mp.local_id
        WHERE ($1::text IS NULL OR mp.kind::text = $1) ORDER BY mp.kind, mp.external_code`,
      [kind ?? null],
    );
  }

  async saveMapping(dto: MappingDto) {
    const code = dto.externalCode.trim();
    const table = { DRUG: dto.isItem ? 'item' : 'generic', LOCATION: 'store', WARD: 'department', PAYER: 'payer' }[dto.kind];
    const [hit] = await this.ds.query(`SELECT id FROM "${table}" WHERE id = $1`, [dto.localId]);
    if (!hit) throw new BadRequestException(`No ${table} with that id`);
    const repo = this.ds.getRepository(HmisCodeMapping);
    const row = (await repo.findOneBy({ kind: dto.kind, externalCode: code })) ?? repo.create({ kind: dto.kind, externalCode: code });
    Object.assign(row, { externalDisplay: dto.externalDisplay ?? row.externalDisplay ?? null, localId: dto.localId, isItem: dto.kind === HmisMappingKind.DRUG && !!dto.isItem });
    return repo.save(row);
  }

  async deleteMapping(id: string) {
    const r = await this.ds.getRepository(HmisCodeMapping).delete({ id });
    if (!r.affected) throw new NotFoundException('Mapping not found');
  }

  async resolve(m: EntityManager, kind: HmisMappingKind, code: string | null | undefined): Promise<HmisCodeMapping | null> {
    if (!code) return null;
    return m.findOneBy(HmisCodeMapping, { kind, externalCode: code });
  }

  // ------------------------------------------------------------------ patients and encounters

  /** Creates or refreshes the cached patient (matched on HMIS id, else hospital number). */
  async upsertPatient(m: EntityManager, info: PatientInfo, allergies?: string[]): Promise<Patient> {
    let p = (await m.findOneBy(Patient, { externalId: info.externalId })) ?? (await m.findOneBy(Patient, { hospitalNo: info.hospitalNo }));
    if (p?.externalId && p.externalId !== info.externalId) {
      throw new ConflictException(`Hospital number ${info.hospitalNo} already belongs to HMIS patient ${p.externalId}`);
    }
    const payer = info.payerCode ? await this.resolve(m, HmisMappingKind.PAYER, info.payerCode) : null;
    p ??= m.create(Patient, { allergies: [] });
    Object.assign(p, {
      externalId: info.externalId,
      hospitalNo: info.hospitalNo,
      name: info.name,
      dateOfBirth: info.dateOfBirth,
      sex: info.sex,
      weightKg: info.weightKg ?? p.weightKg ?? null,
      isPregnant: info.isPregnant,
      payerId: info.payerCode ? (payer?.localId ?? p.payerId ?? null) : (p.payerId ?? null),
      memberNo: info.memberNo ?? p.memberNo ?? null,
      phone: info.phone ?? p.phone ?? null,
      syncedAt: new Date(),
    });
    if (allergies) p.allergies = [...new Set(allergies.map((a) => a.trim().toLowerCase()).filter(Boolean))];
    return m.save(p);
  }

  /** Allergy list is replaced by what the HMIS holds (inbound AllergyIntolerance updates one entry). */
  async applyAllergy(m: EntityManager, patientExternalId: string, substance: string, active: boolean): Promise<Patient | null> {
    const p = await m.findOneBy(Patient, { externalId: patientExternalId });
    if (!p) return null;
    const set = new Set(p.allergies);
    if (active) set.add(substance);
    else set.delete(substance);
    p.allergies = [...set];
    return m.save(p);
  }

  async upsertEncounter(m: EntityManager, info: EncounterInfo, patientId: string): Promise<Encounter> {
    const repo = m.getRepository(Encounter);
    const e = (await repo.findOneBy({ externalId: info.externalId })) ?? repo.create({ externalId: info.externalId });
    const ward = await this.resolve(m, HmisMappingKind.WARD, info.wardCode);
    const payer = await this.resolve(m, HmisMappingKind.PAYER, info.payerCode);
    Object.assign(e, {
      patientId,
      class: info.class,
      status: info.status,
      wardCode: info.wardCode,
      departmentId: ward?.localId ?? null,
      bed: info.bed,
      payerId: payer?.localId ?? null,
      memberNo: info.memberNo,
      attending: info.attending,
      startedAt: info.startedAt ? new Date(info.startedAt) : null,
      endedAt: info.endedAt ? new Date(info.endedAt) : null,
      syncedAt: new Date(),
    });
    return repo.save(e);
  }

  /**
   * Makes sure the patient (and encounter) are cached and fresh, reading them
   * from the HMIS when missing or older than hmis.patientRefreshHours.
   * Throws HmisUnavailableError when the HMIS cannot be read.
   */
  async ensurePatient(m: EntityManager, patientExternalId: string, encounterExternalId: string | null): Promise<{ patient: Patient; encounter: Encounter | null }> {
    let patient = await m.findOneBy(Patient, { externalId: patientExternalId });
    const hours = await this.settings.get('hmis.patientRefreshHours', m);
    const stale = !patient?.syncedAt || Date.now() - patient.syncedAt.getTime() > hours * 3_600_000;
    let encounter = encounterExternalId ? await m.findOneBy(Encounter, { externalId: encounterExternalId }) : null;
    if (stale || (encounterExternalId && !encounter)) {
      const { adapter, timeoutMs } = await this.adapter(m);
      if (stale) {
        const items = await adapter.fetchPatient(patientExternalId, timeoutMs);
        const pi = items.find((i) => i.type === HmisMessageType.PATIENT && 'data' in i && i.data);
        if (!pi || !pi.data) {
          if (!patient) throw new BadRequestException(`Patient ${patientExternalId} was not found in the HMIS`);
        } else {
          const allergies = items.flatMap((i) => (i.type === HmisMessageType.ALLERGY && i.data && i.data.active ? [i.data.substance] : []));
          patient = await this.upsertPatient(m, pi.data as PatientInfo, (pi as { allergies?: string[] }).allergies ?? allergies);
        }
      }
      if (encounterExternalId && !encounter) {
        const items = await adapter.fetchEncounter(encounterExternalId, timeoutMs);
        const ei = items.find((i) => i.type === HmisMessageType.ENCOUNTER && i.data);
        if (ei?.data) encounter = await this.upsertEncounter(m, ei.data as EncounterInfo, patient!.id);
      }
    }
    return { patient: patient!, encounter };
  }

  encounters(q: { patientId?: string; departmentId?: string; status?: EncounterStatus; search?: string; page?: number; pageSize?: number }): Promise<Paginated<Encounter>> {
    const qb = this.ds
      .getRepository(Encounter)
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.patient', 'patient')
      .leftJoinAndSelect('e.department', 'department')
      .leftJoinAndSelect('e.payer', 'payer')
      .orderBy('e.startedAt', 'DESC', 'NULLS LAST');
    if (q.patientId) qb.andWhere('e.patient_id = :p', { p: q.patientId });
    if (q.departmentId) qb.andWhere('e.department_id = :d', { d: q.departmentId });
    if (q.status) qb.andWhere('e.status = :s', { s: q.status });
    if (q.search) qb.andWhere('(patient.name ILIKE :q OR patient.hospital_no ILIKE :q OR e.external_id ILIKE :q OR e.bed ILIKE :q)', { q: likeTerm(q.search) });
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    return qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount()
      .then(([items, total]) => ({ items, total, page, pageSize }));
  }

  async encounter(id: string) {
    const e = await this.ds.getRepository(Encounter).findOne({ where: { id }, relations: { patient: { payer: true }, department: true, payer: true } });
    if (!e) throw new NotFoundException('Encounter not found');
    const charges = await this.ds.getRepository(PatientCharge).find({ where: { encounterId: id }, relations: { item: true, store: true }, order: { createdAt: 'ASC' } });
    const prescriptions = await this.ds.query(
      `SELECT rx.id, rx.number, rx.status, rx.supply_mode AS "supplyMode", rx.received_at AS "receivedAt", s.name AS store
         FROM prescription rx JOIN store s ON s.id = rx.store_id WHERE rx.encounter_id = $1 ORDER BY rx.received_at DESC`,
      [id],
    );
    const total = Math.round(charges.reduce((s, c) => s + c.amount, 0) * 100) / 100;
    return { ...e, charges, prescriptions, totals: { charged: total, pendingToHmis: charges.filter((c) => c.status === PatientChargeStatus.PENDING || c.status === PatientChargeStatus.FAILED).length } };
  }

  // ------------------------------------------------------------------ message log

  /**
   * Records an inbound item once per version. A repeat of the same version
   * only counts a duplicate (except repeats from polling, which are expected).
   */
  async logInbound(item: InboundItem, via: string, m: EntityManager = this.ds.manager): Promise<{ message: HmisMessage; duplicate: boolean }> {
    const existing = await m.findOneBy(HmisMessage, { idempotencyKey: item.key });
    if (existing) {
      if (via !== 'POLL') await m.increment(HmisMessage, { id: existing.id }, 'duplicates', 1);
      return { message: existing, duplicate: true };
    }
    const error = 'error' in item ? item.error : null;
    const message = await m.save(
      m.create(HmisMessage, {
        direction: HmisDirection.IN,
        type: item.type,
        status: error ? HmisMessageStatus.FAILED : HmisMessageStatus.PENDING,
        idempotencyKey: item.key,
        externalId: item.externalId,
        via,
        payload: item.raw,
        error,
        processedAt: error ? new Date() : null,
      }),
    );
    return { message, duplicate: false };
  }

  /** Queues an outbound message in the caller's transaction (idempotent by key). */
  async enqueue(
    m: EntityManager,
    e: { type: HmisMessageType.MEDICATION_DISPENSE | HmisMessageType.CHARGE; key: string; payload: DispenseOut | ChargeOut; docType: string; docId: string; docNo: string | null; patientId: string; encounterId: string | null; externalId?: string | null },
  ): Promise<HmisMessage> {
    const existing = await m.findOneBy(HmisMessage, { idempotencyKey: e.key });
    if (existing) return existing;
    return m.save(
      m.create(HmisMessage, {
        direction: HmisDirection.OUT,
        type: e.type,
        status: HmisMessageStatus.PENDING,
        idempotencyKey: e.key,
        externalId: e.externalId ?? null,
        localDocType: e.docType,
        localDocId: e.docId,
        localDocNo: e.docNo,
        patientId: e.patientId,
        encounterId: e.encounterId,
        payload: e.payload as unknown as Record<string, unknown>,
      }),
    );
  }

  async messages(q: MessageQueryDto): Promise<Paginated<HmisMessage>> {
    const qb = this.ds.getRepository(HmisMessage).createQueryBuilder('msg').orderBy('msg.createdAt', 'DESC');
    if (q.direction) qb.andWhere('msg.direction = :d', { d: q.direction });
    if (q.type) qb.andWhere('msg.type = :t', { t: q.type });
    if (q.status) qb.andWhere('msg.status = :s', { s: q.status });
    if (q.patientId) qb.andWhere('msg.patient_id = :p', { p: q.patientId });
    if (q.from) qb.andWhere('msg.created_at >= :from::date', { from: q.from });
    if (q.to) qb.andWhere(`msg.created_at < :to::date + 1`, { to: q.to });
    if (q.search) qb.andWhere('(msg.external_id ILIKE :q OR msg.local_doc_no ILIKE :q OR msg.error ILIKE :q OR msg.idempotency_key ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb
      .skip((q.page - 1) * q.pageSize)
      .take(q.pageSize)
      .getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async message(id: string) {
    const msg = await this.ds.getRepository(HmisMessage).findOneBy({ id });
    if (!msg) throw new NotFoundException('Message not found');
    return msg;
  }

  /** Integration dashboard: health, queue, failures and throughput. */
  async dashboard() {
    const connection = await this.getConnection();
    const [counts, failed, oldest, today] = await Promise.all([
      this.ds.query(`SELECT direction, status, count(*)::int AS n FROM hmis_message GROUP BY direction, status ORDER BY direction, status`),
      this.ds.query(
        `SELECT id, direction, type, status, external_id AS "externalId", local_doc_no AS "localDocNo", error, attempts, created_at AS "createdAt"
           FROM hmis_message WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 50`,
      ),
      this.ds.query(`SELECT min(created_at) AS at, count(*)::int AS n FROM hmis_message WHERE status = 'PENDING'`),
      this.ds.query(
        `SELECT direction, type, count(*)::int AS n, sum(duplicates)::int AS duplicates FROM hmis_message WHERE created_at >= now() - interval '24 hours' GROUP BY direction, type ORDER BY direction, type`,
      ),
    ]);
    const unmapped = await this.ds.query(
      `SELECT DISTINCT ON (code) code, display, count(*) OVER (PARTITION BY code)::int AS messages FROM (
         SELECT substring(error FROM 'Unmapped drug code ([^ ]+)') AS code, substring(error FROM '\\((.*)\\)$') AS display
           FROM hmis_message WHERE status = 'FAILED' AND error LIKE 'Unmapped drug code %') x
        WHERE code IS NOT NULL ORDER BY code`,
    );
    return {
      connection,
      counts,
      failed,
      pending: { count: oldest[0].n, oldestAt: oldest[0].at },
      last24h: today,
      unmappedDrugs: unmapped,
    };
  }

  // ------------------------------------------------------------------ outbound

  /** Sends due outbound messages and retries inbound ones that were waiting on the HMIS (job hmis.dispatch). */
  async dispatch(limit = 100): Promise<{ sent: number; failed: number; retry: number; inbound: number }> {
    const totals = { sent: 0, failed: 0, retry: 0, inbound: 0 };
    if (!(await this.connection())) return totals;
    const due: { id: string; direction: HmisDirection }[] = await this.ds.query(
      `SELECT id, direction FROM hmis_message WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
      [limit],
    );
    for (const d of due) {
      if (d.direction === HmisDirection.IN) {
        if (this.inbound) {
          await this.inbound(d.id);
          totals.inbound++;
        }
        continue;
      }
      const r = await this.sendOne(d.id);
      if (r === 'SENT') totals.sent++;
      else if (r === 'FAILED') totals.failed++;
      else if (r === 'RETRY') totals.retry++;
    }
    return totals;
  }

  /** Back-off for the next attempt: base × 2^(attempts−1), capped at 1 h. */
  async backoff(m: EntityManager, attempts: number): Promise<Date> {
    const base = await this.settings.get('hmis.retryBaseSeconds', m);
    return new Date(Date.now() + Math.min(base * 2 ** Math.max(attempts - 1, 0), 3600) * 1000);
  }

  /**
   * Sends one outbound message (row locked, SKIP LOCKED). A charge that
   * reverses another waits until the original has its HMIS id.
   */
  async sendOne(id: string): Promise<'SENT' | 'FAILED' | 'RETRY' | 'WAITING' | 'SKIPPED'> {
    return this.ds.transaction(async (m) => {
      const [row] = await m.query(`SELECT id FROM hmis_message WHERE id = $1 AND status = 'PENDING' AND direction = 'OUT' FOR UPDATE SKIP LOCKED`, [id]);
      if (!row) return 'SKIPPED';
      const msg = await m.findOneByOrFail(HmisMessage, { id });
      const payload = msg.payload as unknown as DispenseOut & ChargeOut & { reversesChargeId?: string | null };
      if (msg.type === HmisMessageType.CHARGE && payload.reversesChargeId && !payload.reversesExternalId) {
        const orig = await m.findOneBy(PatientCharge, { id: payload.reversesChargeId });
        if (!orig?.externalId) {
          msg.error = 'Waiting for the original charge to be posted';
          msg.nextAttemptAt = new Date(Date.now() + 30_000);
          await m.save(msg);
          return 'WAITING';
        }
        payload.reversesExternalId = orig.externalId;
        msg.payload = payload as unknown as Record<string, unknown>;
      }
      // Updating a dispense record already in the HMIS: use its id.
      let externalId = msg.externalId;
      if (msg.type === HmisMessageType.MEDICATION_DISPENSE && !externalId && msg.idempotencyKey.includes('#')) {
        const first: { external_id: string | null; status: string }[] = await m.query(
          `SELECT external_id, status FROM hmis_message WHERE idempotency_key = $1`,
          [msg.idempotencyKey.split('#')[0]],
        );
        if (first[0] && !first[0].external_id) {
          msg.error = 'Waiting for the original dispense record to be sent';
          msg.nextAttemptAt = new Date(Date.now() + 30_000);
          await m.save(msg);
          return 'WAITING';
        }
        externalId = first[0]?.external_id ?? null;
      }
      const { adapter, timeoutMs } = await this.adapter(m);
      const req: OutboundRequest = { type: msg.type as OutboundRequest['type'], payload, externalId };
      const res = await adapter.send(req, timeoutMs);
      msg.attempts++;
      msg.request = res.request;
      msg.response = res.response;
      msg.httpStatus = res.status;
      msg.error = res.error?.slice(0, 1000) ?? null;
      if (res.ok) {
        Object.assign(msg, { status: HmisMessageStatus.SENT, externalId: res.externalId ?? externalId, processedAt: new Date(), error: null });
        await m.save(msg);
        if (msg.type === HmisMessageType.CHARGE) await m.update(PatientCharge, { messageId: msg.id }, { status: PatientChargeStatus.POSTED, externalId: msg.externalId });
        return 'SENT';
      }
      const max = await this.settings.get('hmis.maxAttempts', m);
      if (res.retryable && msg.attempts < max) {
        msg.nextAttemptAt = await this.backoff(m, msg.attempts);
        await m.save(msg);
        return 'RETRY';
      }
      Object.assign(msg, { status: HmisMessageStatus.FAILED, processedAt: new Date() });
      await m.save(msg);
      if (msg.type === HmisMessageType.CHARGE) await m.update(PatientCharge, { messageId: msg.id }, { status: PatientChargeStatus.FAILED });
      return 'FAILED';
    });
  }

  /** After a dispense or charge: try to deliver now; whatever is left goes to the worker. */
  async trySendNow(ids: string[]): Promise<void> {
    for (const id of ids) await this.sendOne(id).catch((e) => this.log.warn(`HMIS send failed: ${(e as Error).message}`));
    if (ids.length) await this.jobs.enqueue('hmis.dispatch', {}, { trigger: 'event', dedupeKey: 'now' }).catch(() => undefined);
  }

  /** Puts a failed message back in the queue (outbound: resend; inbound: process again, e.g. after mapping a code). */
  async reprocess(id: string) {
    const msg = await this.ds.transaction(async (m) => {
      const row = await m.findOne(HmisMessage, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('Message not found');
      if (row.status === HmisMessageStatus.SENT || row.status === HmisMessageStatus.PROCESSED) throw new ConflictException(`Already ${row.status.toLowerCase()}`);
      Object.assign(row, { status: HmisMessageStatus.PENDING, nextAttemptAt: new Date(), attempts: row.direction === HmisDirection.OUT ? 0 : row.attempts, alertedAt: null });
      await m.save(row);
      if (row.type === HmisMessageType.CHARGE) await m.update(PatientCharge, { messageId: row.id }, { status: PatientChargeStatus.PENDING });
      return row;
    });
    if (msg.direction === HmisDirection.OUT) await this.sendOne(id);
    else if (this.inbound) await this.inbound(id);
    return this.message(id);
  }

  /** Alerts users with hmis.manage once per message failed or unsent after hmis.alertAfterMinutes. */
  async monitor(): Promise<{ overdue: number; alerted: number }> {
    const minutes = await this.settings.get('hmis.alertAfterMinutes');
    const overdue: { id: string; direction: string; type: string; status: string; local_doc_no: string | null; external_id: string | null; error: string | null }[] = await this.ds.query(
      `SELECT id, direction, type, status, local_doc_no, external_id, error FROM hmis_message
        WHERE status IN ('PENDING', 'FAILED') AND alerted_at IS NULL AND created_at < now() - ($1 || ' minutes')::interval
        ORDER BY created_at LIMIT 200`,
      [String(minutes)],
    );
    if (!overdue.length) return { overdue: 0, alerted: 0 };
    const users: { id: string }[] = await this.ds.query(
      `SELECT DISTINCT ur.user_id AS id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
         JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
      [Permissions.HMIS_MANAGE],
    );
    const lines = overdue.map((o) => `• ${o.direction} ${o.type} ${o.local_doc_no ?? o.external_id ?? ''} — ${o.status}${o.error ? `: ${o.error}` : ''}`);
    const reached = await this.notifications.dispatch(this.ds.manager, users.map((u) => u.id), NotificationCategory.HMIS, {
      title: `HMIS: ${overdue.length} message(s) failed or unsent after ${minutes} minutes`,
      body: lines.slice(0, 5).join('\n'),
      link: '/hmis',
      emailText: `These HMIS messages need attention:\n\n${lines.join('\n')}`,
    });
    await this.ds.query(`UPDATE hmis_message SET alerted_at = now() WHERE id = ANY($1::uuid[])`, [overdue.map((o) => o.id)]);
    return { overdue: overdue.length, alerted: reached };
  }

  /** Outbound messages of local documents (prescription screen, encounter screen). */
  outboundFor(docIds: string[]) {
    if (!docIds.length) return Promise.resolve([] as HmisMessage[]);
    return this.ds.getRepository(HmisMessage).find({ where: { localDocId: In(docIds) }, order: { createdAt: 'ASC' } });
  }
}

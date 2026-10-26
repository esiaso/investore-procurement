import { createHash } from 'node:crypto';
import { HmisAdapterKind, HmisMessageType } from '@sil/shared';
import {
  AllergyInfo,
  ChargeOut,
  DispenseOut,
  EncounterInfo,
  FhirError,
  FhirResource,
  MedicationOrder,
  parseAllergy,
  parseEncounter,
  parseMedicationRequest,
  parsePatient,
  PatientInfo,
  resourcesOf,
  toChargeItem,
  toMedicationDispense,
  versionKey,
} from './fhir';
import { Hl7HmisAdapter, mllpTransport } from './hl7-adapter';
import { MockHmis, mockHl7Transport, sharedMockHmis } from './mock/mock-hmis';

// ------------------------------------------------------------------ transport

export interface TransportReply {
  status: number;
  body: unknown;
  /** Set when no HTTP answer came back. */
  network?: 'offline' | 'timeout';
  error?: string;
}

export type HmisTransport = (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, timeoutMs: number) => Promise<TransportReply>;

/** JSON over HTTP(S) with an optional bearer token / API key header. */
export function httpTransport(baseUrl: string, auth: { header: string; token: string | null }, contentType = 'application/json'): HmisTransport {
  const base = baseUrl.replace(/\/+$/, '');
  return async (method, path, body, timeoutMs) => {
    const headers: Record<string, string> = { accept: contentType, 'content-type': contentType };
    if (auth.token) headers[auth.header] = auth.header.toLowerCase() === 'authorization' ? `Bearer ${auth.token}` : auth.token;
    try {
      const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { text: text.slice(0, 2000) };
      }
      return { status: res.status, body: parsed };
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { status: 0, body: null, network: timedOut ? 'timeout' : 'offline', error: timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${err.message}` };
    }
  };
}

/** The in-process mock (tests, development without the mock-hmis container). */
export function mockTransport(mock: MockHmis = sharedMockHmis): HmisTransport {
  return async (method, path, body, timeoutMs) => {
    const r = mock.handle(method, path, body === undefined ? undefined : structuredClone(body));
    if (r.network) return { status: 0, body: null, network: r.network, error: r.network === 'timeout' ? `Timed out after ${timeoutMs} ms` : 'Network error: connection refused' };
    return { status: r.status, body: r.body ?? null };
  };
}

// ------------------------------------------------------------------ neutral inbound items

interface ItemBase {
  externalId: string | null;
  /** Same version of the same record → same key (idempotency). */
  key: string;
  raw: Record<string, unknown>;
}
export type InboundItem =
  | (ItemBase & { type: HmisMessageType.PATIENT; data: PatientInfo; allergies?: string[] })
  | (ItemBase & { type: HmisMessageType.ENCOUNTER; data: EncounterInfo })
  | (ItemBase & { type: HmisMessageType.ALLERGY; data: AllergyInfo })
  | (ItemBase & { type: HmisMessageType.MEDICATION_REQUEST; data: MedicationOrder })
  | (ItemBase & { type: HmisMessageType; data?: undefined; error: string });

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const FHIR_TYPE: Record<string, HmisMessageType> = {
  Patient: HmisMessageType.PATIENT,
  Encounter: HmisMessageType.ENCOUNTER,
  AllergyIntolerance: HmisMessageType.ALLERGY,
  MedicationRequest: HmisMessageType.MEDICATION_REQUEST,
};

/** FHIR resources (a Bundle or one resource) → inbound items; unsupported types are skipped. */
export function itemsFromFhir(body: FhirResource, hospitalNoSystem: string): InboundItem[] {
  const out: InboundItem[] = [];
  for (const r of resourcesOf(body)) {
    const type = FHIR_TYPE[r.resourceType];
    if (!type) continue;
    const base = { externalId: r.id ?? null, key: `FHIR:${versionKey(r, hash(r))}`, raw: r as Record<string, unknown> };
    try {
      if (type === HmisMessageType.PATIENT) out.push({ ...base, type, data: parsePatient(r, hospitalNoSystem) });
      else if (type === HmisMessageType.ENCOUNTER) out.push({ ...base, type, data: parseEncounter(r) });
      else if (type === HmisMessageType.ALLERGY) out.push({ ...base, type, data: parseAllergy(r) });
      else out.push({ ...base, type: HmisMessageType.MEDICATION_REQUEST, data: parseMedicationRequest(r) });
    } catch (e) {
      out.push({ ...base, type, error: e instanceof FhirError ? e.message : `Unreadable ${r.resourceType}: ${(e as Error).message}` });
    }
  }
  return out;
}

/** Generic REST webhook event → inbound items. The body uses the neutral field names (see HMIS_ASSUMPTIONS). */
export function itemsFromRest(event: { type?: string; data?: unknown }): InboundItem[] {
  const t = String(event.type ?? '').toLowerCase();
  const list = Array.isArray(event.data) ? event.data : [event.data];
  const type =
    t === 'patient' ? HmisMessageType.PATIENT : t === 'encounter' ? HmisMessageType.ENCOUNTER : t === 'allergy' ? HmisMessageType.ALLERGY : t === 'order' ? HmisMessageType.MEDICATION_REQUEST : null;
  if (!type) return [{ type: HmisMessageType.PATIENT, externalId: null, key: `REST:unknown/${hash(event)}`, raw: event as Record<string, unknown>, error: `Unknown event type "${event.type}"` }];
  return list.map((d) => {
    const data = (d ?? {}) as Record<string, unknown>;
    const id = typeof data.externalId === 'string' ? data.externalId : null;
    const base = { externalId: id, key: `REST:${t}/${id ?? 'no-id'}/${hash(data)}`, raw: data };
    const need = (fields: string[]) => fields.filter((f) => data[f] === undefined || data[f] === null || data[f] === '');
    const missing =
      type === HmisMessageType.PATIENT ? need(['externalId', 'hospitalNo', 'name'])
      : type === HmisMessageType.ENCOUNTER ? need(['externalId', 'patientExternalId', 'class'])
      : type === HmisMessageType.ALLERGY ? need(['patientExternalId', 'substance'])
      : need(['externalId', 'patientExternalId', 'drugCodes']);
    if (missing.length) return { ...base, type, error: `Missing ${missing.join(', ')}` };
    if (type === HmisMessageType.PATIENT) {
      return { ...base, type, data: { dateOfBirth: null, sex: null, weightKg: null, isPregnant: false, payerCode: null, memberNo: null, phone: null, active: true, ...data } as PatientInfo, allergies: (data.allergies as string[] | undefined) ?? undefined };
    }
    if (type === HmisMessageType.ENCOUNTER) return { ...base, type, data: { status: 'ACTIVE', wardCode: null, bed: null, payerCode: null, memberNo: null, attending: null, startedAt: null, endedAt: null, ...data } as EncounterInfo };
    if (type === HmisMessageType.ALLERGY) return { ...base, type, data: { externalId: id, active: true, ...data, substance: String(data.substance).toLowerCase() } as AllergyInfo };
    return {
      ...base,
      type: HmisMessageType.MEDICATION_REQUEST,
      data: {
        groupId: id,
        status: 'active',
        encounterExternalId: null,
        prescriber: 'HMIS prescriber',
        prescriberRegNo: null,
        authoredOn: null,
        drugText: null,
        dose: 'As directed',
        frequency: 'As directed',
        duration: null,
        route: null,
        quantity: null,
        dailyQuantity: null,
        supplyMode: 'STANDARD',
        locationCode: null,
        instructions: null,
        ...data,
        drugCodes: (data.drugCodes as unknown[]).map((c) => (typeof c === 'string' ? { system: null, code: c, display: null } : c)),
      } as MedicationOrder,
    };
  });
}

// ------------------------------------------------------------------ adapters

export interface SendResult {
  ok: boolean;
  /** Worth retrying later (network, timeout, 5xx, 408/429). */
  retryable: boolean;
  status: number | null;
  /** HMIS id of the created / updated record. */
  externalId: string | null;
  error: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
}

export interface OutboundRequest {
  type: HmisMessageType.MEDICATION_DISPENSE | HmisMessageType.CHARGE;
  payload: DispenseOut | ChargeOut;
  /** HMIS id when updating a record already sent. */
  externalId?: string | null;
}

/** One HMIS. Implementations differ in protocol only; everything above works on neutral records. */
export interface HmisAdapter {
  readonly kind: HmisAdapterKind;
  /** The HMIS can be queried (patients, visits, orders); false for HL7 v2, where the HMIS pushes. */
  readonly canRead: boolean;
  /** A cheap call that proves the HMIS answers (FHIR: /metadata). */
  ping(timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  searchPatients(query: string, timeoutMs: number): Promise<InboundItem[]>;
  /** The patient with allergies, and (when given) the encounter. */
  fetchPatient(externalId: string, timeoutMs: number): Promise<InboundItem[]>;
  fetchEncounter(externalId: string, timeoutMs: number): Promise<InboundItem[]>;
  /** Orders changed since the cursor, with their patients and encounters. */
  pollOrders(since: Date | null, timeoutMs: number): Promise<{ items: InboundItem[]; cursor: Date | null }>;
  send(req: OutboundRequest, timeoutMs: number): Promise<SendResult>;
}

/** Thrown when the HMIS cannot be read (network, 5xx…); the caller retries later. */
export class HmisUnavailableError extends Error {}

function classify(reply: TransportReply): { ok: boolean; retryable: boolean; error: string | null } {
  if (reply.network) return { ok: false, retryable: true, error: reply.error ?? reply.network };
  if (reply.status >= 200 && reply.status < 300) return { ok: true, retryable: false, error: null };
  const retryable = reply.status >= 500 || reply.status === 408 || reply.status === 429;
  const issue = (reply.body as { issue?: { diagnostics?: string }[]; message?: string } | null) ?? null;
  return { ok: false, retryable, error: `HTTP ${reply.status}${issue?.issue?.[0]?.diagnostics ? `: ${issue.issue[0].diagnostics}` : issue?.message ? `: ${issue.message}` : ''}` };
}

async function read(t: HmisTransport, path: string, timeoutMs: number): Promise<unknown | null> {
  const r = await t('GET', path, undefined, timeoutMs);
  if (r.status === 404) return null;
  const c = classify(r);
  if (!c.ok) throw new HmisUnavailableError(`GET ${path}: ${c.error}`);
  return r.body;
}

/** FHIR R4 REST (also used for the mock, which speaks FHIR). */
export class FhirHmisAdapter implements HmisAdapter {
  readonly canRead = true;
  constructor(
    readonly kind: HmisAdapterKind,
    private readonly t: HmisTransport,
    private readonly hospitalNoSystem: string,
  ) {}

  async ping(timeoutMs: number) {
    const r = await this.t('GET', '/metadata', undefined, timeoutMs);
    const c = classify(r);
    const body = r.body as { fhirVersion?: string; software?: { name?: string } } | null;
    return { ok: c.ok, detail: c.ok ? `FHIR ${body?.fhirVersion ?? '?'} (${body?.software?.name ?? 'unknown server'})` : (c.error ?? 'failed') };
  }

  async searchPatients(query: string, timeoutMs: number) {
    const q = query.trim();
    const param = /\d/.test(q) ? `identifier=${encodeURIComponent(q)}` : `name=${encodeURIComponent(q)}`;
    const body = (await read(this.t, `/Patient?${param}&_count=20`, timeoutMs)) as FhirResource | null;
    return body ? itemsFromFhir(body, this.hospitalNoSystem) : [];
  }

  async fetchPatient(externalId: string, timeoutMs: number) {
    const p = (await read(this.t, `/Patient/${encodeURIComponent(externalId)}`, timeoutMs)) as FhirResource | null;
    if (!p) return [];
    const allergies = (await read(this.t, `/AllergyIntolerance?patient=${encodeURIComponent(externalId)}`, timeoutMs)) as FhirResource | null;
    return [...itemsFromFhir(p, this.hospitalNoSystem), ...(allergies ? itemsFromFhir(allergies, this.hospitalNoSystem) : [])];
  }

  async fetchEncounter(externalId: string, timeoutMs: number) {
    const e = (await read(this.t, `/Encounter/${encodeURIComponent(externalId)}`, timeoutMs)) as FhirResource | null;
    return e ? itemsFromFhir(e, this.hospitalNoSystem) : [];
  }

  async pollOrders(since: Date | null, timeoutMs: number) {
    const filter = since ? `&_lastUpdated=gt${encodeURIComponent(since.toISOString())}` : '';
    const body = (await read(this.t, `/MedicationRequest?status=active,on-hold,cancelled,stopped,entered-in-error${filter}&_include=MedicationRequest:subject&_include=MedicationRequest:encounter&_count=200`, timeoutMs)) as FhirResource | null;
    if (!body) return { items: [], cursor: since };
    const resources = resourcesOf(body);
    const latest = resources.filter((r) => r.resourceType === 'MedicationRequest' && r.meta?.lastUpdated).map((r) => new Date(r.meta!.lastUpdated!).getTime());
    // Patients and encounters first, so orders find them.
    const order = (r: { type: HmisMessageType }) => (r.type === HmisMessageType.MEDICATION_REQUEST ? 1 : 0);
    return { items: itemsFromFhir(body, this.hospitalNoSystem).sort((a, b) => order(a) - order(b)), cursor: latest.length ? new Date(Math.max(...latest)) : since };
  }

  async send(req: OutboundRequest, timeoutMs: number): Promise<SendResult> {
    const resource = req.type === HmisMessageType.MEDICATION_DISPENSE ? toMedicationDispense(req.payload as DispenseOut, req.externalId) : toChargeItem(req.payload as ChargeOut);
    const path = req.externalId && req.type === HmisMessageType.MEDICATION_DISPENSE ? `/${resource.resourceType}/${encodeURIComponent(req.externalId)}` : `/${resource.resourceType}`;
    const reply = await this.t(req.externalId && req.type === HmisMessageType.MEDICATION_DISPENSE ? 'PUT' : 'POST', path, resource, timeoutMs);
    const c = classify(reply);
    const body = (reply.body ?? null) as Record<string, unknown> | null;
    return { ...c, status: reply.network ? null : reply.status, externalId: c.ok ? ((body?.id as string) ?? req.externalId ?? null) : null, request: resource, response: body };
  }
}

/**
 * Generic REST/JSON HMIS (no FHIR). Contract, relative to the base URL:
 * GET /patients?q=, GET /patients/:id, GET /encounters/:id,
 * GET /orders?since=, POST /dispenses, PUT /dispenses/:id, POST /charges —
 * bodies use the neutral field names (PatientInfo, EncounterInfo,
 * MedicationOrder, DispenseOut, ChargeOut); responses carry { id }.
 */
export class RestHmisAdapter implements HmisAdapter {
  readonly kind = HmisAdapterKind.REST;
  readonly canRead = true;
  constructor(private readonly t: HmisTransport) {}

  async ping(timeoutMs: number) {
    const r = await this.t('GET', '/patients?q=__ping__', undefined, timeoutMs);
    const c = classify(r);
    return { ok: c.ok, detail: c.ok ? 'REST HMIS answered' : (c.error ?? 'failed') };
  }

  async searchPatients(query: string, timeoutMs: number) {
    const body = (await read(this.t, `/patients?q=${encodeURIComponent(query)}`, timeoutMs)) as { patients?: unknown[] } | null;
    return itemsFromRest({ type: 'patient', data: body?.patients ?? [] }).filter((i) => i.externalId);
  }

  async fetchPatient(externalId: string, timeoutMs: number) {
    const body = (await read(this.t, `/patients/${encodeURIComponent(externalId)}`, timeoutMs)) as { patient?: Record<string, unknown>; allergies?: string[] } | null;
    if (!body?.patient) return [];
    return itemsFromRest({ type: 'patient', data: { ...body.patient, allergies: body.allergies } });
  }

  async fetchEncounter(externalId: string, timeoutMs: number) {
    const body = (await read(this.t, `/encounters/${encodeURIComponent(externalId)}`, timeoutMs)) as { encounter?: unknown } | null;
    return body?.encounter ? itemsFromRest({ type: 'encounter', data: body.encounter }) : [];
  }

  async pollOrders(since: Date | null, timeoutMs: number) {
    const body = (await read(this.t, `/orders${since ? `?since=${encodeURIComponent(since.toISOString())}` : ''}`, timeoutMs)) as
      | { orders?: unknown[]; patients?: unknown[]; encounters?: unknown[]; cursor?: string }
      | null;
    if (!body) return { items: [], cursor: since };
    return {
      items: [...itemsFromRest({ type: 'patient', data: body.patients ?? [] }), ...itemsFromRest({ type: 'encounter', data: body.encounters ?? [] }), ...itemsFromRest({ type: 'order', data: body.orders ?? [] })].filter((i) => i.externalId),
      cursor: body.cursor ? new Date(body.cursor) : new Date(),
    };
  }

  async send(req: OutboundRequest, timeoutMs: number): Promise<SendResult> {
    const dispense = req.type === HmisMessageType.MEDICATION_DISPENSE;
    const update = dispense && !!req.externalId;
    const path = dispense ? (update ? `/dispenses/${encodeURIComponent(req.externalId!)}` : '/dispenses') : '/charges';
    const request = req.payload as unknown as Record<string, unknown>;
    const reply = await this.t(update ? 'PUT' : 'POST', path, request, timeoutMs);
    const c = classify(reply);
    const body = (reply.body ?? null) as Record<string, unknown> | null;
    return { ...c, status: reply.network ? null : reply.status, externalId: c.ok ? ((body?.id as string) ?? req.externalId ?? null) : null, request, response: body };
  }
}

export function createHmisAdapter(cfg: { adapter: HmisAdapterKind; baseUrl: string | null; token: string | null; authHeader: string; hospitalNoSystem: string; code?: string }): HmisAdapter {
  const auth = { header: cfg.authHeader || 'Authorization', token: cfg.token };
  if (cfg.adapter === HmisAdapterKind.HL7) {
    const header = { sendingApp: 'SIL-PIS', sendingFacility: 'SIL', receivingApp: 'HMIS', receivingFacility: cfg.code ?? 'HMIS' };
    const url = cfg.baseUrl ?? 'mllp://mock';
    const m = /^mllp:\/\/([^:/]+)(?::(\d+))?\/?$/.exec(url);
    if (!m) throw new Error('HL7 v2 needs an address like mllp://host:2575');
    return new Hl7HmisAdapter(m[1] === 'mock' ? mockHl7Transport() : mllpTransport(m[1], Number(m[2] ?? 2575)), header);
  }
  if (cfg.adapter === HmisAdapterKind.MOCK) {
    return new FhirHmisAdapter(HmisAdapterKind.MOCK, cfg.baseUrl ? httpTransport(cfg.baseUrl, auth, 'application/fhir+json') : mockTransport(), cfg.hospitalNoSystem);
  }
  if (!cfg.baseUrl) throw new Error(`${cfg.adapter} needs a base URL`);
  if (cfg.adapter === HmisAdapterKind.FHIR) return new FhirHmisAdapter(HmisAdapterKind.FHIR, httpTransport(cfg.baseUrl, auth, 'application/fhir+json'), cfg.hospitalNoSystem);
  return new RestHmisAdapter(httpTransport(cfg.baseUrl, auth));
}

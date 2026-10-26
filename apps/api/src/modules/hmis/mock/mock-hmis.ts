/**
 * Mock HMIS for development and tests: a small in-memory FHIR R4 server
 * (Patient, Encounter, AllergyIntolerance, MedicationRequest,
 * MedicationDispense, ChargeItem) with failure injection. NOT a real HMIS.
 *
 * Supported: read, search (the parameters this system uses), create (with
 * identifier-based conditional create, so a re-sent record is not
 * duplicated), update, and GET /metadata.
 */
import type { Bundle, FhirResource } from '../fhir';

export type MockHmisFailure = { mode: 'offline' | 'timeout' | 'http500' | 'http400'; count: number };
export interface MockHmisReply {
  status: number;
  body?: unknown;
  network?: 'offline' | 'timeout';
}

const TYPES = ['Patient', 'Encounter', 'AllergyIntolerance', 'MedicationRequest', 'MedicationDispense', 'ChargeItem'] as const;

export interface MockPrescription {
  patient: string;
  encounter?: string | null;
  group?: string;
  /** Dispensing location code (dispenseRequest.performer). */
  location?: string | null;
  prescriber?: string;
  lines: { code: string; display?: string; quantity?: number; dose?: number; doseUnit?: string; frequency?: string; durationDays?: number; supplyMode?: string; route?: string }[];
}

export class MockHmis {
  readonly store = new Map<string, Map<string, FhirResource>>(TYPES.map((t) => [t, new Map()]));
  failure: MockHmisFailure | null = null;
  requests: { method: string; path: string; status: number; at: string }[] = [];
  private seq = 0;
  private clock = 0;

  reset() {
    for (const m of this.store.values()) m.clear();
    this.failure = null;
    this.requests = [];
    this.seq = 0;
  }

  /** Strictly increasing timestamps so _lastUpdated searches are exact. */
  private now(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  private nextId(type: string) {
    return `${type.toLowerCase().slice(0, 3)}-${(++this.seq).toString().padStart(5, '0')}`;
  }

  /** Stores a resource (new id unless given), bumping its version. */
  put<T extends FhirResource>(r: T): T {
    const map = this.store.get(r.resourceType);
    if (!map) throw new Error(`Unsupported type ${r.resourceType}`);
    const id = r.id ?? this.nextId(r.resourceType);
    const prev = map.get(id);
    const version = prev ? Number(prev.meta?.versionId ?? '1') + 1 : 1;
    const saved = { ...structuredClone(r), id, meta: { versionId: String(version), lastUpdated: this.now() } } as T;
    map.set(id, saved);
    return saved;
  }

  get(type: string, id: string): FhirResource | undefined {
    return this.store.get(type)?.get(id);
  }

  all(type: string): FhirResource[] {
    return [...(this.store.get(type)?.values() ?? [])];
  }

  /** Writes MedicationRequests as a prescriber would (one group). */
  prescribe(p: MockPrescription): FhirResource[] {
    const group = p.group ?? `rx-${(++this.seq).toString().padStart(5, '0')}`;
    return p.lines.map((l) =>
      this.put({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        groupIdentifier: { value: group },
        subject: { reference: `Patient/${p.patient}` },
        ...(p.encounter ? { encounter: { reference: `Encounter/${p.encounter}` } } : {}),
        authoredOn: new Date().toISOString(),
        requester: { display: p.prescriber ?? 'Dr. Mock Prescriber', identifier: { value: 'KMPDC-0001' } },
        medicationCodeableConcept: { coding: [{ system: 'urn:mock-hmis:drug', code: l.code, display: l.display ?? l.code }], text: l.display ?? l.code },
        ...(l.supplyMode ? { extension: [{ url: 'https://sil.health/fhir/StructureDefinition/supply-mode', valueCode: l.supplyMode }] } : {}),
        dosageInstruction: [
          {
            text: `${l.dose ?? 1} ${l.doseUnit ?? 'tab'} ${l.frequency ?? 'TDS'}`,
            ...(l.route ? { route: { text: l.route } } : {}),
            timing: { code: { text: l.frequency ?? 'TDS' } },
            doseAndRate: [{ doseQuantity: { value: l.dose ?? 1, unit: l.doseUnit ?? 'tab' } }],
          },
        ],
        dispenseRequest: {
          ...(l.quantity !== undefined ? { quantity: { value: l.quantity } } : {}),
          ...(l.durationDays ? { expectedSupplyDuration: { value: l.durationDays, unit: 'days', code: 'd' } } : {}),
          ...(p.location ? { performer: { identifier: { value: p.location } } } : {}),
        },
      }),
    );
  }

  /** Changes the status of an order (e.g. the prescriber stops it). */
  setOrderStatus(id: string, status: string) {
    const r = this.get('MedicationRequest', id);
    if (!r) throw new Error(`MedicationRequest ${id} not found`);
    return this.put({ ...r, status });
  }

  handle(method: string, rawPath: string, body?: unknown): MockHmisReply {
    const reply = this.route(method.toUpperCase(), rawPath, body);
    this.requests.push({ method, path: rawPath, status: reply.network ? 0 : reply.status, at: new Date().toISOString() });
    if (this.requests.length > 500) this.requests.shift();
    return reply;
  }

  private route(method: string, rawPath: string, body?: unknown): MockHmisReply {
    if (this.failure && this.failure.count > 0) {
      this.failure.count--;
      const f = this.failure;
      if (f.count <= 0) this.failure = null;
      if (f.mode === 'offline') return { status: 0, network: 'offline' };
      if (f.mode === 'timeout') return { status: 0, network: 'timeout' };
      if (f.mode === 'http500') return { status: 500, body: outcome('exception', 'Mock HMIS internal error') };
      return { status: 400, body: outcome('invalid', 'Mock HMIS rejected the request') };
    }
    const url = new URL(rawPath, 'http://mock');
    const parts = url.pathname.replace(/^\/(fhir\/?)?/, '').split('/').filter(Boolean);
    if (parts[0] === 'metadata' && method === 'GET') {
      return { status: 200, body: { resourceType: 'CapabilityStatement', status: 'active', fhirVersion: '4.0.1', software: { name: 'SIL mock HMIS' }, kind: 'instance' } };
    }
    const type = parts[0];
    if (!type || !this.store.has(type)) return { status: 404, body: outcome('not-found', `Unknown resource type ${type}`) };
    const map = this.store.get(type)!;

    if (method === 'GET' && parts[1]) {
      const r = map.get(parts[1]);
      return r ? { status: 200, body: r } : { status: 404, body: outcome('not-found', `${type}/${parts[1]} not found`) };
    }
    if (method === 'GET') return { status: 200, body: this.search(type, url.searchParams) };
    if (method === 'POST' && !parts[1]) {
      const res = body as FhirResource;
      if (!res || res.resourceType !== type) return { status: 400, body: outcome('invalid', `Body must be a ${type}`) };
      const ident = (res.identifier as { system?: string; value?: string }[] | undefined)?.[0];
      if (ident?.value) {
        const existing = [...map.values()].find((x) => (x.identifier as { system?: string; value?: string }[] | undefined)?.some((i) => i.system === ident.system && i.value === ident.value));
        if (existing) return { status: 200, body: existing };
      }
      const { id: _ignored, ...rest } = res;
      return { status: 201, body: this.put(rest as FhirResource) };
    }
    if (method === 'PUT' && parts[1]) {
      const res = body as FhirResource;
      if (!res || res.resourceType !== type) return { status: 400, body: outcome('invalid', `Body must be a ${type}`) };
      const existed = map.has(parts[1]);
      return { status: existed ? 200 : 201, body: this.put({ ...res, id: parts[1] }) };
    }
    return { status: 405, body: outcome('not-supported', `${method} not supported`) };
  }

  private search(type: string, q: URLSearchParams): Bundle {
    let rows = [...this.store.get(type)!.values()];
    const refMatch = (v: unknown, want: string) => {
      const ref = (v as { reference?: string } | undefined)?.reference;
      return !!ref && (ref === want || ref.endsWith(`/${want}`));
    };
    for (const [k, v] of q.entries()) {
      if (k === '_id') rows = rows.filter((r) => v.split(',').includes(r.id!));
      else if (k === 'identifier') {
        const [sys, val] = v.includes('|') ? v.split('|') : [null, v];
        rows = rows.filter((r) => (r.identifier as { system?: string; value?: string }[] | undefined)?.some((i) => i.value === val && (!sys || i.system === sys)));
      } else if (k === 'name') {
        const t = v.toLowerCase();
        rows = rows.filter((r) => JSON.stringify(r.name ?? '').toLowerCase().includes(t));
      } else if (k === 'patient' || k === 'subject') rows = rows.filter((r) => refMatch(r.subject ?? r.patient, v));
      else if (k === 'encounter' || k === 'context') rows = rows.filter((r) => refMatch(r.encounter ?? r.context, v));
      else if (k === 'status') rows = rows.filter((r) => v.split(',').includes(String(r.status)));
      else if (k === '_lastUpdated') {
        const m = /^(gt|ge|lt|le)?(.+)$/.exec(v)!;
        const at = new Date(m[2]).getTime();
        rows = rows.filter((r) => {
          const t = new Date(r.meta!.lastUpdated!).getTime();
          return m[1] === 'ge' ? t >= at : m[1] === 'lt' ? t < at : m[1] === 'le' ? t <= at : t > at;
        });
      }
    }
    rows.sort((a, b) => a.meta!.lastUpdated!.localeCompare(b.meta!.lastUpdated!));
    const entry: { resource: FhirResource; search: { mode: string } }[] = rows.map((r) => ({ resource: r, search: { mode: 'match' } }));
    for (const inc of q.getAll('_include')) {
      const field = inc.split(':')[1];
      const seen = new Set(entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`));
      for (const r of rows) {
        const ref = (r[field] as { reference?: string } | undefined)?.reference;
        if (!ref || seen.has(ref)) continue;
        const [t, id] = ref.split('/');
        const target = this.get(t, id);
        if (target) {
          entry.push({ resource: target, search: { mode: 'include' } });
          seen.add(ref);
        }
      }
    }
    return { resourceType: 'Bundle', type: 'searchset', total: rows.length, entry } as Bundle;
  }
}

function outcome(code: string, diagnostics: string) {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] };
}

/**
 * Sample HMIS content matching the seeded patients (hospital numbers
 * SIL-000101…104), their visits and allergies.
 */
export function seedMockHmis(mock: MockHmis, system = 'urn:sil:hospital-no') {
  const patient = (id: string, no: string, given: string, family: string, birthDate: string, gender: string, extra: Record<string, unknown> = {}) =>
    mock.put({ resourceType: 'Patient', id, identifier: [{ system, value: no, type: { coding: [{ code: 'MR' }] } }], name: [{ use: 'official', given: [given], family }], birthDate, gender, ...extra });
  patient('pt-101', 'SIL-000101', 'Wanjiku', 'Kamau', '1984-03-12', 'female', { telecom: [{ system: 'phone', value: '0712000101' }] });
  patient('pt-102', 'SIL-000102', 'Ochieng', 'Otieno', '1958-11-02', 'male', {
    extension: [
      { url: 'https://sil.health/fhir/StructureDefinition/payer', valueCoding: { code: 'ALPHA' } },
      { url: 'https://sil.health/fhir/StructureDefinition/member-no', valueString: 'ALPHA-55821' },
    ],
  });
  patient('pt-103', 'SIL-000103', 'Amina', 'Hassan', '1996-07-21', 'female', { extension: [{ url: 'https://sil.health/fhir/StructureDefinition/pregnant', valueBoolean: true }] });
  patient('pt-105', 'SIL-000105', 'Juma', 'Mwangi', '1971-09-30', 'male');
  mock.put({ resourceType: 'AllergyIntolerance', id: 'alg-101', patient: { reference: 'Patient/pt-101' }, code: { text: 'penicillins' }, clinicalStatus: { coding: [{ code: 'active' }] } });
  mock.put({ resourceType: 'AllergyIntolerance', id: 'alg-103', patient: { reference: 'Patient/pt-103' }, code: { text: 'sulfonamides' }, clinicalStatus: { coding: [{ code: 'active' }] } });
  const visit = (id: string, pt: string, cls: string, ward: string | null, bed: string | null, payer?: string) =>
    mock.put({
      resourceType: 'Encounter',
      id,
      status: 'in-progress',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls },
      subject: { reference: `Patient/${pt}` },
      period: { start: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      participant: [{ individual: { display: 'Dr. Achieng Odhiambo' } }],
      ...(ward
        ? {
            location: [
              { location: { identifier: { value: ward }, display: ward }, physicalType: { coding: [{ code: 'wa' }] }, status: 'active' },
              ...(bed ? [{ location: { display: bed }, physicalType: { coding: [{ code: 'bd' }] }, status: 'active' }] : []),
            ],
          }
        : {}),
      ...(payer ? { extension: [{ url: 'https://sil.health/fhir/StructureDefinition/payer', valueCoding: { code: payer } }] } : {}),
    });
  visit('enc-101', 'pt-101', 'AMB', null, null);
  visit('enc-102', 'pt-102', 'IMP', 'HMIS-MED', 'M-04', 'ALPHA');
  visit('enc-103', 'pt-103', 'IMP', 'HMIS-MAT', 'MAT-02');
  visit('enc-105', 'pt-105', 'IMP', 'HMIS-SURG', 'S-11');
}

/** One mock shared by the in-process adapter (tests, development without the container). */
export const sharedMockHmis = new MockHmis();

/**
 * HL7 v2 (2.5.1 profile) ↔ neutral records, for HMIS that speak v2 instead of
 * FHIR. Inbound: ADT^A01/A03/A04/A08/A11 (PID, PV1, AL1, IN1) and pharmacy
 * orders RDE^O11 / OMP^O09 (PID, PV1, ORC, RXE/RXO, RXR, TQ1). Outbound:
 * RDS^O13 (dispense) and DFT^P03 (charge). Every inbound message is answered
 * with an ACK (AA accepted, AE error, AR rejected).
 */
import { randomUUID } from 'node:crypto';
import { EncounterClass, EncounterStatus, Sex, SupplyMode } from '@sil/shared';
import { AllergyInfo, ChargeOut, DispenseOut, EncounterInfo, FREQUENCY_PER_DAY, MedicationOrder, OrderStatus, PatientInfo } from './fhir';

export class Hl7Error extends Error {}

/** MLLP framing: <VT> message <FS><CR>. */
export const MLLP = { start: '\x0b', end: '\x1c\x0d' } as const;

export interface Hl7Segment {
  name: string;
  /** fields[n] is field n (for MSH, fields[1] is the field separator itself). */
  fields: string[];
}

export interface Hl7Message {
  segments: Hl7Segment[];
  enc: { field: string; component: string; repetition: string; escape: string; subcomponent: string };
}

const ESCAPES: [RegExp, string][] = [
  [/\\F\\/g, '|'],
  [/\\S\\/g, '^'],
  [/\\R\\/g, '~'],
  [/\\T\\/g, '&'],
  [/\\E\\/g, '\\'],
  [/\\\.br\\/g, '\n'],
];
const unescape = (s: string) => ESCAPES.reduce((acc, [re, v]) => acc.replace(re, v), s);
/** Escapes text for a field (standard delimiters). */
export const esc = (s: string | number | null | undefined) =>
  s === null || s === undefined ? '' : String(s).replace(/\\/g, '\\E\\').replace(/\|/g, '\\F\\').replace(/\^/g, '\\S\\').replace(/~/g, '\\R\\').replace(/&/g, '\\T\\').replace(/\r?\n/g, ' ');

export function parseHl7(raw: string): Hl7Message {
  const text = raw.replace(/^\x0b/, '').replace(/\x1c\r?$/, '').trim();
  if (!text.startsWith('MSH')) throw new Hl7Error('Not an HL7 v2 message (no MSH segment)');
  const field = text[3];
  const encChars = text.slice(4, 8);
  const enc = { field, component: encChars[0] ?? '^', repetition: encChars[1] ?? '~', escape: encChars[2] ?? '\\', subcomponent: encChars[3] ?? '&' };
  const segments = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.split(field);
      const name = parts[0];
      // MSH-1 is the separator, so MSH fields are shifted by one.
      const fields = name === 'MSH' ? ['MSH', field, ...parts.slice(1)] : parts;
      return { name, fields };
    });
  return { segments, enc };
}

/** Value of field / component / subcomponent (1-based), unescaped; '' when absent. */
export function val(seg: Hl7Segment | undefined, f: number, c = 1, s = 1, rep = 0, enc = { component: '^', repetition: '~', subcomponent: '&' }): string {
  if (!seg) return '';
  const fieldValue = seg.fields[f] ?? '';
  if (seg.name === 'MSH' && f <= 2) return fieldValue;
  const r = fieldValue.split(enc.repetition)[rep] ?? '';
  const comp = r.split(enc.component)[c - 1] ?? '';
  return unescape(comp.split(enc.subcomponent)[s - 1] ?? '');
}

const reps = (seg: Hl7Segment | undefined, f: number) => (seg?.fields[f] ?? '').split('~').filter(Boolean).length;
const first = (m: Hl7Message, name: string) => m.segments.find((s) => s.name === name);
const all = (m: Hl7Message, name: string) => m.segments.filter((s) => s.name === name);

export function messageType(m: Hl7Message): { type: string; event: string; controlId: string; version: string } {
  const msh = first(m, 'MSH')!;
  return { type: val(msh, 9, 1), event: val(msh, 9, 2), controlId: val(msh, 10), version: val(msh, 12) };
}

/** HL7 TS (YYYYMMDD[HHMM[SS]][+ZZZZ]) → ISO; date only → YYYY-MM-DD. */
export function hl7Date(ts: string, dateOnly = false): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?([+-]\d{4})?$/.exec(ts.trim());
  if (!m) return null;
  if (dateOnly || !m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  const tz = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : '+03:00';
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${tz}`).toISOString();
}

export function hl7Ts(d: Date = new Date()): string {
  // East Africa Time, as the HL7 TS with offset.
  const eat = new Date(d.getTime() + 3 * 3_600_000).toISOString();
  return `${eat.slice(0, 4)}${eat.slice(5, 7)}${eat.slice(8, 10)}${eat.slice(11, 13)}${eat.slice(14, 16)}${eat.slice(17, 19)}+0300`;
}

// ------------------------------------------------------------------ inbound

/** PID → patient. PID-3 repetition with type MR / the hospital-number authority, else the first. */
export function pidToPatient(m: Hl7Message, hospitalNoSystem: string): PatientInfo {
  const pid = first(m, 'PID');
  if (!pid) throw new Hl7Error('No PID segment');
  const n = reps(pid, 3) || 1;
  let hospitalNo = '';
  let externalId = '';
  for (let r = 0; r < n; r++) {
    const id = val(pid, 3, 1, 1, r);
    const authority = val(pid, 3, 4, 1, r);
    const type = val(pid, 3, 5, 1, r);
    if (!externalId && (type === 'PI' || type === 'PT')) externalId = id;
    if (!hospitalNo && (type === 'MR' || authority === hospitalNoSystem)) hospitalNo = id;
  }
  hospitalNo ||= val(pid, 3, 1);
  externalId ||= hospitalNo;
  if (!hospitalNo) throw new Hl7Error('PID-3 has no patient identifier');
  const name = [val(pid, 5, 2), val(pid, 5, 3), val(pid, 5, 1)].filter(Boolean).join(' ');
  if (!name) throw new Hl7Error(`Patient ${hospitalNo} has no name (PID-5)`);
  const sex = val(pid, 8);
  const insurer = first(m, 'IN1');
  return {
    externalId: externalId.slice(0, 100),
    hospitalNo: hospitalNo.slice(0, 40),
    name: name.slice(0, 200),
    dateOfBirth: hl7Date(val(pid, 7), true),
    sex: sex === 'F' ? Sex.F : sex === 'M' ? Sex.M : sex === 'O' || sex === 'A' ? Sex.OTHER : null,
    weightKg: null,
    isPregnant: false,
    payerCode: insurer ? val(insurer, 3) || val(insurer, 2) || null : null,
    memberNo: insurer ? val(insurer, 36) || val(insurer, 49) || null : null,
    phone: (val(pid, 13, 1) || val(pid, 13, 12) || null)?.slice(0, 20) ?? null,
    active: true,
  };
}

const PV1_CLASS: Record<string, EncounterClass> = { I: EncounterClass.IPD, O: EncounterClass.OPD, E: EncounterClass.EMERGENCY, P: EncounterClass.OPD, R: EncounterClass.OPD, B: EncounterClass.OPD, C: EncounterClass.OPD };

/** PV1 → encounter (visit number PV1-19, ward PV1-3.1, bed PV1-3.3). */
export function pv1ToEncounter(m: Hl7Message, patientExternalId: string, event = ''): EncounterInfo | null {
  const pv1 = first(m, 'PV1');
  const visit = pv1 ? val(pv1, 19) : '';
  if (!pv1 || !visit) return null;
  const discharged = !!val(pv1, 45) || event === 'A03';
  const cancelled = event === 'A11';
  const attending = [val(pv1, 7, 3), val(pv1, 7, 2)].filter(Boolean).join(' ');
  const insurer = first(m, 'IN1');
  return {
    externalId: visit.slice(0, 100),
    patientExternalId,
    class: PV1_CLASS[val(pv1, 2)] ?? EncounterClass.OPD,
    status: cancelled ? EncounterStatus.CANCELLED : discharged ? EncounterStatus.FINISHED : EncounterStatus.ACTIVE,
    wardCode: val(pv1, 3, 1) || null,
    bed: (val(pv1, 3, 3) || null)?.slice(0, 40) ?? null,
    payerCode: insurer ? val(insurer, 3) || val(insurer, 2) || null : null,
    memberNo: insurer ? val(insurer, 36) || null : null,
    attending: attending ? `Dr. ${attending}`.slice(0, 200) : null,
    startedAt: hl7Date(val(pv1, 44)),
    endedAt: hl7Date(val(pv1, 45)),
  };
}

export function al1ToAllergies(m: Hl7Message, patientExternalId: string): AllergyInfo[] {
  return all(m, 'AL1')
    .map((a) => ({ externalId: null, patientExternalId, substance: (val(a, 3, 2) || val(a, 3, 1)).trim().toLowerCase().slice(0, 100), active: true }))
    .filter((a) => a.substance);
}

/** ORC + RXE (or RXO) + RXR + TQ1 → order. ORC-1 CA / DC / OD / XX? cancel; NW / XO / SC active. */
export function rxeToOrders(m: Hl7Message, patientExternalId: string, encounterExternalId: string | null): MedicationOrder[] {
  const orders: MedicationOrder[] = [];
  const segs = m.segments;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].name !== 'ORC') continue;
    const orc = segs[i];
    const group: Hl7Segment[] = [];
    for (let j = i + 1; j < segs.length && segs[j].name !== 'ORC'; j++) group.push(segs[j]);
    const rx = group.find((s) => s.name === 'RXE') ?? group.find((s) => s.name === 'RXO');
    if (!rx) throw new Hl7Error(`ORC ${val(orc, 2) || i} has no RXE/RXO segment`);
    const isRxe = rx.name === 'RXE';
    const placer = val(orc, 2) || val(orc, 3);
    if (!placer) throw new Hl7Error('ORC-2 (placer order number) is required');
    const control = val(orc, 1);
    const status: OrderStatus = ['CA', 'DC', 'OD', 'CR', 'DR'].includes(control) ? (control === 'DC' || control === 'OD' ? 'stopped' : 'cancelled') : control === 'HD' ? 'on-hold' : 'active';
    // RXE: 2 give code, 3 min amount, 5 units, 10 dispense amount, 21 instructions, 23 rate... RXO: 1 code, 2 amount, 4 units, 11 dispense amount.
    const codeField = isRxe ? 2 : 1;
    const code = val(rx, codeField, 1);
    const display = val(rx, codeField, 2) || null;
    const altCode = val(rx, codeField, 4);
    const doseAmount = val(rx, isRxe ? 3 : 2);
    const doseUnit = val(rx, isRxe ? 5 : 4, 1) || val(rx, isRxe ? 5 : 4, 2);
    const dispense = Number(val(rx, isRxe ? 10 : 11)) || null;
    const tq1 = group.find((s) => s.name === 'TQ1');
    const freqCode = (tq1 ? val(tq1, 3, 1) : '') || (isRxe ? val(rx, 1, 2, 1) : '');
    const perDay = freqCode ? (FREQUENCY_PER_DAY[freqCode.toUpperCase()] ?? null) : null;
    const durationDays = tq1 ? Number(val(tq1, 6, 1)) || null : null;
    const countable = /^(tab|tabs|tablet|cap|caps|capsule|each|ea|unit|units|sachet|vial|amp|puff)s?$/i.test(doseUnit);
    const daily = countable && perDay && Number(doseAmount) ? Math.round(Number(doseAmount) * perDay * 10_000) / 10_000 : null;
    const supplyRaw = (isRxe ? val(rx, 45) : '') || (tq1 ? val(tq1, 9) : '');
    const supplyMode = /^(DAILY|UNIT_DOSE)$/i.test(supplyRaw) ? (supplyRaw.toUpperCase() as SupplyMode) : SupplyMode.STANDARD;
    const rxr = group.find((s) => s.name === 'RXR');
    const requester = [val(orc, 12, 3), val(orc, 12, 2)].filter(Boolean).join(' ');
    orders.push({
      externalId: placer.slice(0, 100),
      groupId: (val(orc, 4) || placer).slice(0, 100),
      status,
      patientExternalId,
      encounterExternalId,
      prescriber: (requester ? `Dr. ${requester}` : 'HMIS prescriber').slice(0, 200),
      prescriberRegNo: val(orc, 12, 1) || null,
      authoredOn: hl7Date(val(orc, 9)),
      drugCodes: [{ system: val(rx, codeField, 3) || null, code, display }, ...(altCode ? [{ system: val(rx, codeField, 6) || null, code: altCode, display: val(rx, codeField, 5) || null }] : [])].filter((c) => c.code),
      drugText: display,
      dose: (doseAmount ? `${doseAmount}${doseUnit ? ` ${doseUnit}` : ''}` : 'As directed').slice(0, 100),
      frequency: (freqCode || 'As directed').slice(0, 60),
      duration: durationDays ? `${durationDays} days` : null,
      route: rxr ? (val(rxr, 1, 2) || val(rxr, 1, 1) || null)?.slice(0, 60) ?? null : null,
      quantity: dispense ?? (daily && durationDays ? Math.ceil(daily * durationDays) : null),
      dailyQuantity: daily,
      supplyMode,
      locationCode: (isRxe ? val(rx, 40, 1) : '') || val(orc, 13, 1) || null,
      instructions: ((isRxe ? val(rx, 21, 2) || val(rx, 21, 1) : '') || null)?.slice(0, 500) ?? null,
    });
  }
  return orders;
}

// ------------------------------------------------------------------ outbound

export interface Hl7Header {
  sendingApp: string;
  sendingFacility: string;
  receivingApp: string;
  receivingFacility: string;
}

const msh = (h: Hl7Header, type: string, controlId: string) =>
  `MSH|^~\\&|${esc(h.sendingApp)}|${esc(h.sendingFacility)}|${esc(h.receivingApp)}|${esc(h.receivingFacility)}|${hl7Ts()}||${type}|${controlId}|P|2.5.1|||AL|NE`;

/** RDS^O13: one RXD per dispensed batch line; ORC-2 the HMIS order, RXD-14 the batch. */
export function buildRds(d: DispenseOut, h: Hl7Header, controlId = randomUUID().slice(0, 20)): string {
  const control = d.status === 'entered-in-error' ? 'CA' : 'RE';
  return [
    msh(h, 'RDS^O13^RDS_O13', controlId),
    `PID|1||${esc(d.patientExternalId)}^^^^PI`,
    ...(d.encounterExternalId ? [`PV1|1||||||||||||||||||${esc(d.encounterExternalId)}`] : []),
    `ORC|${control}|${esc(d.orderExternalId ?? '')}|${esc(d.dispenseLineId)}^SIL||CM`,
    `RXD|1|${esc(d.hmisDrugCode ?? d.itemCode)}^${esc(d.itemName)}^${d.hmisDrugCode ? 'HMIS' : 'SIL'}^${esc(d.itemCode)}^${esc(d.itemName)}^SIL|${hl7Ts(new Date(d.dispensedAt))}|${d.quantity}|${esc(d.unit ?? '')}||${esc(d.dispenseNo)}||${d.substituted ? 'G' : 'N'}|||||${esc(d.batchNo)}|${d.expiryDate ? d.expiryDate.replace(/-/g, '') : ''}`,
    ...(d.note ? [`NTE|1||${esc(d.note)}`] : []),
  ].join('\r');
}

/** DFT^P03: FT1 charge (CG) or credit (CD); FT1-2 our charge id, FT1-19 filler order for reversals. */
export function buildDft(c: ChargeOut, h: Hl7Header, controlId = randomUUID().slice(0, 20)): string {
  const credit = c.quantity < 0;
  return [
    msh(h, 'DFT^P03^DFT_P03', controlId),
    `EVN|P03|${hl7Ts()}`,
    `PID|1||${esc(c.patientExternalId)}^^^^PI`,
    ...(c.encounterExternalId ? [`PV1|1||||||||||||||||||${esc(c.encounterExternalId)}`] : []),
    `FT1|1|${esc(c.chargeId)}|${esc(c.sourceNo ?? '')}|${hl7Ts(new Date(c.occurredAt))}||${credit ? 'CD' : 'CG'}|${esc(c.itemCode)}^${esc(c.description)}^SIL|||${Math.abs(c.quantity)}|${Math.abs(c.amount)}^${esc(c.currency)}|${c.unitPrice}^${esc(c.currency)}|||||||${esc(c.reversesExternalId ?? '')}`,
  ].join('\r');
}

/** ACK for an inbound message. */
export function buildAck(inbound: Hl7Message | null, code: 'AA' | 'AE' | 'AR', text: string, h: Hl7Header): string {
  const t = inbound ? messageType(inbound) : { event: '', controlId: '' };
  return [msh(h, `ACK^${t.event}^ACK`, randomUUID().slice(0, 20)), `MSA|${code}|${esc(t.controlId)}|${esc(text.slice(0, 80))}`, ...(code === 'AA' ? [] : [`ERR|||${code === 'AR' ? '200' : '207'}|E||||${esc(text.slice(0, 250))}`])].join('\r');
}

/** Reads an ACK: accepted, or the error text. */
export function readAck(raw: string): { ok: boolean; code: string; text: string; controlId: string } {
  const m = parseHl7(raw);
  const msa = first(m, 'MSA');
  if (!msa) throw new Hl7Error('Reply has no MSA segment');
  const code = val(msa, 1);
  return { ok: code === 'AA' || code === 'CA', code, text: val(msa, 3) || val(first(m, 'ERR'), 8), controlId: val(msa, 2) };
}

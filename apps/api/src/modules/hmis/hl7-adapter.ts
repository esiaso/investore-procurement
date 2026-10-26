import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { HmisAdapterKind, HmisMessageType } from '@sil/shared';
import type { ChargeOut, DispenseOut } from './fhir';
import { al1ToAllergies, buildDft, buildRds, Hl7Error, Hl7Header, MLLP, messageType, parseHl7, pidToPatient, pv1ToEncounter, readAck, rxeToOrders } from './hl7';
import type { HmisAdapter, InboundItem, OutboundRequest, SendResult } from './hmis-adapter';

/** Sends one framed message and returns the reply (ACK) text, or a network failure. */
export type MllpTransport = (message: string, timeoutMs: number) => Promise<{ reply: string | null; error: string | null }>;

/** HL7 v2 over MLLP/TCP (mllp://host:port). */
export function mllpTransport(host: string, port: number): MllpTransport {
  return (message, timeoutMs) =>
    new Promise((resolve) => {
      let buf = '';
      let done = false;
      const finish = (r: { reply: string | null; error: string | null }) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(r);
      };
      const sock = connect({ host, port }, () => sock.write(`${MLLP.start}${message}${MLLP.end}`));
      sock.setTimeout(timeoutMs, () => finish({ reply: null, error: `Timed out after ${timeoutMs} ms` }));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const end = buf.indexOf('\x1c');
        if (end >= 0) finish({ reply: buf.slice(buf.indexOf(MLLP.start) + 1, end), error: null });
      });
      sock.on('error', (e) => finish({ reply: null, error: `Network error: ${e.message}` }));
      sock.on('close', () => finish({ reply: null, error: 'Network error: connection closed without an ACK' }));
    });
}

/** Splits an MLLP stream into messages (returns the complete ones and the rest). */
export function mllpFrames(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const s = rest.indexOf(MLLP.start);
    const e = rest.indexOf('\x1c', s + 1);
    if (s < 0 || e < 0) break;
    messages.push(rest.slice(s + 1, e));
    rest = rest.slice(e + 1).replace(/^\r/, '');
  }
  return { messages, rest };
}

const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

/**
 * HL7 v2 message → inbound items: the patient (PID, with AL1 allergies),
 * the visit (PV1), allergies and orders (ORC/RXE). Keys use the message
 * control id (MSH-10), so a resent message is recognised; each item keeps the
 * whole message as its payload.
 */
export function itemsFromHl7(raw: string, hospitalNoSystem: string): InboundItem[] {
  const payload = { hl7: raw.replace(/\r\n|\n/g, '\r') };
  let m;
  try {
    m = parseHl7(raw);
  } catch (e) {
    return [{ type: HmisMessageType.PATIENT, externalId: null, key: `HL7:${hash(raw)}`, raw: payload, error: (e as Error).message }];
  }
  const t = messageType(m);
  const base = `HL7:${t.controlId || hash(raw)}`;
  const out: InboundItem[] = [];
  const supported = (t.type === 'ADT' && ['A01', 'A02', 'A03', 'A04', 'A05', 'A08', 'A11', 'A28', 'A31'].includes(t.event)) || (t.type === 'RDE' && t.event === 'O11') || (t.type === 'OMP' && t.event === 'O09');
  if (!supported) return [{ type: HmisMessageType.PATIENT, externalId: null, key: `${base}:unsupported`, raw: payload, error: `${t.type}^${t.event} is not read (send ADT, RDE^O11 or OMP^O09)` }];
  try {
    const patient = pidToPatient(m, hospitalNoSystem);
    const allergies = al1ToAllergies(m, patient.externalId);
    // ADT carries the full allergy list; an order message only updates demographics.
    out.push({ type: HmisMessageType.PATIENT, externalId: patient.externalId, key: `${base}:PATIENT:${patient.externalId}`, raw: payload, data: patient, ...(t.type === 'ADT' ? { allergies: allergies.map((a) => a.substance) } : {}) });
    const enc = pv1ToEncounter(m, patient.externalId, t.event);
    if (enc) out.push({ type: HmisMessageType.ENCOUNTER, externalId: enc.externalId, key: `${base}:ENCOUNTER:${enc.externalId}`, raw: payload, data: enc });
    if (t.type !== 'ADT') {
      for (const a of allergies) out.push({ type: HmisMessageType.ALLERGY, externalId: null, key: `${base}:ALLERGY:${a.substance}`, raw: payload, data: a });
      for (const o of rxeToOrders(m, patient.externalId, enc?.externalId ?? null)) out.push({ type: HmisMessageType.MEDICATION_REQUEST, externalId: o.externalId, key: `${base}:ORDER:${o.externalId}`, raw: payload, data: o });
    }
  } catch (e) {
    if (!(e instanceof Hl7Error)) throw e;
    out.push({ type: t.type === 'ADT' ? HmisMessageType.PATIENT : HmisMessageType.MEDICATION_REQUEST, externalId: null, key: `${base}:error`, raw: payload, error: e.message });
  }
  return out;
}

/**
 * HL7 v2 HMIS: the HMIS pushes ADT and pharmacy orders (MLLP listener or
 * POST /integration/hmis/hl7); dispenses (RDS^O13) and charges (DFT^P03) go
 * out over MLLP and must be acknowledged with AA. There is no query: patients
 * and visits are known from what the HMIS sends.
 */
export class Hl7HmisAdapter implements HmisAdapter {
  readonly kind = HmisAdapterKind.HL7;
  readonly canRead = false;
  constructor(
    private readonly t: MllpTransport,
    private readonly header: Hl7Header,
  ) {}

  async ping(timeoutMs: number) {
    // An ACK to an ACK is not expected; a connection that accepts the frame is enough.
    const r = await this.t(buildDft({ chargeId: 'PING', reversesExternalId: null, patientExternalId: 'PING', encounterExternalId: null, source: 'PING', sourceNo: null, itemCode: 'PING', description: 'Connection test (ignore)', quantity: 0, unitPrice: 0, amount: 0, currency: 'KES', occurredAt: new Date().toISOString(), enteredBy: 'system' }, this.header), timeoutMs);
    if (r.error) return { ok: false, detail: r.error };
    try {
      const a = readAck(r.reply ?? '');
      return { ok: true, detail: `HL7 v2 over MLLP: ACK ${a.code}${a.text ? ` (${a.text})` : ''}` };
    } catch {
      return { ok: true, detail: 'HL7 v2 over MLLP: connected (reply was not an ACK)' };
    }
  }

  private unsupported(): never {
    throw new Hl7Error('Not available over HL7 v2: the HMIS sends patients and visits (ADT) itself');
  }
  async searchPatients(): Promise<InboundItem[]> {
    return this.unsupported();
  }
  async fetchPatient(): Promise<InboundItem[]> {
    return this.unsupported();
  }
  async fetchEncounter(): Promise<InboundItem[]> {
    return this.unsupported();
  }
  async pollOrders(since: Date | null) {
    return { items: [] as InboundItem[], cursor: since };
  }

  async send(req: OutboundRequest, timeoutMs: number): Promise<SendResult> {
    const dispense = req.type === HmisMessageType.MEDICATION_DISPENSE;
    const message = dispense ? buildRds(req.payload as DispenseOut, this.header) : buildDft(req.payload as ChargeOut, this.header);
    const request = { hl7: message };
    const r = await this.t(message, timeoutMs);
    if (r.error) return { ok: false, retryable: true, status: null, externalId: null, error: r.error, request, response: null };
    let ack;
    try {
      ack = readAck(r.reply ?? '');
    } catch (e) {
      return { ok: false, retryable: true, status: null, externalId: null, error: `Unreadable reply: ${(e as Error).message}`, request, response: { hl7: r.reply } };
    }
    // AE (application error) may clear on a later try; AR (rejected) will not.
    const id = dispense ? (req.payload as DispenseOut).dispenseLineId : (req.payload as ChargeOut).chargeId;
    return {
      ok: ack.ok,
      retryable: !ack.ok && ack.code !== 'AR' && ack.code !== 'CR',
      status: null,
      externalId: ack.ok ? id : null,
      error: ack.ok ? null : `ACK ${ack.code}: ${ack.text || 'no reason given'}`,
      request,
      response: { hl7: r.reply, code: ack.code },
    };
  }
}

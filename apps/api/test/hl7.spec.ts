import { HmisMessageType, Sex, SupplyMode } from '@sil/shared';
import { buildAck, buildDft, buildRds, esc, hl7Date, parseHl7, readAck, val } from '../src/modules/hmis/hl7';
import { Hl7HmisAdapter, itemsFromHl7, mllpFrames } from '../src/modules/hmis/hl7-adapter';
import { MockHl7Peer, mockHl7Transport } from '../src/modules/hmis/mock/mock-hmis';
import { seg } from './hl7-fixtures';

const SYS = 'urn:sil:hospital-no';

const adt = (ctl: string, pid = 'P-77', mrn = 'SIL-9001', extra = '') =>
  [
    `MSH|^~\\&|HMIS|KNH|SIL-PIS|SIL|20261026101500+0300||ADT^A01^ADT_A01|${ctl}|P|2.5.1`,
    `PID|1||${pid}^^^HMIS^PI~${mrn}^^^SIL^MR||Kariuki^James^M||19750412|M|||||0722000111`,
    `PV1|1|I|WARD-MED^^B-12||||D01^Achieng^Mary||||||||||||V-5001|||||||||||||||||||||||||20261025080000+0300`,
    `AL1|1|DA|^Penicillins`,
    `IN1|1|PLAN1|ALPHA|Alpha Health Insurance${extra}`,
  ].join('\r');

describe('HL7 v2 (HMIS)', () => {
  it('parses segments, components, repetitions and escapes', () => {
    const m = parseHl7(`MSH|^~\\&|A|B|C|D|20260101||ADT^A08|X1|P|2.5.1\rPID|1||1^^^H^PI~2^^^H^MR||O\\T\\Brien^Pat\\F\\X`);
    const pid = m.segments[1];
    expect(val(m.segments[0], 9, 2)).toBe('A08');
    expect(val(m.segments[0], 10)).toBe('X1');
    expect(val(pid, 3, 1, 1, 1)).toBe('2');
    expect(val(pid, 3, 5, 1, 1)).toBe('MR');
    expect(val(pid, 5, 1)).toBe('O&Brien');
    expect(val(pid, 5, 2)).toBe('Pat|X');
    expect(esc('a|b^c&d~e\\f')).toBe('a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f');
    expect(hl7Date('19750412', true)).toBe('1975-04-12');
    expect(hl7Date('20261025080000+0300')).toBe('2026-10-25T05:00:00.000Z');
    expect(() => parseHl7('PID|1')).toThrow(/MSH/);
  });

  it('reads ADT into patient (MR / PI ids, allergies replace), visit (ward, bed, class, payer) items keyed by control id', () => {
    const items = itemsFromHl7(adt('C-1'), SYS);
    expect(items.map((i) => [i.type, i.key])).toEqual([
      [HmisMessageType.PATIENT, 'HL7:C-1:PATIENT:P-77'],
      [HmisMessageType.ENCOUNTER, 'HL7:C-1:ENCOUNTER:V-5001'],
    ]);
    expect(items[0]).toMatchObject({ allergies: ['penicillins'], data: { externalId: 'P-77', hospitalNo: 'SIL-9001', name: 'James M Kariuki', dateOfBirth: '1975-04-12', sex: Sex.M, payerCode: 'ALPHA', phone: '0722000111' } });
    expect(items[1]).toMatchObject({ data: { class: 'IPD', status: 'ACTIVE', wardCode: 'WARD-MED', bed: 'B-12', attending: 'Dr. Mary Achieng', payerCode: 'ALPHA' } });
    const discharge = itemsFromHl7(adt('C-2').replace('ADT^A01^ADT_A01', 'ADT^A03^ADT_A03'), SYS);
    expect(discharge[1]).toMatchObject({ data: { status: 'FINISHED' } });
    expect(itemsFromHl7(adt('C-3').replace('ADT^A01', 'ORU^R01'), SYS)[0]).toMatchObject({ error: expect.stringMatching(/ORU\^R01 is not read/) });
    expect(itemsFromHl7('garbage', SYS)[0]).toMatchObject({ error: expect.stringMatching(/Not an HL7 v2 message/) });
  });

  it('reads RDE^O11 orders: code, dose × frequency × duration, supply mode, location; ORC-1 DC stops', () => {
    const rde = [
      'MSH|^~\\&|HMIS|KNH|SIL-PIS|SIL|20261026101500||RDE^O11^RDE_O11|R-1|P|2.5.1',
      'PID|1||P-77^^^HMIS^PI~SIL-9001^^^SIL^MR||Kariuki^James',
      'PV1|1|I|WARD-MED^^B-12||||||||||||||||V-5001',
      'ORC|NW|ORD-1|||||||20261026100000|||KMPDC-9^Odhiambo^Peter',
      seg('RXE', { 2: 'PARA500^Paracetamol 500 mg^HMIS^ITM-1^Panadol^SIL', 3: '2', 5: 'tab', 21: 'Take with food^Take with food', 40: 'IPD-PH', 45: 'DAILY' }),
      'TQ1|1||QID|||5^d',
      'RXR|PO^Oral',
      'ORC|DC|ORD-2',
      'RXE||AMOX500^Amoxicillin 500 mg^HMIS|1||cap|||||21',
    ].join('\r');
    const items = itemsFromHl7(rde, SYS);
    expect(items.map((i) => i.type)).toEqual([HmisMessageType.PATIENT, HmisMessageType.ENCOUNTER, HmisMessageType.MEDICATION_REQUEST, HmisMessageType.MEDICATION_REQUEST]);
    expect('allergies' in items[0]).toBe(false);
    expect(items[2]).toMatchObject({
      key: 'HL7:R-1:ORDER:ORD-1',
      data: {
        externalId: 'ORD-1', status: 'active', patientExternalId: 'P-77', encounterExternalId: 'V-5001', prescriber: 'Dr. Peter Odhiambo', prescriberRegNo: 'KMPDC-9',
        drugCodes: [{ code: 'PARA500', display: 'Paracetamol 500 mg' }, { code: 'ITM-1', display: 'Panadol' }],
        dose: '2 tab', frequency: 'QID', duration: '5 days', dailyQuantity: 8, quantity: 40, supplyMode: SupplyMode.DAILY, route: 'Oral', locationCode: 'IPD-PH', instructions: 'Take with food',
      },
    });
    expect(items[3]).toMatchObject({ data: { externalId: 'ORD-2', status: 'stopped', quantity: 21 } });
  });

  it('builds RDS^O13 and DFT^P03, and reads and writes ACKs', () => {
    const h = { sendingApp: 'SIL-PIS', sendingFacility: 'SIL', receivingApp: 'HMIS', receivingFacility: 'KNH' };
    const rds = parseHl7(buildRds({ dispenseLineId: 'dl-1', dispenseNo: 'DSP/1', status: 'completed', orderExternalId: 'ORD-1', patientExternalId: 'P-77', encounterExternalId: 'V-5001', hmisDrugCode: 'PARA500', itemCode: 'ITM-1', itemName: 'Panadol 500|tabs', quantity: 8, unit: 'TAB', batchNo: 'B1', expiryDate: '2027-03-31', dispensedAt: '2026-10-26T07:00:00Z', dispensedBy: 'Pharm', substituted: true, note: null }, h, 'CTL-1'));
    const rxd = rds.segments.find((s) => s.name === 'RXD')!;
    expect(val(rds.segments[0], 9, 1)).toBe('RDS');
    expect(val(rds.segments.find((s) => s.name === 'ORC'), 2)).toBe('ORD-1');
    expect([val(rxd, 2, 1), val(rxd, 2, 5), val(rxd, 4), val(rxd, 9), val(rxd, 14), val(rxd, 15)]).toEqual(['PARA500', 'Panadol 500|tabs', '8', 'G', 'B1', '20270331']);
    const dft = parseHl7(buildDft({ chargeId: 'ch-2', reversesExternalId: 'ch-1', patientExternalId: 'P-77', encounterExternalId: null, source: 'DISPENSE', sourceNo: 'DSP/1', itemCode: 'ITM-1', description: 'Panadol', quantity: -2, unitPrice: 5, amount: -10, currency: 'KES', occurredAt: '2026-10-26T07:00:00Z', enteredBy: 'x' }, h));
    const ft1 = dft.segments.find((s) => s.name === 'FT1')!;
    expect([val(ft1, 2), val(ft1, 6), val(ft1, 10), val(ft1, 11, 1), val(ft1, 19)]).toEqual(['ch-2', 'CD', '2', '10', 'ch-1']);
    expect(dft.segments.some((s) => s.name === 'PV1')).toBe(false);
    const ack = buildAck(parseHl7(adt('Z-9')), 'AE', 'Unmapped drug code X', h);
    expect(readAck(ack)).toMatchObject({ ok: false, code: 'AE', controlId: 'Z-9', text: 'Unmapped drug code X' });
  });

  it('frames MLLP streams', () => {
    expect(mllpFrames('\x0bA\x1c\r\x0bB\x1c\r\x0bC')).toEqual({ messages: ['A', 'B'], rest: '\x0bC' });
  });

  it('sends over the HL7 adapter: AA is accepted, AE is retried, AR fails, no answer is retried', async () => {
    const peer = new MockHl7Peer();
    const a = new Hl7HmisAdapter(mockHl7Transport(peer), { sendingApp: 'SIL-PIS', sendingFacility: 'SIL', receivingApp: 'HMIS', receivingFacility: 'KNH' });
    expect(a.canRead).toBe(false);
    await expect(a.searchPatients()).rejects.toThrow(/HL7 v2/);
    const charge = { chargeId: 'c1', reversesExternalId: null, patientExternalId: 'P-77', encounterExternalId: 'V-1', source: 'DISPENSE', sourceNo: 'DSP/1', itemCode: 'I', description: 'D', quantity: 1, unitPrice: 2, amount: 2, currency: 'KES', occurredAt: new Date().toISOString(), enteredBy: 'x' };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000)).toMatchObject({ ok: true, externalId: 'c1' });
    expect(peer.received).toHaveLength(1);
    peer.failure = { mode: 'AE', count: 1 };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000)).toMatchObject({ ok: false, retryable: true, error: expect.stringMatching(/ACK AE/) });
    peer.failure = { mode: 'AR', count: 1 };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000)).toMatchObject({ ok: false, retryable: false });
    peer.failure = { mode: 'offline', count: 1 };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000)).toMatchObject({ ok: false, retryable: true, error: expect.stringMatching(/Network error/) });
  });
});

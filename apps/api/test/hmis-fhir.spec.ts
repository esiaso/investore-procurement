import { EncounterClass, EncounterStatus, HmisMessageType, Sex, SupplyMode } from '@sil/shared';
import { EXT, parseEncounter, parseMedicationRequest, parsePatient, toChargeItem, toMedicationDispense } from '../src/modules/hmis/fhir';
import { FhirHmisAdapter, itemsFromFhir, itemsFromRest, mockTransport } from '../src/modules/hmis/hmis-adapter';
import { MockHmis, seedMockHmis } from '../src/modules/hmis/mock/mock-hmis';
import { HmisAdapterKind } from '@sil/shared';

const SYS = 'urn:sil:hospital-no';

describe('FHIR R4 mapping (HMIS)', () => {
  it('reads a Patient: hospital number by system, else MR type; name; sex; payer and pregnancy extensions', () => {
    const p = parsePatient(
      {
        resourceType: 'Patient',
        id: 'p1',
        identifier: [{ system: 'urn:other', value: 'X-1' }, { system: SYS, value: 'SIL-1' }],
        name: [{ use: 'official', given: ['Achieng', 'Mary'], family: 'Odhiambo' }],
        gender: 'female',
        birthDate: '1990-02-03',
        telecom: [{ system: 'phone', value: '0712345678' }],
        extension: [
          { url: EXT.payer, valueCoding: { code: 'ALPHA' } },
          { url: EXT.memberNo, valueString: 'M-1' },
          { url: EXT.pregnant, valueBoolean: true },
          { url: EXT.weightKg, valueDecimal: 61.5 },
        ],
      },
      SYS,
    );
    expect(p).toEqual({ externalId: 'p1', hospitalNo: 'SIL-1', name: 'Achieng Mary Odhiambo', dateOfBirth: '1990-02-03', sex: Sex.F, weightKg: 61.5, isPregnant: true, payerCode: 'ALPHA', memberNo: 'M-1', phone: '0712345678', active: true });
    expect(parsePatient({ resourceType: 'Patient', id: 'p2', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'MR-9' }], name: [{ text: 'Juma' }], gender: 'male', extension: [{ url: EXT.pregnant, valueBoolean: true }] }, SYS)).toMatchObject({ hospitalNo: 'MR-9', name: 'Juma', sex: Sex.M, isPregnant: false });
    expect(() => parsePatient({ resourceType: 'Patient', id: 'p3', name: [{ text: 'No number' }] }, SYS)).toThrow(/no hospital number/);
  });

  it('reads an Encounter: class, status, ward and bed, payer', () => {
    const e = parseEncounter({
      resourceType: 'Encounter',
      id: 'e1',
      status: 'in-progress',
      class: { code: 'IMP' },
      subject: { reference: 'Patient/p1' },
      period: { start: '2026-10-20T08:00:00Z' },
      location: [
        { location: { identifier: { value: 'W-MED' } }, physicalType: { coding: [{ code: 'wa' }] }, status: 'active' },
        { location: { display: 'Bed 4' }, physicalType: { coding: [{ code: 'bd' }] }, status: 'active' },
        { location: { identifier: { value: 'W-OLD' } }, physicalType: { coding: [{ code: 'wa' }] }, status: 'completed' },
      ],
      extension: [{ url: EXT.payer, valueCoding: { code: 'ALPHA' } }],
    });
    expect(e).toMatchObject({ externalId: 'e1', patientExternalId: 'p1', class: EncounterClass.IPD, status: EncounterStatus.ACTIVE, wardCode: 'W-MED', bed: 'Bed 4', payerCode: 'ALPHA' });
    expect(parseEncounter({ resourceType: 'Encounter', id: 'e2', status: 'finished', class: { code: 'EMER' }, subject: { reference: 'Patient/p1' } })).toMatchObject({ class: EncounterClass.EMERGENCY, status: EncounterStatus.FINISHED, wardCode: null });
  });

  it('reads a MedicationRequest: dose, frequency, quantity from dose × frequency × duration, supply mode, group and location', () => {
    const o = parseMedicationRequest({
      resourceType: 'MedicationRequest',
      id: 'mr1',
      status: 'active',
      groupIdentifier: { value: 'G1' },
      subject: { reference: 'Patient/p1' },
      encounter: { reference: 'Encounter/e1' },
      requester: { display: 'Dr. A', identifier: { value: 'KMPDC-1' } },
      medicationCodeableConcept: { coding: [{ system: 'urn:x', code: 'PARA', display: 'Paracetamol 500 mg' }] },
      extension: [{ url: EXT.supplyMode, valueCode: 'daily' }],
      dosageInstruction: [{ timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: 2, unit: 'tab' } }], route: { text: 'Oral' } }],
      dispenseRequest: { expectedSupplyDuration: { value: 5, unit: 'days', code: 'd' }, performer: { identifier: { value: 'IPD-PH' } } },
    });
    expect(o).toMatchObject({
      externalId: 'mr1', groupId: 'G1', status: 'active', patientExternalId: 'p1', encounterExternalId: 'e1', prescriber: 'Dr. A', prescriberRegNo: 'KMPDC-1',
      drugCodes: [{ system: 'urn:x', code: 'PARA', display: 'Paracetamol 500 mg' }],
      dose: '2 tab', frequency: 'TDS', duration: '5 days', route: 'Oral', dailyQuantity: 6, quantity: 30, supplyMode: SupplyMode.DAILY, locationCode: 'IPD-PH',
    });
    // Explicit quantity wins; a non-countable dose gives no daily quantity; no group → own id.
    const syrup = parseMedicationRequest({
      resourceType: 'MedicationRequest', id: 'mr2', status: 'active', subject: { reference: 'Patient/p1' }, medicationCodeableConcept: { text: 'Amoxicillin susp' },
      dosageInstruction: [{ timing: { code: { text: 'BD' } }, doseAndRate: [{ doseQuantity: { value: 5, unit: 'mL' } }] }], dispenseRequest: { quantity: { value: 100 } },
    });
    expect(syrup).toMatchObject({ groupId: 'mr2', quantity: 100, dailyQuantity: null, frequency: 'BD', drugCodes: [], drugText: 'Amoxicillin susp', supplyMode: SupplyMode.STANDARD });
    expect(() => parseMedicationRequest({ resourceType: 'MedicationRequest', id: 'mr3', subject: { reference: 'Patient/p1' }, medicationReference: { reference: 'Medication/1' } })).toThrow(/medicationReference/);
  });

  it('renders MedicationDispense (batch, order, substitution) and ChargeItem (price, reversal)', () => {
    const md = toMedicationDispense({
      dispenseLineId: 'dl1', dispenseNo: 'DSP/1', status: 'completed', orderExternalId: 'mr1', patientExternalId: 'p1', encounterExternalId: 'e1', hmisDrugCode: 'PARA',
      itemCode: 'ITM1', itemName: 'Panadol 500', quantity: 6, unit: 'TAB', batchNo: 'B1', expiryDate: '2027-01-31', dispensedAt: '2026-10-26T10:00:00Z', dispensedBy: 'Pharm A', substituted: true, note: null,
    });
    expect(md).toMatchObject({
      resourceType: 'MedicationDispense',
      identifier: [{ system: 'urn:sil:dispense-line', value: 'dl1' }],
      subject: { reference: 'Patient/p1' },
      context: { reference: 'Encounter/e1' },
      authorizingPrescription: [{ reference: 'MedicationRequest/mr1' }],
      quantity: { value: 6, unit: 'TAB' },
      substitution: { wasSubstituted: true },
      contained: [{ resourceType: 'Medication', batch: { lotNumber: 'B1', expirationDate: '2027-01-31' } }],
    });
    const ci = toChargeItem({ chargeId: 'c2', reversesExternalId: 'ci-1', patientExternalId: 'p1', encounterExternalId: null, source: 'DISPENSE', sourceNo: 'DSP/1', itemCode: 'ITM1', description: 'Reversal', quantity: -2, unitPrice: 5, amount: -10, currency: 'KES', occurredAt: '2026-10-26T10:00:00Z', enteredBy: 'Pharm A' });
    expect(ci).toMatchObject({ resourceType: 'ChargeItem', status: 'billable', quantity: { value: -2 }, priceOverride: { value: -10, currency: 'KES' }, partOf: [{ reference: 'ChargeItem/ci-1' }] });
    expect(ci.context).toBeUndefined();
  });

  it('turns Bundles and REST events into inbound items with stable version keys and readable errors', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1', meta: { versionId: '3' }, identifier: [{ system: SYS, value: 'S-1' }], name: [{ text: 'A' }] } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
        { resource: { resourceType: 'MedicationRequest', id: 'mr9', subject: { reference: 'Patient/p1' } } },
      ],
    };
    const items = itemsFromFhir(bundle, SYS);
    expect(items.map((i) => [i.type, i.key, 'error' in i ? i.error : null])).toEqual([
      [HmisMessageType.PATIENT, 'FHIR:Patient/p1/3', null],
      [HmisMessageType.MEDICATION_REQUEST, expect.stringMatching(/^FHIR:MedicationRequest\/mr9\/[0-9a-f]{16}$/), expect.stringMatching(/no medicationCodeableConcept/)],
    ]);
    expect(itemsFromFhir(bundle, SYS)[1].key).toBe(items[1].key);
    const rest = itemsFromRest({ type: 'order', data: [{ externalId: 'o1', patientExternalId: 'p1', drugCodes: ['PARA'], quantity: 10 }, { externalId: 'o2' }] });
    expect(rest[0]).toMatchObject({ type: HmisMessageType.MEDICATION_REQUEST, data: { groupId: 'o1', drugCodes: [{ code: 'PARA' }], quantity: 10, supplyMode: 'STANDARD' } });
    expect(rest[1]).toMatchObject({ error: 'Missing patientExternalId, drugCodes' });
    expect(itemsFromRest({ type: 'lab', data: {} })[0]).toMatchObject({ error: 'Unknown event type "lab"' });
  });

  it('talks to the mock over the FHIR adapter: search, read with allergies, poll since a cursor, conditional create', async () => {
    const mock = new MockHmis();
    seedMockHmis(mock, SYS);
    const a = new FhirHmisAdapter(HmisAdapterKind.MOCK, mockTransport(mock), SYS);
    expect((await a.ping(1000)).ok).toBe(true);
    expect((await a.searchPatients('SIL-000101', 1000)).map((i) => i.externalId)).toEqual(['pt-101']);
    expect((await a.searchPatients('hassan', 1000)).map((i) => i.externalId)).toEqual(['pt-103']);
    const read = await a.fetchPatient('pt-101', 1000);
    expect(read.map((i) => i.type)).toEqual([HmisMessageType.PATIENT, HmisMessageType.ALLERGY]);
    expect(await a.fetchPatient('nobody', 1000)).toEqual([]);

    const first = await a.pollOrders(null, 1000);
    expect(first.items).toEqual([]);
    mock.prescribe({ patient: 'pt-102', encounter: 'enc-102', lines: [{ code: 'X', quantity: 4 }] });
    const polled = await a.pollOrders(new Date(Date.now() - 60_000), 1000);
    expect(polled.items.map((i) => i.type)).toEqual([HmisMessageType.PATIENT, HmisMessageType.ENCOUNTER, HmisMessageType.MEDICATION_REQUEST]);
    expect((await a.pollOrders(polled.cursor, 1000)).items).toEqual([]);

    const charge = { chargeId: 'c1', reversesExternalId: null, patientExternalId: 'pt-102', encounterExternalId: 'enc-102', source: 'DISPENSE', sourceNo: null, itemCode: 'I', description: 'D', quantity: 1, unitPrice: 2, amount: 2, currency: 'KES', occurredAt: new Date().toISOString(), enteredBy: 'x' };
    const s1 = await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000);
    const s2 = await a.send({ type: HmisMessageType.CHARGE, payload: charge }, 1000);
    expect(s1).toMatchObject({ ok: true, status: 201 });
    expect(s2).toMatchObject({ ok: true, status: 200, externalId: s1.externalId });
    expect(mock.all('ChargeItem')).toHaveLength(1);

    mock.failure = { mode: 'http500', count: 1 };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: { ...charge, chargeId: 'c2' } }, 1000)).toMatchObject({ ok: false, retryable: true, status: 500 });
    mock.failure = { mode: 'http400', count: 1 };
    expect(await a.send({ type: HmisMessageType.CHARGE, payload: { ...charge, chargeId: 'c2' } }, 1000)).toMatchObject({ ok: false, retryable: false, status: 400 });
    mock.failure = { mode: 'offline', count: 1 };
    await expect(a.searchPatients('x', 1000)).rejects.toThrow(/Network error/);
  });
});

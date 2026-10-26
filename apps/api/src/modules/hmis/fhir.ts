/**
 * FHIR R4 ↔ neutral records. Only the elements this system uses are typed.
 * Inbound resources become PatientInfo / EncounterInfo / MedicationOrder;
 * outbound dispenses and charges are rendered as MedicationDispense / ChargeItem.
 * Where R4 leaves room (payer, weight, pregnancy, supply mode), SIL
 * extensions are used; they are listed in HMIS_ASSUMPTIONS.
 */
import { EncounterClass, EncounterStatus, Sex, SupplyMode } from '@sil/shared';

export const SIL_EXT = 'https://sil.health/fhir/StructureDefinition';
export const EXT = {
  weightKg: `${SIL_EXT}/weight-kg`,
  pregnant: `${SIL_EXT}/pregnant`,
  payer: `${SIL_EXT}/payer`,
  memberNo: `${SIL_EXT}/member-no`,
  supplyMode: `${SIL_EXT}/supply-mode`,
  dailyQuantity: `${SIL_EXT}/daily-quantity`,
  phone: `${SIL_EXT}/phone`,
} as const;
/** Identifier systems this system stamps on what it sends. */
export const SIL_SYSTEM = {
  dispense: 'urn:sil:dispense-line',
  charge: 'urn:sil:patient-charge',
  item: 'urn:sil:item-code',
  batch: 'urn:sil:batch',
} as const;

export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}
export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}
export interface Identifier {
  system?: string;
  value?: string;
  type?: CodeableConcept;
}
export interface Reference {
  reference?: string;
  identifier?: Identifier;
  display?: string;
}
export interface Extension {
  url: string;
  valueString?: string;
  valueBoolean?: boolean;
  valueDecimal?: number;
  valueCode?: string;
  valueCoding?: Coding;
}
export interface Quantity {
  value?: number;
  unit?: string;
  code?: string;
}
export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: { versionId?: string; lastUpdated?: string };
  [k: string]: unknown;
}
export interface Bundle extends FhirResource {
  resourceType: 'Bundle';
  type?: string;
  entry?: { resource?: FhirResource; fullUrl?: string }[];
}

// ------------------------------------------------------------------ neutral records

export interface PatientInfo {
  externalId: string;
  hospitalNo: string;
  name: string;
  dateOfBirth: string | null;
  sex: Sex | null;
  weightKg: number | null;
  isPregnant: boolean;
  payerCode: string | null;
  memberNo: string | null;
  phone: string | null;
  active: boolean;
}

export interface EncounterInfo {
  externalId: string;
  patientExternalId: string;
  class: EncounterClass;
  status: EncounterStatus;
  wardCode: string | null;
  bed: string | null;
  payerCode: string | null;
  memberNo: string | null;
  attending: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AllergyInfo {
  externalId: string | null;
  patientExternalId: string;
  substance: string;
  active: boolean;
}

export type OrderStatus = 'active' | 'on-hold' | 'cancelled' | 'completed' | 'entered-in-error' | 'stopped' | 'draft' | 'unknown';

export interface MedicationOrder {
  externalId: string;
  /** Orders written together share a group (one prescription). */
  groupId: string;
  status: OrderStatus;
  patientExternalId: string;
  encounterExternalId: string | null;
  prescriber: string;
  prescriberRegNo: string | null;
  authoredOn: string | null;
  drugCodes: { system: string | null; code: string; display: string | null }[];
  drugText: string | null;
  dose: string;
  frequency: string;
  duration: string | null;
  route: string | null;
  /** Base units to supply; null when only a daily quantity is known. */
  quantity: number | null;
  dailyQuantity: number | null;
  supplyMode: SupplyMode;
  /** Dispensing location code (dispenseRequest.performer). */
  locationCode: string | null;
  instructions: string | null;
}

/** Neutral outbound dispense (one per batch dispensed). */
export interface DispenseOut {
  dispenseLineId: string;
  dispenseNo: string;
  status: 'completed' | 'entered-in-error';
  orderExternalId: string | null;
  patientExternalId: string;
  encounterExternalId: string | null;
  hmisDrugCode: string | null;
  itemCode: string;
  itemName: string;
  quantity: number;
  unit: string | null;
  batchNo: string;
  expiryDate: string | null;
  dispensedAt: string;
  dispensedBy: string;
  substituted: boolean;
  note: string | null;
}

/** Neutral outbound charge to the patient's HMIS bill. */
export interface ChargeOut {
  chargeId: string;
  /** HMIS id of the charge this one reverses. */
  reversesExternalId: string | null;
  patientExternalId: string;
  encounterExternalId: string | null;
  source: string;
  sourceNo: string | null;
  itemCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
  occurredAt: string;
  enteredBy: string;
}

// ------------------------------------------------------------------ helpers

const ext = (r: { extension?: Extension[] } | undefined, url: string) => r?.extension?.find((e) => e.url === url);
const refId = (ref: Reference | undefined): string | null => {
  if (!ref?.reference) return ref?.identifier?.value ?? null;
  const parts = ref.reference.split('/');
  return parts[parts.length - 1] || null;
};
const text = (cc: CodeableConcept | undefined): string | null => cc?.text ?? cc?.coding?.find((c) => c.display)?.display ?? cc?.coding?.[0]?.code ?? null;

/** Resources in a Bundle (or the resource itself). */
export function resourcesOf(body: FhirResource): FhirResource[] {
  if (body.resourceType !== 'Bundle') return [body];
  return ((body as Bundle).entry ?? []).map((e) => e.resource).filter((r): r is FhirResource => !!r && typeof r.resourceType === 'string');
}

/** Same resource version → same key (the meta.versionId, else the content hash supplied by the caller). */
export function versionKey(r: FhirResource, contentHash: string): string {
  return `${r.resourceType}/${r.id ?? 'no-id'}/${r.meta?.versionId ?? contentHash}`;
}

// ------------------------------------------------------------------ inbound

export function parsePatient(r: FhirResource, hospitalNoSystem: string): PatientInfo {
  if (r.resourceType !== 'Patient' || !r.id) throw new FhirError('Not a Patient with an id');
  const ids = (r.identifier as Identifier[] | undefined) ?? [];
  const mrn =
    ids.find((i) => i.system === hospitalNoSystem) ??
    ids.find((i) => i.type?.coding?.some((c) => c.code === 'MR')) ??
    ids[0];
  if (!mrn?.value) throw new FhirError(`Patient ${r.id} has no hospital number (identifier ${hospitalNoSystem})`);
  const names = (r.name as { text?: string; given?: string[]; family?: string; use?: string }[] | undefined) ?? [];
  const n = names.find((x) => x.use === 'official') ?? names[0];
  const name = n?.text ?? [...(n?.given ?? []), n?.family].filter(Boolean).join(' ');
  if (!name) throw new FhirError(`Patient ${r.id} has no name`);
  const gender = r.gender as string | undefined;
  const telecom = (r.telecom as { system?: string; value?: string }[] | undefined) ?? [];
  const payer = ext(r as { extension?: Extension[] }, EXT.payer);
  return {
    externalId: r.id,
    hospitalNo: mrn.value.slice(0, 40),
    name: name.slice(0, 200),
    dateOfBirth: typeof r.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.birthDate) ? r.birthDate : null,
    sex: gender === 'female' ? Sex.F : gender === 'male' ? Sex.M : gender === 'other' ? Sex.OTHER : null,
    weightKg: ext(r as { extension?: Extension[] }, EXT.weightKg)?.valueDecimal ?? null,
    isPregnant: gender === 'female' && ext(r as { extension?: Extension[] }, EXT.pregnant)?.valueBoolean === true,
    payerCode: payer?.valueCoding?.code ?? payer?.valueCode ?? null,
    memberNo: ext(r as { extension?: Extension[] }, EXT.memberNo)?.valueString ?? null,
    phone: (telecom.find((t) => t.system === 'phone')?.value ?? ext(r as { extension?: Extension[] }, EXT.phone)?.valueString ?? null)?.slice(0, 20) ?? null,
    active: r.active !== false,
  };
}

const ENCOUNTER_CLASS: Record<string, EncounterClass> = {
  AMB: EncounterClass.OPD,
  OBSENC: EncounterClass.OPD,
  HH: EncounterClass.OPD,
  VR: EncounterClass.OPD,
  IMP: EncounterClass.IPD,
  ACUTE: EncounterClass.IPD,
  NONAC: EncounterClass.IPD,
  PRENC: EncounterClass.OPD,
  EMER: EncounterClass.EMERGENCY,
  SS: EncounterClass.DAY_CASE,
};

export function parseEncounter(r: FhirResource): EncounterInfo {
  if (r.resourceType !== 'Encounter' || !r.id) throw new FhirError('Not an Encounter with an id');
  const patient = refId(r.subject as Reference);
  if (!patient) throw new FhirError(`Encounter ${r.id} has no subject`);
  const cls = (r.class as Coding | undefined)?.code ?? 'AMB';
  const st = r.status as string | undefined;
  const status =
    st === 'finished' ? EncounterStatus.FINISHED : st === 'cancelled' || st === 'entered-in-error' ? EncounterStatus.CANCELLED : EncounterStatus.ACTIVE;
  const locations = (r.location as { location?: Reference; physicalType?: CodeableConcept; status?: string }[] | undefined) ?? [];
  const current = locations.filter((l) => l.status !== 'completed');
  const typed = (code: string) => current.find((l) => l.physicalType?.coding?.some((c) => c.code === code));
  const ward = typed('wa') ?? current.find((l) => !l.physicalType) ?? current[0];
  const bed = typed('bd');
  const period = (r.period as { start?: string; end?: string } | undefined) ?? {};
  const participants = (r.participant as { individual?: Reference }[] | undefined) ?? [];
  const payer = ext(r as { extension?: Extension[] }, EXT.payer);
  return {
    externalId: r.id,
    patientExternalId: patient,
    class: ENCOUNTER_CLASS[cls] ?? EncounterClass.OPD,
    status,
    wardCode: ward?.location?.identifier?.value ?? refId(ward?.location) ?? null,
    bed: (bed?.location?.display ?? bed?.location?.identifier?.value ?? null)?.slice(0, 40) ?? null,
    payerCode: payer?.valueCoding?.code ?? payer?.valueCode ?? null,
    memberNo: ext(r as { extension?: Extension[] }, EXT.memberNo)?.valueString ?? null,
    attending: participants[0]?.individual?.display?.slice(0, 200) ?? null,
    startedAt: period.start ?? null,
    endedAt: period.end ?? null,
  };
}

export function parseAllergy(r: FhirResource): AllergyInfo {
  if (r.resourceType !== 'AllergyIntolerance') throw new FhirError('Not an AllergyIntolerance');
  const patient = refId(r.patient as Reference);
  if (!patient) throw new FhirError('AllergyIntolerance has no patient');
  const substance = text(r.code as CodeableConcept);
  if (!substance) throw new FhirError('AllergyIntolerance has no substance');
  const clinical = (r.clinicalStatus as CodeableConcept | undefined)?.coding?.[0]?.code;
  const verification = (r.verificationStatus as CodeableConcept | undefined)?.coding?.[0]?.code;
  return {
    externalId: r.id ?? null,
    patientExternalId: patient,
    substance: substance.trim().toLowerCase().slice(0, 100),
    active: clinical !== 'inactive' && clinical !== 'resolved' && verification !== 'refuted' && verification !== 'entered-in-error',
  };
}

/** Times per day for common frequency codes. */
export const FREQUENCY_PER_DAY: Record<string, number> = { OD: 1, QD: 1, DAILY: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, QDS: 4, Q6H: 4, Q8H: 3, Q12H: 2, Q4H: 6, NOCTE: 1, MANE: 1 };
const PER_DAY_LABEL: Record<number, string> = { 1: 'OD', 2: 'BD', 3: 'TDS', 4: 'QID', 6: 'Q4H' };
const DAYS: Record<string, number> = { d: 1, wk: 7, mo: 30, h: 1 / 24 };
/** Dose units that are counted (so dose × frequency gives base units). */
const COUNT_UNITS = /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|\{tbl\}|\{cap\}|1|each|ea|unit|units|sachet|sachets|suppository|pessary|puff|puffs|vial|vials|amp|ampoule|ampoules)$/i;

interface Dosage {
  text?: string;
  route?: CodeableConcept;
  patientInstruction?: string;
  timing?: { code?: CodeableConcept; repeat?: { frequency?: number; period?: number; periodUnit?: string; boundsDuration?: Quantity } };
  doseAndRate?: { doseQuantity?: Quantity }[];
}

export function parseMedicationRequest(r: FhirResource): MedicationOrder {
  if (r.resourceType !== 'MedicationRequest' || !r.id) throw new FhirError('Not a MedicationRequest with an id');
  const patient = refId(r.subject as Reference);
  if (!patient) throw new FhirError(`MedicationRequest ${r.id} has no subject`);
  const med = r.medicationCodeableConcept as CodeableConcept | undefined;
  if (!med?.coding?.length && !med?.text) throw new FhirError(`MedicationRequest ${r.id} has no medicationCodeableConcept (medicationReference is not supported)`);
  const dosage = ((r.dosageInstruction as Dosage[] | undefined) ?? [])[0] ?? {};
  const doseQ = dosage.doseAndRate?.[0]?.doseQuantity;
  const dose = doseQ?.value !== undefined ? `${doseQ.value}${doseQ.unit ? ` ${doseQ.unit}` : ''}` : (dosage.text ?? 'As directed');
  const rep = dosage.timing?.repeat;
  const timingCode = dosage.timing?.code?.coding?.[0]?.code ?? dosage.timing?.code?.text;
  let perDay: number | null = timingCode ? (FREQUENCY_PER_DAY[timingCode.toUpperCase()] ?? null) : null;
  if (perDay === null && rep?.frequency && rep.period && rep.periodUnit && DAYS[rep.periodUnit]) perDay = rep.frequency / (rep.period * DAYS[rep.periodUnit]);
  const frequency = timingCode ?? (perDay ? (PER_DAY_LABEL[perDay] ?? `${Math.round(perDay * 100) / 100}x daily`) : 'As directed');
  const dr = (r.dispenseRequest as { quantity?: Quantity; expectedSupplyDuration?: Quantity; performer?: Reference } | undefined) ?? {};
  const durationQ = dr.expectedSupplyDuration ?? rep?.boundsDuration;
  const durationDays = durationQ?.value !== undefined ? durationQ.value * (DAYS[durationQ.code ?? ''] ?? (/week/i.test(durationQ.unit ?? '') ? 7 : /month/i.test(durationQ.unit ?? '') ? 30 : 1)) : null;
  const duration = durationQ?.value !== undefined ? `${durationQ.value} ${durationQ.unit ?? durationQ.code ?? 'days'}` : null;
  const supplyExt = ext(r as { extension?: Extension[] }, EXT.supplyMode)?.valueCode?.toUpperCase();
  const supplyMode = supplyExt && supplyExt in SupplyMode ? (supplyExt as SupplyMode) : SupplyMode.STANDARD;
  const explicitDaily = ext(r as { extension?: Extension[] }, EXT.dailyQuantity)?.valueDecimal ?? null;
  const countable = doseQ?.value !== undefined && COUNT_UNITS.test((doseQ.code ?? doseQ.unit ?? '').trim());
  const dailyQuantity = explicitDaily ?? (countable && perDay ? Math.round(doseQ!.value! * perDay * 10_000) / 10_000 : null);
  let quantity = dr.quantity?.value ?? null;
  if (quantity === null && dailyQuantity !== null && durationDays) quantity = Math.ceil(dailyQuantity * durationDays);
  const requester = r.requester as Reference | undefined;
  const group = (r.groupIdentifier as Identifier | undefined)?.value;
  const notes = ((r.note as { text?: string }[] | undefined) ?? []).map((n) => n.text).filter(Boolean);
  return {
    externalId: r.id,
    groupId: group ?? r.id,
    status: ((r.status as string) ?? 'unknown') as OrderStatus,
    patientExternalId: patient,
    encounterExternalId: refId(r.encounter as Reference),
    prescriber: (requester?.display ?? requester?.identifier?.value ?? 'HMIS prescriber').slice(0, 200),
    prescriberRegNo: requester?.identifier?.value?.slice(0, 60) ?? null,
    authoredOn: (r.authoredOn as string) ?? null,
    drugCodes: (med.coding ?? []).filter((c) => c.code).map((c) => ({ system: c.system ?? null, code: c.code!, display: c.display ?? null })),
    drugText: med.text ?? med.coding?.find((c) => c.display)?.display ?? null,
    dose: dose.slice(0, 100),
    frequency: frequency.slice(0, 60),
    duration: duration?.slice(0, 60) ?? null,
    route: text(dosage.route)?.slice(0, 60) ?? null,
    quantity,
    dailyQuantity,
    supplyMode,
    locationCode: dr.performer?.identifier?.value ?? refId(dr.performer) ?? null,
    instructions: [dosage.patientInstruction, dosage.text && doseQ ? dosage.text : null, ...notes].filter(Boolean).join('; ').slice(0, 500) || null,
  };
}

// ------------------------------------------------------------------ outbound

export function toMedicationDispense(d: DispenseOut, existingId?: string | null): FhirResource {
  return {
    resourceType: 'MedicationDispense',
    ...(existingId ? { id: existingId } : {}),
    identifier: [{ system: SIL_SYSTEM.dispense, value: d.dispenseLineId }],
    status: d.status,
    contained: [
      {
        resourceType: 'Medication',
        id: 'med',
        code: {
          coding: [...(d.hmisDrugCode ? [{ code: d.hmisDrugCode }] : []), { system: SIL_SYSTEM.item, code: d.itemCode, display: d.itemName }],
          text: d.itemName,
        },
        batch: { lotNumber: d.batchNo, ...(d.expiryDate ? { expirationDate: d.expiryDate } : {}) },
      },
    ],
    medicationReference: { reference: '#med', display: d.itemName },
    subject: { reference: `Patient/${d.patientExternalId}` },
    ...(d.encounterExternalId ? { context: { reference: `Encounter/${d.encounterExternalId}` } } : {}),
    ...(d.orderExternalId ? { authorizingPrescription: [{ reference: `MedicationRequest/${d.orderExternalId}` }] } : {}),
    performer: [{ actor: { display: d.dispensedBy } }],
    quantity: { value: d.quantity, ...(d.unit ? { unit: d.unit } : {}) },
    whenHandedOver: d.dispensedAt,
    ...(d.substituted ? { substitution: { wasSubstituted: true, type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution', code: 'E', display: 'equivalent' }] } } } : {}),
    note: [{ text: `${d.dispenseNo}${d.note ? ` — ${d.note}` : ''}` }],
  };
}

export function toChargeItem(c: ChargeOut): FhirResource {
  return {
    resourceType: 'ChargeItem',
    identifier: [{ system: SIL_SYSTEM.charge, value: c.chargeId }],
    status: 'billable',
    code: { coding: [{ system: SIL_SYSTEM.item, code: c.itemCode, display: c.description }], text: c.description },
    subject: { reference: `Patient/${c.patientExternalId}` },
    ...(c.encounterExternalId ? { context: { reference: `Encounter/${c.encounterExternalId}` } } : {}),
    occurrenceDateTime: c.occurredAt,
    enterer: { display: c.enteredBy },
    quantity: { value: c.quantity },
    priceOverride: { value: c.amount, currency: c.currency },
    ...(c.reversesExternalId ? { partOf: [{ reference: `ChargeItem/${c.reversesExternalId}` }] } : {}),
    note: [{ text: `${c.source}${c.sourceNo ? ` ${c.sourceNo}` : ''}; unit price ${c.unitPrice} ${c.currency} (VAT inclusive)` }],
  };
}

export class FhirError extends Error {}

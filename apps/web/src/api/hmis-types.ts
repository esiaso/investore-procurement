import type { Payer, Patient } from './pharmacy-types';
import type { Item, Store } from './types';

export type HmisAdapterKind = 'FHIR' | 'REST' | 'HL7' | 'MOCK';
export type HmisBillingMode = 'LOCAL' | 'HMIS';
export type HmisMessageStatus = 'PENDING' | 'PROCESSED' | 'SENT' | 'FAILED' | 'IGNORED';
export type HmisMessageType = 'PATIENT' | 'ENCOUNTER' | 'ALLERGY' | 'MEDICATION_REQUEST' | 'MEDICATION_DISPENSE' | 'CHARGE';
export type HmisMappingKind = 'DRUG' | 'LOCATION' | 'WARD' | 'PAYER';
export type PatientChargeStatus = 'INVOICED' | 'PENDING' | 'POSTED' | 'FAILED';

export interface HmisConnection {
  id: string;
  code: string;
  name: string;
  adapter: HmisAdapterKind;
  baseUrl: string | null;
  authHeader: string;
  hasToken: boolean;
  hospitalNoSystem: string;
  billingMode: HmisBillingMode;
  sendDispenses: boolean;
  pollOrders: boolean;
  lastPolledAt: string | null;
  lastPollError: string | null;
  isActive: boolean;
}

export interface HmisMapping {
  id: string;
  kind: HmisMappingKind;
  externalCode: string;
  externalDisplay: string | null;
  localId: string;
  isItem: boolean;
  localName: string | null;
  localCode: string | null;
}

export interface HmisMessage {
  id: string;
  direction: 'IN' | 'OUT';
  type: HmisMessageType;
  status: HmisMessageStatus;
  idempotencyKey: string;
  externalId: string | null;
  via: string | null;
  localDocType: string | null;
  localDocId: string | null;
  localDocNo: string | null;
  patientId: string | null;
  encounterId: string | null;
  payload: Record<string, unknown>;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  httpStatus: number | null;
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  duplicates: number;
  createdAt: string;
  processedAt: string | null;
}

export interface HmisDashboard {
  connection: HmisConnection | null;
  counts: { direction: 'IN' | 'OUT'; status: HmisMessageStatus; n: number }[];
  failed: Pick<HmisMessage, 'id' | 'direction' | 'type' | 'status' | 'externalId' | 'localDocNo' | 'error' | 'attempts' | 'createdAt'>[];
  pending: { count: number; oldestAt: string | null };
  last24h: { direction: 'IN' | 'OUT'; type: HmisMessageType; n: number; duplicates: number }[];
  unmappedDrugs: { code: string; display: string | null; messages: number }[];
}

export interface Encounter {
  id: string;
  externalId: string;
  patientId: string;
  patient?: Patient;
  class: 'OPD' | 'IPD' | 'EMERGENCY' | 'DAY_CASE';
  status: 'ACTIVE' | 'FINISHED' | 'CANCELLED';
  departmentId: string | null;
  department?: { id: string; code: string; name: string } | null;
  wardCode: string | null;
  bed: string | null;
  payerId: string | null;
  payer?: Payer | null;
  memberNo: string | null;
  attending: string | null;
  startedAt: string | null;
  endedAt: string | null;
  syncedAt: string;
}

export interface PatientCharge {
  id: string;
  patientId: string;
  encounterId: string | null;
  source: 'DISPENSE' | 'ISSUE' | 'WARD_CONSUMPTION';
  sourceId: string;
  sourceNo: string | null;
  storeId: string | null;
  store?: Store | null;
  item?: Item;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  status: PatientChargeStatus;
  invoiceId: string | null;
  externalId: string | null;
  reversesId: string | null;
  note: string | null;
  createdAt: string;
}

export interface EncounterDetail extends Encounter {
  charges: PatientCharge[];
  prescriptions: { id: string; number: string; status: string; supplyMode: string; receivedAt: string; store: string }[];
  totals: { charged: number; pendingToHmis: number };
}

export interface HmisPatientHit {
  externalId: string;
  hospitalNo: string;
  name: string;
  dateOfBirth: string | null;
  sex: string | null;
  isPregnant: boolean;
  payerCode: string | null;
  patientId: string | null;
}

export interface WardSupplyLine {
  prescriptionId: string;
  prescriptionNo: string;
  status: string;
  supplyMode: 'DAILY' | 'UNIT_DOSE';
  prescriptionLineId: string;
  lineNo: number;
  genericId: string;
  generic: string;
  dose: string;
  frequency: string;
  route: string | null;
  dailyQuantity: number;
  givenToday: number;
  remaining: number;
  due: number;
  needsVerification: boolean;
}

export interface WardSupplyList {
  date: string;
  patients: { patientId: string; patient: string; hospitalNo: string; ward: string | null; bed: string | null; lines: WardSupplyLine[] }[];
}

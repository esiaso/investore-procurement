import type { Generic, Item, Store } from './types';

export type Severity = 'CONTRAINDICATED' | 'MAJOR' | 'MODERATE' | 'MINOR';
export type EtimsSync = 'NOT_REQUIRED' | 'PENDING' | 'SENT' | 'ACCEPTED' | 'FAILED';

export interface Payer {
  id: string;
  code: string;
  name: string;
  type: 'INSURANCE' | 'CORPORATE';
  kraPin: string | null;
  priceListId: string | null;
  coPayPercent: number;
  etimsInsuranceCode: string | null;
  isActive: boolean;
}

export interface Patient {
  id: string;
  hospitalNo: string;
  name: string;
  dateOfBirth: string | null;
  sex: 'F' | 'M' | 'OTHER' | null;
  weightKg: number | null;
  isPregnant: boolean;
  payerId: string | null;
  payer?: Payer | null;
  memberNo: string | null;
  allergies: string[];
  phone: string | null;
  kraPin: string | null;
  /** HMIS patient id (null: entered here). */
  externalId?: string | null;
  syncedAt?: string | null;
}

export interface InteractionOverride {
  id: string;
  reason: string;
  pharmacistId: string;
  at: string;
}

export interface ClinicalAlert {
  id: string;
  type: 'INTERACTION' | 'ALLERGY' | 'DUPLICATE_THERAPY' | 'AGE' | 'PREGNANCY';
  severity: Severity;
  message: string;
  management: string | null;
  lineIds: string[];
  blocking: boolean;
  override: InteractionOverride | null;
  createdAt: string;
}

export interface PrescriptionLine {
  id: string;
  lineNo: number;
  genericId: string;
  generic?: Generic;
  preferredItemId: string | null;
  dose: string;
  frequency: string;
  duration: string | null;
  route: string | null;
  quantity: number;
  dispensedQty: number;
  cancelledQty: number;
  instructions: string | null;
  externalRef?: string | null;
  hmisDrugCode?: string | null;
  dailyQuantity?: number | null;
}

export interface DispenseLine {
  id: string;
  prescriptionLineId: string;
  itemId: string;
  item?: Item;
  substituted: boolean;
  batchId: string;
  batch?: { id: string; batchNo: string; expiryDate: string | null };
  quantity: number;
  returnedQty: number;
}

export interface Dispense {
  id: string;
  number: string;
  dispensedAt: string;
  dispensedBy: string;
  invoiceId: string | null;
  billingMode?: 'LOCAL' | 'HMIS';
  fefoOverrideReason: string | null;
  lines: DispenseLine[];
}

export interface Prescription {
  id: string;
  number: string;
  status: 'RECEIVED' | 'VERIFIED' | 'PARTIALLY_DISPENSED' | 'DISPENSED' | 'CLOSED' | 'CANCELLED';
  patientId: string;
  patient?: Patient;
  storeId: string;
  store?: Store;
  prescriber: string;
  prescriberRegNo: string | null;
  encounterRef: string | null;
  encounterId?: string | null;
  encounter?: { id: string; externalId: string; class: string; status: string; bed: string | null; department?: { name: string } | null; payer?: Payer | null } | null;
  supplyMode?: 'STANDARD' | 'DAILY' | 'UNIT_DOSE';
  /** Who bills the next dispense. */
  billingMode?: 'LOCAL' | 'HMIS';
  receivedAt: string;
  verifiedAt: string | null;
  firstDispensedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  lines?: PrescriptionLine[];
  alerts?: ClinicalAlert[];
  dispenses?: Dispense[];
  invoices?: { id: string; number: string; docType: string; totalAmount: number; etimsStatus: EtimsSync; cuInvoiceNo: string | null; sourceId: string | null }[];
  charges?: { id: string; sourceId: string; description: string; quantity: number; amount: number; status: string; externalId: string | null; reversesId: string | null }[];
  hmisMessages?: { id: string; type: string; status: string; localDocNo: string | null; externalId: string | null; attempts: number; error: string | null; createdAt: string; processedAt: string | null }[];
}

export interface WorklistRow extends Omit<Prescription, 'alerts'> {
  waitingMinutes: number;
  alerts: { highest: Severity; openBlocking: number; total: number } | null;
}

export interface BrandOption {
  prescriptionLineId: string;
  genericId: string;
  remaining: number;
  preferredItemId: string | null;
  brands: { itemId: string; code: string; name: string; brandName: string | null; available: number; earliestExpiry: string | null; preferred: boolean }[];
}

export interface DrugInteraction {
  id: string;
  innA: string;
  innB: string;
  severity: Severity;
  mechanism: string;
  management: string;
  source: string;
  isActive: boolean;
}

export interface SalesInvoiceLine {
  id: string;
  lineNo: number;
  itemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxTypeCode: string;
  taxRatePercent: number;
  grossAmount: number;
  taxAmount: number;
  payerShare: number;
  patientShare: number;
  sourceLineId: string | null;
}

export interface SalesInvoice {
  id: string;
  number: string;
  docType: 'INVOICE' | 'CREDIT_NOTE';
  originalInvoiceId: string | null;
  originalInvoice?: { id: string; number: string } | null;
  status: string;
  source: string;
  storeId: string;
  store?: Store;
  patientId: string | null;
  customerName: string | null;
  customerPin: string | null;
  payer?: Payer | null;
  issuedAt: string;
  taxSummary: Record<string, { taxable: number; tax: number; rate: number }>;
  totalNet: number;
  totalTax: number;
  totalAmount: number;
  discountAmount: number;
  payerAmount: number;
  patientAmount: number;
  paidAmount: number;
  etimsStatus: EtimsSync;
  cuInvoiceNo: string | null;
  rcptSign: string | null;
  etimsError: string | null;
  notes: string | null;
  lines?: SalesInvoiceLine[];
  payments?: { id: string; modeCode: string; amount: number; reference: string | null }[];
  creditNotes?: { id: string; number: string; totalAmount: number; etimsStatus: EtimsSync }[];
  change?: number;
}

export interface PriceList {
  id: string;
  code: string;
  name: string;
  type: 'RETAIL' | 'STAFF' | 'CORPORATE' | 'INSURANCE';
  adjustPercent: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface PaymentMode {
  id: string;
  code: string;
  name: string;
  etimsPaymentTypeCode: string;
  requiresReference: boolean;
  isCredit: boolean;
  isActive: boolean;
}

export interface EtimsConfig {
  id: string;
  storeId: string;
  store?: Store;
  adapter: 'OSCU' | 'VSCU' | 'MOCK';
  baseUrl: string | null;
  kraPin: string;
  branchId: string;
  deviceSerial: string;
  cuId: string | null;
  mrcNo: string | null;
  initialisedAt: string | null;
  stockReportError: string | null;
  isActive: boolean;
}

export interface EtimsOutbox {
  id: string;
  kind: string;
  docType: string;
  docId: string | null;
  docNo: string | null;
  status: EtimsSync;
  attempts: number;
  nextAttemptAt: string;
  resultCd: string | null;
  resultMsg: string | null;
  createdAt: string;
  acceptedAt: string | null;
}

export interface EtimsTransmission {
  id: string;
  operation: string;
  url: string;
  httpStatus: number | null;
  resultCd: string | null;
  error: string | null;
  durationMs: number;
  at: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
}

export interface EtimsPurchase {
  id: string;
  spplrTin: string;
  spplrNm: string | null;
  spplrInvcNo: string;
  salesDt: string | null;
  totAmt: number;
  totTaxAmt: number;
  status: 'RECEIVED' | 'CONFIRMED' | 'REJECTED';
  supplierInvoiceId: string | null;
}

export interface EtimsImportItem {
  id: string;
  taskCd: string;
  dclDe: string | null;
  itemSeq: number;
  hsCd: string | null;
  itemNm: string;
  imptItemSttsCd: string;
  itemId: string | null;
}

export interface EtimsMapping {
  id: string;
  kind: string;
  localKey: string;
  etimsCode: string;
}

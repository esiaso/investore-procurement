import type { Item, Store } from '../api/types';

/** Types for slice 8 (quality, cold chain, recalls, disposal, logistics, assets). */

export interface BatchRef {
  id: string;
  batchNo: string;
  expiryDate: string | null;
  holdStatus: string;
  item?: Item;
}

export interface QualityHold {
  id: string;
  number: string;
  batchId: string;
  batch?: BatchRef;
  storeId: string | null;
  store?: Store | null;
  reason: string;
  details: string;
  sourceType: string;
  sourceId: string | null;
  quantityAtHold: number;
  status: 'OPEN' | 'RELEASED' | 'REJECTED';
  placedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  disposalId: string | null;
  createdAt: string;
}

export interface HoldDetail extends QualityHold {
  locations: { store: string; bin: string | null; onHand: number }[];
  placedByName: string | null;
  decidedByName: string | null;
}

export interface StorageUnit {
  id: string;
  code: string;
  name: string;
  storeId: string;
  store?: Store;
  type: 'FRIDGE' | 'FREEZER' | 'COLD_ROOM' | 'AMBIENT';
  binIds: string[];
  loggerSerial: string | null;
  isActive: boolean;
}

export interface Reading {
  id: string;
  recordedAt: string;
  temperatureC: number;
  source: string;
  inRange: boolean;
  note: string | null;
  excursionId: string | null;
}

export interface Excursion {
  id: string;
  unitId: string;
  unit?: StorageUnit;
  startedAt: string;
  endedAt: string | null;
  minTemperatureC: number;
  maxTemperatureC: number;
  rangeMin: number;
  rangeMax: number;
  status: 'OPEN' | 'REVIEWED';
  reviewNote: string | null;
  holdIds: string[];
}

export interface ExcursionDetail extends Excursion {
  holds: { id: string; number: string; status: string; quantityAtHold: number; batchNo: string; item: string }[];
  readings: Reading[];
}

export interface Complaint {
  id: string;
  number: string;
  itemId: string;
  item?: Item;
  batchId: string | null;
  batch?: BatchRef | null;
  supplierId: string | null;
  supplier?: { id: string; name: string } | null;
  category: string;
  description: string;
  reportedByName: string;
  reportedOn: string;
  severity: string;
  sampleRetained: boolean;
  ppbReportType: string | null;
  ppbReference: string | null;
  reportedToPpbOn: string | null;
  investigation: string | null;
  outcome: string | null;
  status: 'OPEN' | 'INVESTIGATING' | 'CLOSED';
  hold?: { id: string; number: string; status: string } | null;
  patient?: { hospitalNo: string; name: string } | null;
}

export interface Recall {
  id: string;
  number: string;
  source: string;
  noticeReference: string | null;
  noticeDate: string;
  classification: string;
  itemId: string;
  item?: Item;
  batchNos: string[];
  batchIds: string[];
  reason: string;
  instructions: string | null;
  patientLevel: boolean;
  status: 'OPEN' | 'CLOSED';
  outcome: string | null;
  closedAt: string | null;
  returns?: { id: string; batchId: string; source: string; fromName: string | null; quantity: number; intoStoreId: string | null; outcome: string | null; notes: string | null; returnedOn: string }[];
  holds?: { id: string; number: string; status: string; quantityAtHold: number; batchNo: string }[];
}

export interface RecallTrace {
  recall: Recall;
  holdings: { storeId: string; storeCode: string; storeName: string; batchNo: string; binCode: string | null; onHand: number; reserved: number; inTransit: number }[];
  issues: { id: string; date: string; docNo: string; fromStore: string; departmentId: string | null; department: string | null; batchNo: string; quantity: number }[];
  dispenses: { id: string; dispenseNo: string; dispensedAt: string; store: string; batchNo: string; quantity: number; returnedQty: number; patientId: string; hospitalNo: string; patientName: string; patientPhone: string | null }[];
  sales: { invoiceId: string; invoiceNo: string; issuedAt: string; store: string; batchNo: string; quantity: number; patientId: string | null; hospitalNo: string | null; customerName: string | null; phone: string | null }[];
  transfers: { id: string; date: string; docNo: string; fromStore: string; toStore: string; batchNo: string; quantity: number }[];
  otherMovements: { id: string; txnType: string; date: string; docNo: string; store: string; batchNo: string; quantity: number; reasonCode: string | null }[];
  patients: { patientId: string; hospitalNo: string; name: string; phone: string | null; quantity: number; via: string[] }[];
  unidentifiedSales: number;
  totals: { onHand: number; inTransit: number; issued: number; dispensed: number; sold: number; returned: number };
}

export interface RecallDashboard {
  open: { id: string; number: string; item: string; classification: string; noticeDate: string; batches: string[]; storesHolding: number; onHand: number; distributed: number; returned: number; patients: number }[];
  closedLastYear: number;
}

export interface Disposal {
  id: string;
  number: string;
  storeId: string;
  store?: Store;
  method: string;
  reason: string;
  recipient: string | null;
  status: string;
  totalValue: number;
  publicNoticeRef: string | null;
  holdIds: string[];
  completedOn: string | null;
  place: string | null;
  agent: string | null;
  wasteTransferNote: string | null;
  proceeds: number | null;
  notes: string | null;
  lastComment: string | null;
  createdAt: string;
}

export interface DisposalDetail extends Disposal {
  lines: { id: string; itemId: string; item?: Item; batchId: string; batch?: BatchRef; binId: string | null; bin?: { code: string } | null; quantity: number; unitCost: number }[];
  members: { id: string; userId: string; fullName?: string; role: string; signedAt: string | null; comment: string | null }[];
  files: { id: string; category: string; fileName: string; sha256: string }[];
}

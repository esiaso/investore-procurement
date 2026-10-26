import type {
  DepartmentReturnStatus,
  RequisitionPriority,
  ReturnCondition,
  ReturnReasonKind,
  StoreRequisitionStatus,
  SupplierReturnSource,
  SupplierReturnStatus,
} from '@sil/shared';
import type { Batch } from './inventory-types';
import type { Base, Department, Item, Store } from './types';

export interface Reservation {
  requisitionLineId: string;
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  binId: string | null;
  binCode: string | null;
  quantity: number;
}

export interface StoreRequisitionLine extends Base {
  lineNo: number;
  itemId: string;
  item?: Item;
  requestedQty: number;
  issuedQty: number;
  cancelledQty: number;
  cancelReason: string | null;
  patientRef: string | null;
  encounterId?: string | null;
  notes: string | null;
  outstandingQty: number;
  reservedQty: number;
  availableQty: number;
  reservations: Reservation[];
}

export interface StoreRequisition extends Base {
  number: string;
  departmentId: string;
  department?: Department;
  storeId: string;
  store?: Store;
  priority: RequisitionPriority;
  requiredBy: string | null;
  status: StoreRequisitionStatus;
  requestedBy: string;
  requestedByName?: string | null;
  notes: string | null;
  estimatedValue: number;
  approvedAt: string | null;
  lastComment: string | null;
  lines?: StoreRequisitionLine[];
  issues?: { id: string; number: string; issueDate: string; totalValue: number }[];
}

export interface PlanCandidate {
  batchId: string;
  binId: string | null;
  binCode: string | null;
  batchNo: string;
  expiryDate: string | null;
  available: number;
}

export interface PlanLine {
  requisitionLineId: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  barcode: string | null;
  gtin: string | null;
  isControlled: boolean;
  isColdChain: boolean;
  uom: string;
  patientRef: string | null;
  outstandingQty: number;
  shortfall: number;
  picks: { batchId: string; binId: string | null; binCode: string | null; batchNo: string; expiryDate: string | null; quantity: number }[];
  candidates: PlanCandidate[];
}

export interface IssuePlan {
  requisitionId: string;
  scanConfirm: 'OPTIONAL' | 'REQUIRED';
  lines: PlanLine[];
}

export interface IssueVoucherLine extends Base {
  requisitionLineId: string;
  itemId: string;
  item?: Item;
  batchId: string;
  batch?: Batch;
  binId: string | null;
  binCode?: string | null;
  quantity: number;
  unitCost: number;
  value: number;
  fefoOverridden: boolean;
  scanConfirmed: boolean;
  patientRef: string | null;
  returnedQty: number;
}

export interface IssueVoucher extends Base {
  number: string;
  requisitionId: string;
  requisition?: StoreRequisition;
  storeId: string;
  store?: Store;
  departmentId: string;
  department?: Department;
  issueDate: string;
  issuedBy: string;
  issuedByName?: string | null;
  collectedBy: string | null;
  witnessId: string | null;
  witnessName?: string | null;
  fefoOverrideReason: string | null;
  totalValue: number;
  notes: string | null;
  lines?: IssueVoucherLine[];
}

export interface BackorderRow {
  lineId: string;
  requisitionId: string;
  number: string;
  priority: RequisitionPriority;
  requiredBy: string | null;
  department: string;
  storeId: string;
  store: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  requestedQty: number;
  issuedQty: number;
  outstandingQty: number;
  reservedQty: number;
  availableQty: number;
  ageDays: number | null;
}

export interface ReturnReason extends Base {
  code: string;
  name: string;
  kind: ReturnReasonKind;
  isActive: boolean;
}

export interface ReturnableLine {
  issueVoucherLineId: string;
  voucherNo: string;
  issueDate: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  returnableQty: number;
  unitCost: number;
  patientRef: string | null;
}

export interface DepartmentReturnLine extends Base {
  itemId: string;
  item?: Item;
  batchId: string;
  batch?: Batch;
  issueVoucherLineId: string | null;
  quantity: number;
  reasonCode: string;
  condition: ReturnCondition;
  binId: string | null;
  unitCost: number;
  value: number;
  patientRef: string | null;
}

export interface DepartmentReturn extends Base {
  number: string;
  departmentId: string;
  department?: Department;
  storeId: string;
  store?: Store;
  status: DepartmentReturnStatus;
  returnDate: string | null;
  requestedBy: string;
  receivedBy: string | null;
  postedAt: string | null;
  totalValue: number;
  notes: string | null;
  lines?: DepartmentReturnLine[];
}

export interface SupplierReturnLine extends Base {
  itemId: string;
  item?: Item;
  batchId: string | null;
  batchNo: string | null;
  binId: string | null;
  grnLineId: string | null;
  quantity: number;
  unitCost: number;
  value: number;
  reason: string | null;
}

export interface SupplierReturn extends Base {
  number: string;
  source: SupplierReturnSource;
  status: SupplierReturnStatus;
  supplierId: string;
  supplier?: { id: string; name: string; code: string };
  storeId: string;
  store?: Store;
  grnId: string | null;
  grn?: { id: string; number: string } | null;
  purchaseOrderId: string | null;
  purchaseOrder?: { id: string; number: string } | null;
  reasonCode: string;
  notes: string | null;
  totalValue: number;
  returnDate: string | null;
  dispatchedAt: string | null;
  creditNoteNo: string | null;
  creditNoteDate: string | null;
  creditNoteAmount: number | null;
  creditVariance?: number | null;
  lines?: SupplierReturnLine[];
}

export interface ConsumptionRow {
  key: string;
  label: string;
  departmentCode?: string | null;
  costCentre?: string | null;
  department?: string | null;
  period?: string | null;
  itemCode?: string | null;
  uom?: string | null;
  patientRef?: string | null;
  issuedQty: number | null;
  returnedQty: number | null;
  netQty: number | null;
  issuedValue: number;
  returnedValue: number;
  netValue: number;
  movements: number;
}

export interface ConsumptionReport {
  from: string;
  to: string;
  groupBy: 'department' | 'period' | 'item' | 'patient';
  currency: string;
  rows: ConsumptionRow[];
  totals: { issuedValue: number; returnedValue: number; netValue: number };
}

export interface MovementRow {
  id: string;
  txnType: string;
  effectiveDate: string;
  postedAt: string;
  sourceDocType: string;
  sourceDocNo: string | null;
  sourceDocId: string | null;
  storeCode: string;
  storeName?: string;
  binCode: string | null;
  quantity: number;
  inTransitDelta: number;
  unitCost: number;
  valueDelta: number;
  reasonCode: string | null;
  fefoOverrideReason: string | null;
  department: string | null;
  patientRef: string | null;
  user: string | null;
  secondSigner: string | null;
  from: string | null;
  to: string | null;
}

export interface BatchTrace {
  batch: { id: string; batchNo: string; expiryDate: string | null; manufactureDate: string | null; holdStatus: string; holdReason: string | null; itemId: string; itemCode: string; itemName: string; uom: string; isControlled: boolean };
  locations: { storeCode: string; storeName: string; binCode: string | null; inQuarantine: boolean; onHand: number; reserved: number; inTransit: number }[];
  movements: MovementRow[];
  totals: { received: number; issued: number; returnedFromDepartments: number; returnedToSupplier: number; adjusted: number };
  patients: string[];
}

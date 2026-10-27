/** Non-stock procurement (phase 1): staff requisitions, procurement queue, finance master data. */
export type LineType = 'STOCK' | 'NON_STOCK_GOODS' | 'SERVICE' | 'CAPEX_EXPENSED';

export const LINE_TYPES: { value: LineType; label: string }[] = [
  { value: 'STOCK', label: 'Stock item (from the store)' },
  { value: 'NON_STOCK_GOODS', label: 'Goods (not stocked)' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'CAPEX_EXPENSED', label: 'Capital item (expensed)' },
];

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  description: string | null;
  qboAccountId: string | null;
  isActive: boolean;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  department?: { name: string } | null;
  startsOn: string | null;
  endsOn: string | null;
  budget: number | null;
  isActive: boolean;
}

export interface CurrencyRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  isBase: boolean;
  latestRate: 1 | { rate: number; rate_date: string } | null;
}

export interface ExchangeRate {
  id: string;
  currencyCode: string;
  rateDate: string;
  rate: number;
  source: string | null;
}

export interface StaffRequisitionLine {
  id: string;
  lineNo: number;
  lineType: LineType;
  itemId: string | null;
  item?: { id: string; code: string; name: string } | null;
  description: string;
  categoryId: string | null;
  category?: { name: string } | null;
  quantity: number;
  uomId: string | null;
  uom?: { code: string } | null;
  estimatedUnitCost: number;
  glAccountId: string | null;
  glAccount?: { code: string; name: string } | null;
  status: 'OPEN' | 'TO_STORE' | 'ON_PR' | 'DELIVERED' | 'CANCELLED';
  notes: string | null;
  purchaseRequisition?: { id: string; number: string; status: string } | null;
  storeRequisition?: { id: string; number: string } | null;
  receivedQty?: number;
  deliveredQty?: number;
}

/** Per non-stock line: received from the supplier, delivered, and what can be handed over. */
export interface Deliverable {
  requisitionLineId: string;
  lineNo: number;
  lineType: LineType;
  description: string;
  uom: string | null;
  quantity: number;
  receivedQty: number;
  deliveredQty: number;
  pendingQty: number;
  available: number;
  status: string;
}

export interface Handover {
  id: string;
  number: string;
  requisitionId: string;
  requisition?: { number: string; requestedBy?: string } | null;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'CANCELLED';
  preparedBy: string;
  preparedByName?: string | null;
  receivedBy: string;
  receivedByName?: string | null;
  condition: string;
  notes: string | null;
  ackChannel: 'IN_APP' | 'OTP' | null;
  acknowledgedAt: string | null;
  ackComment: string | null;
  otpPending?: boolean;
  createdAt: string;
  lines?: { id: string; requisitionLineId: string; quantity: number; remarks: string | null; requisitionLine?: { lineNo: number; description: string; uom?: { code: string } | null } }[];
}

export interface StaffRequisition {
  id: string;
  number: string;
  requestedBy: string;
  requestedByName?: string;
  departmentId: string;
  department?: { name: string };
  onBehalfOfDepartment: boolean;
  projectId: string | null;
  project?: { code: string; name: string } | null;
  storeId: string | null;
  store?: { name: string } | null;
  budgetId: string | null;
  priority: string;
  requiredBy: string | null;
  justification: string;
  status: string;
  estimatedTotal: number;
  submittedAt: string | null;
  approvedAt: string | null;
  lastComment: string | null;
  createdAt: string;
  lines?: StaffRequisitionLine[];
  budgetWarning?: string | null;
  deliverable?: Deliverable[];
}

export interface QueueLine {
  id: string;
  lineType: LineType;
  description: string;
  quantity: number;
  uom: string | null;
  estimatedUnitCost: number;
  estimatedTotal: number;
  category: string | null;
  glCode: string | null;
  glName: string | null;
  requisitionId: string;
  requisitionNo: string;
  priority: string;
  requiredBy: string | null;
  approvedAt: string;
  departmentId: string;
  department: string;
  requestedBy: string;
  project: string | null;
}

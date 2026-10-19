import type { Base, Department, Item, Store, Uom } from './types';

export interface Supplier extends Base {
  code: string;
  name: string;
  kraPin: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  paymentTermsDays: number;
  status: string;
  statusReason: string | null;
  prequalificationStatus: string;
  prequalifiedUntil: string | null;
  categoryIds: string[];
  bankName: string | null;
  bankBranch: string | null;
  bankAccountMasked: string | null;
  bankAccountNo?: string | null;
  onTimeDeliveryRate: number | null;
  qualityRejectRate: number | null;
  avgPriceVariancePct: number | null;
  grnCount: number;
  contacts?: { id: string; name: string; role: string | null; email: string | null; phone: string | null; isPrimary: boolean }[];
  documents?: { id: string; documentType: string; reference: string | null; issuedOn: string | null; expiresOn: string | null; notes: string | null }[];
}

export interface ContractPrice extends Base {
  supplierId: string;
  supplier?: Supplier;
  itemId: string;
  item?: Item;
  unitPrice: number;
  validFrom: string;
  validTo: string | null;
  contractRef: string | null;
}

export interface BudgetPosition {
  id: string;
  departmentId: string;
  departmentName: string;
  voteHead: string;
  description: string | null;
  financialYear: string;
  amount: number;
  committed: number;
  actual: number;
  available: number;
  enforcement: string;
}

export interface ApprovalInboxRow {
  id: string;
  documentType: string;
  documentId: string;
  documentNo: string;
  amount: number;
  summary: string | null;
  link: string | null;
  createdAt: string;
  stepName: string;
  requestedByName: string;
  workflowName: string;
}

export interface ApprovalHistory {
  id: string;
  status: string;
  currentStep: number;
  amount: number;
  createdAt: string;
  workflow?: { name: string; steps: { sequence: number; name: string; approverType: string; role?: { name: string } | null }[] };
  actions: { id: string; stepSequence: number; stepName: string | null; action: string; userName: string | null; onBehalfOfName: string | null; comment: string | null; at: string }[];
}

export interface Workflow extends Base {
  code: string;
  name: string;
  documentType: string;
  minAmount: number | null;
  maxAmount: number | null;
  departmentId: string | null;
  itemCategoryId: string | null;
  priority: number;
  isActive: boolean;
  steps?: { id: string; sequence: number; name: string; approverType: string; roleId: string | null; userId: string | null; role?: { name: string } | null }[];
}

export interface Requisition extends Base {
  number: string;
  departmentId: string;
  department?: Department;
  storeId: string;
  store?: Store;
  budgetId: string | null;
  priority: string;
  requiredBy: string | null;
  justification: string;
  status: string;
  requestedBy: string;
  estimatedTotal: number;
  lastComment: string | null;
  lines?: (Base & { itemId: string; item?: Item; quantity: number; estimatedUnitPrice: number; orderedQty: number; notes: string | null })[];
}

export interface Rfq extends Base {
  number: string;
  requisitionId: string | null;
  title: string;
  closingDate: string;
  status: string;
  supplierIds: string[];
  awardJustification: string | null;
  lines?: (Base & { itemId: string; item?: Item; quantity: number; awardedQuotationLineId: string | null })[];
}

export interface Comparison {
  rfq: Rfq;
  lines: {
    rfqLineId: string;
    itemId: string;
    itemName: string;
    quantity: number;
    awardedQuotationLineId: string | null;
    quotes: { quotationLineId: string; supplierId: string; supplierName: string; unitPrice: number; lineTotal: number; deliveryDays: number | null; compliant: boolean; offeredBrand: string | null; rank: number; lowestCompliant: boolean }[];
  }[];
  suppliers: { supplierId: string; supplierName: string; compliant: boolean; complianceNotes: string | null; deliveryDays: number | null; total: number; linesQuoted: number; lowestOnLines: number }[];
}

export interface PoLine extends Base {
  lineNo: number;
  itemId: string;
  item?: Item;
  uomId: string;
  uom?: Uom;
  conversionFactor: number;
  quantity: number;
  unitPrice: number;
  taxRatePercent: number;
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
  receivedBaseQty: number;
  requisitionLineId: string | null;
}

export interface PurchaseOrder extends Base {
  number: string;
  version: number;
  supplierId: string;
  supplier?: Supplier;
  storeId: string;
  store?: Store;
  departmentId: string;
  department?: Department;
  budgetId: string | null;
  source: string;
  requisitionId: string | null;
  rfqId: string | null;
  status: string;
  orderDate: string;
  expectedDelivery: string | null;
  notes: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  committedTotal: number;
  lastComment: string | null;
  cancellationReason: string | null;
  lines?: PoLine[];
  budgetWarning?: string | null;
}

export interface GrnLine extends Base {
  poLineId: string | null;
  itemId: string;
  item?: Item;
  batchNo: string | null;
  expiryDate: string | null;
  conversionFactor: number;
  quantity: number;
  receivedBaseQty: number;
  acceptedBaseQty: number;
  rejectedBaseQty: number;
  rejectionReason: string | null;
  unitPrice: number;
}

export interface Grn extends Base {
  number: string;
  purchaseOrderId: string | null;
  purchaseOrder?: PurchaseOrder | null;
  supplierId: string;
  supplier?: Supplier;
  storeId: string;
  store?: Store;
  status: string;
  receivedDate: string;
  deliveryNoteNo: string | null;
  receivedBy: string;
  isEmergency: boolean;
  regularisationStatus: string;
  emergencyReason: string | null;
  inspectedBy: string[];
  inspectionNotes: string | null;
  lines?: GrnLine[];
  returns?: { id: string; number: string; lines: { itemName: string; batchNo: string | null; quantity: number; reason: string | null }[] }[];
}

export interface Invoice extends Base {
  number: string;
  supplierId: string;
  supplier?: Supplier;
  supplierInvoiceNo: string;
  purchaseOrderId: string;
  purchaseOrder?: PurchaseOrder;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  matchStatus: string;
  variances: { poLineId: string; code: string; message: string }[];
  etimsStatus: string;
  etimsInvoiceNo: string | null;
  subtotal: number;
  taxTotal: number;
  total: number;
  capturedBy: string;
  lastComment: string | null;
}

export interface MatchView {
  invoice: Invoice;
  lines: { poLineId: string; lineNo: number; item: string; uom: string; orderedQty: number; poUnitPrice: number; receivedQty: number; invoicedToDate: number; thisInvoiceQty: number; thisInvoicePrice: number | null; variances: { code: string; message: string }[] }[];
}

export interface ChainNode {
  key: string;
  type: string;
  id: string;
  no: string;
  status?: string;
  date?: string | null;
  amount?: number | null;
}

/** Kinds of stock-holding location. */
export enum StoreType {
  MAIN_STORE = 'MAIN_STORE',
  MAIN_PHARMACY = 'MAIN_PHARMACY',
  SATELLITE_PHARMACY = 'SATELLITE_PHARMACY',
  SUB_STORE = 'SUB_STORE',
}

/** Service point a satellite pharmacy / sub-store serves. */
export enum ServicePoint {
  OPD = 'OPD',
  IPD = 'IPD',
  THEATRE = 'THEATRE',
  EMERGENCY = 'EMERGENCY',
  ICU = 'ICU',
  MATERNITY = 'MATERNITY',
  OTHER = 'OTHER',
}

/** Kenyan medicine sales classification. */
export enum SalesClass {
  OTC = 'OTC',
  P = 'P',
  POM = 'POM',
  CD = 'CD',
}

/** Narcotic / psychotropic control schedule of a generic. */
export enum ControlledSchedule {
  NONE = 'NONE',
  SCHEDULE_I = 'SCHEDULE_I',
  SCHEDULE_II = 'SCHEDULE_II',
  SCHEDULE_III = 'SCHEDULE_III',
  SCHEDULE_IV = 'SCHEDULE_IV',
}

export enum TaxTreatment {
  STANDARD = 'STANDARD',
  ZERO_RATED = 'ZERO_RATED',
  EXEMPT = 'EXEMPT',
}

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LOGIN = 'LOGIN',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  PASSWORD_CHANGE = 'PASSWORD_CHANGE',
  TWO_FACTOR_ENABLED = 'TWO_FACTOR_ENABLED',
  TWO_FACTOR_DISABLED = 'TWO_FACTOR_DISABLED',
  IMPORT = 'IMPORT',
}

export enum AttributeType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  ENUM = 'enum',
}

/** Document types that draw numbers from the numbering service. */
export enum DocumentType {
  ITEM = 'ITEM',
  PURCHASE_REQUISITION = 'PR',
  PURCHASE_ORDER = 'PO',
  GOODS_RECEIVED_NOTE = 'GRN',
  STORE_REQUISITION = 'SR',
  ISSUE_NOTE = 'ISS',
  TRANSFER = 'TRF',
  STOCK_ADJUSTMENT = 'ADJ',
  STOCK_RECEIPT = 'RCPT',
  STOCK_TAKE = 'STK',
  RFQ = 'RFQ',
  SUPPLIER = 'SUP',
  SUPPLIER_INVOICE = 'INV',
  RETURN_TO_SUPPLIER = 'RTS',
  PAYMENT_VOUCHER = 'PV',
}

// ------------------------------------------------------------------ approvals

export enum ApproverType {
  ROLE = 'ROLE',
  USER = 'USER',
}

export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
}

export enum ApprovalActionType {
  SUBMIT = 'SUBMIT',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  RETURN = 'RETURN',
  CANCEL = 'CANCEL',
}

// ------------------------------------------------------------------ suppliers & purchasing

export enum SupplierStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLACKLISTED = 'BLACKLISTED',
}

export enum PrequalificationStatus {
  NOT_PREQUALIFIED = 'NOT_PREQUALIFIED',
  PENDING = 'PENDING',
  PREQUALIFIED = 'PREQUALIFIED',
}

export enum BudgetEnforcement {
  WARN = 'WARN',
  BLOCK = 'BLOCK',
}

export enum BudgetEntryType {
  COMMITMENT = 'COMMITMENT',
  RELEASE = 'RELEASE',
  ACTUAL = 'ACTUAL',
}

export enum RequisitionPriority {
  ROUTINE = 'ROUTINE',
  URGENT = 'URGENT',
  EMERGENCY = 'EMERGENCY',
}

/** Shared by PRs, POs and invoices that go through the approval engine. */
export enum ApprovableStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
}

export enum RequisitionStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
  /** Fully converted to RFQ / PO. */
  CLOSED = 'CLOSED',
}

export enum RfqStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  EVALUATION = 'EVALUATION',
  AWARDED = 'AWARDED',
  CANCELLED = 'CANCELLED',
}

export enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  SENT = 'SENT',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum PurchaseOrderSource {
  REQUISITION = 'REQUISITION',
  RFQ = 'RFQ',
  CONTRACT = 'CONTRACT',
}

export enum GrnStatus {
  DRAFT = 'DRAFT',
  INSPECTION = 'INSPECTION',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
}

export enum RegularisationStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  PENDING = 'PENDING',
  REGULARISED = 'REGULARISED',
}

export enum InvoiceStatus {
  CAPTURED = 'CAPTURED',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum MatchStatus {
  NOT_MATCHED = 'NOT_MATCHED',
  MATCHED = 'MATCHED',
  VARIANCE = 'VARIANCE',
}

/** Hook for KRA eTIMS invoice verification (slice 6). */
export enum EtimsStatus {
  NOT_CHECKED = 'NOT_CHECKED',
  VERIFIED = 'VERIFIED',
  FAILED = 'FAILED',
}

export enum EmailStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

// ------------------------------------------------------------------ inventory

export enum BatchHoldStatus {
  NONE = 'NONE',
  QUARANTINE = 'QUARANTINE',
  RECALL = 'RECALL',
  EXPIRED = 'EXPIRED',
}

/** Ledger transaction types. Quantities on the ledger are signed, in base units. */
export enum StockTxnType {
  OPENING = 'OPENING',
  RECEIPT = 'RECEIPT',
  ADJUSTMENT = 'ADJUSTMENT',
  TRANSFER_DISPATCH = 'TRANSFER_DISPATCH',
  TRANSFER_RECEIPT = 'TRANSFER_RECEIPT',
  TRANSFER_DISCREPANCY = 'TRANSFER_DISCREPANCY',
  STOCK_TAKE = 'STOCK_TAKE',
  ISSUE = 'ISSUE',
}

export enum ValuationMethod {
  WAC = 'WAC',
  FIFO = 'FIFO',
}

export enum AdjustmentDirection {
  INCREASE = 'INCREASE',
  DECREASE = 'DECREASE',
  BOTH = 'BOTH',
}

export enum AdjustmentStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  /** First approval done; value above threshold needs a second approver. */
  PARTIALLY_APPROVED = 'PARTIALLY_APPROVED',
  POSTED = 'POSTED',
  REJECTED = 'REJECTED',
}

export enum TransferStatus {
  REQUESTED = 'REQUESTED',
  DISPATCHED = 'DISPATCHED',
  RECEIVED = 'RECEIVED',
  RECEIVED_WITH_DISCREPANCY = 'RECEIVED_WITH_DISCREPANCY',
  CANCELLED = 'CANCELLED',
}

export enum StockTakeType {
  FULL = 'FULL',
  CYCLE = 'CYCLE',
}

export enum StockTakeStatus {
  DRAFT = 'DRAFT',
  /** Stock frozen, counting in progress. */
  COUNTING = 'COUNTING',
  /** Counts submitted, variances under review. */
  REVIEW = 'REVIEW',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
}

export enum StockReceiptType {
  OPENING = 'OPENING',
  RECEIPT = 'RECEIPT',
}

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
  DEPARTMENT_RETURN = 'DRT',
  SALES_INVOICE = 'SI',
  CREDIT_NOTE = 'CN',
  PRESCRIPTION = 'RX',
  DISPENSE = 'DSP',
  PROCUREMENT_PLAN = 'APP',
  TENDER = 'TND',
  CONTRACT = 'CTR',
  CONTRACT_VARIATION = 'CV',
  SUPPLIER_SANCTION = 'SSN',
  QUALITY_HOLD = 'QH',
  QUALITY_COMPLAINT = 'PQC',
  RECALL = 'RCL',
  DISPOSAL = 'DSL',
  DISTRIBUTION_RUN = 'DRN',
  SHIPMENT = 'SHP',
  ASSET = 'AST',
  SERVICE_CERTIFICATE = 'SCC',
}

// ------------------------------------------------------------------ approvals

export enum ApproverType {
  ROLE = 'ROLE',
  USER = 'USER',
  /** Members of the role who belong to the document's department (e.g. the ward in-charge). */
  DEPARTMENT_ROLE = 'DEPARTMENT_ROLE',
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
  /** Raised from an order template (national agency order cycle). */
  ORDER_CYCLE = 'ORDER_CYCLE',
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
  /** No matching sale by the supplier was found on eTIMS. */
  NOT_ON_ETIMS = 'NOT_ON_ETIMS',
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
  /** Issue to a department / cost centre (negative). */
  ISSUE = 'ISSUE',
  /** Return from a department back into the store (positive, credits the department). */
  RETURN_IN = 'RETURN_IN',
  /** Stock sent back to a supplier (negative). */
  SUPPLIER_RETURN = 'SUPPLIER_RETURN',
  /** Dispensed / sold to a patient or customer (negative). */
  DISPENSE = 'DISPENSE',
  /** Dispensed stock returned by the patient (positive). */
  DISPENSE_RETURN = 'DISPENSE_RETURN',
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

// ------------------------------------------------------------------ internal requisitions, issues, returns

export enum StoreRequisitionStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  /** Approved; stock reserved where available. */
  APPROVED = 'APPROVED',
  /** Something issued; the rest is on back-order. */
  PARTIALLY_ISSUED = 'PARTIALLY_ISSUED',
  /** Everything issued. */
  ISSUED = 'ISSUED',
  /** Settled with some back-order cancelled. */
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
}

export enum ReturnCondition {
  /** Back to the same batch, usable. */
  RESALEABLE = 'RESALEABLE',
  /** To the store's quarantine bin. */
  DAMAGED = 'DAMAGED',
  EXPIRED = 'EXPIRED',
}

export enum ReturnReasonKind {
  DEPARTMENT = 'DEPARTMENT',
  SUPPLIER = 'SUPPLIER',
  BOTH = 'BOTH',
}

export enum DepartmentReturnStatus {
  DRAFT = 'DRAFT',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
}

export enum SupplierReturnSource {
  /** Stock already in the store. */
  STOCK = 'STOCK',
  /** Rejected at GRN inspection; never entered stock. */
  GRN_REJECT = 'GRN_REJECT',
}

export enum SupplierReturnStatus {
  DRAFT = 'DRAFT',
  /** Goods left the store (stock posted for STOCK returns). */
  DISPATCHED = 'DISPATCHED',
  /** Supplier credit note recorded. */
  CREDITED = 'CREDITED',
  CANCELLED = 'CANCELLED',
}

// ------------------------------------------------------------------ stock planning, alerts, jobs

/** AUTO: the AMC job recalculates levels; MANUAL: levels entered by hand are kept (AMC still updated). */
export enum StockSettingMode {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
}

export enum StockAlertType {
  REORDER = 'REORDER',
  STOCKOUT = 'STOCKOUT',
  NEAR_EXPIRY = 'NEAR_EXPIRY',
  EXPIRED = 'EXPIRED',
}

export enum StockAlertStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

/** Categories users can switch notification channels for. */
export enum NotificationCategory {
  REORDER = 'REORDER',
  STOCKOUT = 'STOCKOUT',
  EXPIRY = 'EXPIRY',
  JOBS = 'JOBS',
  /** eTIMS documents not accepted in time. */
  ETIMS = 'ETIMS',
  /** Contract and performance-security expiry, tender milestones. */
  CONTRACTS = 'CONTRACTS',
}

export enum JobRunStatus {
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

// ------------------------------------------------------------------ pharmacy, billing, eTIMS (slice 6)

export enum Sex {
  F = 'F',
  M = 'M',
  OTHER = 'OTHER',
}

export enum PayerType {
  INSURANCE = 'INSURANCE',
  CORPORATE = 'CORPORATE',
}

export enum PrescriptionStatus {
  RECEIVED = 'RECEIVED',
  VERIFIED = 'VERIFIED',
  PARTIALLY_DISPENSED = 'PARTIALLY_DISPENSED',
  DISPENSED = 'DISPENSED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum InteractionSeverity {
  CONTRAINDICATED = 'CONTRAINDICATED',
  MAJOR = 'MAJOR',
  MODERATE = 'MODERATE',
  MINOR = 'MINOR',
}

export enum ClinicalAlertType {
  INTERACTION = 'INTERACTION',
  ALLERGY = 'ALLERGY',
  DUPLICATE_THERAPY = 'DUPLICATE_THERAPY',
  AGE = 'AGE',
  PREGNANCY = 'PREGNANCY',
}

export enum PriceListType {
  RETAIL = 'RETAIL',
  STAFF = 'STAFF',
  CORPORATE = 'CORPORATE',
  INSURANCE = 'INSURANCE',
}

export enum SalesDocType {
  INVOICE = 'INVOICE',
  CREDIT_NOTE = 'CREDIT_NOTE',
}

export enum SalesSource {
  DISPENSE = 'DISPENSE',
  OTC = 'OTC',
  CONSUMABLE = 'CONSUMABLE',
  HMIS = 'HMIS',
  RETURN = 'RETURN',
}

export enum SalesInvoiceStatus {
  ISSUED = 'ISSUED',
  CANCELLED = 'CANCELLED',
}

/** eTIMS state of a local document. */
export enum EtimsSyncStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  PENDING = 'PENDING',
  SENT = 'SENT',
  ACCEPTED = 'ACCEPTED',
  FAILED = 'FAILED',
}

export enum EtimsAdapterKind {
  OSCU = 'OSCU',
  VSCU = 'VSCU',
  MOCK = 'MOCK',
}

export enum EtimsOutboxKind {
  ITEM = 'ITEM',
  SALE = 'SALE',
  STOCK_IO = 'STOCK_IO',
  STOCK_MASTER = 'STOCK_MASTER',
  PURCHASE = 'PURCHASE',
  IMPORT_ITEM = 'IMPORT_ITEM',
}

export enum EtimsPurchaseStatus {
  RECEIVED = 'RECEIVED',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
}

// ------------------------------------------------------------------ slice 7: planning, sourcing, contracts

export enum ForecastMethod {
  AMC = 'AMC',
  MOVING_AVERAGE = 'MOVING_AVERAGE',
  HOLT_WINTERS = 'HOLT_WINTERS',
  /** Pick the method with the lowest back-tested MAPE per item. */
  AUTO = 'AUTO',
}

export enum PlanStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  /** Departmental plan rolled into the hospital plan. */
  CONSOLIDATED = 'CONSOLIDATED',
}

/** Sourcing method codes; thresholds and rules live in setting procurement.sourcingMethods. */
export enum SourcingMethod {
  LOW_VALUE = 'LOW_VALUE',
  RFQ = 'RFQ',
  RESTRICTED_TENDER = 'RESTRICTED_TENDER',
  OPEN_TENDER = 'OPEN_TENDER',
  /** Request for proposals (services, quality-weighted). */
  RFP = 'RFP',
  DIRECT = 'DIRECT',
  FRAMEWORK = 'FRAMEWORK',
}

export enum TenderStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  CLOSED = 'CLOSED',
  OPENED = 'OPENED',
  EVALUATION = 'EVALUATION',
  RECOMMENDED = 'RECOMMENDED',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  AWARDED = 'AWARDED',
  CONTRACTED = 'CONTRACTED',
  CANCELLED = 'CANCELLED',
}

export enum BidStatus {
  SUBMITTED = 'SUBMITTED',
  WITHDRAWN = 'WITHDRAWN',
  OPENED = 'OPENED',
  NON_RESPONSIVE = 'NON_RESPONSIVE',
  TECHNICALLY_FAILED = 'TECHNICALLY_FAILED',
  QUALIFIED = 'QUALIFIED',
  AWARDED = 'AWARDED',
  REGRET = 'REGRET',
}

export enum EvaluationStage {
  PRELIMINARY = 'PRELIMINARY',
  TECHNICAL = 'TECHNICAL',
  FINANCIAL = 'FINANCIAL',
}

export enum CommitteeRole {
  CHAIR = 'CHAIR',
  MEMBER = 'MEMBER',
  SECRETARY = 'SECRETARY',
}

export enum ContractType {
  FIXED = 'FIXED',
  FRAMEWORK = 'FRAMEWORK',
}

export enum ContractStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  TERMINATED = 'TERMINATED',
}

export enum VariationStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
}

export enum SanctionType {
  SUSPEND = 'SUSPEND',
  BLACKLIST = 'BLACKLIST',
  REINSTATE = 'REINSTATE',
}

export enum CorrectiveActionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

/** Access to Government Procurement Opportunities (optional PPADA rule set). */
export enum AgpoCategory {
  YOUTH = 'YOUTH',
  WOMEN = 'WOMEN',
  PWD = 'PWD',
}

export enum NationalAgency {
  KEMSA = 'KEMSA',
  MEDS = 'MEDS',
}

export enum DeliveryStage {
  ORDER_SENT = 'ORDER_SENT',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
}

export enum SupplierSubmissionType {
  DELIVERY_NOTE = 'DELIVERY_NOTE',
  INVOICE = 'INVOICE',
}

export enum QuantificationMethod {
  CONSUMPTION = 'CONSUMPTION',
  MORBIDITY = 'MORBIDITY',
}

// ------------------------------------------------------------------ slice 8: logistics, quality, assets

export enum HoldReason {
  INSPECTION = 'INSPECTION',
  INVESTIGATION = 'INVESTIGATION',
  RECALL = 'RECALL',
  EXCURSION = 'EXCURSION',
  COMPLAINT = 'COMPLAINT',
}

export enum HoldStatus {
  OPEN = 'OPEN',
  RELEASED = 'RELEASED',
  REJECTED = 'REJECTED',
}

export enum StorageUnitType {
  FRIDGE = 'FRIDGE',
  FREEZER = 'FREEZER',
  COLD_ROOM = 'COLD_ROOM',
  AMBIENT = 'AMBIENT',
}

export enum ReadingSource {
  MANUAL = 'MANUAL',
  CSV = 'CSV',
  RECEIPT = 'RECEIPT',
}

export enum ExcursionStatus {
  OPEN = 'OPEN',
  REVIEWED = 'REVIEWED',
}

export enum ComplaintCategory {
  QUALITY_DEFECT = 'QUALITY_DEFECT',
  SUSPECTED_FALSIFIED = 'SUSPECTED_FALSIFIED',
  ADVERSE_REACTION = 'ADVERSE_REACTION',
  PACKAGING = 'PACKAGING',
  LABELLING = 'LABELLING',
  OTHER = 'OTHER',
}

export enum ComplaintStatus {
  OPEN = 'OPEN',
  INVESTIGATING = 'INVESTIGATING',
  CLOSED = 'CLOSED',
}

export enum RecallSource {
  PPB = 'PPB',
  SUPPLIER = 'SUPPLIER',
  MANUFACTURER = 'MANUFACTURER',
  INTERNAL = 'INTERNAL',
}

export enum RecallClass {
  CLASS_I = 'CLASS_I',
  CLASS_II = 'CLASS_II',
  CLASS_III = 'CLASS_III',
}

export enum RecallStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum RecallReturnSource {
  STORE = 'STORE',
  DEPARTMENT = 'DEPARTMENT',
  PATIENT = 'PATIENT',
}

export enum DisposalMethod {
  DESTRUCTION = 'DESTRUCTION',
  SALE = 'SALE',
  RETURN_TO_SUPPLIER = 'RETURN_TO_SUPPLIER',
  DONATION = 'DONATION',
  TRANSFER = 'TRANSFER',
}

export enum DisposalStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
}

export enum DistributionRunStatus {
  PLANNED = 'PLANNED',
  PICKING = 'PICKING',
  DISPATCHED = 'DISPATCHED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum StopStatus {
  PENDING = 'PENDING',
  PICKED = 'PICKED',
  PACKED = 'PACKED',
  DISPATCHED = 'DISPATCHED',
  DELIVERED = 'DELIVERED',
  DELIVERED_WITH_DISCREPANCY = 'DELIVERED_WITH_DISCREPANCY',
}

export enum ShipmentStatus {
  EXPECTED = 'EXPECTED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELAYED = 'DELAYED',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

export enum AssetStatus {
  ACTIVE = 'ACTIVE',
  IN_REPAIR = 'IN_REPAIR',
  DISPOSED = 'DISPOSED',
}

export enum CertificateStatus {
  DRAFT = 'DRAFT',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
}

/** Kinds of record a file can be attached to (polymorphic owner). */
export enum AttachmentOwner {
  SUPPLIER_DOCUMENT = 'SUPPLIER_DOCUMENT',
  PORTAL_SUBMISSION = 'PORTAL_SUBMISSION',
  TENDER = 'TENDER',
  GRN = 'GRN',
  DISPOSAL = 'DISPOSAL',
  COMPLAINT = 'COMPLAINT',
  RECALL = 'RECALL',
  ASSET = 'ASSET',
  SERVICE_CERTIFICATE = 'SERVICE_CERTIFICATE',
  STOCK_ADJUSTMENT = 'STOCK_ADJUSTMENT',
}

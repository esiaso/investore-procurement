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
  POS_SHIFT = 'SHF',
  CUSTOMER = 'CUS',
  ACCOUNTING_BATCH = 'QBB',
  PAYER_SETTLEMENT = 'RCV',
  /** Staff / departmental requisition (goods or services; stock lines go to the stores, the rest to procurement). */
  STAFF_REQUISITION = 'REQ',
  /** Hand-over of received goods / services to the requester (final user). */
  HANDOVER = 'HOV',
  /** Petty cash payment / advance (petty cash voucher). */
  PETTY_CASH_VOUCHER = 'PCV',
  PETTY_CASH_REPLENISHMENT = 'PCRP',
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
  /** System: the step passed its SLA and was escalated. */
  ESCALATE = 'ESCALATE',
  /** System: approvers reminded. */
  REMIND = 'REMIND',
}

/** Where an approver acted. */
export enum ApprovalChannel {
  IN_APP = 'IN_APP',
  EMAIL_LINK = 'EMAIL_LINK',
  SMS_LINK = 'SMS_LINK',
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
  /** An RFQ was raised for it. */
  RFQ_ISSUED = 'RFQ_ISSUED',
  /** Part of it is on purchase orders. */
  PARTIALLY_FULFILLED = 'PARTIALLY_FULFILLED',
  /** Non-stock: everything is on LPOs / LSOs (closed once delivered to the users). */
  LPO_RAISED = 'LPO_RAISED',
  /** Fully converted to RFQ / PO. */
  CLOSED = 'CLOSED',
}

/** Requisitions that can still go on RFQs and purchase orders. */
export const OPEN_REQUISITION_STATUSES = [RequisitionStatus.APPROVED, RequisitionStatus.RFQ_ISSUED, RequisitionStatus.PARTIALLY_FULFILLED];

/** DRAFT → SENT (issued) → EVALUATION (quotations coming in) → CLOSED (bidding closed) → EVALUATED (scored) → AWARDED; CANCELLED. */
export enum RfqStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  EVALUATION = 'EVALUATION',
  CLOSED = 'CLOSED',
  EVALUATED = 'EVALUATED',
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
  /** Fully invoiced (non-stock cycle, phase 3). */
  INVOICED = 'INVOICED',
  /** Fully paid (phase 4). */
  PAID = 'PAID',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  /** Past its validity with nothing received. */
  EXPIRED = 'EXPIRED',
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
  /** On an approved payment run, not yet paid (phase 4). */
  SCHEDULED = 'SCHEDULED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
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
  /** HMIS messages that failed or are stuck. */
  HMIS = 'HMIS',
  /** Documents waiting for my approval (email carries approve / reject links). */
  APPROVALS = 'APPROVALS',
  /** Progress of my requisitions (approved, ordered, received, ready for collection). */
  REQUISITIONS = 'REQUISITIONS',
  /** Payments made, failed or waiting for review. */
  PAYMENTS = 'PAYMENTS',
  /** Petty cash: my requests, cash to disburse, retirements due, low floats. */
  PETTY_CASH = 'PETTY_CASH',
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
  /** Accepted / signed off: the quantities count as received. */
  POSTED = 'POSTED',
  /** Refused at sign-off by the requesting department. */
  REJECTED = 'REJECTED',
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
  /** Quotes, specifications, photos attached to a staff requisition. */
  STAFF_REQUISITION = 'STAFF_REQUISITION',
  HANDOVER = 'HANDOVER',
  PETTY_CASH = 'PETTY_CASH',
}

// ------------------------------------------------------------------ slice 9: HMIS integration

/** How the HMIS is reached. MOCK is the built-in FHIR mock (in process, or the mock-hmis container); HL7 is HL7 v2 over MLLP. */
export enum HmisAdapterKind {
  FHIR = 'FHIR',
  REST = 'REST',
  HL7 = 'HL7',
  MOCK = 'MOCK',
}

/** Who bills patient charges: this system (sales invoices + eTIMS) or the HMIS (charges posted to its bill). */
export enum HmisBillingMode {
  LOCAL = 'LOCAL',
  HMIS = 'HMIS',
}

export enum EncounterClass {
  OPD = 'OPD',
  IPD = 'IPD',
  EMERGENCY = 'EMERGENCY',
  DAY_CASE = 'DAY_CASE',
}

export enum EncounterStatus {
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED',
  CANCELLED = 'CANCELLED',
}

export enum HmisDirection {
  IN = 'IN',
  OUT = 'OUT',
}

export enum HmisMessageType {
  PATIENT = 'PATIENT',
  ENCOUNTER = 'ENCOUNTER',
  ALLERGY = 'ALLERGY',
  MEDICATION_REQUEST = 'MEDICATION_REQUEST',
  MEDICATION_DISPENSE = 'MEDICATION_DISPENSE',
  CHARGE = 'CHARGE',
}

/** IN: PROCESSED | FAILED | IGNORED. OUT: PENDING (retrying) → SENT | FAILED. */
export enum HmisMessageStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  SENT = 'SENT',
  FAILED = 'FAILED',
  IGNORED = 'IGNORED',
}

export enum HmisMappingKind {
  /** HMIS drug code → generic (or brand item). */
  DRUG = 'DRUG',
  /** HMIS dispensing location → pharmacy outlet (store). */
  LOCATION = 'LOCATION',
  /** HMIS ward → department. */
  WARD = 'WARD',
  /** HMIS payer / scheme → payer. */
  PAYER = 'PAYER',
}

/** Outpatient supply, or daily / unit-dose supply to an admitted patient. */
export enum SupplyMode {
  STANDARD = 'STANDARD',
  DAILY = 'DAILY',
  UNIT_DOSE = 'UNIT_DOSE',
}

export enum PatientChargeSource {
  DISPENSE = 'DISPENSE',
  ISSUE = 'ISSUE',
  WARD_CONSUMPTION = 'WARD_CONSUMPTION',
}

export enum PatientChargeStatus {
  /** Billed here: a sales invoice holds it. */
  INVOICED = 'INVOICED',
  /** Waiting to be posted to the HMIS bill (retrying). */
  PENDING = 'PENDING',
  POSTED = 'POSTED',
  FAILED = 'FAILED',
}

// ------------------------------------------------------------------ slice 10: point of sale

export enum PosShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

/** Cash-up variance outside pos.varianceTolerance needs a supervisor's decision. */
export enum VarianceStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum PosSaleStatus {
  COMPLETED = 'COMPLETED',
  VOIDED = 'VOIDED',
  PARTLY_REFUNDED = 'PARTLY_REFUNDED',
  REFUNDED = 'REFUNDED',
}

export enum PosEventType {
  VOID_LINE = 'VOID_LINE',
  VOID_SALE = 'VOID_SALE',
  REFUND = 'REFUND',
  DISCOUNT_OVERRIDE = 'DISCOUNT_OVERRIDE',
  PHARMACIST_APPROVAL = 'PHARMACIST_APPROVAL',
  INTERACTION_OVERRIDE = 'INTERACTION_OVERRIDE',
  ACCOUNT_PAYMENT = 'ACCOUNT_PAYMENT',
  OFFLINE_REJECTED = 'OFFLINE_REJECTED',
}

export enum MpesaEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
  MOCK = 'MOCK',
}

export enum MpesaMethod {
  /** Lipa na M-Pesa Online (STK Push) started at the till. */
  STK = 'STK',
  /** Customer paid the till / paybill; confirmation received from Daraja C2B. */
  C2B = 'C2B',
  /** Code typed by the cashier with no confirmation (yet). */
  MANUAL = 'MANUAL',
}

export enum MpesaStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  TIMEOUT = 'TIMEOUT',
}

export enum CustomerLedgerType {
  SALE = 'SALE',
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
}

// ------------------------------------------------------------------ slice 11: QuickBooks accounting

/** Accounting system behind the AccountingAdapter. */
export enum AccountingProvider {
  QBO = 'QBO',
  MOCK = 'MOCK',
}

export enum QboEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
}

/** What a local document becomes in QuickBooks. */
export enum PostingDocType {
  /** Approved LPO / LSO (non-posting in QuickBooks). */
  PURCHASE_ORDER = 'PURCHASE_ORDER',
  BILL = 'BILL',
  BILL_PAYMENT = 'BILL_PAYMENT',
  VENDOR_CREDIT = 'VENDOR_CREDIT',
  SALES_RECEIPT = 'SALES_RECEIPT',
  INVOICE = 'INVOICE',
  PAYMENT = 'PAYMENT',
  REFUND_RECEIPT = 'REFUND_RECEIPT',
  CREDIT_MEMO = 'CREDIT_MEMO',
  JOURNAL = 'JOURNAL',
  /** Expense paid straight from a bank / cash account (petty cash, M-PESA charges). */
  PURCHASE = 'PURCHASE',
  /** Money moved between accounts (petty cash replenishment). */
  TRANSFER = 'TRANSFER',
}

/** READY (previewed, valid) → POSTED; BLOCKED (mapping missing, period closed); PENDING (retrying); FAILED. */
export enum PostingStatus {
  READY = 'READY',
  BLOCKED = 'BLOCKED',
  PENDING = 'PENDING',
  POSTED = 'POSTED',
  FAILED = 'FAILED',
}

export enum AccountMappingKind {
  /** Item category → inventory asset account. */
  CATEGORY_INVENTORY = 'CATEGORY_INVENTORY',
  CATEGORY_COGS = 'CATEGORY_COGS',
  CATEGORY_INCOME = 'CATEGORY_INCOME',
  /** Departmental consumption (issues to wards / departments). */
  CATEGORY_CONSUMPTION = 'CATEGORY_CONSUMPTION',
  /** Store → QuickBooks class (or location). */
  STORE_CLASS = 'STORE_CLASS',
  /** Department / cost centre → QuickBooks class. */
  DEPARTMENT_CLASS = 'DEPARTMENT_CLASS',
  /** Tax category → QuickBooks tax code. */
  TAX_CODE = 'TAX_CODE',
  /** Payment mode / payment method → bank or cash account money goes into or out of. */
  PAYMENT_ACCOUNT = 'PAYMENT_ACCOUNT',
  /** Control accounts: GRNI, AP, AR, VAT, stock adjustment, write-off, in transit, opening balance. */
  SYSTEM = 'SYSTEM',
  /** GL account (by code) → QuickBooks account, when it was not imported from QuickBooks. */
  GL_ACCOUNT = 'GL_ACCOUNT',
}

/** Local master data mirrored in QuickBooks. */
export enum ExternalEntity {
  VENDOR = 'VENDOR',
  CUSTOMER = 'CUSTOMER',
  ITEM = 'ITEM',
}

// ------------------------------------------------------------------ slice 12: documents, dashboards and reports

/** VED criticality of a generic (vital / essential / desirable). */
export enum VedClass {
  VITAL = 'V',
  ESSENTIAL = 'E',
  DESIRABLE = 'D',
}

export enum ReportFormat {
  CSV = 'csv',
  XLSX = 'xlsx',
  PDF = 'pdf',
}

export enum ReportFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

/** Period of a scheduled report, resolved when it runs. */
export enum ReportPeriod {
  YESTERDAY = 'YESTERDAY',
  LAST_7_DAYS = 'LAST_7_DAYS',
  LAST_30_DAYS = 'LAST_30_DAYS',
  LAST_WEEK = 'LAST_WEEK',
  LAST_MONTH = 'LAST_MONTH',
  MONTH_TO_DATE = 'MONTH_TO_DATE',
}

// ------------------------------------------------------------------ non-stock procurement (phase 1)

/**
 * What a requisition / purchase line is. STOCK lines are catalog items held in
 * a store; the others are bought for a user or department and never change
 * stock levels (they post to expense or asset GL accounts).
 */
export enum PurchaseLineType {
  STOCK = 'STOCK',
  NON_STOCK_GOODS = 'NON_STOCK_GOODS',
  SERVICE = 'SERVICE',
  /** Capital item expensed directly (not held as stock). */
  CAPEX_EXPENSED = 'CAPEX_EXPENSED',
}

/**
 * Staff / departmental requisition: DRAFT → SUBMITTED (head of department and
 * further levels) → APPROVED → PARTLY_CONVERTED / CONVERTED (stock lines sent
 * to the store, non-stock lines on purchase requisitions) → CLOSED (all delivered);
 * REJECTED, RETURNED (amend and resubmit), CANCELLED.
 */
export enum StaffRequisitionStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  PARTLY_CONVERTED = 'PARTLY_CONVERTED',
  CONVERTED = 'CONVERTED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

/** Where a requisition line is in the cycle. */
export enum StaffRequisitionLineStatus {
  OPEN = 'OPEN',
  /** Stock line: on an internal store requisition. */
  TO_STORE = 'TO_STORE',
  /** Non-stock line: on a purchase requisition. */
  ON_PR = 'ON_PR',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum GlAccountType {
  EXPENSE = 'EXPENSE',
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  EQUITY = 'EQUITY',
  INCOME = 'INCOME',
  COST_OF_SALES = 'COST_OF_SALES',
  BANK = 'BANK',
}

// ------------------------------------------------------------------ non-stock phase 3: delivery to the final user

export enum HandoverStatus {
  /** Ready for collection: waiting for the receiver's acknowledgement. */
  PENDING = 'PENDING',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  CANCELLED = 'CANCELLED',
}

/** How the receiver acknowledged a hand-over. */
export enum HandoverChannel {
  IN_APP = 'IN_APP',
  OTP = 'OTP',
}

export enum ItemCondition {
  GOOD = 'GOOD',
  DAMAGED = 'DAMAGED',
  INCOMPLETE = 'INCOMPLETE',
}

// ------------------------------------------------------------------ non-stock phase 4: payments and M-PESA payouts

export enum PaymentMethod {
  EFT = 'EFT',
  CHEQUE = 'CHEQUE',
  /** M-PESA B2B to a PayBill number + account. */
  MPESA_PAYBILL = 'MPESA_PAYBILL',
  /** M-PESA B2B to a Till (buy goods) number. */
  MPESA_TILL = 'MPESA_TILL',
  /** M-PESA B2C to a phone number (individuals, sole proprietors). */
  MPESA_B2C = 'MPESA_B2C',
  CASH = 'CASH',
}

export const MPESA_METHODS: PaymentMethod[] = [PaymentMethod.MPESA_PAYBILL, PaymentMethod.MPESA_TILL, PaymentMethod.MPESA_B2C];

export enum PaymentVoucherStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  /** Sent to the payment channel; waiting for its result. */
  PROCESSING = 'PROCESSING',
  PAID = 'PAID',
  /** The channel refused or failed it (review queue: retry or cancel). */
  FAILED = 'FAILED',
  /** Outcome not known after the status checks (review queue). */
  REVIEW = 'REVIEW',
  REVERSED = 'REVERSED',
  CANCELLED = 'CANCELLED',
}

/** One dispatch of a voucher to M-PESA. */
export enum PayoutAttemptStatus {
  /** Accepted by Daraja; result awaited. */
  PENDING = 'PENDING',
  /** No reliable answer (timeout / network): its status must be queried before anything else. */
  UNKNOWN = 'UNKNOWN',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

export enum ReconciliationStatus {
  MATCHED = 'MATCHED',
  EXCEPTIONS = 'EXCEPTIONS',
}

// ------------------------------------------------------------------ non-stock phase 5: petty cash

export enum PettyCashKind {
  /** Pays a staff member or vendor for an expense. */
  PAYMENT = 'PAYMENT',
  /** Advance / imprest: must be retired with receipts (and the balance refunded). */
  ADVANCE = 'ADVANCE',
}

export enum PettyCashStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  /** Sent through M-PESA; result awaited. */
  PROCESSING = 'PROCESSING',
  DISBURSED = 'DISBURSED',
  FAILED = 'FAILED',
  REVIEW = 'REVIEW',
  /** Advance: receipts submitted, waiting for the custodian's check. */
  RETIREMENT_SUBMITTED = 'RETIREMENT_SUBMITTED',
  RETIRED = 'RETIRED',
  REVERSED = 'REVERSED',
  CANCELLED = 'CANCELLED',
}

export enum PettyCashTxnType {
  OPENING = 'OPENING',
  REPLENISHMENT = 'REPLENISHMENT',
  DISBURSEMENT = 'DISBURSEMENT',
  /** Unspent advance returned to the float. */
  REFUND = 'REFUND',
  /** Spent more than the advance: the difference paid out at retirement. */
  TOP_UP = 'TOP_UP',
  REVERSAL = 'REVERSAL',
}

export enum ReplenishmentStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  /** Cash received into the float by the custodian. */
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

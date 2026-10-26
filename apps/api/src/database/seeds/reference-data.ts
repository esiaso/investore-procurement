import {
  AdjustmentDirection,
  ApproverType,
  AttributeType,
  DocumentType,
  Permissions,
  ReturnReasonKind,
  RoleCodes,
  TaxTreatment,
  type AttributeDefinition,
  type PermissionCode,
} from '@sil/shared';

/** eTIMS background jobs (also merged into existing installations by a migration). */
export const ETIMS_SCHEDULES: Record<string, string> = {
  'etims.dispatch': '* * * * *',
  'etims.stock': '*/15 * * * *',
  'etims.purchases': '0 * * * *',
  'etims.monitor': '*/15 * * * *',
  'etims.codes': '0 3 * * *',
};

/** Slice 7 jobs (also merged into existing installations by a migration). */
export const PROCUREMENT_SCHEDULES: Record<string, string> = {
  'forecast.run': '0 4 1 * *',
  'forecast.accuracy': '30 4 1 * *',
  'tenders.close': '*/5 * * * *',
  'contracts.alerts': '0 7 * * *',
  'suppliers.sanctions': '5 0 * * *',
  'suppliers.scorecards': '0 5 1 * *',
  'agency.ordercycle': '0 6 * * *',
  'assets.alerts': '0 7 * * *',
  'shipments.delays': '0 8 * * *',
  'suppliers.leadtimes': '30 5 1 * *',
};

/** Slice 9 HMIS jobs (also merged into existing installations by a migration). */
export const HMIS_SCHEDULES: Record<string, string> = {
  'hmis.dispatch': '* * * * *',
  'hmis.poll': '* * * * *',
  'hmis.monitor': '*/15 * * * *',
};

/**
 * Sourcing methods for a private hospital: the hospital's own policy (not
 * PPADA). Bands are estimated values in KES, VAT inclusive; edit them in settings.
 * Order matters: the first competitive method whose band fits is recommended.
 */
export const DEFAULT_SOURCING_METHODS = [
  { code: 'LOW_VALUE', label: 'Low-value procurement', minAmount: null, maxAmount: 50_000, minBidders: 1, requiresJustification: false, isActive: true },
  { code: 'RFQ', label: 'Request for quotations', minAmount: 50_000, maxAmount: 1_000_000, minBidders: 3, requiresJustification: false, isActive: true },
  { code: 'OPEN_TENDER', label: 'Open tender', minAmount: 1_000_000, maxAmount: null, minBidders: 1, requiresJustification: false, isActive: true },
  { code: 'RESTRICTED_TENDER', label: 'Restricted tender', minAmount: null, maxAmount: 5_000_000, minBidders: 3, requiresJustification: true, isActive: true },
  { code: 'RFP', label: 'Request for proposals', minAmount: null, maxAmount: null, minBidders: 3, requiresJustification: true, isActive: true },
  { code: 'DIRECT', label: 'Direct procurement', minAmount: null, maxAmount: null, minBidders: 1, requiresJustification: true, isActive: true },
  { code: 'FRAMEWORK', label: 'Call-off under a framework agreement', minAmount: null, maxAmount: null, minBidders: 1, requiresJustification: false, isActive: true },
];

/**
 * Default configuration for a private hospital in Kenya. Everything here is
 * data: it is inserted once and can then be changed through the API.
 */
export const DEFAULT_SETTINGS: { key: string; value: unknown; description: string; isPublic: boolean }[] = [
  { key: 'locale.currency', value: 'KES', description: 'ISO 4217 currency code', isPublic: true },
  { key: 'locale.timezone', value: 'Africa/Nairobi', description: 'IANA timezone for business dates', isPublic: true },
  { key: 'locale.dateFormat', value: 'DD/MM/YYYY', description: 'Display date format', isPublic: true },
  { key: 'finance.fyStartMonth', value: 1, description: 'Financial year start month (1 = January)', isPublic: true },
  {
    key: 'security.passwordPolicy',
    value: { minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true },
    description: 'Password complexity rules',
    isPublic: true,
  },
  { key: 'security.maxFailedLogins', value: 5, description: 'Failed logins before temporary lockout', isPublic: false },
  { key: 'security.lockoutMinutes', value: 15, description: 'Lockout duration in minutes', isPublic: false },
  { key: 'security.totpIssuer', value: 'SIL Hospital', description: 'Issuer name shown in authenticator apps', isPublic: false },
  { key: 'security.pending2faTtlSeconds', value: 300, description: 'Time allowed to enter the 2FA code', isPublic: false },
  { key: 'import.maxRows', value: 5000, description: 'Maximum rows per bulk import file', isPublic: false },
  { key: 'inventory.valuationMethod', value: 'WAC', description: 'Stock valuation: WAC (weighted average per item per store) or FIFO (batch cost)', isPublic: false },
  {
    key: 'inventory.adjustmentSecondApprovalThreshold',
    value: 50000,
    description: 'Adjustments above this value need a second, different approver',
    isPublic: false,
  },
  { key: 'inventory.expiryWarningDays', value: [30, 60, 90, 180], description: 'Expiry warning buckets (days)', isPublic: true },
  { key: 'mail.fromAddress', value: 'Procurement <procurement@hospital.example>', description: 'Sender of outgoing mail', isPublic: false },
  { key: 'purchasing.matchQtyTolerancePct', value: 0, description: 'Three-way match: % over received quantity tolerated', isPublic: false },
  { key: 'purchasing.matchPriceTolerancePct', value: 2, description: 'Three-way match: % price difference tolerated', isPublic: false },
  { key: 'purchasing.overReceiptTolerancePct', value: 0, description: '% over the ordered quantity a GRN may receive', isPublic: false },
  { key: 'purchasing.inspectionCommitteeMinMembers', value: 2, description: 'Inspection committee sign-offs needed to post a GRN', isPublic: false },
  { key: 'purchasing.costIncludesVat', value: true, description: 'Add VAT to stock cost on receipt. On by default: the hospital cannot claim input VAT, so VAT paid is part of item cost', isPublic: false },
  { key: 'purchasing.grnRejectReturnReason', value: 'INSPECTION_REJECT', description: 'Return reason on supplier return notes created from GRN inspection rejects', isPublic: false },
  { key: 'inventory.reserveOnApproval', value: true, description: 'Reserve stock (FEFO) for internal requisitions when they are approved', isPublic: false },
  {
    key: 'inventory.issueScanConfirm',
    value: 'OPTIONAL',
    description: 'Issue picks: OPTIONAL (scan or confirm by hand) or REQUIRED (every pick must be scanned: item barcode/GTIN/code or batch number)',
    isPublic: true,
  },
  { key: 'inventory.quarantineBinCode', value: 'QUARANTINE', description: 'Bin (created per store when first needed) that receives damaged/expired returns', isPublic: false },
  { key: 'stock.amcWindowDays', value: 90, description: 'Average monthly consumption: days of ledger history used', isPublic: false },
  {
    key: 'stock.amcTxnTypes',
    value: ['ISSUE', 'TRANSFER_DISPATCH', 'DISPENSE'],
    description: 'Ledger movements counted as consumption for AMC (issues to departments, transfers to other stores, dispenses and sales; returns are netted off)',
    isPublic: false,
  },
  { key: 'stock.amcExcludeStockoutDays', value: true, description: 'Leave days with no stock out of the AMC so stock-outs do not understate demand', isPublic: false },
  { key: 'stock.amcMinDays', value: 14, description: 'AMC is averaged over at least this many days even when most of the window was a stock-out', isPublic: false },
  { key: 'stock.defaultLeadTimeDays', value: 14, description: 'Lead time for items without their own store setting', isPublic: false },
  { key: 'stock.defaultReviewPeriodDays', value: 30, description: 'Review period (days between orders) for items without their own setting', isPublic: false },
  { key: 'stock.safetyStockDays', value: 7, description: 'AUTO mode: safety stock = AMC per day × this many days', isPublic: false },
  { key: 'stock.reorderIncludeOnOrder', value: true, description: 'Reorder check counts open purchase orders and stock in transit on top of available stock', isPublic: false },
  { key: 'stock.disposalReasonCode', value: 'EXPIRY', description: 'Adjustment reason used to write off / dispose of expired stock', isPublic: false },
  { key: 'notify.emailDefault', value: true, description: 'Stock alerts are emailed unless the user switched email off for that category', isPublic: false },
  {
    key: 'jobs.schedules',
    value: {
      'inventory.reconcile': '0 2 * * *',
      'stock.amc': '30 2 * * *',
      'stock.expiry': '15 0 * * *',
      'stock.reorder': '0 6-20 * * *',
      ...ETIMS_SCHEDULES,
      ...PROCUREMENT_SCHEDULES,
      ...HMIS_SCHEDULES,
    },
    description: 'Background job schedules (cron, in locale.timezone). Remove a job to stop scheduling it.',
    isPublic: false,
  },
  { key: 'etims.requestTimeoutMs', value: 10000, description: 'eTIMS: time allowed for one call to the control unit (ms)', isPublic: false },
  { key: 'etims.syncWaitMs', value: 4000, description: 'eTIMS: at sale, how long to wait for the signed receipt before printing "eTIMS pending" and queueing (ms)', isPublic: false },
  { key: 'etims.maxAttempts', value: 20, description: 'eTIMS: attempts for a transient failure (timeout, 5xx, offline) before the document is marked FAILED', isPublic: false },
  { key: 'etims.retryBaseSeconds', value: 30, description: 'eTIMS: first retry delay; doubles each attempt, capped at one hour', isPublic: false },
  { key: 'etims.alertAfterMinutes', value: 60, description: 'eTIMS: alert finance about documents not accepted within this many minutes', isPublic: false },
  {
    key: 'etims.qrUrlTemplate',
    value: 'https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceptData?Data={pin}{bhfId}{rcptSign}',
    description: 'eTIMS: receipt QR link ({pin}, {bhfId}, {rcptSign})',
    isPublic: false,
  },
  { key: 'etims.defaultPackagingUnit', value: 'NT', description: 'eTIMS: packaging unit (code class 17) for units without a mapping', isPublic: false },
  { key: 'etims.defaultOriginCountry', value: 'KE', description: 'eTIMS: country of origin for item codes when not mapped per item', isPublic: false },
  { key: 'etims.defaultPaymentType', value: '01', description: 'eTIMS: payment type (code class 07) when a document has no payment', isPublic: false },
  { key: 'etims.taxTypeRates', value: { A: 0, B: 16, C: 0, D: 0, E: 8 }, description: 'eTIMS: rate per tax type when the synced code table carries none', isPublic: false },
  { key: 'etims.stockReporting', value: true, description: 'eTIMS: report stock movements and stock master (job etims.stock)', isPublic: false },
  { key: 'billing.defaultPriceListCode', value: 'RETAIL', description: 'Price list for walk-in / cash customers', isPublic: false },
  { key: 'billing.patientCreditMode', value: 'CREDIT', description: 'Payment mode that carries an unpaid patient balance (on account)', isPublic: false },
  { key: 'forecast.historyMonths', value: 24, description: 'Forecasting: months of consumption history used', isPublic: false },
  { key: 'forecast.horizonMonths', value: 12, description: 'Forecasting: months forecast ahead', isPublic: false },
  { key: 'forecast.movingAverageMonths', value: 3, description: 'Forecasting: window of the moving average', isPublic: false },
  { key: 'forecast.defaultMethod', value: 'AUTO', description: 'AMC, MOVING_AVERAGE, HOLT_WINTERS, or AUTO (lowest back-tested MAPE per item)', isPublic: false },
  { key: 'forecast.holtWinters', value: { alpha: 0.4, beta: 0.1, gamma: 0.3, seasonLength: 12 }, description: 'Holt-Winters smoothing (level, trend, season) and season length in months', isPublic: false },
  { key: 'supply.minMonthsOfStock', value: 2, description: 'Supply planning: order when stock would fall below this many months', isPublic: true },
  { key: 'supply.maxMonthsOfStock', value: 4, description: 'Supply planning: order up to this many months', isPublic: true },
  { key: 'procurement.sourcingMethods', value: DEFAULT_SOURCING_METHODS, description: 'Sourcing methods and the estimated-value bands (KES, VAT inclusive) in which each may be used', isPublic: true },
  { key: 'procurement.ppadaRuleSet', value: false, description: 'Optional public-procurement (PPADA) steps: standstill before contract, PPRA award report, AGPO tracking. Off for a private hospital', isPublic: true },
  { key: 'procurement.standstillDays', value: 14, description: 'PPADA rule set: days between award notification and contract signature', isPublic: false },
  { key: 'procurement.bidValidityDays', value: 120, description: 'Default tender bid validity (days)', isPublic: false },
  { key: 'procurement.minEvaluationCommittee', value: 3, description: 'Evaluation committee members (without a conflict of interest) needed to recommend an award', isPublic: false },
  { key: 'contracts.expiryAlertDays', value: [90, 30], description: 'Alert contract managers this many days before a contract ends', isPublic: false },
  { key: 'contracts.securityAlertDays', value: [30, 7], description: 'Alert this many days before a performance security expires', isPublic: false },
  { key: 'suppliers.scorecardWeights', value: { onTime: 30, inFull: 25, quality: 25, price: 10, documents: 10 }, description: 'Supplier scorecard weights (on time, in full, quality, price compliance, documents)', isPublic: false },
  { key: 'suppliers.requiredDocumentTypes', value: ['TAX_COMPLIANCE', 'BUSINESS_PERMIT'], description: 'Supplier documents that must be current for document compliance', isPublic: false },
  { key: 'suppliers.scorecardActionThreshold', value: 60, description: 'A corrective action is opened when a monthly score is below this', isPublic: false },
  { key: 'files.maxSizeMb', value: 20, description: 'Largest attachment accepted (MB)', isPublic: true },
  { key: 'files.allowedMimeTypes', value: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], description: 'MIME types accepted as attachments', isPublic: true },
  { key: 'coldChain.ranges', value: { FRIDGE: { min: 2, max: 8 }, FREEZER: { min: -25, max: -15 }, COLD_ROOM: { min: 2, max: 8 }, AMBIENT: { min: 15, max: 25 } }, description: 'Acceptable temperature range (°C) per storage unit type', isPublic: true },
  { key: 'coldChain.excursionMinutes', value: 0, description: 'Out-of-range readings must last this many minutes to count as an excursion (0 = any reading)', isPublic: false },
  { key: 'coldChain.autoQuarantine', value: true, description: 'Hold the batches in a fridge / cold room automatically when an excursion is detected', isPublic: false },
  { key: 'disposal.minCommittee', value: 2, description: 'Disposal committee sign-offs needed before a disposal goes for approval', isPublic: false },
  { key: 'shipments.leadTimeHistoryMonths', value: 12, description: 'Months of receipts used for supplier lead-time history', isPublic: false },
  { key: 'shipments.delayGraceDays', value: 0, description: 'Days after the expected date before a shipment counts as delayed', isPublic: false },
  { key: 'assets.warrantyAlertDays', value: 60, description: 'Alert this many days before an asset warranty ends', isPublic: false },
  { key: 'assets.maintenanceAlertDays', value: 14, description: 'Alert this many days before asset maintenance is due', isPublic: false },
  { key: 'assets.categoryCodes', value: ['EQUIP'], description: 'Item categories whose items become tagged assets on receipt (one per unit)', isPublic: true },
  { key: 'services.categoryCodes', value: ['SVC'], description: 'Item categories that are services / works (completion certificate instead of a GRN)', isPublic: true },
  { key: 'labels.size', value: { widthMm: 62, heightMm: 29 }, description: 'Shelf / batch label size (mm)', isPublic: false },
  {
    key: 'hmis.defaultOutlets',
    value: { OPD: 'OPD-PH', IPD: 'IPD-PH', EMERGENCY: 'ER-PH', DAY_CASE: 'OPD-PH' },
    description: 'Pharmacy (store code) receiving HMIS orders with no mapped dispensing location, by encounter class',
    isPublic: false,
  },
  { key: 'hmis.requestTimeoutMs', value: 8000, description: 'Timeout for each call to the HMIS (ms)', isPublic: false },
  { key: 'hmis.maxAttempts', value: 12, description: 'Attempts to send a message to the HMIS before it is marked failed', isPublic: false },
  { key: 'hmis.retryBaseSeconds', value: 30, description: 'HMIS retry back-off base (seconds, doubled per attempt, capped at 1 hour)', isPublic: false },
  { key: 'hmis.alertAfterMinutes', value: 30, description: 'Alert integration admins about HMIS messages failed or unsent after this many minutes', isPublic: false },
  { key: 'hmis.patientRefreshHours', value: 12, description: 'Re-read a cached patient (demographics, allergies) from the HMIS when older than this', isPublic: false },
  { key: 'pos.discountLimits', value: { POS_CASHIER: 5, PHARMACY_TECHNICIAN: 5, PHARMACIST: 15, SYSTEM_ADMIN: 100 }, description: 'Largest manual discount (%) per role at the till; above it a supervisor (pos.override) authorises', isPublic: true },
  { key: 'pos.varianceTolerance', value: 50, description: 'Cash-up difference (KES) accepted without a supervisor', isPublic: true },
  { key: 'pos.defaultSalesClass', value: 'P', description: 'Sales class for items without one (OTC, P pharmacy-only, POM prescription-only, CD controlled)', isPublic: true },
  { key: 'pos.loyalty', value: { enabled: true, earnPerAmount: 100, pointValue: 1, minRedeemPoints: 50 }, description: 'Loyalty: 1 point per earnPerAmount paid; a point is worth pointValue when redeemed', isPublic: true },
  { key: 'pos.offlineMaxHours', value: 72, description: 'Offline till sales older than this are refused at sync', isPublic: true },
  { key: 'pos.manualMpesaRequiresMatch', value: false, description: 'A typed M-Pesa code must match a confirmation received from Safaricom', isPublic: true },
  { key: 'mpesa.stkTimeoutSeconds', value: 120, description: 'How long an STK push waits for the customer before it times out', isPublic: true },
  { key: 'pharmacy.activeMedicationDays', value: 30, description: 'Medicines dispensed within this many days count as active medications in the checks', isPublic: false },
  {
    key: 'pharmacy.blockingSeverities',
    value: ['CONTRAINDICATED', 'MAJOR'],
    description: 'Alert severities that block verification and dispensing until a pharmacist overrides them with a reason',
    isPublic: true,
  },
];

/** Configurable reason codes for department returns and returns to suppliers. */
export const DEFAULT_RETURN_REASONS: { code: string; name: string; kind: ReturnReasonKind }[] = [
  { code: 'NOT_USED', name: 'Not used / excess to need', kind: ReturnReasonKind.DEPARTMENT },
  { code: 'DISCHARGED', name: 'Patient discharged or transferred', kind: ReturnReasonKind.DEPARTMENT },
  { code: 'TREATMENT_CHANGED', name: 'Treatment changed or stopped', kind: ReturnReasonKind.DEPARTMENT },
  { code: 'WRONG_ITEM', name: 'Wrong item issued / supplied', kind: ReturnReasonKind.BOTH },
  { code: 'DAMAGED', name: 'Damaged', kind: ReturnReasonKind.BOTH },
  { code: 'EXPIRED', name: 'Expired', kind: ReturnReasonKind.BOTH },
  { code: 'NEAR_EXPIRY', name: 'Near expiry', kind: ReturnReasonKind.BOTH },
  { code: 'QUALITY', name: 'Quality defect', kind: ReturnReasonKind.SUPPLIER },
  { code: 'RECALL', name: 'Manufacturer / PPB recall', kind: ReturnReasonKind.SUPPLIER },
  { code: 'OVER_SUPPLY', name: 'Supplied in excess of order', kind: ReturnReasonKind.SUPPLIER },
  { code: 'INSPECTION_REJECT', name: 'Rejected at goods inspection', kind: ReturnReasonKind.SUPPLIER },
];

export const DEFAULT_ADJUSTMENT_REASONS: { code: string; name: string; direction: AdjustmentDirection }[] = [
  { code: 'DAMAGE', name: 'Damaged', direction: AdjustmentDirection.DECREASE },
  { code: 'LOSS', name: 'Lost / unaccounted', direction: AdjustmentDirection.DECREASE },
  { code: 'THEFT', name: 'Theft', direction: AdjustmentDirection.DECREASE },
  { code: 'BREAKAGE', name: 'Breakage', direction: AdjustmentDirection.DECREASE },
  { code: 'EXPIRY', name: 'Expiry write-off', direction: AdjustmentDirection.DECREASE },
  { code: 'FOUND', name: 'Stock found', direction: AdjustmentDirection.INCREASE },
  { code: 'CORRECTION', name: 'Data correction', direction: AdjustmentDirection.BOTH },
  { code: 'TRANSIT_LOSS', name: 'Lost or damaged in transit', direction: AdjustmentDirection.DECREASE },
  { code: 'DISPOSAL', name: 'Disposal (approved disposal)', direction: AdjustmentDirection.DECREASE },
  { code: 'COUNT_VARIANCE', name: 'Stock-take variance', direction: AdjustmentDirection.BOTH },
];

/**
 * Tax categories and their rates. Treatments follow the Kenyan VAT Act
 * (standard 16%, zero-rated, exempt). Which items fall in which category must
 * be confirmed by Finance; the sample catalog uses them illustratively.
 */
export const DEFAULT_TAX: { code: string; name: string; treatment: TaxTreatment; ratePercent: number; effectiveFrom: string }[] = [
  { code: 'STANDARD', name: 'VAT standard rate', treatment: TaxTreatment.STANDARD, ratePercent: 16, effectiveFrom: '2020-01-01' },
  { code: 'ZERO', name: 'VAT zero-rated', treatment: TaxTreatment.ZERO_RATED, ratePercent: 0, effectiveFrom: '2020-01-01' },
  { code: 'EXEMPT', name: 'VAT exempt', treatment: TaxTreatment.EXEMPT, ratePercent: 0, effectiveFrom: '2020-01-01' },
];

export const DEFAULT_NUMBERING: {
  documentType: string;
  prefix: string;
  format: string;
  padding: number;
  resetEachYear: boolean;
}[] = [
  { documentType: DocumentType.ITEM, prefix: 'ITM', format: '{PREFIX}{SEQ}', padding: 6, resetEachYear: false },
  { documentType: DocumentType.PURCHASE_REQUISITION, prefix: 'PR', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.PURCHASE_ORDER, prefix: 'PO', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.GOODS_RECEIVED_NOTE, prefix: 'GRN', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STORE_REQUISITION, prefix: 'SR', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.ISSUE_NOTE, prefix: 'ISS', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.TRANSFER, prefix: 'TRF', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_ADJUSTMENT, prefix: 'ADJ', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_RECEIPT, prefix: 'RCPT', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_TAKE, prefix: 'STK', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.RFQ, prefix: 'RFQ', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.SUPPLIER, prefix: 'SUP', format: '{PREFIX}{SEQ}', padding: 4, resetEachYear: false },
  { documentType: DocumentType.SUPPLIER_INVOICE, prefix: 'INV', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.RETURN_TO_SUPPLIER, prefix: 'RTS', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.PAYMENT_VOUCHER, prefix: 'PV', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.DEPARTMENT_RETURN, prefix: 'DRT', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.SALES_INVOICE, prefix: 'SI', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 6, resetEachYear: true },
  { documentType: DocumentType.CREDIT_NOTE, prefix: 'CN', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.PRESCRIPTION, prefix: 'RX', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 6, resetEachYear: true },
  { documentType: DocumentType.DISPENSE, prefix: 'DSP', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 6, resetEachYear: true },
  { documentType: DocumentType.PROCUREMENT_PLAN, prefix: 'APP', format: '{PREFIX}/{FY}/{SEQ}', padding: 3, resetEachYear: true },
  { documentType: DocumentType.TENDER, prefix: 'TND', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.CONTRACT, prefix: 'CTR', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.CONTRACT_VARIATION, prefix: 'CV', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.SUPPLIER_SANCTION, prefix: 'SSN', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.QUALITY_HOLD, prefix: 'QH', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.QUALITY_COMPLAINT, prefix: 'PQC', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.RECALL, prefix: 'RCL', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.DISPOSAL, prefix: 'DSL', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.DISTRIBUTION_RUN, prefix: 'DRN', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.SHIPMENT, prefix: 'SHP', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.ASSET, prefix: 'AST', format: '{PREFIX}{SEQ}', padding: 6, resetEachYear: false },
  { documentType: DocumentType.SERVICE_CERTIFICATE, prefix: 'SCC', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.POS_SHIFT, prefix: 'Z', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.CUSTOMER, prefix: 'CUS', format: '{PREFIX}{SEQ}', padding: 5, resetEachYear: false },
];

export const DEFAULT_UOMS: [code: string, name: string][] = [
  ['TAB', 'Tablet'],
  ['CAP', 'Capsule'],
  ['STRIP', 'Strip'],
  ['BOX', 'Box'],
  ['BTL', 'Bottle'],
  ['VIAL', 'Vial'],
  ['AMP', 'Ampoule'],
  ['TUBE', 'Tube'],
  ['SACHET', 'Sachet'],
  ['PCS', 'Piece'],
  ['PAIR', 'Pair'],
  ['PACK', 'Pack'],
  ['ROLL', 'Roll'],
  ['KIT', 'Kit'],
  ['BAG', 'Bag'],
  ['ML', 'Millilitre'],
  ['L', 'Litre'],
  ['PESS', 'Pessary'],
  ['INH', 'Inhaler'],
];

/** Global conversions (item-independent). */
export const DEFAULT_CONVERSIONS: [from: string, to: string, factor: number][] = [['L', 'ML', 1000]];

const ppe: AttributeDefinition[] = [
  { key: 'size', label: 'Size', type: AttributeType.ENUM, required: true, options: ['XS', 'S', 'M', 'L', 'XL', 'Universal'] },
  { key: 'material', label: 'Material', type: AttributeType.STRING, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const sharps: AttributeDefinition[] = [
  { key: 'gauge', label: 'Gauge (G)', type: AttributeType.NUMBER, required: false },
  { key: 'volumeMl', label: 'Volume (mL)', type: AttributeType.NUMBER, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const dressings: AttributeDefinition[] = [
  { key: 'dimensions', label: 'Dimensions', type: AttributeType.STRING, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const sutures: AttributeDefinition[] = [
  { key: 'usp', label: 'USP size', type: AttributeType.STRING, required: true },
  { key: 'absorbable', label: 'Absorbable', type: AttributeType.BOOLEAN, required: true },
  { key: 'needle', label: 'Needle type', type: AttributeType.ENUM, required: false, options: ['Round body', 'Cutting', 'Reverse cutting', 'None'] },
];
const lab: AttributeDefinition[] = [
  { key: 'testsPerKit', label: 'Tests per kit', type: AttributeType.NUMBER, required: false },
  { key: 'storageTemp', label: 'Storage temperature', type: AttributeType.STRING, required: false },
];

export const DEFAULT_CATEGORIES: { code: string; name: string; isDrug: boolean; attributeSchema: AttributeDefinition[]; parent?: string }[] = [
  { code: 'DRUG', name: 'Medicines', isDrug: true, attributeSchema: [] },
  { code: 'DRUG-ANALG', name: 'Analgesics & anti-inflammatories', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-ANTIINF', name: 'Anti-infectives', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-CVS', name: 'Cardiovascular', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-ENDO', name: 'Endocrine & diabetes', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-GIT', name: 'Gastro-intestinal', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-RESP', name: 'Respiratory & allergy', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-CNS', name: 'CNS, anaesthesia & controlled', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-FLUIDS', name: 'IV fluids & electrolytes', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-OBS', name: 'Obstetrics & reproductive health', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-VACC', name: 'Vaccines & sera', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-DERM', name: 'Dermatologicals', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-VIT', name: 'Vitamins & minerals', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'SUP', name: 'Medical supplies', isDrug: false, attributeSchema: [] },
  { code: 'SUP-PPE', name: 'PPE', isDrug: false, attributeSchema: ppe, parent: 'SUP' },
  { code: 'SUP-SHARPS', name: 'Syringes, needles & cannulae', isDrug: false, attributeSchema: sharps, parent: 'SUP' },
  { code: 'SUP-DRESS', name: 'Dressings & bandages', isDrug: false, attributeSchema: dressings, parent: 'SUP' },
  { code: 'SUP-SUTURE', name: 'Sutures', isDrug: false, attributeSchema: sutures, parent: 'SUP' },
  { code: 'SUP-LAB', name: 'Laboratory reagents & kits', isDrug: false, attributeSchema: lab, parent: 'SUP' },
  { code: 'SUP-GEN', name: 'General consumables', isDrug: false, attributeSchema: [], parent: 'SUP' },
  { code: 'EQUIP', name: 'Medical equipment (tagged assets)', isDrug: false, attributeSchema: [] },
  { code: 'SVC', name: 'Services & works', isDrug: false, attributeSchema: [] },
];

const P = Permissions;
const ALL = Object.values(P) as PermissionCode[];
const READ_ALL: PermissionCode[] = [
  P.SETTINGS_READ, P.AUDIT_READ, P.USERS_READ, P.ROLES_READ, P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.TAX_READ, P.NUMBERING_READ,
  P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_CONSUMPTION, P.SUPPLIERS_READ, P.BUDGETS_READ, P.PURCHASING_READ,
  P.PATIENTS_READ, P.PHARMACY_READ, P.BILLING_READ, P.ETIMS_READ,
  P.FORECASTING_READ, P.PLANS_READ, P.TENDERS_READ, P.CONTRACTS_READ, P.PROCUREMENT_KPIS,
  P.QUALITY_READ, P.ASSETS_READ, P.HMIS_READ, P.POS_REPORTS,
];
const BUYING: PermissionCode[] = [P.SUPPLIERS_READ, P.SUPPLIERS_MANAGE, P.BUDGETS_READ, P.PURCHASING_READ, P.PURCHASING_RFQ, P.PURCHASING_PO];
/** Strategic procurement (slice 7) for procurement staff. */
const SOURCING: PermissionCode[] = [P.PLANS_READ, P.TENDERS_READ, P.TENDERS_MANAGE, P.CONTRACTS_READ, P.FORECASTING_READ, P.PROCUREMENT_KPIS, P.SUPPLIERS_PERFORMANCE];
/** Day-to-day store operations in assigned stores. */
const STORE_OPS: PermissionCode[] = [
  P.INVENTORY_READ, P.INVENTORY_RECEIVE, P.INVENTORY_ADJUST, P.INVENTORY_TRANSFER_REQUEST, P.INVENTORY_TRANSFER_DISPATCH,
  P.INVENTORY_TRANSFER_RECEIVE, P.INVENTORY_STOCKTAKE, P.INVENTORY_ISSUE, P.INVENTORY_DEPT_RETURN, P.INVENTORY_SUPPLIER_RETURN,
  P.INVENTORY_PLANNING, P.INVENTORY_ALERTS,
];

/** Default permission sets per built-in role. Editable at runtime. */
export const DEFAULT_ROLES: { code: string; name: string; description: string; permissions: PermissionCode[] }[] = [
  { code: RoleCodes.SYSTEM_ADMIN, name: 'System Admin', description: 'Full system administration', permissions: ALL },
  {
    code: RoleCodes.PROCUREMENT_OFFICER,
    name: 'Procurement Officer',
    description: 'Raises requisitions and purchase orders; maintains the catalog',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.INVENTORY_READ, P.INVENTORY_VALUATION,
      P.INVENTORY_PLANNING, ...BUYING, P.PURCHASING_REQUISITION, ...SOURCING, P.SHIPMENTS_MANAGE, P.FILES_UPLOAD, P.ASSETS_READ],
  },
  {
    code: RoleCodes.PROCUREMENT_MANAGER,
    name: 'Procurement Manager / Approver',
    description: 'Approves procurement documents',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_CONSUMPTION, ...BUYING,
      ...SOURCING, P.PLANS_MANAGE, P.PLANS_CONSOLIDATE, P.CONTRACTS_MANAGE, P.SHIPMENTS_MANAGE, P.FILES_UPLOAD, P.QUALITY_READ, P.ASSETS_READ],
  },
  {
    code: RoleCodes.STOREKEEPER,
    name: 'Storekeeper',
    description: 'Receives, stores and issues stock in assigned stores',
    permissions: [
      P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, ...STORE_OPS, P.INVENTORY_HANDLE_COLD_CHAIN, P.SUPPLIERS_READ, P.PURCHASING_READ,
      P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_EMERGENCY_RECEIPT, P.FORECASTING_READ,
      P.DISTRIBUTION_MANAGE, P.QUALITY_READ, P.FILES_UPLOAD, P.ASSETS_READ,
    ],
  },
  {
    code: RoleCodes.PHARMACIST,
    name: 'Pharmacist',
    description: 'Manages pharmacy stock and formulary in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, P.CATALOG_MANAGE, ...STORE_OPS, P.INVENTORY_VALUATION,
      P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_OVERRIDE_FEFO,
      P.INVENTORY_HANDLE_CONTROLLED, P.INVENTORY_HANDLE_COLD_CHAIN, P.SUPPLIERS_READ, P.PURCHASING_READ,
      P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_INSPECT,
      P.PATIENTS_READ, P.PATIENTS_MANAGE, P.PHARMACY_READ, P.PHARMACY_PRESCRIPTION, P.PHARMACY_VERIFY, P.PHARMACY_DISPENSE,
      P.PHARMACY_INTERACTIONS, P.BILLING_READ, P.BILLING_INVOICE,
      P.FORECASTING_READ, P.FORECASTING_MANAGE, P.PLANS_READ, P.PLANS_MANAGE,
      P.QUALITY_READ, P.QUALITY_MANAGE, P.RECALLS_MANAGE, P.DISPOSALS_MANAGE, P.DISTRIBUTION_MANAGE, P.FILES_UPLOAD,
      P.HMIS_READ, P.PATIENTS_CHARGE,
      P.POS_SELL, P.POS_APPROVE_POM, P.POS_OVERRIDE, P.POS_VOID, P.POS_REFUND, P.POS_APPROVE_VARIANCE, P.POS_REPORTS,
    ],
  },
  {
    code: RoleCodes.PHARMACY_TECHNICIAN,
    name: 'Pharmacy Technician',
    description: 'Dispenses and handles pharmacy stock in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_TRANSFER_REQUEST, P.INVENTORY_TRANSFER_RECEIVE,
      P.INVENTORY_STOCKTAKE, P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED, P.PURCHASING_READ,
      P.INVENTORY_ISSUE, P.INVENTORY_DEPT_RETURN, P.INVENTORY_ALERTS,
      P.PATIENTS_READ, P.PATIENTS_MANAGE, P.PHARMACY_READ, P.PHARMACY_PRESCRIPTION, P.PHARMACY_DISPENSE, P.BILLING_READ, P.BILLING_INVOICE,
      P.HMIS_READ, P.POS_SELL,
    ],
  },
  { code: RoleCodes.POS_CASHIER, name: 'POS Cashier', description: 'Point-of-sale operations', permissions: [P.CATALOG_READ, P.INVENTORY_READ, P.PATIENTS_READ, P.BILLING_READ, P.BILLING_INVOICE, P.POS_SELL] },
  {
    code: RoleCodes.QUALITY_OFFICER,
    name: 'Cold-chain / Quality Officer',
    description: 'Monitors cold chain, recalls and quality',
    permissions: [
      P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_BATCH_HOLD,
      P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED, P.SUPPLIERS_READ, P.PURCHASING_READ, P.PURCHASING_INSPECT,
      P.QUALITY_READ, P.QUALITY_MANAGE, P.QUALITY_RELEASE, P.RECALLS_MANAGE, P.DISPOSALS_MANAGE, P.FILES_UPLOAD,
    ],
  },
  {
    code: RoleCodes.WARD_IN_CHARGE,
    name: 'Department / Ward In-charge',
    description: 'Requests stock for a department or ward and approves its internal requisitions',
    permissions: [P.ORG_READ, P.CATALOG_READ, P.PURCHASING_READ, P.PURCHASING_REQUISITION, P.INVENTORY_REQUISITION, P.INVENTORY_CONSUMPTION, P.PLANS_READ, P.PLANS_MANAGE, P.SERVICES_CERTIFY, P.ASSETS_READ,
      P.PATIENTS_READ, P.HMIS_READ, P.PATIENTS_CHARGE],
  },
  {
    code: RoleCodes.WARD_STAFF,
    name: 'Department / Ward Staff',
    description: 'Raises internal requisitions and returns for their department',
    permissions: [P.ORG_READ, P.CATALOG_READ, P.INVENTORY_REQUISITION, P.PATIENTS_READ, P.HMIS_READ, P.PATIENTS_CHARGE],
  },
  {
    code: RoleCodes.FINANCE,
    name: 'Finance / Accounts',
    description: 'Tax configuration, invoices and payments',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.TAX_READ, P.TAX_MANAGE, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_PERIOD_LOCK, P.INVENTORY_RECONCILE,
      P.INVENTORY_CONSUMPTION, P.SUPPLIERS_READ, P.SUPPLIERS_BANK, P.BUDGETS_READ, P.BUDGETS_MANAGE, P.PURCHASING_READ, P.PURCHASING_INVOICE, P.PURCHASING_PAYMENT,
      P.PATIENTS_READ, P.BILLING_READ, P.BILLING_MANAGE, P.ETIMS_READ, P.ETIMS_MANAGE, P.HMIS_READ,
      P.POS_REPORTS, P.POS_APPROVE_VARIANCE, P.POS_MANAGE, P.POS_REFUND,
      P.PLANS_READ, P.CONTRACTS_READ, P.TENDERS_READ, P.PROCUREMENT_KPIS, P.DISPOSALS_MANAGE, P.FILES_UPLOAD, P.ASSETS_READ],
  },
  {
    code: RoleCodes.TENDER_COMMITTEE,
    name: 'Tender / Evaluation Committee Member',
    description: 'Evaluates tenders and quotations',
    permissions: [P.CATALOG_READ, P.SUPPLIERS_READ, P.PURCHASING_READ, P.PURCHASING_INSPECT, P.TENDERS_READ, P.TENDERS_EVALUATE],
  },
  {
    code: RoleCodes.SUPPLY_CHAIN_MANAGER,
    name: 'Supply Chain Manager',
    description: 'Oversees stores, catalog and numbering',
    permissions: [
      P.ORG_READ, P.ORG_MANAGE, P.BINS_MANAGE, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT,
      P.TAX_READ, P.AUDIT_READ, P.NUMBERING_READ, P.NUMBERING_MANAGE, P.USERS_READ, ...STORE_OPS,
      P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_OVERRIDE_FEFO,
      P.INVENTORY_HANDLE_CONTROLLED, P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_BATCH_HOLD, P.INVENTORY_PERIOD_LOCK,
      P.INVENTORY_RECONCILE, P.INVENTORY_CONSUMPTION, P.JOBS_RUN, ...BUYING, P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_INSPECT,
      P.PURCHASING_EMERGENCY_RECEIPT, P.APPROVALS_MANAGE,
      ...SOURCING, P.FORECASTING_MANAGE, P.PLANS_CONSOLIDATE, P.CONTRACTS_MANAGE,
      P.QUALITY_READ, P.QUALITY_MANAGE, P.RECALLS_MANAGE, P.DISPOSALS_MANAGE, P.DISTRIBUTION_MANAGE, P.SHIPMENTS_MANAGE,
      P.ASSETS_READ, P.ASSETS_MANAGE, P.SERVICES_CERTIFY, P.FILES_UPLOAD,
    ],
  },
  { code: RoleCodes.SUPPLIER, name: 'Supplier (portal)', description: 'External supplier portal user', permissions: [P.PORTAL_ACCESS] },
  { code: RoleCodes.AUDITOR, name: 'Auditor (read-only)', description: 'Read-only access to all records', permissions: READ_ALL },
  { code: RoleCodes.HOSPITAL_MANAGEMENT, name: 'Hospital Management', description: 'Read-only oversight', permissions: READ_ALL },
];

/**
 * Default approval workflows by amount band (KES, VAT inclusive). Bands are
 * [min, max). Edit them under Approvals → Workflows.
 */
export const DEFAULT_WORKFLOWS: {
  code: string;
  name: string;
  documentType: string;
  minAmount: number | null;
  maxAmount: number | null;
  itemCategoryCode?: string;
  priority?: number;
  /** Approver type defaults to ROLE; DEPARTMENT_ROLE = role members in the document's department. */
  steps: [name: string, roleCode: string, approverType?: ApproverType][];
}[] = [
  { code: 'PR-1', name: 'Requisitions up to 100,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: null, maxAmount: 100_000, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PR-2', name: 'Requisitions 100,000 to 1,000,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: 100_000, maxAmount: 1_000_000, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER], ['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER]] },
  { code: 'PR-3', name: 'Requisitions over 1,000,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: 1_000_000, maxAmount: null, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER], ['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'PR-CD', name: 'Requisitions with CNS / controlled medicines', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: null, maxAmount: null, itemCategoryCode: 'DRUG-CNS', steps: [['Pharmacist-in-charge', RoleCodes.PHARMACIST], ['Procurement review', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PO-1', name: 'Purchase orders up to 500,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: null, maxAmount: 500_000, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PO-2', name: 'Purchase orders 500,000 to 5,000,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: 500_000, maxAmount: 5_000_000, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER], ['Finance approval', RoleCodes.FINANCE]] },
  { code: 'PO-3', name: 'Purchase orders over 5,000,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: 5_000_000, maxAmount: null, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER], ['Finance approval', RoleCodes.FINANCE], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'INV-1', name: 'Supplier invoices', documentType: DocumentType.SUPPLIER_INVOICE, minAmount: null, maxAmount: null, steps: [['Finance approval', RoleCodes.FINANCE]] },
  { code: 'SR-1', name: 'Internal requisitions', documentType: DocumentType.STORE_REQUISITION, minAmount: null, maxAmount: null, steps: [['Department in-charge', RoleCodes.WARD_IN_CHARGE, ApproverType.DEPARTMENT_ROLE]] },
  { code: 'APP-1', name: 'Annual procurement plans and revisions', documentType: DocumentType.PROCUREMENT_PLAN, minAmount: null, maxAmount: null, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER], ['Finance (budget) review', RoleCodes.FINANCE], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'TND-1', name: 'Tender awards', documentType: DocumentType.TENDER, minAmount: null, maxAmount: null, steps: [['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'CV-1', name: 'Contract variations', documentType: DocumentType.CONTRACT_VARIATION, minAmount: null, maxAmount: null, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER], ['Finance approval', RoleCodes.FINANCE]] },
  { code: 'SSN-1', name: 'Supplier suspension / blacklisting / reinstatement', documentType: DocumentType.SUPPLIER_SANCTION, minAmount: null, maxAmount: null, steps: [['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'DSL-1', name: 'Disposals up to 100,000', documentType: DocumentType.DISPOSAL, minAmount: null, maxAmount: 100_000, steps: [['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Finance approval', RoleCodes.FINANCE]] },
  { code: 'DSL-2', name: 'Disposals over 100,000', documentType: DocumentType.DISPOSAL, minAmount: 100_000, maxAmount: null, steps: [['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Finance approval', RoleCodes.FINANCE], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
];
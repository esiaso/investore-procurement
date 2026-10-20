import type { PasswordPolicy, ValuationMethod } from '@sil/shared';

/** Typed keys of the system_setting table. Values are seeded, never defaulted in code. */
export interface SettingTypes {
  'locale.currency': string;
  'locale.timezone': string;
  'locale.dateFormat': string;
  'finance.fyStartMonth': number;
  'security.passwordPolicy': PasswordPolicy;
  'security.maxFailedLogins': number;
  'security.lockoutMinutes': number;
  'security.totpIssuer': string;
  'security.pending2faTtlSeconds': number;
  'import.maxRows': number;
  'inventory.valuationMethod': ValuationMethod;
  /** Adjustments whose value (in currency) exceeds this need a second, different approver. */
  'inventory.adjustmentSecondApprovalThreshold': number;
  /** Expiry warning buckets in days, e.g. [30, 60, 90, 180]. */
  'inventory.expiryWarningDays': number[];
  'mail.fromAddress': string;
  /** Three-way match: % over received quantity tolerated on invoices. */
  'purchasing.matchQtyTolerancePct': number;
  /** Three-way match: % price difference tolerated. */
  'purchasing.matchPriceTolerancePct': number;
  /** % over the ordered quantity a GRN may receive. */
  'purchasing.overReceiptTolerancePct': number;
  /** Distinct committee sign-offs needed before a GRN can be posted. */
  'purchasing.inspectionCommitteeMinMembers': number;
  /** Add (non-recoverable) VAT to stock cost on receipt. */
  'purchasing.costIncludesVat': boolean;
  /** Return reason code put on return notes created from GRN inspection rejects. */
  'purchasing.grnRejectReturnReason': string;
  /** Reserve stock for internal requisitions on approval. */
  'inventory.reserveOnApproval': boolean;
  /** OPTIONAL or REQUIRED: issue picks must be confirmed by a scan. */
  'inventory.issueScanConfirm': 'OPTIONAL' | 'REQUIRED';
  /** Code of the per-store bin that receives damaged/expired returns. */
  'inventory.quarantineBinCode': string;
  'stock.amcWindowDays': number;
  /** Ledger movement types that count as consumption. */
  'stock.amcTxnTypes': string[];
  'stock.amcExcludeStockoutDays': boolean;
  'stock.amcMinDays': number;
  'stock.defaultLeadTimeDays': number;
  'stock.defaultReviewPeriodDays': number;
  'stock.safetyStockDays': number;
  'stock.reorderIncludeOnOrder': boolean;
  'stock.disposalReasonCode': string;
  'notify.emailDefault': boolean;
  /** Job name → cron expression. */
  'jobs.schedules': Record<string, string>;
  'etims.requestTimeoutMs': number;
  /** How long a sale waits for eTIMS before the receipt is printed as "eTIMS pending". */
  'etims.syncWaitMs': number;
  'etims.maxAttempts': number;
  'etims.retryBaseSeconds': number;
  'etims.alertAfterMinutes': number;
  /** {pin} {bhfId} {rcptSign} placeholders. */
  'etims.qrUrlTemplate': string;
  'etims.defaultPackagingUnit': string;
  'etims.defaultOriginCountry': string;
  'etims.defaultPaymentType': string;
  /** Rate per eTIMS tax type until code tables are synchronised. */
  'etims.taxTypeRates': Record<string, number>;
  'etims.stockReporting': boolean;
  'billing.defaultPriceListCode': string;
  /** Payment mode used when the patient's share is left on account. */
  'billing.patientCreditMode': string;
  /** Prescriptions dispensed within this many days count as the patient's active medication. */
  'pharmacy.activeMedicationDays': number;
  /** Alert severities that block dispensing until a pharmacist overrides them. */
  'pharmacy.blockingSeverities': string[];
  /** Months of consumption history used by the forecasters. */
  'forecast.historyMonths': number;
  'forecast.horizonMonths': number;
  'forecast.movingAverageMonths': number;
  /** AMC | MOVING_AVERAGE | HOLT_WINTERS | AUTO. */
  'forecast.defaultMethod': string;
  'forecast.holtWinters': { alpha: number; beta: number; gamma: number; seasonLength: number };
  /** Months of stock: below min → order; order up to max. */
  'supply.minMonthsOfStock': number;
  'supply.maxMonthsOfStock': number;
  /** Sourcing methods and the amount bands (VAT inclusive) in which each may be used. */
  'procurement.sourcingMethods': SourcingMethodRule[];
  /** Optional public-procurement (PPADA) steps: standstill, PPRA report, AGPO tracking. Off for a private hospital. */
  'procurement.ppadaRuleSet': boolean;
  'procurement.standstillDays': number;
  'procurement.bidValidityDays': number;
  /** Committee members without a conflict of interest needed to evaluate a tender. */
  'procurement.minEvaluationCommittee': number;
  /** Days before a contract ends / a performance security expires at which to alert. */
  'contracts.expiryAlertDays': number[];
  'contracts.securityAlertDays': number[];
  /** Weights (summing to 100) of the scorecard dimensions. */
  'suppliers.scorecardWeights': { onTime: number; inFull: number; quality: number; price: number; documents: number };
  /** Supplier document types that must be current for document compliance. */
  'suppliers.requiredDocumentTypes': string[];
  /** Overall score below which a corrective action is opened automatically. */
  'suppliers.scorecardActionThreshold': number;
}

export interface SourcingMethodRule {
  code: string;
  label: string;
  /** Inclusive lower bound of the estimated value; null = no lower bound. */
  minAmount: number | null;
  /** Exclusive upper bound; null = no limit. */
  maxAmount: number | null;
  /** Quotations / bids to invite at least. */
  minBidders: number;
  requiresJustification: boolean;
  isActive: boolean;
}

export type SettingKey = keyof SettingTypes;

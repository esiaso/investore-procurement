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
}

export type SettingKey = keyof SettingTypes;

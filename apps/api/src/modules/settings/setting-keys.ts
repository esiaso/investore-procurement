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
}

export type SettingKey = keyof SettingTypes;

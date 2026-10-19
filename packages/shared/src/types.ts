import type { PasswordPolicy } from './schemas';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  roles: { code: string; name: string }[];
  permissions: string[];
  /** null = all stores (store.all permission). */
  storeIds: string[] | null;
  /** Department the user belongs to (scopes department-level data). */
  departmentId?: string | null;
  totpEnabled: boolean;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  twoFactorRequired: boolean;
  user: SessionUser | null;
  csrfToken: string;
}

export interface PublicSettings {
  currency: string;
  timezone: string;
  dateFormat: string;
  financialYearStartMonth: number;
  passwordPolicy: PasswordPolicy;
  /** Expiry warning buckets (days), e.g. [30, 60, 90, 180]. */
  expiryWarningDays: number[];
}

export interface ImportIssue {
  row: number;
  field?: string;
  message: string;
}

export interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  createdItems: number;
  createdGenerics: number;
  skippedDuplicates: number;
  errors: ImportIssue[];
  duplicates: ImportIssue[];
  committed: boolean;
}

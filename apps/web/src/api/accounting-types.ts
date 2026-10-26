/** QuickBooks Online integration (slice 11). */
export interface AccountingConnection {
  id: string;
  provider: 'QBO' | 'MOCK';
  environment: 'SANDBOX' | 'PRODUCTION';
  clientId: string | null;
  redirectUri: string | null;
  realmId: string | null;
  companyName: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  connectedAt: string | null;
  closingDate: string | null;
  journalsFrom: string | null;
  lastError: string | null;
  isActive: boolean;
  hasClientSecret: boolean;
  connected: boolean;
}

export type AccountMappingKind = 'CATEGORY_INVENTORY' | 'CATEGORY_COGS' | 'CATEGORY_INCOME' | 'CATEGORY_CONSUMPTION' | 'STORE_CLASS' | 'DEPARTMENT_CLASS' | 'TAX_CODE' | 'PAYMENT_ACCOUNT' | 'SYSTEM';

export interface AccountMapping {
  id: string;
  kind: AccountMappingKind;
  localKey: string;
  externalId: string;
  externalName: string | null;
}

export interface MappingsResponse {
  mappings: AccountMapping[];
  keys: Record<AccountMappingKind, { code: string; name: string }[]>;
}

export interface QboLists {
  accounts: { id: string; name: string; AccountType?: string }[];
  classes: { id: string; name: string }[];
  taxCodes: { id: string; name: string }[];
}

export interface Posting {
  id: string;
  docType: string;
  localDocType: string;
  localDocId: string;
  localDocNo: string | null;
  txnDate: string;
  amount: number;
  status: 'READY' | 'BLOCKED' | 'PENDING' | 'POSTED' | 'FAILED';
  batchId: string | null;
  entries: { account: string; amount: number; classId?: string | null }[];
  payload: Record<string, unknown>;
  externalId: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: string;
  postedAt: string | null;
}

export interface AccountingBatch {
  id: string;
  number: string;
  fromDate: string;
  toDate: string;
  kinds: string;
  status: string;
  createdAt: string;
  postedAt: string | null;
}

export interface BatchDetail extends AccountingBatch {
  summary: { docType: string; count: number; amount: number; ready: number; blocked: number; posted: number }[];
  items: Posting[];
  totals?: { posted: number; failed: number; retry: number };
}

export interface Reconciliation {
  from: string;
  to: string;
  balanced: boolean;
  accounts: { account: string; name: string; local: number; posted: number; quickbooks: number; difference: number; toPost: number }[];
  postings: { doc_type: string; status: string; n: number; amount: number }[];
  unposted: { count: number; byType: { docType: string; count: number }[] };
  inventory: { local: number; quickbooks: number; difference: number; since: string | null };
}

export interface SettlementRow {
  id: string;
  number: string;
  receivedOn: string;
  amount: number;
  modeCode: string;
  reference: string;
  payer: string;
  invoices: number;
}

export interface OutstandingInvoice {
  id: string;
  number: string;
  date: string;
  patient: string | null;
  payerAmount: number;
  owed: number;
}

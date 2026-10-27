/** Reports, dashboard and documents register (slice 12). */
export type ColumnType = 'text' | 'number' | 'qty' | 'money' | 'percent' | 'date' | 'datetime';
export type FilterKey = 'from' | 'to' | 'storeId' | 'categoryId' | 'itemId' | 'supplierId' | 'departmentId' | 'groupBy' | 'days' | 'limit' | 'status';
export type ReportGroup = 'INVENTORY' | 'PHARMACY' | 'PURCHASING' | 'SUPPLY_CHAIN';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportDef {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  filters: FilterKey[];
  required?: FilterKey[];
  groupBy?: { value: string; label: string }[];
  columns: ReportColumn[];
  landscape?: boolean;
}

export interface ReportResult {
  key: string;
  title: string;
  criteria: string[];
  generatedAt: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  notes?: string[];
}

export interface ReportSchedule {
  id: string;
  name: string;
  reportKey: string;
  title: string;
  filters: Record<string, unknown>;
  period: string;
  format: 'csv' | 'xlsx' | 'pdf';
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  hour: number;
  weekday: number | null;
  monthDay: number | null;
  recipients: string[];
  ownerId: string;
  owner: string;
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface DashboardTile {
  key: string;
  section: string;
  label: string;
  value: number;
  format: 'count' | 'money';
  link: string;
  tone?: 'default' | 'warning' | 'error' | 'success';
}

export interface DashboardTrend {
  key: string;
  label: string;
  format: 'money' | 'count';
  points: { period: string; value: number }[];
}

export interface Dashboard {
  tiles: DashboardTile[];
  trends: DashboardTrend[];
}

export interface DocumentRow {
  id: string;
  ownerType: string;
  ownerTypeName: string;
  ownerId: string;
  owner: string | null;
  link: string | null;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  isCurrent: boolean;
  generated: boolean;
  uploadedBy: string | null;
  createdAt: string;
  notes: string | null;
}

export interface ExpiringDocument {
  id: string;
  supplierId: string;
  supplier: string;
  documentType: string;
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string;
  daysLeft: number;
  files: number;
}

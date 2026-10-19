import type { Base, Item } from './types';

export interface StoreItemSetting extends Base {
  storeId: string;
  itemId: string;
  item?: Item;
  mode: 'AUTO' | 'MANUAL';
  minLevel: number;
  maxLevel: number;
  reorderLevel: number;
  reorderQty: number;
  safetyStock: number;
  leadTimeDays: number | null;
  reviewPeriodDays: number | null;
  amc: number;
  amcCalculatedAt: string | null;
  amcDays: number | null;
  isActive: boolean;
}

export interface ReorderRow {
  storeId: string;
  storeName: string;
  parentStoreId: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  categoryName: string;
  mode: string;
  amc: number;
  reorderLevel: number;
  maxLevel: number;
  available: number;
  onHand: number;
  reserved: number;
  onOrder: number;
  inTransit: number;
  unitCost: number;
  position: number;
  below: boolean;
  stockOut: boolean;
  daysOfStock: number | null;
  suggestedQty: number;
  suggestedValue: number;
}

export interface ExpiryRow {
  storeId: string;
  storeName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  batchId: string;
  batchNo: string;
  expiryDate: string;
  daysLeft: number;
  holdStatus: string;
  quantity: number;
  reserved: number;
  inQuarantine: number;
  unitCost: number;
  value: number;
  amc: number;
  daysToConsume: number | null;
  atRisk: boolean;
  suggestedStore: { id: string; name: string; amc: number } | null;
  bins: { binId: string | null; binCode: string | null; quantity: number }[];
}

export interface StockAlertRow {
  id: string;
  type: 'REORDER' | 'STOCKOUT' | 'NEAR_EXPIRY' | 'EXPIRED';
  status: string;
  message: string;
  horizonDays: number | null;
  value: number | null;
  raisedAt: string;
  storeId: string;
  storeName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  batchId: string | null;
  batchNo: string | null;
}

export interface PlanningDashboard {
  reorderAlerts: number;
  stockOuts: number;
  newExpiryAlerts: number;
  nearExpiry: { label: string; horizonDays: number; value: number; batches: number }[];
  expired: { value: number; batches: number };
  currency: string;
}

export interface JobStatus {
  mode: string;
  jobs: { name: string; description: string; schedule: string | null; lastRun: { status: string; startedAt: string; finishedAt: string | null; result: unknown; error: string | null } | null }[];
}

export interface JobRun {
  id: string;
  name: string;
  status: string;
  trigger: string;
  result: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

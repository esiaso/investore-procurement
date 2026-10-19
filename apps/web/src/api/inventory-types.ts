import type {
  AdjustmentDirection,
  AdjustmentStatus,
  BatchHoldStatus,
  StockReceiptType,
  StockTakeStatus,
  StockTakeType,
  StockTxnType,
  TransferStatus,
} from '@sil/shared';
import type { Base, Item, Store } from './types';

export interface StockRow {
  id?: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  binId?: string | null;
  binCode?: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  genericName: string | null;
  uom: string;
  isControlled: boolean;
  isColdChain: boolean;
  batchId?: string;
  batchNo?: string;
  expiryDate?: string | null;
  nearestExpiry?: string | null;
  holdStatus?: BatchHoldStatus;
  batches?: number;
  onHand: number;
  reserved: number;
  inTransit: number;
  usable?: number;
  reorderLevel?: number | null;
  unitCost?: number | null;
  value: number | null;
}

export interface LedgerRow {
  id: string;
  txnType: StockTxnType;
  effectiveDate: string;
  postedAt: string;
  sourceDocType: string;
  sourceDocNo: string | null;
  batchNo: string;
  binCode: string | null;
  quantity: number;
  inTransitDelta: number;
  unitCost: number;
  valueDelta: number;
  reasonCode: string | null;
  fefoOverrideReason: string | null;
  counterpartStore: string | null;
  user: string | null;
  secondSigner: string | null;
  balance: number;
}

export interface Batch extends Base {
  itemId: string;
  item?: Item;
  batchNo: string;
  expiryDate: string | null;
  unitCost: number;
  holdStatus: BatchHoldStatus;
  holdReason: string | null;
}

export interface AdjustmentReason extends Base {
  code: string;
  name: string;
  direction: AdjustmentDirection;
  isActive: boolean;
}

export interface FefoResult {
  allocations: { batchId: string; binId: string | null; batchNo: string; expiryDate: string | null; quantity: number }[];
  allocated: number;
  shortfall: number;
}

interface DocLine extends Base {
  itemId: string;
  item?: Item;
  batchId: string;
  batch?: Batch;
  binId: string | null;
  quantity: number;
  unitCost: number;
}

export interface StockReceipt extends Base {
  number: string;
  type: StockReceiptType;
  storeId: string;
  store?: Store;
  receiptDate: string;
  notes: string | null;
  lines?: DocLine[];
}

export interface StockAdjustment extends Base {
  number: string;
  storeId: string;
  store?: Store;
  reasonCode: string;
  status: AdjustmentStatus;
  adjustmentDate: string;
  notes: string | null;
  totalValue: number;
  requiresSecondApproval: boolean;
  submittedBy: string | null;
  firstApprovedBy: string | null;
  secondApprovedBy: string | null;
  rejectionReason: string | null;
  lines?: DocLine[];
}

export interface TransferAllocation extends Base {
  lineId: string;
  batchId: string;
  batch?: Batch;
  fromBinId: string | null;
  dispatchedQty: number;
  receivedQty: number | null;
  toBinId: string | null;
  unitCost: number;
  discrepancyReasonCode: string | null;
  discrepancyNotes: string | null;
}

export interface StockTransfer extends Base {
  number: string;
  fromStoreId: string;
  fromStore?: Store;
  toStoreId: string;
  toStore?: Store;
  status: TransferStatus;
  notes: string | null;
  lines?: (Base & { itemId: string; item?: Item; requestedQty: number; allocations?: TransferAllocation[] })[];
}

export interface StockTakeLine extends Base {
  itemId: string;
  item?: Item;
  batchId: string;
  batch?: Batch;
  binId: string | null;
  systemQty: number | null;
  countedQty: number | null;
  variance: number | null;
  varianceValue: number | null;
  notes: string | null;
}

export interface StockTake extends Base {
  number: string;
  storeId: string;
  store?: Store;
  type: StockTakeType;
  blind: boolean;
  status: StockTakeStatus;
  itemIds: string[];
  notes: string | null;
  submittedBy: string | null;
  lines?: StockTakeLine[];
}

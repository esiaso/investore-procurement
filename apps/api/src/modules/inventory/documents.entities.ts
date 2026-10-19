import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import {
  AdjustmentDirection,
  AdjustmentStatus,
  ReturnReasonKind,
  StockReceiptType,
  StockTakeStatus,
  StockTakeType,
  TransferStatus,
} from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Store } from '../org/org.entities';
import { Batch } from './inventory.entities';

/** Configurable reason codes for adjustments and transfer discrepancies. */
@Entity('adjustment_reason')
export class AdjustmentReason extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: AdjustmentDirection, enumName: 'adjustment_direction' })
  direction: AdjustmentDirection;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Configurable reason codes for department returns and returns to suppliers. */
@Entity('return_reason')
export class ReturnReason extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: ReturnReasonKind, enumName: 'return_reason_kind' })
  kind: ReturnReasonKind;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

// ------------------------------------------------------------------ receipts (temporary until GRN)

@Entity('stock_receipt')
export class StockReceipt extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'enum', enum: StockReceiptType, enumName: 'stock_receipt_type' })
  type: StockReceiptType;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'date' })
  receiptDate: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @OneToMany(() => StockReceiptLine, (l) => l.receipt, { cascade: true })
  lines?: StockReceiptLine[];
}

@Entity('stock_receipt_line')
export class StockReceiptLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  receiptId: string;

  @ManyToOne(() => StockReceipt, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'receipt_id' })
  receipt?: StockReceipt;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @Column(QUANTITY)
  quantity: number;

  @Column(MONEY)
  unitCost: number;
}

// ------------------------------------------------------------------ adjustments

@Entity('stock_adjustment')
export class StockAdjustment extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'varchar', length: 40 })
  reasonCode: string;

  @Column({ type: 'enum', enum: AdjustmentStatus, enumName: 'adjustment_status', default: AdjustmentStatus.DRAFT })
  status: AdjustmentStatus;

  @Column({ type: 'date' })
  adjustmentDate: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  /** Σ |qty| × unit cost, used for the dual-approval threshold. */
  @Column({ ...MONEY, default: 0 })
  totalValue: number;

  @Column({ type: 'boolean', default: false })
  requiresSecondApproval: boolean;

  @Column({ type: 'uuid', nullable: true })
  submittedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  firstApprovedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstApprovedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  secondApprovedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  secondApprovedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  rejectedBy: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @OneToMany(() => StockAdjustmentLine, (l) => l.adjustment, { cascade: true })
  lines?: StockAdjustmentLine[];
}

@Entity('stock_adjustment_line')
export class StockAdjustmentLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  adjustmentId: string;

  @ManyToOne(() => StockAdjustment, (a) => a.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adjustment_id' })
  adjustment?: StockAdjustment;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  /** Signed: negative = decrease. */
  @Column(QUANTITY)
  quantity: number;

  /** Cost used to value the line (current cost when the line was created). */
  @Column(MONEY)
  unitCost: number;
}

// ------------------------------------------------------------------ transfers

@Entity('stock_transfer')
export class StockTransfer extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  fromStoreId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_store_id' })
  fromStore?: Store;

  @Column({ type: 'uuid' })
  toStoreId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_store_id' })
  toStore?: Store;

  @Column({ type: 'enum', enum: TransferStatus, enumName: 'transfer_status', default: TransferStatus.REQUESTED })
  status: TransferStatus;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: true })
  requestedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  dispatchedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  receivedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @OneToMany(() => StockTransferLine, (l) => l.transfer, { cascade: true })
  lines?: StockTransferLine[];
}

/** Requested item, plus the batches actually dispatched (allocations). */
@Entity('stock_transfer_line')
export class StockTransferLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  transferId: string;

  @ManyToOne(() => StockTransfer, (t) => t.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transfer_id' })
  transfer?: StockTransfer;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column(QUANTITY)
  requestedQty: number;

  @OneToMany(() => StockTransferAllocation, (a) => a.line, { cascade: true })
  allocations?: StockTransferAllocation[];
}

@Entity('stock_transfer_allocation')
export class StockTransferAllocation extends AppBaseEntity {
  @Column({ type: 'uuid' })
  lineId: string;

  @ManyToOne(() => StockTransferLine, (l) => l.allocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'line_id' })
  line?: StockTransferLine;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  /** Bin picked from at the source store. */
  @Column({ type: 'uuid', nullable: true })
  fromBinId: string | null;

  @Column(QUANTITY)
  dispatchedQty: number;

  @Column({ ...QUANTITY, nullable: true })
  receivedQty: number | null;

  /** Bin put away to at the destination. */
  @Column({ type: 'uuid', nullable: true })
  toBinId: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  unitCost: number;

  @Column({ type: 'varchar', length: 40, nullable: true })
  discrepancyReasonCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  discrepancyNotes: string | null;
}

// ------------------------------------------------------------------ stock takes

@Entity('stock_take')
export class StockTake extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: StockTakeType, enumName: 'stock_take_type' })
  type: StockTakeType;

  /** Counters do not see system quantities while counting. */
  @Column({ type: 'boolean', default: true })
  blind: boolean;

  @Column({ type: 'enum', enum: StockTakeStatus, enumName: 'stock_take_status', default: StockTakeStatus.DRAFT })
  status: StockTakeStatus;

  /** Cycle counts: the items in scope. Empty for full counts. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  itemIds: string[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  frozenAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  submittedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @OneToMany(() => StockTakeLine, (l) => l.stockTake, { cascade: true })
  lines?: StockTakeLine[];
}

@Entity('stock_take_line')
@Index(['stockTakeId', 'itemId'])
export class StockTakeLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  stockTakeId: string;

  @ManyToOne(() => StockTake, (s) => s.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stock_take_id' })
  stockTake?: StockTake;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  /** Snapshot at freeze. */
  @Column(QUANTITY)
  systemQty: number;

  @Column({ ...QUANTITY, nullable: true })
  countedQty: number | null;

  @Column({ type: 'uuid', nullable: true })
  countedBy: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

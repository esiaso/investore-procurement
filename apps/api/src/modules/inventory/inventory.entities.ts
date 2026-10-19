import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { BatchHoldStatus, StockTxnType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Bin, Store } from '../org/org.entities';

/** A lot of an item. Non-batch-tracked items get one implicit batch per item. */
@Entity('batch')
@Index(['itemId', 'batchNo'], { unique: true })
@Index(['expiryDate'])
export class Batch extends AppBaseEntity {
  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'varchar', length: 60 })
  batchNo: string;

  @Column({ type: 'date', nullable: true })
  manufactureDate: string | null;

  /** Required for batch-tracked items. */
  @Column({ type: 'date', nullable: true })
  expiryDate: string | null;

  /** Cost of the receipt that created the batch (FIFO cost layer). */
  @Column(MONEY)
  unitCost: number;

  @Column({ type: 'enum', enum: BatchHoldStatus, enumName: 'batch_hold_status', default: BatchHoldStatus.NONE })
  holdStatus: BatchHoldStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  holdReason: string | null;

  /** Donor / programme funding the stock (e.g. Global Fund), when relevant. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  fundingSource: string | null;

  /** Tie-break for FEFO. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;
}

/**
 * Stock per store × bin × batch. Only ever changed by the posting service,
 * inside the same transaction as the ledger rows that explain the change.
 * Uniqueness (bin may be NULL) is a NULLS NOT DISTINCT index in the migration.
 */
@Entity('stock_balance')
@Index('uq_stock_balance_location', { synchronize: false })
@Index(['storeId', 'itemId'])
@Index(['itemId'])
@Index(['batchId'])
@Check(`"on_hand" >= 0`)
@Check(`"reserved" >= 0`)
@Check(`"in_transit" >= 0`)
export class StockBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @ManyToOne(() => Bin, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'bin_id' })
  bin?: Bin | null;

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

  @Column({ ...QUANTITY, default: 0 })
  onHand: number;

  @Column({ ...QUANTITY, default: 0 })
  reserved: number;

  @Column({ ...QUANTITY, default: 0 })
  inTransit: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/**
 * Append-only stock ledger (UPDATE/DELETE blocked by trigger).
 * Invariant: per store × bin × batch, Σ quantity = on_hand and
 * Σ in_transit_delta = in_transit.
 */
@Entity('stock_transaction')
@Index(['storeId', 'itemId', 'postedAt'])
@Index(['batchId'])
@Index(['sourceDocType', 'sourceDocId'])
@Index(['effectiveDate'])
export class StockTransaction {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'enum', enum: StockTxnType, enumName: 'stock_txn_type' })
  txnType: StockTxnType;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @ManyToOne(() => Bin, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'bin_id' })
  bin?: Bin | null;

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

  /** Signed change to on_hand, in base units. */
  @Column(QUANTITY)
  quantity: number;

  /** Signed change to in_transit, in base units. */
  @Column({ ...QUANTITY, default: 0 })
  inTransitDelta: number;

  /** Cost per base unit applied to this movement. */
  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  unitCost: number;

  /** Signed change to stock value (on hand + in transit). */
  @Column({ type: 'numeric', precision: 20, scale: 4, transformer: numericTransformer })
  valueDelta: number;

  /** The other side of a transfer (from/to store). */
  @Column({ type: 'uuid', nullable: true })
  counterpartStoreId: string | null;

  @Column({ type: 'varchar', length: 20 })
  sourceDocType: string;

  @Column({ type: 'uuid', nullable: true })
  sourceDocId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  sourceDocNo: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  reasonCode: string | null;

  /** Set when FEFO was overridden for this row. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  fefoOverrideReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  patientRef: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** Second signatory (controlled drugs). */
  @Column({ type: 'uuid', nullable: true })
  secondSignerId: string | null;

  /** Business date of the movement (period locks apply to it). */
  @Column({ type: 'date' })
  effectiveDate: string;

  @CreateDateColumn({ type: 'timestamptz' })
  postedAt: Date;
}

/** Weighted average cost per item per store. */
@Entity('item_store_cost')
export class ItemStoreCost {
  @PrimaryColumn({ type: 'uuid' })
  storeId: string;

  @PrimaryColumn({ type: 'uuid' })
  itemId: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  avgCost: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/** Postings dated on or before lockedUntil are rejected for the store. */
@Entity('store_period_lock')
export class StorePeriodLock {
  @PrimaryColumn({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'date' })
  lockedUntil: string;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

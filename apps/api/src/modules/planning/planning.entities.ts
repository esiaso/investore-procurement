import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { StockAlertStatus, StockAlertType, StockSettingMode } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { QUANTITY, numericTransformer } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Batch } from '../inventory/inventory.entities';
import { Store } from '../org/org.entities';

/**
 * Stock levels of an item in a store (base units). AUTO: the AMC job
 * recalculates reorder level, safety stock, max and reorder quantity; MANUAL:
 * the values entered are kept and only the AMC is refreshed.
 */
@Entity('store_item_setting')
@Index(['storeId', 'itemId'], { unique: true })
export class StoreItemSetting extends AppBaseEntity {
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'enum', enum: StockSettingMode, enumName: 'stock_setting_mode', default: StockSettingMode.AUTO })
  mode: StockSettingMode;

  @Column({ ...QUANTITY, default: 0 })
  minLevel: number;

  @Column({ ...QUANTITY, default: 0 })
  maxLevel: number;

  @Column({ ...QUANTITY, default: 0 })
  reorderLevel: number;

  @Column({ ...QUANTITY, default: 0 })
  reorderQty: number;

  @Column({ ...QUANTITY, default: 0 })
  safetyStock: number;

  /** null = setting stock.defaultLeadTimeDays */
  @Column({ type: 'int', nullable: true })
  leadTimeDays: number | null;

  /** null = setting stock.defaultReviewPeriodDays */
  @Column({ type: 'int', nullable: true })
  reviewPeriodDays: number | null;

  /** Average monthly consumption (base units per 30 days). */
  @Column({ ...QUANTITY, default: 0 })
  amc: number;

  @Column({ type: 'timestamptz', nullable: true })
  amcCalculatedAt: Date | null;

  /** Days of the window actually averaged over (stock-out days left out). */
  @Column({ type: 'int', nullable: true })
  amcDays: number | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/**
 * A stock condition worth telling someone about. Reorder/stock-out alerts stay
 * OPEN while the condition holds (one open alert per store × item × type) and
 * resolve when it clears; expiry alerts fire once per batch × store × horizon.
 */
@Entity('stock_alert')
@Index(['status', 'type', 'storeId'])
@Index('uq_stock_alert_dedupe', ['dedupeKey'], { unique: true })
export class StockAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: StockAlertType, enumName: 'stock_alert_type' })
  type: StockAlertType;

  @Column({ type: 'enum', enum: StockAlertStatus, enumName: 'stock_alert_status', default: StockAlertStatus.OPEN })
  status: StockAlertStatus;

  /**
   * Insert-once key. Open reorder/stock-out alerts use TYPE|store|item|open and are
   * re-keyed to TYPE|store|item|<id> on resolve, so the next crossing raises a new one.
   * Expiry alerts use TYPE|store|batch|horizon for good.
   */
  @Column({ type: 'varchar', length: 200 })
  dedupeKey: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;

  @ManyToOne(() => Batch, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch | null;

  @Column({ type: 'int', nullable: true })
  horizonDays: number | null;

  @Column({ type: 'varchar', length: 300 })
  message: string;

  /** Quantity / value snapshot when raised. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  details: Record<string, unknown>;

  @Column({ type: 'numeric', precision: 20, scale: 4, transformer: numericTransformer, nullable: true })
  value: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  raisedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** Users notified (in-app / email per preference). */
  @Column({ type: 'int', default: 0 })
  notifiedCount: number;
}

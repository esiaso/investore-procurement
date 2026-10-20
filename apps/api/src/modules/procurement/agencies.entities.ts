import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { DeliveryStage, SupplierSubmissionType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY } from '../../common/entities/transformers';
import { Store } from '../org/org.entities';
import { Supplier } from '../suppliers/suppliers.entities';

/**
 * Recurring order to a supplier (typically KEMSA / MEDS on their order cycle):
 * on each cycle date a draft PO is raised with fixed quantities or the
 * current forecast / reorder suggestions.
 */
@Entity('order_template')
@Index(['nextOrderDate'])
export class OrderTemplate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  departmentId: string;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  /** Order every N months (KEMSA: often monthly or quarterly). */
  @Column({ type: 'int' })
  frequencyMonths: number;

  @Column({ type: 'date' })
  nextOrderDate: string;

  /** Expected delivery after ordering. */
  @Column({ type: 'int', default: 14 })
  leadTimeDays: number;

  /** FIXED: template quantities; SUGGESTED: current forecast / reorder suggestion (template quantity as fallback). */
  @Column({ type: 'varchar', length: 20, default: 'SUGGESTED' })
  quantityMode: 'FIXED' | 'SUGGESTED';

  @Column({ type: 'jsonb' })
  lines: { itemId: string; quantity: number; uomId?: string | null }[];

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'date', nullable: true })
  lastOrderedOn: string | null;
}

/** Delivery tracking of a purchase order (supplier / agency updates). */
@Entity('purchase_order_delivery')
@Index(['purchaseOrderId'])
export class PurchaseOrderDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @Column({ type: 'enum', enum: DeliveryStage, enumName: 'delivery_stage' })
  stage: DeliveryStage;

  /** Waybill, dispatch note, KEMSA invoice / delivery number. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'date', nullable: true })
  expectedDate: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note: string | null;

  @Column({ type: 'uuid', nullable: true })
  recordedBy: string | null;

  @Column({ type: 'boolean', default: false })
  viaPortal: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

/** Delivery note or invoice sent by a supplier through the portal (metadata; files later). */
@Entity('supplier_submission')
@Index(['supplierId', 'createdAt'])
export class SupplierSubmission extends AppBaseEntity {
  @Column({ type: 'uuid' })
  supplierId: string;

  @Column({ type: 'enum', enum: SupplierSubmissionType, enumName: 'supplier_submission_type' })
  type: SupplierSubmissionType;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @Column({ type: 'varchar', length: 60 })
  reference: string;

  @Column({ type: 'date' })
  documentDate: string;

  @Column({ ...MONEY, nullable: true })
  amount: number | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  fileName: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  /** RECEIVED → CAPTURED (turned into a GRN / supplier invoice) or REJECTED. */
  @Column({ type: 'varchar', length: 20, default: 'RECEIVED' })
  status: string;

  @Column({ type: 'uuid' })
  submittedBy: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reviewNote: string | null;
}

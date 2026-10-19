import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { DepartmentReturnStatus, RequisitionPriority, ReturnCondition, StoreRequisitionStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Batch } from '../inventory/inventory.entities';
import { Department, Store } from '../org/org.entities';

// ------------------------------------------------------------------ internal requisitions (S11)

/** A department / ward asking a store or pharmacy for stock. */
@Entity('store_requisition')
@Index(['storeId', 'status'])
@Index(['departmentId', 'status'])
export class StoreRequisition extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  /** Issuing store / pharmacy. */
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: RequisitionPriority, enumName: 'requisition_priority', default: RequisitionPriority.ROUTINE })
  priority: RequisitionPriority;

  @Column({ type: 'date', nullable: true })
  requiredBy: string | null;

  @Column({ type: 'enum', enum: StoreRequisitionStatus, enumName: 'store_requisition_status', default: StoreRequisitionStatus.DRAFT })
  status: StoreRequisitionStatus;

  @Column({ type: 'uuid' })
  requestedBy: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  /** Σ requested × store cost when last saved (routes the approval). */
  @Column({ ...MONEY, default: 0 })
  estimatedValue: number;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => StoreRequisitionLine, (l) => l.requisition, { cascade: true })
  lines?: StoreRequisitionLine[];
}

@Entity('store_requisition_line')
export class StoreRequisitionLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  requisitionId: string;

  @ManyToOne(() => StoreRequisition, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: StoreRequisition;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Base units. */
  @Column(QUANTITY)
  requestedQty: number;

  @Column({ ...QUANTITY, default: 0 })
  issuedQty: number;

  /** Back-order cancelled. Outstanding = requested − issued − cancelled. */
  @Column({ ...QUANTITY, default: 0 })
  cancelledQty: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  cancelReason: string | null;

  /** Patient / encounter the consumable is for (free text until the HMIS link). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  patientRef: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

// ------------------------------------------------------------------ issue vouchers

@Entity('issue_voucher')
@Index(['requisitionId'])
export class IssueVoucher extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  requisitionId: string;

  @ManyToOne(() => StoreRequisition, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: StoreRequisition;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  @Column({ type: 'date' })
  issueDate: string;

  @Column({ type: 'uuid' })
  issuedBy: string;

  /** Person collecting for the department. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  collectedBy: string | null;

  /** Controlled-drug co-signatory. */
  @Column({ type: 'uuid', nullable: true })
  witnessId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  fefoOverrideReason: string | null;

  @Column({ ...MONEY, default: 0 })
  totalValue: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => IssueVoucherLine, (l) => l.voucher, { cascade: true })
  lines?: IssueVoucherLine[];
}

/** One batch/bin pick. */
@Entity('issue_voucher_line')
@Index(['requisitionLineId'])
@Index(['batchId'])
export class IssueVoucherLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  voucherId: string;

  @ManyToOne(() => IssueVoucher, (v) => v.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'voucher_id' })
  voucher?: IssueVoucher;

  @Column({ type: 'uuid' })
  requisitionLineId: string;

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

  /** Cost per base unit charged (WAC or FIFO per settings). */
  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  unitCost: number;

  @Column(MONEY)
  value: number;

  @Column({ type: 'boolean', default: false })
  fefoOverridden: boolean;

  /** The pick was confirmed by scanning (item barcode/GTIN/code or batch number). */
  @Column({ type: 'boolean', default: false })
  scanConfirmed: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  patientRef: string | null;

  /** Quantity since returned by the department. */
  @Column({ ...QUANTITY, default: 0 })
  returnedQty: number;
}

// ------------------------------------------------------------------ department returns

@Entity('department_return')
export class DepartmentReturn extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: DepartmentReturnStatus, enumName: 'department_return_status', default: DepartmentReturnStatus.DRAFT })
  status: DepartmentReturnStatus;

  @Column({ type: 'date', nullable: true })
  returnDate: string | null;

  @Column({ type: 'uuid' })
  requestedBy: string;

  @Column({ type: 'uuid', nullable: true })
  receivedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  witnessId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  /** Credited to the department's consumption. */
  @Column({ ...MONEY, default: 0 })
  totalValue: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => DepartmentReturnLine, (l) => l.departmentReturn, { cascade: true })
  lines?: DepartmentReturnLine[];
}

@Entity('department_return_line')
export class DepartmentReturnLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  returnId: string;

  @ManyToOne(() => DepartmentReturn, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'return_id' })
  departmentReturn?: DepartmentReturn;

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

  /** Issue the stock came from, when known. */
  @Column({ type: 'uuid', nullable: true })
  issueVoucherLineId: string | null;

  @Column(QUANTITY)
  quantity: number;

  @Column({ type: 'varchar', length: 40 })
  reasonCode: string;

  @Column({ type: 'enum', enum: ReturnCondition, enumName: 'return_condition' })
  condition: ReturnCondition;

  /** Put-away bin for resaleable stock; the quarantine bin otherwise (set on posting). */
  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer, default: 0 })
  unitCost: number;

  @Column({ ...MONEY, default: 0 })
  value: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  patientRef: string | null;
}

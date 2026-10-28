import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { HandoverChannel, HandoverStatus, ItemCondition, PurchaseLineType, RequisitionPriority, StaffRequisitionLineStatus, StaffRequisitionStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, QUANTITY } from '../../common/entities/transformers';
import { Item, ItemCategory, UnitOfMeasure } from '../catalog/catalog.entities';
import { GlAccount, Project } from '../finance/finance.entities';
import { Department, Store } from '../org/org.entities';

/**
 * A staff member's (or department's) requisition for goods or services: the
 * start of the purchasing chain. Stock lines become an internal store
 * requisition once approved; non-stock lines (goods, services, capital items
 * expensed) wait for procurement to put them on a purchase requisition.
 */
@Entity('staff_requisition')
@Index(['requestedBy', 'createdAt'])
@Index(['status', 'departmentId'])
@Index(['requestedBy'])
export class StaffRequisition extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  requestedBy: string;

  /** Department / cost centre charged. */
  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  /** Raised for a department other than the requester's own. */
  @Column({ type: 'boolean', default: false })
  onBehalfOfDepartment: boolean;

  @Column({ type: 'uuid', nullable: true })
  projectId: string | null;

  @ManyToOne(() => Project, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'project_id' })
  project?: Project | null;

  /** Store that issues the stock lines (required when there are any). */
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'store_id' })
  store?: Store | null;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  @Column({ type: 'enum', enum: RequisitionPriority, enumName: 'requisition_priority', default: RequisitionPriority.ROUTINE })
  priority: RequisitionPriority;

  @Column({ type: 'date', nullable: true })
  requiredBy: string | null;

  @Column({ type: 'varchar', length: 2000 })
  justification: string;

  @Column({ type: 'enum', enum: StaffRequisitionStatus, enumName: 'staff_requisition_status', default: StaffRequisitionStatus.DRAFT })
  status: StaffRequisitionStatus;

  @Column({ ...MONEY, default: 0 })
  estimatedTotal: number;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  /** Internal store requisition raised for the stock lines. */
  @Column({ type: 'uuid', nullable: true })
  storeRequisitionId: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => StaffRequisitionLine, (l) => l.requisition, { cascade: true })
  lines?: StaffRequisitionLine[];
}

@Entity('staff_requisition_line')
@Index(['prLineId'])
@Index(['requisitionId'])
@Index(['status'])
export class StaffRequisitionLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  requisitionId: string;

  @ManyToOne(() => StaffRequisition, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: StaffRequisition;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'enum', enum: PurchaseLineType, enumName: 'purchase_line_type' })
  lineType: PurchaseLineType;

  /** Catalog item: required for stock lines, optional otherwise. */
  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'varchar', length: 500 })
  description: string;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => ItemCategory, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'category_id' })
  category?: ItemCategory | null;

  @Column(QUANTITY)
  quantity: number;

  /** Stock lines are in the item's base unit. */
  @Column({ type: 'uuid', nullable: true })
  uomId: string | null;

  @ManyToOne(() => UnitOfMeasure, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'uom_id' })
  uom?: UnitOfMeasure | null;

  @Column(MONEY)
  estimatedUnitCost: number;

  /** Expense / asset account the purchase is charged to (non-stock lines). */
  @Column({ type: 'uuid', nullable: true })
  glAccountId: string | null;

  @ManyToOne(() => GlAccount, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'gl_account_id' })
  glAccount?: GlAccount | null;

  @Column({ type: 'enum', enum: StaffRequisitionLineStatus, enumName: 'staff_requisition_line_status', default: StaffRequisitionLineStatus.OPEN })
  status: StaffRequisitionLineStatus;

  /** Purchase requisition line it was consolidated into. */
  @Column({ type: 'uuid', nullable: true })
  prLineId: string | null;

  /** Store requisition line (stock lines). */
  @Column({ type: 'uuid', nullable: true })
  storeRequisitionLineId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  /** Non-stock lines: accepted from the supplier (service certificate), in the line unit. */
  @Column({ ...QUANTITY, default: 0 })
  receivedQty: number;

  /** Handed over to the requester (or accepted by them directly). */
  @Column({ ...QUANTITY, default: 0 })
  deliveredQty: number;
}

/**
 * Hand-over of received non-stock goods (or services) to the final user. It
 * waits for the receiver's acknowledgement, in the app or with a one-time code
 * sent to them; acknowledged quantities count as delivered.
 */
@Entity('handover')
@Index(['requisitionId'])
@Index(['receivedBy', 'status'])
export class Handover extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  requisitionId: string;

  @ManyToOne(() => StaffRequisition, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: StaffRequisition;

  @Column({ type: 'enum', enum: HandoverStatus, enumName: 'handover_status', default: HandoverStatus.PENDING })
  status: HandoverStatus;

  /** Who handed it over. */
  @Column({ type: 'uuid' })
  preparedBy: string;

  /** Who receives it (the requester, or a colleague in their department). */
  @Column({ type: 'uuid' })
  receivedBy: string;

  @Column({ type: 'enum', enum: ItemCondition, enumName: 'item_condition', default: ItemCondition.GOOD })
  condition: ItemCondition;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'enum', enum: HandoverChannel, enumName: 'handover_channel', nullable: true })
  ackChannel: HandoverChannel | null;

  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  ackComment: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ackIp: string | null;

  /** SHA-256 of the one-time code (never the code). */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  otpHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  otpExpiresAt: Date | null;

  @Column({ type: 'int', default: 0 })
  otpAttempts: number;

  @OneToMany(() => HandoverLine, (l) => l.handover, { cascade: true })
  lines?: HandoverLine[];
}

@Entity('handover_line')
@Index(['requisitionLineId'])
@Index(['handoverId'])
export class HandoverLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  handoverId: string;

  @ManyToOne(() => Handover, (h) => h.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'handover_id' })
  handover?: Handover;

  @Column({ type: 'uuid' })
  requisitionLineId: string;

  @ManyToOne(() => StaffRequisitionLine, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requisition_line_id' })
  requisitionLine?: StaffRequisitionLine;

  @Column(QUANTITY)
  quantity: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  remarks: string | null;
}

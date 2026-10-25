import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CorrectiveActionStatus, SanctionType, VariationStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { numericTransformer } from '../../common/entities/transformers';
import { Supplier } from '../suppliers/suppliers.entities';

const PCT = { type: 'numeric', precision: 7, scale: 2, nullable: true, transformer: numericTransformer } as const;

/** Supplier performance for one month. Rates are %; null = nothing to measure. */
@Entity('supplier_scorecard')
@Index(['supplierId', 'period'], { unique: true })
export class SupplierScorecard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  /** YYYY-MM. */
  @Column({ type: 'varchar', length: 7 })
  period: string;

  /** Orders due for delivery in the period. */
  @Column({ type: 'int', default: 0 })
  ordersDue: number;

  @Column({ type: 'int', default: 0 })
  grnLines: number;

  @Column({ type: 'int', default: 0 })
  invoiceLines: number;

  @Column(PCT)
  onTimeRate: number | null;

  @Column(PCT)
  inFullRate: number | null;

  /** On time and in full. */
  @Column(PCT)
  otifRate: number | null;

  @Column(PCT)
  qualityRejectRate: number | null;

  /** Invoice lines priced within tolerance of the order. */
  @Column(PCT)
  priceComplianceRate: number | null;

  /** Required documents current at the end of the period. */
  @Column(PCT)
  documentComplianceRate: number | null;

  /** Weighted score 0–100 (suppliers.scorecardWeights). */
  @Column(PCT)
  overallScore: number | null;

  /** Average days from PO sent to GRN for orders received in the month, and shipments that slipped. */
  @Column({ type: 'numeric', precision: 7, scale: 1, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  avgLeadTimeDays: number | null;

  @Column({ type: 'int', default: 0 })
  delayedShipments: number;

  @CreateDateColumn({ type: 'timestamptz' })
  computedAt: Date;
}

@Entity('corrective_action')
@Index(['supplierId', 'status'])
export class CorrectiveAction extends AppBaseEntity {
  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid', nullable: true })
  scorecardId: string | null;

  @Column({ type: 'varchar', length: 2000 })
  issue: string;

  @Column({ type: 'varchar', length: 2000 })
  actionRequired: string;

  @Column({ type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ type: 'enum', enum: CorrectiveActionStatus, enumName: 'corrective_action_status', default: CorrectiveActionStatus.OPEN })
  status: CorrectiveActionStatus;

  @Column({ type: 'uuid', nullable: true })
  raisedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  outcome: string | null;
}

/** Request to suspend, blacklist or reinstate a supplier (approval engine). */
@Entity('supplier_sanction')
@Index(['supplierId'])
export class SupplierSanction extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'enum', enum: SanctionType, enumName: 'sanction_type' })
  type: SanctionType;

  @Column({ type: 'varchar', length: 2000 })
  reason: string;

  @Column({ type: 'date' })
  effectiveFrom: string;

  /** Suspensions end (the supplier is reinstated automatically); null = indefinite. */
  @Column({ type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'enum', enum: VariationStatus, enumName: 'variation_status', default: VariationStatus.PENDING_APPROVAL })
  status: VariationStatus;

  @Column({ type: 'uuid' })
  requestedBy: string;

  @Column({ type: 'boolean', default: false })
  lifted: boolean;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;
}

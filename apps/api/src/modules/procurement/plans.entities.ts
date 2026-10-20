import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { PlanStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, QUANTITY } from '../../common/entities/transformers';
import { Item, ItemCategory } from '../catalog/catalog.entities';
import { Department } from '../org/org.entities';

/**
 * Annual procurement plan of a department for a financial year, or the
 * consolidated hospital plan (departmentId null). Revisions bump the version
 * and go through approval again; earlier versions are kept as snapshots.
 */
@Entity('procurement_plan')
@Index(['financialYear', 'departmentId'], { unique: true, where: '"department_id" IS NOT NULL' })
@Index(['financialYear'], { unique: true, where: '"department_id" IS NULL' })
export class ProcurementPlan extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'varchar', length: 20 })
  financialYear: string;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'enum', enum: PlanStatus, enumName: 'plan_status', default: PlanStatus.DRAFT })
  status: PlanStatus;

  @Column({ type: 'int', default: 1 })
  version: number;

  /** Approved at least once (revisions of an approved plan restore it on rejection). */
  @Column({ type: 'boolean', default: false })
  wasApproved: boolean;

  @Column({ ...MONEY, default: 0 })
  totalEstimate: number;

  /** Departmental plan: the hospital plan it was consolidated into. */
  @Column({ type: 'uuid', nullable: true })
  consolidatedIntoId: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  revisionReason: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => ProcurementPlanLine, (l) => l.plan, { cascade: true })
  lines?: ProcurementPlanLine[];
}

@Entity('procurement_plan_line')
@Index(['planId'])
export class ProcurementPlanLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  planId: string;

  @ManyToOne(() => ProcurementPlan, (p) => p.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan?: ProcurementPlan;

  @Column({ type: 'int' })
  lineNo: number;

  /** Catalogue item, or a description for works/services/new items. */
  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => ItemCategory, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'category_id' })
  category?: ItemCategory | null;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  @Column(MONEY)
  estimatedUnitCost: number;

  @Column(MONEY)
  estimatedTotal: number;

  /** Budget vote head the line is funded from. */
  @Column({ type: 'varchar', length: 40 })
  voteHead: string;

  /** Planned sourcing method code (setting procurement.sourcingMethods). */
  @Column({ type: 'varchar', length: 40 })
  sourcingMethod: string;

  /** 1–4: quarter of the financial year in which to procure. */
  @Column({ type: 'int' })
  plannedQuarter: number;

  /** Consolidated plan: departments contributing to the line. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  sourceDepartmentIds: string[];

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

/** Snapshot of a plan at each approved version (revision history). */
@Entity('procurement_plan_version')
@Index(['planId', 'version'], { unique: true })
export class ProcurementPlanVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  planId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BudgetEnforcement, BudgetEntryType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY } from '../../common/entities/transformers';
import { Department } from '../org/org.entities';

/** Budget per department × vote head × financial year. */
@Entity('budget')
@Index(['departmentId', 'voteHead', 'financialYear'], { unique: true })
export class Budget extends AppBaseEntity {
  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  /** e.g. PHARMA, MED-SUPPLIES, LAB-REAGENTS. */
  @Column({ type: 'varchar', length: 40 })
  voteHead: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  /** FY label as produced by the numbering service ("2026" or "2026/27"). */
  @Column({ type: 'varchar', length: 20 })
  financialYear: string;

  @Column(MONEY)
  amount: number;

  /** WARN lets the document through with a warning; BLOCK stops approval. */
  @Column({ type: 'enum', enum: BudgetEnforcement, enumName: 'budget_enforcement', default: BudgetEnforcement.WARN })
  enforcement: BudgetEnforcement;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/**
 * Append-only budget movements. committed = Σ COMMITMENT + Σ RELEASE (releases
 * are negative); actual = Σ ACTUAL; available = amount − committed − actual.
 */
@Entity('budget_entry')
@Index(['budgetId'])
@Index(['sourceDocType', 'sourceDocId'])
export class BudgetEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  budgetId: string;

  @ManyToOne(() => Budget, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'budget_id' })
  budget?: Budget;

  @Column({ type: 'enum', enum: BudgetEntryType, enumName: 'budget_entry_type' })
  entryType: BudgetEntryType;

  /** Signed. */
  @Column(MONEY)
  amount: number;

  @Column({ type: 'varchar', length: 20 })
  sourceDocType: string;

  @Column({ type: 'uuid' })
  sourceDocId: string;

  @Column({ type: 'varchar', length: 60 })
  sourceDocNo: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  postedAt: Date;
}

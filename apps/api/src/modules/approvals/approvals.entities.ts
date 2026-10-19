import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalActionType, ApprovalStatus, ApproverType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY } from '../../common/entities/transformers';
import { Role } from '../rbac/rbac.entities';

/**
 * Who approves a document type within an amount band, optionally only for a
 * department or item category. The most specific matching workflow wins
 * (department + category > department or category > neither), then priority.
 */
@Entity('approval_workflow')
@Index(['documentType', 'isActive'])
export class ApprovalWorkflow extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** e.g. PR, PO, INV. */
  @Column({ type: 'varchar', length: 20 })
  documentType: string;

  /** Inclusive lower bound (null = 0). */
  @Column({ ...MONEY, nullable: true })
  minAmount: number | null;

  /** Exclusive upper bound (null = no limit). */
  @Column({ ...MONEY, nullable: true })
  maxAmount: number | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  itemCategoryId: string | null;

  /** Higher wins between equally specific workflows. */
  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => ApprovalStep, (s) => s.workflow, { cascade: true })
  steps?: ApprovalStep[];
}

@Entity('approval_step')
@Index(['workflowId', 'sequence'], { unique: true })
export class ApprovalStep extends AppBaseEntity {
  @Column({ type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => ApprovalWorkflow, (w) => w.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: ApprovalWorkflow;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: ApproverType, enumName: 'approver_type' })
  approverType: ApproverType;

  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'role_id' })
  role?: Role | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;
}

/** One approval cycle of one document. */
@Entity('approval_request')
@Index(['documentType', 'documentId'])
@Index(['status'])
export class ApprovalRequest extends AppBaseEntity {
  @Column({ type: 'varchar', length: 20 })
  documentType: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @Column({ type: 'varchar', length: 60 })
  documentNo: string;

  @Column({ type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => ApprovalWorkflow, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: ApprovalWorkflow;

  @Column({ type: 'enum', enum: ApprovalStatus, enumName: 'approval_status', default: ApprovalStatus.PENDING })
  status: ApprovalStatus;

  /** Sequence of the step awaiting action. */
  @Column({ type: 'int' })
  currentStep: number;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'uuid' })
  requestedBy: string;

  /** Department of the document; DEPARTMENT_ROLE steps are limited to its members. */
  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  summary: string | null;

  /** Front-end route of the document, e.g. /purchase-orders/<id>. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  link: string | null;

  @OneToMany(() => ApprovalAction, (a) => a.request)
  actions?: ApprovalAction[];
}

@Entity('approval_action')
@Index(['requestId'])
export class ApprovalAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  requestId: string;

  @ManyToOne(() => ApprovalRequest, (r) => r.actions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request?: ApprovalRequest;

  @Column({ type: 'int' })
  stepSequence: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  stepName: string | null;

  @Column({ type: 'enum', enum: ApprovalActionType, enumName: 'approval_action_type' })
  action: ApprovalActionType;

  @Column({ type: 'uuid' })
  userId: string;

  /** Set when the user acted as a delegate. */
  @Column({ type: 'uuid', nullable: true })
  onBehalfOfUserId: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

/** While away, `fromUserId`'s approvals can be done by `toUserId`. */
@Entity('approval_delegation')
@Index(['toUserId'])
export class ApprovalDelegation extends AppBaseEntity {
  @Column({ type: 'uuid' })
  fromUserId: string;

  @Column({ type: 'uuid' })
  toUserId: string;

  @Column({ type: 'date' })
  startsOn: string;

  @Column({ type: 'date' })
  endsOn: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  reason: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

@Entity('notification')
@Index(['userId', 'readAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  link: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** Edge in the document chain (PR → RFQ → PO → GRN → invoice → payment). */
@Entity('document_link')
@Index(['fromType', 'fromId'])
@Index(['toType', 'toId'])
@Index(['fromType', 'fromId', 'toType', 'toId'], { unique: true })
export class DocumentLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 20 })
  fromType: string;

  @Column({ type: 'uuid' })
  fromId: string;

  @Column({ type: 'varchar', length: 60 })
  fromNo: string;

  @Column({ type: 'varchar', length: 20 })
  toType: string;

  @Column({ type: 'uuid' })
  toId: string;

  @Column({ type: 'varchar', length: 60 })
  toNo: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

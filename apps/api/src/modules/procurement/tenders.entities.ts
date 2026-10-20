import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BidStatus, CommitteeRole, EvaluationStage, TenderStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Supplier } from '../suppliers/suppliers.entities';

const SCORE = { type: 'numeric', precision: 9, scale: 4, transformer: numericTransformer } as const;

/** Open / restricted tender or request for proposals, awarded as one lot. */
@Entity('tender')
export class Tender extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  description: string | null;

  /** OPEN_TENDER, RESTRICTED_TENDER or RFP. */
  @Column({ type: 'varchar', length: 40 })
  method: string;

  @Column({ type: 'uuid', nullable: true })
  requisitionId: string | null;

  @Column({ type: 'uuid', nullable: true })
  planLineId: string | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'enum', enum: TenderStatus, enumName: 'tender_status', default: TenderStatus.DRAFT })
  status: TenderStatus;

  @Column(MONEY)
  estimatedValue: number;

  /** Restricted tenders and RFPs: only these suppliers may bid. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  invitedSupplierIds: string[];

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'timestamptz' })
  closingAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ ...MONEY, default: 0 })
  bidSecurityAmount: number;

  @Column({ type: 'int' })
  bidValidityDays: number;

  /** Combined score = technical × weight + financial × (100 − weight); 0 = lowest evaluated price. */
  @Column({ type: 'int', default: 0 })
  technicalWeight: number;

  /** Technical score (0–100) a bid needs to go to financial evaluation. */
  @Column({ type: 'int', default: 0 })
  technicalPassMark: number;

  @Column({ type: 'uuid', nullable: true })
  recommendedBidId: string | null;

  @Column({ type: 'text', nullable: true })
  evaluationReport: string | null;

  /** Head of procurement's professional opinion on the recommendation. */
  @Column({ type: 'text', nullable: true })
  professionalOpinion: string | null;

  @Column({ type: 'uuid', nullable: true })
  opinionBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  awardedBidId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  awardedAt: Date | null;

  /** Optional standstill (PPADA rule set): no contract before this time. */
  @Column({ type: 'timestamptz', nullable: true })
  standstillUntil: Date | null;

  @Column({ type: 'uuid', nullable: true })
  contractId: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  cancellationReason: string | null;

  @OneToMany(() => TenderLine, (l) => l.tender, { cascade: true })
  lines?: TenderLine[];
}

@Entity('tender_line')
export class TenderLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  tenderId: string;

  @ManyToOne(() => Tender, (t) => t.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tender_id' })
  tender?: Tender;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  /** Base units (a framework tender: the estimated quantity over the contract). */
  @Column(QUANTITY)
  quantity: number;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  specification: string | null;
}

/** Bid documents issued (bought / downloaded) per supplier. */
@Entity('tender_document_issue')
@Index(['tenderId', 'supplierId'], { unique: true })
export class TenderDocumentIssue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ ...MONEY, default: 0 })
  fee: number;

  @Column({ type: 'uuid', nullable: true })
  issuedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  issuedAt: Date;
}

/** A question from a bidder and its answer; addenda change the bid document for everyone. */
@Entity('tender_clarification')
@Index(['tenderId'])
export class TenderClarification extends AppBaseEntity {
  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'uuid', nullable: true })
  supplierId: string | null;

  @Column({ type: 'varchar', length: 4000 })
  question: string;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  answer: string | null;

  @Column({ type: 'boolean', default: false })
  isAddendum: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  answeredBy: string | null;
}

/** Bid submission register. Prices stay sealed until the tender is opened. */
@Entity('bid')
@Index(['tenderId', 'supplierId'], { unique: true })
export class Bid extends AppBaseEntity {
  @Column({ type: 'uuid' })
  tenderId: string;

  @ManyToOne(() => Tender, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tender_id' })
  tender?: Tender;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'timestamptz' })
  submittedAt: Date;

  /** Who recorded it: a procurement officer (physical bid) or the supplier (portal). */
  @Column({ type: 'uuid', nullable: true })
  recordedBy: string | null;

  @Column({ type: 'boolean', default: false })
  viaPortal: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  bidSecurityRef: string | null;

  @Column({ ...MONEY, default: 0 })
  bidSecurityAmount: number;

  @Column({ type: 'int', nullable: true })
  deliveryDays: number | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  technicalProposal: string | null;

  @Column({ ...MONEY, default: 0 })
  totalPrice: number;

  @Column({ type: 'enum', enum: BidStatus, enumName: 'bid_status', default: BidStatus.SUBMITTED })
  status: BidStatus;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  statusReason: string | null;

  @Column({ ...SCORE, nullable: true })
  technicalScore: number | null;

  @Column({ ...SCORE, nullable: true })
  financialScore: number | null;

  @Column({ ...SCORE, nullable: true })
  combinedScore: number | null;

  @Column({ type: 'int', nullable: true })
  rank: number | null;

  @OneToMany(() => BidLine, (l) => l.bid, { cascade: true })
  lines?: BidLine[];
}

@Entity('bid_line')
@Index(['bidId', 'tenderLineId'], { unique: true })
export class BidLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  bidId: string;

  @ManyToOne(() => Bid, (b) => b.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bid_id' })
  bid?: Bid;

  @Column({ type: 'uuid' })
  tenderLineId: string;

  /** Per base unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  offeredBrand: string | null;
}

/** Minutes of the public bid opening. */
@Entity('bid_opening')
@Index(['tenderId'], { unique: true })
export class BidOpening {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'timestamptz' })
  openedAt: Date;

  @Column({ type: 'text', array: true, default: () => `'{}'` })
  attendees: string[];

  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  openedBy: string[];

  /** Read-out per bid: supplier, total price, bid security, notes. */
  @Column({ type: 'jsonb' })
  readouts: { bidId: string; supplier: string; totalPrice: number; bidSecurity: string | null; late: boolean }[];

  @Column({ type: 'text', nullable: true })
  minutes: string | null;
}

/** Evaluation committee; members must declare conflicts of interest before scoring. */
@Entity('evaluation_member')
@Index(['tenderId', 'userId'], { unique: true })
export class EvaluationMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: CommitteeRole, enumName: 'committee_role', default: CommitteeRole.MEMBER })
  role: CommitteeRole;

  @Column({ type: 'timestamptz', nullable: true })
  declaredAt: Date | null;

  @Column({ type: 'boolean', nullable: true })
  hasConflict: boolean | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  declaration: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  appointedAt: Date;
}

/**
 * Evaluation criterion. PRELIMINARY criteria are pass/fail (mandatory
 * requirements); TECHNICAL criteria are scored out of maxScore and weighted.
 */
@Entity('evaluation_criterion')
@Index(['tenderId', 'stage'])
export class EvaluationCriterion extends AppBaseEntity {
  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'enum', enum: EvaluationStage, enumName: 'evaluation_stage' })
  stage: EvaluationStage;

  @Column({ type: 'varchar', length: 300 })
  name: string;

  /** Technical: share of the technical score (weights of a tender add up to 100). */
  @Column({ type: 'int', default: 0 })
  weight: number;

  @Column({ type: 'int', default: 1 })
  maxScore: number;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;
}

@Entity('evaluation_score')
@Index(['criterionId', 'bidId', 'memberId'], { unique: true })
export class EvaluationScore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenderId: string;

  @Column({ type: 'uuid' })
  criterionId: string;

  @Column({ type: 'uuid' })
  bidId: string;

  /** The evaluation_member row. */
  @Column({ type: 'uuid' })
  memberId: string;

  /** Preliminary: 1 pass, 0 fail. Technical: 0–maxScore. */
  @Column(SCORE)
  score: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  scoredAt: Date;
}

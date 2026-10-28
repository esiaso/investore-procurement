import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { PettyCashKind, PettyCashStatus, PettyCashTxnType, ReplenishmentStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY } from '../../common/entities/transformers';
import { GlAccount } from '../finance/finance.entities';
import { Department } from '../org/org.entities';

/**
 * A petty cash float (per branch / department) held by a custodian. Its
 * balance moves only through the ledger (petty_cash_transaction).
 */
@Entity('petty_cash_float')
export class PettyCashFloat extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 30 })
  code: string;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  /** Branch / site. */
  @Column({ type: 'varchar', length: 150, nullable: true })
  location: string | null;

  @Column({ type: 'uuid' })
  custodianId: string;

  /** The imprest: what the float is topped up to. */
  @Column(MONEY)
  floatLimit: number;

  @Column(MONEY)
  perTransactionLimit: number;

  /** A replenishment is requested when the balance drops below this. */
  @Column(MONEY)
  replenishThreshold: number;

  /** Cash / M-PESA account of the float. */
  @Column({ type: 'uuid', nullable: true })
  glAccountId: string | null;

  @ManyToOne(() => GlAccount, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'gl_account_id' })
  glAccount?: GlAccount | null;

  /** Disbursements may go out by M-PESA (B2C / B2B, paying shortcode from the environment). */
  @Column({ type: 'boolean', default: false })
  mpesaEnabled: boolean;

  /** The float's own M-PESA shortcode, for reference / reconciliation. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  mpesaShortcode: string | null;

  /** Current balance (kept by the ledger). */
  @Column({ ...MONEY, default: 0 })
  balance: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Petty cash payment request or advance (printed as the petty cash voucher). */
@Entity('petty_cash_request')
@Index(['amount', 'disbursedOn'])
@Index(['requestedBy', 'createdAt'])
@Index(['floatId', 'status'])
@Index(['requestedBy', 'kind', 'status'])
export class PettyCashRequest extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  floatId: string;

  @ManyToOne(() => PettyCashFloat, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'float_id' })
  float?: PettyCashFloat;

  @Column({ type: 'enum', enum: PettyCashKind, enumName: 'petty_cash_kind', default: PettyCashKind.PAYMENT })
  kind: PettyCashKind;

  @Column({ type: 'enum', enum: PettyCashStatus, enumName: 'petty_cash_status', default: PettyCashStatus.DRAFT })
  status: PettyCashStatus;

  @Column({ type: 'uuid' })
  requestedBy: string;

  /** STAFF or VENDOR. */
  @Column({ type: 'varchar', length: 10 })
  payeeType: string;

  /** Staff payee (advances are always to the requester). */
  @Column({ type: 'uuid', nullable: true })
  payeeUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  supplierId: string | null;

  @Column({ type: 'varchar', length: 200 })
  payeeName: string;

  @Column({ type: 'varchar', length: 1000 })
  purpose: string;

  /** Expense category (GL account). */
  @Column({ type: 'uuid', nullable: true })
  glAccountId: string | null;

  @ManyToOne(() => GlAccount, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'gl_account_id' })
  glAccount?: GlAccount | null;

  /** Cost centre charged. */
  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  @Column({ type: 'uuid', nullable: true })
  projectId: string | null;

  @Column(MONEY)
  amount: number;

  /** PaymentMethod: CASH or an M-PESA method. */
  @Column({ type: 'varchar', length: 20 })
  method: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  payeePhone: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  payeeShortcode: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  payeeAccountRef: string | null;

  /** Same payee and amount within the duplicate window (allowed with a justification). */
  @Column({ type: 'uuid', nullable: true })
  possibleDuplicateOf: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  duplicateJustification: string | null;

  @Column({ type: 'date', nullable: true })
  disbursedOn: string | null;

  @Column({ type: 'uuid', nullable: true })
  disbursedBy: string | null;

  /** M-PESA receipt, or the cash voucher reference. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  reference: string | null;

  /** Cash: who collected it (name as signed). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  receivedByName: string | null;

  /** The payee confirmed receipt in the app. */
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acknowledgedBy: string | null;

  /** Advance: retire by this date. */
  @Column({ type: 'date', nullable: true })
  retirementDueOn: string | null;

  @Column({ ...MONEY, nullable: true })
  spentAmount: number | null;

  /** Unspent advance returned (positive), or overspend paid out at retirement (negative). */
  @Column({ ...MONEY, nullable: true })
  refundAmount: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  retirementNotes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  retiredAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  retiredBy: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => PettyCashRetirementLine, (l) => l.request, { cascade: true })
  retirementLines?: PettyCashRetirementLine[];
}

/** A receipt on an advance's retirement. */
@Entity('petty_cash_retirement_line')
export class PettyCashRetirementLine extends AppBaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  requestId: string;

  @ManyToOne(() => PettyCashRequest, (r) => r.retirementLines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request?: PettyCashRequest;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'uuid', nullable: true })
  glAccountId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  receiptRef: string | null;
}

/** The float's cash book: every movement with the balance after it. */
@Entity('petty_cash_transaction')
@Index(['floatId', 'txnDate'])
export class PettyCashTransaction extends AppBaseEntity {
  @Column({ type: 'uuid' })
  floatId: string;

  @Column({ type: 'date' })
  txnDate: string;

  @Column({ type: 'enum', enum: PettyCashTxnType, enumName: 'petty_cash_txn_type' })
  type: PettyCashTxnType;

  /** Signed: + into the float, − out of it. */
  @Column(MONEY)
  amount: number;

  @Column(MONEY)
  balanceAfter: number;

  /** PCV / PCRP. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  refType: string | null;

  @Column({ type: 'uuid', nullable: true })
  refId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  refNo: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;
}

/** Top-up of a float to its limit, with its own approval. */
@Entity('petty_cash_replenishment')
@Index(['floatId', 'status'])
export class PettyCashReplenishment extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  floatId: string;

  @ManyToOne(() => PettyCashFloat, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'float_id' })
  float?: PettyCashFloat;

  @Column({ type: 'enum', enum: ReplenishmentStatus, enumName: 'replenishment_status', default: ReplenishmentStatus.DRAFT })
  status: ReplenishmentStatus;

  @Column(MONEY)
  amount: number;

  /** Balance when it was requested. */
  @Column(MONEY)
  balanceAtRequest: number;

  @Column({ type: 'uuid' })
  requestedBy: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  receivedBy: string | null;

  /** Cheque / transfer reference of the top-up. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;
}

/** A cash count of the float against its ledger balance. */
@Entity('petty_cash_count')
@Index(['floatId', 'createdAt'])
export class PettyCashCount extends AppBaseEntity {
  @Column({ type: 'uuid' })
  floatId: string;

  @Column({ type: 'uuid' })
  countedBy: string;

  @Column(MONEY)
  expected: number;

  @Column(MONEY)
  counted: number;

  /** counted − expected. */
  @Column(MONEY)
  variance: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;
}

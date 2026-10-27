import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PayoutAttemptStatus, ReconciliationStatus } from '@sil/shared';
import { MONEY } from '../../common/entities/transformers';
import { PaymentVoucher } from '../purchasing/purchasing.entities';

/**
 * One dispatch of a payment voucher to M-PESA (B2C / B2B). Each attempt has
 * its own OriginatorConversationID. At most one attempt per voucher may be
 * live or successful (partial unique index), so a voucher is never paid twice.
 * Raw requests (without the security credential), responses and callbacks are
 * kept for audit.
 */
@Entity('mpesa_payout')
@Index('uq_mpesa_payout_live_voucher', ['voucherId'], { unique: true, where: `status IN ('PENDING', 'UNKNOWN', 'SUCCESS')` })
@Index('uq_mpesa_payout_live_petty_cash', ['pettyCashId'], { unique: true, where: `status IN ('PENDING', 'UNKNOWN', 'SUCCESS')` })
@Check('ck_mpesa_payout_one_owner', `(voucher_id IS NULL) <> (petty_cash_id IS NULL)`)
@Index(['status', 'nextCheckAt'])
export class MpesaPayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  /** The supplier payment voucher paid (or the petty cash voucher). */
  @Column({ type: 'uuid', nullable: true })
  voucherId: string | null;

  @ManyToOne(() => PaymentVoucher, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'voucher_id' })
  voucher?: PaymentVoucher | null;

  /** Petty cash request (voucher) paid. */
  @Column({ type: 'uuid', nullable: true })
  pettyCashId: string | null;

  @Column({ type: 'int' })
  attempt: number;

  /** BusinessPayment / SalaryPayment / PromotionPayment (B2C), BusinessPayBill / BusinessBuyGoods (B2B). */
  @Column({ type: 'varchar', length: 40 })
  commandId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  originatorConversationId: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  conversationId: string | null;

  /** Phone (B2C) or PayBill / Till (B2B). */
  @Column({ type: 'varchar', length: 20 })
  partyB: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  accountRef: string | null;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'enum', enum: PayoutAttemptStatus, enumName: 'payout_attempt_status', default: PayoutAttemptStatus.PENDING })
  status: PayoutAttemptStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  resultCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resultDesc: string | null;

  @Index({ unique: true, where: '"receipt_no" IS NOT NULL' })
  @Column({ type: 'varchar', length: 30, nullable: true })
  receiptNo: string | null;

  /** Transaction charges reported by M-PESA (expensed to bank charges). */
  @Column({ ...MONEY, nullable: true })
  charges: number | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  recipientName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  requestBody: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  resultBody: Record<string, unknown> | null;

  /** Transaction Status queries made for it. */
  @Column({ type: 'int', default: 0 })
  statusChecks: number;

  /** When the follow-up job next looks at it (no callback yet / outcome unknown). */
  @Column({ type: 'timestamptz', nullable: true })
  nextCheckAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  releasedBy: string | null;

  /** Reversal request and its result (M-PESA Reversal API). */
  @Column({ type: 'jsonb', nullable: true })
  reversalBody: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  reversedAt: Date | null;
}

/** A line of an M-PESA organisation statement (imported CSV), for reconciliation. */
@Entity('mpesa_statement_line')
export class MpesaStatementLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 30 })
  receiptNo: string;

  @Index()
  @Column({ type: 'timestamptz' })
  completedAt: Date;

  @Column({ type: 'varchar', length: 500, nullable: true })
  details: string | null;

  /** Paid out (positive). */
  @Column({ ...MONEY, default: 0 })
  withdrawn: number;

  @Column({ ...MONEY, default: 0 })
  paidIn: number;

  @Column({ type: 'uuid', nullable: true })
  importedBy: string | null;
}

/** A reconciliation of M-PESA payouts against the statement for a day (or range). */
@Entity('payment_reconciliation')
@Index(['dateFrom', 'dateTo'])
export class PaymentReconciliation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'date' })
  dateFrom: string;

  @Column({ type: 'date' })
  dateTo: string;

  @Column({ type: 'enum', enum: ReconciliationStatus, enumName: 'reconciliation_status' })
  status: ReconciliationStatus;

  @Column({ type: 'int', default: 0 })
  matched: number;

  @Column(MONEY)
  systemTotal: number;

  @Column(MONEY)
  statementTotal: number;

  /** [{ kind: NOT_ON_STATEMENT | NOT_IN_SYSTEM | AMOUNT_MISMATCH | STATUS_MISMATCH, receiptNo, voucherNo?, system?, statement?, note }] */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  exceptions: { kind: string; receiptNo: string | null; voucherNo?: string | null; system?: number | null; statement?: number | null; note: string }[];

  /** Account balance reported by M-PESA when it ran (if available). */
  @Column({ ...MONEY, nullable: true })
  accountBalance: number | null;

  @Column({ type: 'uuid', nullable: true })
  runBy: string | null;
}

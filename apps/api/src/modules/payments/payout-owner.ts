import { EntityManager } from 'typeorm';
import { PaymentMethod } from '@sil/shared';

/** Documents M-PESA pays out: supplier payment vouchers and petty cash vouchers. */
export type PayoutOwnerType = 'PV' | 'PCV';

/** What one dispatch pays. */
export interface PayoutDoc {
  id: string;
  number: string;
  method: PaymentMethod;
  amount: number;
  payeePhone: string | null;
  payeeShortcode: string | null;
  payeeAccountRef: string | null;
  payeeName: string | null;
}

/**
 * A document type the M-PESA payouts service can pay. The service owns the
 * attempts (idempotency, status checks, retries, callbacks); the owner owns
 * its document's status and what paying it means (invoice balances, float
 * ledger …). Every method runs in the caller's transaction.
 */
export interface PayoutOwner {
  readonly type: PayoutOwnerType;
  /**
   * Locks the document and returns it if it may be sent now. `release`: a
   * person releases it (throws when it is not fully approved / not payable);
   * `retry`: the system re-sends one M-PESA never processed (null when the
   * document is no longer waiting for it).
   */
  claim(m: EntityManager, id: string, mode: 'release' | 'retry'): Promise<PayoutDoc | null>;
  /** Sent: the document is now processing. */
  dispatched(m: EntityManager, id: string, releasedBy: string | null): Promise<void>;
  /** Paid by M-PESA (only applied while the document is processing or under review). */
  paid(m: EntityManager, id: string, receipt: string, paidOn: string): Promise<void>;
  /** Failed (refused / failed result) or needs a person (unknown outcome, amount mismatch). */
  failed(m: EntityManager, id: string, status: 'FAILED' | 'REVIEW', note: string, onlyIfProcessing: boolean): Promise<void>;
  /** Checks a paid document may be reversed (throws otherwise). */
  assertReversible(m: EntityManager, id: string): Promise<void>;
  reversed(m: EntityManager, id: string, note: string): Promise<void>;
}

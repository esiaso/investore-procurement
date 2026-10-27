import { PaymentMethod } from '@sil/shared';

/**
 * A channel that moves money out (M-PESA today; bank APIs later). Dispatch
 * is asynchronous: the result arrives by callback (or a status query). Every
 * request carries a unique originator id, so the channel can be asked what
 * became of it before anything is sent again.
 */
export interface PaymentGateway {
  readonly code: string;
  supports(method: PaymentMethod): boolean;
  dispatch(req: PayoutRequest): Promise<DispatchAnswer>;
  /** What happened to a request whose result has not arrived. */
  queryStatus(ref: StatusRef): Promise<StatusAnswer>;
  reverse(req: ReversalRequest): Promise<DispatchAnswer>;
  /** Working account balance, when the channel answers synchronously (null = not available / arrives later). */
  balance(): Promise<number | null>;
}

export interface PayoutRequest {
  originatorConversationId: string;
  method: PaymentMethod;
  commandId: string;
  amount: number;
  /** Phone (B2C, 2547…/2541…) or PayBill / Till. */
  partyB: string;
  accountRef: string | null;
  remarks: string;
}

export interface StatusRef {
  /** Our attempt id (status answers that come by callback carry it in the URL). */
  payoutId: string;
  originatorConversationId: string;
  conversationId: string | null;
}

export interface ReversalRequest {
  payoutId: string;
  originatorConversationId: string;
  receiptNo: string;
  amount: number;
  remarks: string;
}

/**
 * ACCEPTED: queued by the channel, result to follow. REJECTED: definitely not
 * processed (safe to fix and send again). UNKNOWN: timeout / network error —
 * it may or may not have been processed; query before anything else.
 */
export type DispatchAnswer =
  | { outcome: 'ACCEPTED'; conversationId: string | null; message: string; request: Record<string, unknown>; response: Record<string, unknown> }
  | { outcome: 'REJECTED'; code: string | null; message: string; request: Record<string, unknown>; response: Record<string, unknown> }
  | { outcome: 'UNKNOWN'; message: string; request: Record<string, unknown> };

export interface PayoutResult {
  originatorConversationId: string | null;
  conversationId: string | null;
  /** '0' = success. */
  resultCode: string;
  resultDesc: string;
  receiptNo: string | null;
  amount: number | null;
  recipientName: string | null;
  charges: number | null;
  completedAt: Date | null;
}

/** FOUND: the final result; NOT_FOUND: never processed; PENDING: still being processed, or the answer arrives by callback. */
export type StatusAnswer = { state: 'FOUND'; result: PayoutResult } | { state: 'NOT_FOUND' } | { state: 'PENDING' };

export class GatewayConfigError extends Error {}

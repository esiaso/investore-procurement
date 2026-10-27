import type { PayoutAttempt } from './payment-types';

export interface PettyFloat {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  department?: { name: string } | null;
  location: string | null;
  custodianId: string;
  custodianName?: string | null;
  floatLimit: number;
  perTransactionLimit: number;
  replenishThreshold: number;
  glAccountId: string | null;
  glAccount?: { code: string; name: string } | null;
  mpesaEnabled: boolean;
  mpesaShortcode: string | null;
  balance: number;
  committed?: number;
  available?: number;
  belowThreshold?: boolean;
  isActive: boolean;
}

export type PettyMethod = 'CASH' | 'MPESA_B2C' | 'MPESA_PAYBILL' | 'MPESA_TILL';

export const PETTY_METHODS: { value: PettyMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'MPESA_B2C', label: 'M-PESA to phone' },
  { value: 'MPESA_PAYBILL', label: 'M-PESA PayBill' },
  { value: 'MPESA_TILL', label: 'M-PESA Till' },
];

export interface PettyRequest {
  id: string;
  number: string;
  floatId: string;
  float?: PettyFloat;
  kind: 'PAYMENT' | 'ADVANCE';
  status: string;
  requestedBy: string;
  requestedByName?: string | null;
  payeeType: 'STAFF' | 'VENDOR';
  payeeUserId: string | null;
  payeeName: string;
  purpose: string;
  glAccountId: string | null;
  glAccount?: { code: string; name: string } | null;
  departmentId: string;
  department?: { name: string } | null;
  amount: number;
  method: PettyMethod;
  payeePhone: string | null;
  payeeShortcode: string | null;
  payeeAccountRef: string | null;
  duplicate?: { id: string; number: string } | null;
  duplicateJustification: string | null;
  disbursedOn: string | null;
  disbursedByName?: string | null;
  custodianName?: string | null;
  reference: string | null;
  receivedByName: string | null;
  acknowledgedAt: string | null;
  retirementDueOn: string | null;
  overdue?: boolean;
  spentAmount: number | null;
  refundAmount: number | null;
  retirementNotes: string | null;
  retiredByName?: string | null;
  lastComment: string | null;
  createdAt: string;
  retirementLines?: { id: string; description: string; amount: number; receiptRef: string | null }[];
  attempts?: PayoutAttempt[];
}

export interface Replenishment {
  id: string;
  number: string;
  floatId: string;
  float?: PettyFloat;
  status: string;
  amount: number;
  balanceAtRequest: number;
  reason: string | null;
  reference: string | null;
  receivedAt: string | null;
  lastComment: string | null;
  createdAt: string;
}

export interface FloatStatement {
  float: PettyFloat;
  from: string;
  to: string;
  opening: number;
  closing: number;
  balanced: boolean;
  totals: Record<'OPENING' | 'REPLENISHMENT' | 'DISBURSEMENT' | 'REFUND' | 'TOP_UP' | 'REVERSAL', number>;
  transactions: { id: string; txnDate: string; type: string; amount: number; balanceAfter: number; refType: string | null; refId: string | null; refNo: string | null; note: string | null }[];
  counts: { id: string; countedAt: string; countedBy: string; expected: number; counted: number; variance: number; notes: string | null }[];
}

export type PaymentMethodCode = 'EFT' | 'CHEQUE' | 'MPESA_PAYBILL' | 'MPESA_TILL' | 'MPESA_B2C' | 'CASH';

export const PAYMENT_METHODS: { value: PaymentMethodCode; label: string }[] = [
  { value: 'EFT', label: 'Bank transfer (EFT)' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'MPESA_PAYBILL', label: 'M-PESA PayBill (B2B)' },
  { value: 'MPESA_TILL', label: 'M-PESA Till (B2B)' },
  { value: 'MPESA_B2C', label: 'M-PESA to phone (B2C)' },
  { value: 'CASH', label: 'Cash' },
];

export const isMpesa = (m: string) => m.startsWith('MPESA_');

export interface Payable {
  id: string;
  number: string;
  supplierInvoiceNo: string;
  supplierId: string;
  supplier: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  total: number;
  whtTotal: number;
  paidAmount: number;
  scheduled: number;
  outstanding: number;
  available: number;
  daysOverdue: number;
  bucket: 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
  orderNumber: string;
}

export interface PayoutAttempt {
  id: string;
  attempt: number;
  commandId: string;
  status: 'PENDING' | 'UNKNOWN' | 'SUCCESS' | 'FAILED' | 'REVERSED';
  resultCode: string | null;
  resultDesc: string | null;
  receiptNo: string | null;
  charges: number | null;
  recipientName: string | null;
  completedAt: string | null;
  createdAt: string;
  statusChecks: number;
  reversedAt: string | null;
}

export interface PaymentVoucher {
  id: string;
  number: string;
  supplierId: string | null;
  supplier?: { name: string } | null;
  status: string;
  method: PaymentMethodCode;
  currency: string;
  grossAmount: number;
  whtAmount: number;
  amount: number;
  dueDate: string | null;
  paidOn: string | null;
  paymentReference: string | null;
  payeeName: string | null;
  payeePhone: string | null;
  payeeShortcode: string | null;
  payeeAccountRef: string | null;
  narrative: string | null;
  preparedBy: string | null;
  preparedByName?: string | null;
  releasedByName?: string | null;
  lastComment: string | null;
  createdAt: string;
  lines?: { id: string; invoiceId: string; amount: number; whtAmount: number; netAmount: number; invoice?: { number: string; supplierInvoiceNo: string } }[];
  attempts?: PayoutAttempt[];
}

export interface Reconciliation {
  id: string;
  createdAt: string;
  dateFrom: string;
  dateTo: string;
  status: 'MATCHED' | 'EXCEPTIONS';
  matched: number;
  systemTotal: number;
  statementTotal: number;
  accountBalance: number | null;
  exceptions: { kind: string; receiptNo: string | null; voucherNo?: string | null; system?: number | null; statement?: number | null; note: string }[];
}

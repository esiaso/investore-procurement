import { MPESA_METHODS, PaymentMethod } from '@sil/shared';
import { normalisePhone } from '../pos/mpesa';

export const MPESA_PAYOUT_METHODS = MPESA_METHODS;

/** Daraja CommandID for a method. */
export function commandFor(method: PaymentMethod): string {
  switch (method) {
    case PaymentMethod.MPESA_B2C:
      return 'BusinessPayment';
    case PaymentMethod.MPESA_PAYBILL:
      return 'BusinessPayBill';
    case PaymentMethod.MPESA_TILL:
      return 'BusinessBuyGoods';
    default:
      throw new Error(`${method} is not an M-PESA method`);
  }
}

export interface Payee {
  payeePhone?: string | null;
  payeeShortcode?: string | null;
  payeeAccountRef?: string | null;
}

/**
 * Checks and normalises the payee for the method: B2C needs a Kenyan mobile
 * (2547… / 2541…), PayBill a 5–7 digit number and an account, Till a 5–7
 * digit number. Throws with a message for the user.
 */
export function normalisePayee(method: PaymentMethod, p: Payee): Required<Payee> {
  switch (method) {
    case PaymentMethod.MPESA_B2C:
      if (!p.payeePhone) throw new Error('M-PESA B2C needs the payee phone number');
      return { payeePhone: normalisePhone(p.payeePhone), payeeShortcode: null, payeeAccountRef: null };
    case PaymentMethod.MPESA_PAYBILL:
      if (!/^\d{5,7}$/.test(p.payeeShortcode ?? '')) throw new Error('M-PESA PayBill needs a 5–7 digit PayBill number');
      if (!p.payeeAccountRef?.trim()) throw new Error('M-PESA PayBill needs the account number');
      return { payeePhone: null, payeeShortcode: p.payeeShortcode!, payeeAccountRef: p.payeeAccountRef.trim().slice(0, 13) };
    case PaymentMethod.MPESA_TILL:
      if (!/^\d{5,7}$/.test(p.payeeShortcode ?? '')) throw new Error('M-PESA Till needs a 5–7 digit Till number');
      return { payeePhone: null, payeeShortcode: p.payeeShortcode!, payeeAccountRef: null };
    default:
      return { payeePhone: null, payeeShortcode: null, payeeAccountRef: null };
  }
}

/** Mask for lists and logs: 2547****4149. */
export const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}****${p.slice(-4)}` : null);

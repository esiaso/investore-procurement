import { ApiError } from '../api/client';

/**
 * Offline support for the till: the catalog snapshot and the queue of sales
 * made while the API could not be reached, kept in this browser
 * (localStorage). Each queued sale carries its clientRef, so sending it again
 * never makes a second invoice.
 */

export interface CatalogItem {
  itemId: string;
  code: string;
  name: string;
  generic: string | null;
  barcode: string | null;
  gtin: string | null;
  uom: string | null;
  salesClass: 'OTC' | 'P' | 'POM' | 'CD';
  price: number;
  promotion: { code: string; name: string; percent: number } | null;
  maxQtyPerSale: number | null;
  available: number;
  lowStock: boolean;
}

export interface TillCatalog {
  terminal: { id: string; code: string; name: string; storeId: string };
  priceList: { id: string; code: string; name: string };
  snapshotAt: string;
  items: CatalogItem[];
  customers: { id: string; code: string; name: string; phone: string | null; priceListId: string | null; creditAllowed: boolean; loyaltyPoints: number }[];
  paymentModes: { code: string; name: string; requiresReference: boolean }[];
  discountLimit: number;
}

export interface QueuedSale {
  terminalId: string;
  clientRef: string;
  soldAt: string;
  offline: true;
  customerId?: string;
  lines: { itemId: string; quantity: number; discountPercent?: number }[];
  payments: { modeCode: string; amount: number; reference?: string }[];
  prescriptionRef?: string;
  voidedLines?: { itemId: string; quantity: number; reason?: string }[];
  /** For the receipt and the queue list only (not sent). */
  display?: { total: number; lines: { name: string; quantity: number; amount: number }[] };
}

export interface RejectedSale {
  sale: QueuedSale;
  error: string;
  at: string;
}

const read = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const TERMINAL_KEY = 'pos.terminal';
const catalogKey = (t: string) => `pos.catalog.${t}`;
const queueKey = (t: string) => `pos.queue.${t}`;
const rejectedKey = (t: string) => `pos.rejected.${t}`;

export const loadCatalog = (terminalId: string) => read<TillCatalog | null>(catalogKey(terminalId), null);
export const saveCatalog = (c: TillCatalog) => write(catalogKey(c.terminal.id), c);
export const loadQueue = (terminalId: string) => read<QueuedSale[]>(queueKey(terminalId), []);
export const saveQueue = (terminalId: string, q: QueuedSale[]) => write(queueKey(terminalId), q);
export const loadRejected = (terminalId: string) => read<RejectedSale[]>(rejectedKey(terminalId), []);
export const saveRejected = (terminalId: string, r: RejectedSale[]) => write(rejectedKey(terminalId), r);

export function enqueue(sale: QueuedSale): boolean {
  const q = loadQueue(sale.terminalId);
  if (q.some((s) => s.clientRef === sale.clientRef)) return true;
  // Stock sold offline comes off the cached catalog so the till does not oversell.
  const cat = loadCatalog(sale.terminalId);
  if (cat) {
    for (const l of sale.lines) {
      const it = cat.items.find((i) => i.itemId === l.itemId);
      if (it) it.available = Math.max(0, it.available - l.quantity);
    }
    saveCatalog(cat);
  }
  return saveQueue(sale.terminalId, [...q, sale]);
}

/** The API could not be reached (no network, or the proxy has no API behind it). */
export function isOffline(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  return e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** Exact barcode / GTIN / code match, else name / generic search in the cached catalog. */
export function findInCatalog(cat: TillCatalog | null, term: string): CatalogItem[] {
  if (!cat) return [];
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const exact = cat.items.filter((i) => i.barcode === term.trim() || i.gtin === term.trim() || i.code.toLowerCase() === t);
  if (exact.length) return exact;
  return cat.items.filter((i) => i.name.toLowerCase().includes(t) || (i.generic ?? '').toLowerCase().includes(t)).slice(0, 25);
}

/** Line amount as the server computes it (VAT-inclusive price, discount rounded to cents). */
export function lineAmount(price: number, quantity: number, discountPercent: number): number {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const before = r2(quantity * price);
  return r2(before - r2((before * discountPercent) / 100));
}

/** What can be sold while offline: no controlled drugs; prescription-only and pharmacy-only only by a pharmacist (checked again at sync). */
export function offlineBlock(item: CatalogItem, canApprove: boolean): string | null {
  if (item.salesClass === 'CD') return `${item.name} is a controlled drug and cannot be sold over the counter`;
  if ((item.salesClass === 'POM' || item.salesClass === 'P') && !canApprove) return `${item.name} needs a pharmacist; it cannot be sold offline by this cashier`;
  return null;
}

export function newClientRef(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

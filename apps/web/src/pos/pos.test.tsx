import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import { ApiError } from '../api/client';
import { visibleNav } from '../layout/nav';
import { CatalogItem, enqueue, findInCatalog, isOffline, lineAmount, loadCatalog, loadQueue, offlineBlock, saveCatalog, TERMINAL_KEY, TillCatalog } from './offline';
import { TillPage } from './TillPage';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Cashier', storeIds: ['s1'], departmentId: null, permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const P = Permissions;
const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({ itemId: 'i1', code: 'ITM1', name: 'Panadol 500', generic: 'Paracetamol 500 mg', barcode: '6001234567890', gtin: null, uom: 'TAB', salesClass: 'OTC', price: 2.5, promotion: null, maxQtyPerSale: 20, available: 100, lowStock: false, ...over });
const catalog = (): TillCatalog => ({
  terminal: { id: 't1', code: 'T1', name: 'OPD till', storeId: 's1' },
  priceList: { id: 'pl', code: 'RETAIL', name: 'Retail' },
  snapshotAt: '2026-10-26T08:00:00Z',
  items: [item(), item({ itemId: 'i2', code: 'ITM2', name: 'Amoxil 500', generic: 'Amoxicillin 500 mg', barcode: null, salesClass: 'POM', price: 10 }), item({ itemId: 'i3', code: 'ITM3', name: 'Tramal', salesClass: 'CD', barcode: null })],
  customers: [{ id: 'c1', code: 'CUS1', name: 'Beta Ltd', phone: '0733', priceListId: null, creditAllowed: true, loyaltyPoints: 12 }],
  paymentModes: [{ code: 'CASH', name: 'Cash', requiresReference: false }],
  discountLimit: 5,
});

beforeEach(() => localStorage.clear());
afterEach(() => apiMock.api.mockReset());

describe('till offline support', () => {
  it('finds by barcode exactly, else by name or generic', () => {
    const c = catalog();
    expect(findInCatalog(c, '6001234567890').map((i) => i.itemId)).toEqual(['i1']);
    expect(findInCatalog(c, 'itm2').map((i) => i.itemId)).toEqual(['i2']);
    expect(findInCatalog(c, 'amoxi').map((i) => i.itemId)).toEqual(['i2']);
    expect(findInCatalog(null, 'x')).toEqual([]);
  });

  it('prices lines like the server and blocks what cannot be sold offline', () => {
    expect(lineAmount(2.5, 3, 0)).toBe(7.5);
    expect(lineAmount(116, 1, 10)).toBe(104.4);
    const c = catalog();
    expect(offlineBlock(c.items[2], true)).toMatch(/controlled/);
    expect(offlineBlock(c.items[1], false)).toMatch(/needs a pharmacist/);
    expect(offlineBlock(c.items[1], true)).toBeNull();
    expect(offlineBlock(c.items[0], false)).toBeNull();
  });

  it('queues each sale once and takes it off the cached stock', () => {
    saveCatalog(catalog());
    const sale = { terminalId: 't1', clientRef: 'ref-1', soldAt: '2026-10-26T09:00:00Z', offline: true as const, lines: [{ itemId: 'i1', quantity: 4 }], payments: [{ modeCode: 'CASH', amount: 10 }] };
    expect(enqueue(sale)).toBe(true);
    expect(enqueue(sale)).toBe(true);
    expect(loadQueue('t1')).toHaveLength(1);
    expect(loadCatalog('t1')!.items[0].available).toBe(96);
  });

  it('treats network failures and gateway errors as offline, not business errors', () => {
    expect(isOffline(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOffline(new ApiError(503, null))).toBe(true);
    expect(isOffline(new ApiError(400, { message: 'Payments do not cover the total' }))).toBe(false);
  });
});

describe('POS navigation', () => {
  const labels = (held: PermissionCode[]) => visibleNav((...p) => p.every((x) => held.includes(x))).map((i) => i.label);
  it('shows the till to cashiers and cash-up and reports to finance', () => {
    expect(labels([P.POS_SELL])).toEqual(expect.arrayContaining(['Till', 'POS setup']));
    expect(labels([P.POS_SELL])).not.toContain('POS reports');
    expect(labels([P.POS_REPORTS, P.POS_APPROVE_VARIANCE])).toEqual(expect.arrayContaining(['Shifts & cash-up', 'POS reports']));
  });
});

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

describe('till screen', () => {
  it('scans an item into the basket and shows the server total, controls and alerts', async () => {
    auth.permissions = [P.POS_SELL];
    localStorage.setItem(TERMINAL_KEY, 't1');
    saveCatalog(catalog());
    apiMock.api.mockImplementation(async (path: string) => {
      if (path === '/pos/terminals') return [{ id: 't1', code: 'T1', name: 'OPD till', storeId: 's1' }];
      if (path === '/pos/shifts/current') return { id: 'sh1', number: 'Z/OPD-PH/2026/00001', status: 'OPEN', openingFloat: 500, openedAt: '2026-10-26T08:00:00Z', report: null, variance: null, varianceStatus: 'NONE' };
      if (path === '/pos/terminals/t1/catalog') return catalog();
      if (path === '/pos/check')
        return { lines: [{ itemId: 'i1', salesClass: 'OTC', listPrice: 2.5, promotion: null, discountPercent: 0, gross: 2.5, available: 100, lowStock: true }], total: 2.5, discountAmount: 0, loyalty: null, needs: { pharmacist: false, prescription: false, supervisor: false, interactionReason: false }, blocked: [], alerts: [{ type: 'INTERACTION', severity: 'MODERATE', message: 'Paracetamol + X: monitor', management: null, blocking: false }], maxDiscountPercent: 5 };
      throw new Error(`unexpected ${path}`);
    });
    render(wrap(<TillPage />));
    expect(await screen.findByText(/Shift Z\/OPD-PH\/2026\/00001/)).toBeInTheDocument();
    const search = screen.getByLabelText(/Scan or search/);
    fireEvent.change(search, { target: { value: '6001234567890' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(await screen.findByText('Panadol 500')).toBeInTheDocument();
    expect(await screen.findByText(/Paracetamol \+ X: monitor/)).toBeInTheDocument();
    expect(screen.getByText('Low stock')).toBeInTheDocument();
    expect(screen.getByText('Max 20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay (F9)' })).toBeEnabled();
  });
});

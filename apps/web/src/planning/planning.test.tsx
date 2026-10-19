import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from '@sil/shared';
import type { ReorderRow } from '../api/planning-types';
import { NotificationPreferences } from '../pages/AccountPage';
import { PlanningWidgets, ReorderPage, reorderLines } from './PlanningPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', storeIds: null, departmentId: 'd1', permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const wrap = (ui: ReactNode, url = '/') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

afterEach(() => apiMock.api.mockReset());

const row = (over: Partial<ReorderRow>): ReorderRow => ({
  storeId: 's1', storeName: 'Main Store', parentStoreId: null, itemId: 'i1', itemCode: 'ITM1', itemName: 'Gloves', uom: 'PAIR', categoryName: 'PPE', mode: 'AUTO',
  amc: 300, reorderLevel: 210, maxLevel: 510, available: 50, onHand: 50, reserved: 0, onOrder: 0, inTransit: 0, unitCost: 2, position: 50, below: true,
  stockOut: false, daysOfStock: 5, suggestedQty: 460, suggestedValue: 920, ...over,
});

describe('reorderLines', () => {
  it('takes the selected rows with the edited or suggested quantity, dropping zeros', () => {
    const rows = [row({ itemId: 'a' }), row({ itemId: 'b', suggestedQty: 10 }), row({ itemId: 'c', suggestedQty: 5 })];
    expect(reorderLines(rows, new Set(['a', 'b', 'c']), { a: 100, c: 0 })).toEqual([
      { itemId: 'a', quantity: 100 },
      { itemId: 'b', quantity: 10 },
    ]);
  });
});

describe('ReorderPage', () => {
  beforeEach(() => {
    auth.permissions = [Permissions.INVENTORY_READ, Permissions.INVENTORY_PLANNING, Permissions.PURCHASING_REQUISITION, Permissions.INVENTORY_TRANSFER_REQUEST];
  });

  const mock = (stores: object[], rows: ReorderRow[]) =>
    apiMock.api.mockImplementation(async (path: string) => {
      if (path === '/stores') return { items: stores, total: stores.length };
      if (path === '/item-categories') return [];
      if (path === '/stock-planning/reorder') return rows;
      if (path === '/departments') return { items: [{ id: 'd1', name: 'Pharmacy' }], total: 1 };
      return [];
    });

  it('asks for items below their reorder level in the first store and offers a draft PR once something is picked', async () => {
    mock([{ id: 's1', name: 'Main Store', parentStoreId: null }], [row({})]);
    render(wrap(<ReorderPage />));
    const button = await screen.findByRole('button', { name: /Create draft PR \(0\)/ });
    expect(button).toBeDisabled(); // nothing selected yet (selection → lines is covered by reorderLines)
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledWith('/stock-planning/reorder', { query: { storeId: 's1', categoryId: undefined, search: undefined, belowOnly: true } }));
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute('href', expect.stringContaining('format=csv'));
  });

  it('offers a transfer request to the parent store for a satellite pharmacy', async () => {
    mock([{ id: 's2', name: 'OPD Pharmacy', parentStoreId: 'mp' }], [row({ storeId: 's2', parentStoreId: 'mp' })]);
    render(wrap(<ReorderPage />));
    expect(await screen.findByRole('button', { name: /Request from parent store/ })).toBeInTheDocument();
  });
});

describe('dashboard and preferences', () => {
  it('shows reorder, stock-out and near-expiry figures', async () => {
    auth.permissions = [Permissions.INVENTORY_READ];
    apiMock.api.mockResolvedValue({
      reorderAlerts: 7,
      stockOuts: 2,
      newExpiryAlerts: 3,
      nearExpiry: [{ label: '1–30 days', horizonDays: 30, value: 1500, batches: 4 }],
      expired: { value: 250, batches: 1 },
      currency: 'KES',
    });
    render(wrap(<PlanningWidgets />));
    const box = await screen.findByLabelText('Stock alerts summary');
    expect(within(box).getByText('7')).toBeInTheDocument();
    expect(within(box).getByText('2')).toBeInTheDocument();
    expect(within(box).getByText('1–30 days')).toBeInTheDocument();
    expect(within(box).getByText('4 batch(es)')).toBeInTheDocument();
  });

  it('saves a channel toggle', async () => {
    const prefs = [{ category: 'REORDER', inApp: true, email: true, sms: false }];
    apiMock.api.mockImplementation(async (_path: string, opts?: { method?: string; body?: { preferences: unknown[] } }) => (opts?.method === 'PUT' ? opts.body!.preferences : prefs));
    render(wrap(<NotificationPreferences />));
    await userEvent.click(await screen.findByLabelText('Items at reorder level: email'));
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith('/notifications/preferences', { method: 'PUT', body: { preferences: [{ category: 'REORDER', inApp: true, email: false, sms: false }] } }),
    );
  });
});

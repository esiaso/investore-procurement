import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { AccountingConnection, BatchDetail, MappingsResponse, Posting, QboLists } from '../api/accounting-types';
import { visibleNav } from '../layout/nav';
import { QuickBooksPage } from './QuickBooksPage';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', storeIds: null, departmentId: null, permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const wrap = (ui: ReactNode, url = '/accounting/quickbooks') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/accounting/quickbooks" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

const conn: AccountingConnection = {
  id: 'c1', provider: 'MOCK', environment: 'SANDBOX', clientId: null, redirectUri: '/api/v1/callbacks/quickbooks', realmId: '9130', companyName: 'SIL Hospital', accessExpiresAt: null, refreshExpiresAt: null,
  connectedAt: '2026-10-01T08:00:00Z', closingDate: null, journalsFrom: null, lastError: null, isActive: true, hasClientSecret: false, connected: true,
};
const posting = (p: Partial<Posting>): Posting => ({
  id: 'p1', docType: 'SALES_RECEIPT', localDocType: 'SALES_INVOICE', localDocId: 'i1', localDocNo: 'SI/OPD/0001', txnDate: '2026-10-20', amount: 100, status: 'READY', batchId: 'b1',
  entries: [{ account: '1', amount: 100 }, { account: '40', amount: -100, classId: '102' }], payload: {}, externalId: null, error: null, attempts: 0, nextAttemptAt: '', postedAt: null, ...p,
});
const lists: QboLists = { accounts: [{ id: '1', name: 'Cash on hand' }, { id: '40', name: 'Sales - pharmacy' }, { id: '10', name: 'Accounts Receivable' }], classes: [{ id: '102', name: 'OPD pharmacy' }], taxCodes: [] };

/** Answers by method + path (first matching prefix wins). */
function route(table: [string, unknown][]) {
  apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    const key = `${opts?.method ?? 'GET'} ${path}`;
    const hit = table.find(([p]) => key.startsWith(p));
    if (!hit) throw new Error(`unexpected ${key}`);
    return typeof hit[1] === 'function' ? (hit[1] as (o: unknown) => unknown)(opts) : hit[1];
  });
}

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
});

describe('QuickBooks console', () => {
  it('is in the menu for accounting users only', () => {
    const has = (perms: PermissionCode[]) => visibleNav((...p) => p.every((x) => perms.includes(x))).some((n) => n.path === '/accounting/quickbooks');
    expect(has([Permissions.ACCOUNTING_READ])).toBe(true);
    expect(has([Permissions.POS_SELL])).toBe(false);
  });

  it('previews a batch, shows what is blocked and why, and posts the ready documents', async () => {
    auth.permissions = [Permissions.ACCOUNTING_READ, Permissions.ACCOUNTING_POST];
    const items = [posting({}), posting({ id: 'p2', docType: 'INVOICE', localDocId: 'i2', localDocNo: 'SI/OPD/0002', status: 'BLOCKED', error: 'Map: payment account for payment mode CARD' })];
    const batch: BatchDetail = { id: 'b1', number: 'QBB/2026/0001', fromDate: '2026-09-01', toDate: '2026-09-30', kinds: 'PURCHASES,SALES,INVENTORY', status: 'PREVIEW', createdAt: '', postedAt: null, items, summary: [{ docType: 'SALES_RECEIPT', count: 1, amount: 100, ready: 1, blocked: 0, posted: 0 }, { docType: 'INVOICE', count: 1, amount: 100, ready: 0, blocked: 1, posted: 0 }] };
    const posted: BatchDetail = { ...batch, status: 'POSTED', items: [{ ...items[0], status: 'POSTED', externalId: '1001' }, items[1]], totals: { posted: 1, failed: 0, retry: 0 } };
    let previewBody: unknown;
    route([
      ['GET /accounting/connection', conn],
      ['GET /accounting/batches/b1', batch],
      ['GET /accounting/batches', []],
      ['POST /accounting/batches/b1/post', posted],
      ['POST /accounting/batches', (o: { body: unknown }) => ((previewBody = o.body), batch)],
      ['GET /accounting/lists', lists],
    ]);
    render(wrap(<QuickBooksPage />));
    fireEvent.click(await screen.findByLabelText('Inventory journals'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const dlg = await screen.findByRole('dialog');
    expect(previewBody).toMatchObject({ kinds: ['PURCHASES', 'SALES', 'PETTY_CASH'] });
    expect(await within(dlg).findByText('Map: payment account for payment mode CARD')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Post 1 to QuickBooks' }));
    expect(await within(dlg).findByText(/Posted 1; 0 waiting to retry; 0 failed/)).toBeTruthy();
    expect(within(dlg).getByText('#1001')).toBeTruthy();
  });

  it('shows the double entry of a document and lets a blocked one be rebuilt', async () => {
    auth.permissions = [Permissions.ACCOUNTING_READ, Permissions.ACCOUNTING_POST];
    const blocked = posting({ status: 'BLOCKED', error: 'Map: category income for category DRUG' });
    route([
      ['GET /accounting/connection', conn],
      ['GET /accounting/postings', { items: [blocked], total: 1, page: 1, pageSize: 25 }],
      ['GET /accounting/lists', lists],
      ['POST /accounting/postings/p1/reprocess', { ...blocked, status: 'POSTED', error: null, externalId: '77' }],
    ]);
    render(wrap(<QuickBooksPage />));
    fireEvent.click(screen.getByRole('tab', { name: 'Postings & errors' }));
    fireEvent.click(await screen.findByText('SI/OPD/0001'));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('Cash on hand')).toBeTruthy();
    expect(within(dlg).getByText('OPD pharmacy')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Rebuild and send' }));
    expect(await within(dlg).findByText('In QuickBooks as #77.')).toBeTruthy();
  });

  it('lists mapping gaps and saves a mapping picked from QuickBooks', async () => {
    auth.permissions = [Permissions.ACCOUNTING_READ, Permissions.ACCOUNTING_MANAGE];
    const m: MappingsResponse = {
      mappings: [{ id: 'm1', kind: 'SYSTEM', localKey: 'AR', externalId: '10', externalName: 'Accounts Receivable' }],
      keys: { SYSTEM: [{ code: 'AR', name: 'Accounts receivable' }, { code: 'AP', name: 'Accounts payable' }], CATEGORY_INVENTORY: [], CATEGORY_COGS: [], CATEGORY_INCOME: [], CATEGORY_CONSUMPTION: [], STORE_CLASS: [{ code: 'MS', name: 'Main store' }], DEPARTMENT_CLASS: [], TAX_CODE: [], PAYMENT_ACCOUNT: [], GL_ACCOUNT: [] },
    };
    let saved: unknown;
    route([
      ['GET /accounting/connection', conn],
      ['GET /accounting/mappings', m],
      ['GET /accounting/lists', lists],
      ['PUT /accounting/mappings', (o: { body: unknown }) => (saved = o.body)],
    ]);
    render(wrap(<QuickBooksPage />));
    fireEvent.click(screen.getByRole('tab', { name: 'Mappings' }));
    expect(await screen.findByText('Control accounts (1 to map)')).toBeTruthy();
    expect(screen.getByText('Store classes')).toBeTruthy(); // optional: no gap count
    const row = (await screen.findByText('AP')).closest('tr')!;
    fireEvent.mouseDown(within(row).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Cash on hand' }));
    await waitFor(() => expect(saved).toEqual({ kind: 'SYSTEM', localKey: 'AP', externalId: '1', externalName: 'Cash on hand' }));
  });

  it('reports the outcome of the Intuit redirect', async () => {
    auth.permissions = [Permissions.ACCOUNTING_READ];
    route([['GET /accounting/connection', conn], ['GET /accounting/batches', []]]);
    render(wrap(<QuickBooksPage />, '/accounting/quickbooks?error=QuickBooks%20did%20not%20authorise'));
    expect(await screen.findByText('QuickBooks did not authorise')).toBeTruthy();
  });
});

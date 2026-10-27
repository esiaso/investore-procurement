import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { Dashboard, DocumentRow, ReportDef, ReportResult } from '../api/report-types';
import { visibleNav } from '../layout/nav';
import { DashboardPage } from '../pages/DashboardPage';
import { DocumentsPage } from './DocumentsPage';
import { ReportsPage } from './ReportsPage';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Wafula', email: 'w@example.org', roles: [{ code: 'SCM', name: 'Supply Chain Manager' }], storeIds: null, departmentId: null, permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const wrap = (ui: ReactNode, url: string, path: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={path} element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

/** Answers by method + path (first matching prefix wins); functions get the request options. */
function route(table: [string, unknown][]) {
  apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    const key = `${opts?.method ?? 'GET'} ${path}`;
    const hit = table.find(([p]) => key.startsWith(p));
    if (!hit) throw new Error(`unexpected ${key}`);
    return typeof hit[1] === 'function' ? (hit[1] as (o: unknown) => unknown)(opts) : hit[1];
  });
}

const grnRegister: ReportDef = {
  key: 'grn-register',
  title: 'GRN register',
  group: 'INVENTORY',
  description: 'Goods received notes in the period.',
  filters: ['from', 'to', 'storeId'],
  required: ['from', 'to'],
  columns: [
    { key: 'number', label: 'GRN', type: 'text' },
    { key: 'value', label: 'Value in stock', type: 'money' },
  ],
};
const expired: ReportDef = { key: 'expired', title: 'Expired stock', group: 'INVENTORY', description: 'Past expiry.', filters: ['storeId'], columns: [{ key: 'item', label: 'Item', type: 'text' }] };

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
});

describe('Reports', () => {
  it('is in the menu for anyone with a report, documents for documents.read', () => {
    const nav = (perms: PermissionCode[]) => visibleNav((...p) => p.every((x) => perms.includes(x))).map((n) => n.path);
    expect(nav([Permissions.INVENTORY_READ])).toContain('/reports');
    expect(nav([Permissions.INVENTORY_READ])).not.toContain('/documents');
    expect(nav([Permissions.DOCUMENTS_READ])).toContain('/documents');
    expect(nav([Permissions.POS_SELL])).not.toContain('/reports');
  });

  it('runs a report with its filters, shows totals and offers CSV / Excel / PDF', async () => {
    auth.permissions = [Permissions.PURCHASING_READ];
    let asked: unknown;
    const result: ReportResult = { key: 'grn-register', title: 'GRN register', criteria: ['Period: 2026-10-01 to 2026-10-27'], generatedAt: '', columns: grnRegister.columns, rows: [{ number: 'GRN/0001', value: 1500 }, { number: 'GRN/0002', value: 500 }], totals: { value: 2000 } };
    route([
      ['GET /reports/grn-register', (o: { query: unknown }) => ((asked = o.query), result)],
      ['GET /reports', [grnRegister, expired]],
      ['GET /stores', { items: [], total: 0 }],
    ]);
    render(wrap(<ReportsPage />, '/reports', '/reports'));
    fireEvent.click(await screen.findByText('GRN register'));
    expect(screen.getByText('Goods received notes in the period.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-27' } });
    const csv = screen.getByRole('link', { name: 'CSV' });
    expect(csv.getAttribute('href')).toBe('/api/v1/reports/grn-register/export?from=2026-10-01&to=2026-10-27&format=csv');
    expect(screen.getByRole('link', { name: 'PDF' }).getAttribute('href')).toContain('format=pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('GRN/0001')).toBeTruthy();
    expect(asked).toEqual({ from: '2026-10-01', to: '2026-10-27' });
    const total = screen.getByText('Total').closest('tr')!;
    expect(within(total).getByText(/2,000\.00/)).toBeTruthy();
    expect(screen.getByText('Period: 2026-10-01 to 2026-10-27')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Email on a schedule/ })).toBeNull(); // no reports.schedule
  });

  it('schedules a report by email with the filters chosen', async () => {
    auth.permissions = [Permissions.PURCHASING_READ, Permissions.REPORTS_SCHEDULE];
    let saved: unknown;
    route([
      ['POST /reports/schedules', (o: { body: unknown }) => ((saved = o.body), { id: 's1' })],
      ['GET /reports/schedules', []],
      ['GET /reports/expired', { key: 'expired', title: 'Expired stock', criteria: [], generatedAt: '', columns: expired.columns, rows: [] }],
      ['GET /reports', [grnRegister, expired]],
      ['GET /stores', { items: [{ id: 'st1', name: 'Main store' }], total: 1 }],
    ]);
    render(wrap(<ReportsPage />, '/reports?key=grn-register', '/reports'));
    fireEvent.click(await screen.findByRole('button', { name: /Email on a schedule/ }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/Send to/), { target: { value: 'a@example.org, b@example.org' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual({ name: 'GRN register', reportKey: 'grn-register', filters: {}, period: 'LAST_7_DAYS', format: 'xlsx', frequency: 'WEEKLY', hour: 7, weekday: 1, monthDay: undefined, recipients: ['a@example.org', 'b@example.org'], isActive: true }),
    );
  });

  it('runs a report without required filters straight away', async () => {
    auth.permissions = [Permissions.INVENTORY_READ];
    route([
      ['GET /reports/expired', { key: 'expired', title: 'Expired stock', criteria: ['As at 2026-10-27'], generatedAt: '', columns: expired.columns, rows: [{ item: 'Amoxicillin 500 mg' }] }],
      ['GET /reports', [grnRegister, expired]],
      ['GET /stores', { items: [], total: 0 }],
    ]);
    render(wrap(<ReportsPage />, '/reports?key=expired', '/reports'));
    expect(await screen.findByText('Amoxicillin 500 mg')).toBeTruthy();
  });
});

describe('Documents', () => {
  it('lists files with their record and a download link', async () => {
    auth.permissions = [Permissions.DOCUMENTS_READ];
    const row: DocumentRow = {
      id: 'a1', ownerType: 'GRN', ownerTypeName: 'Goods received note', ownerId: 'g1', owner: 'GRN/MS/2026/0001', link: '/grns/g1', category: 'DELIVERY_NOTE', fileName: 'dn-0001.pdf',
      mimeType: 'application/pdf', sizeBytes: 20480, version: 2, isCurrent: true, generated: false, uploadedBy: 'Wanjiru Stores', createdAt: '2026-10-20T08:00:00Z', notes: null,
    };
    route([
      ['GET /documents/register/facets', { ownerTypes: [{ value: 'GRN', label: 'Goods received note' }], categories: ['DELIVERY_NOTE'] }],
      ['GET /documents/register', { items: [row], total: 1, page: 1, pageSize: 25 }],
    ]);
    render(wrap(<DocumentsPage />, '/documents', '/documents'));
    const file = await screen.findByRole('link', { name: 'dn-0001.pdf' });
    expect(file.getAttribute('href')).toBe('/api/v1/attachments/a1/download');
    expect(screen.getByRole('link', { name: 'GRN/MS/2026/0001' }).getAttribute('href')).toBe('/grns/g1');
    expect(screen.getByText('v2')).toBeTruthy();
  });

  it('shows supplier documents expiring', async () => {
    auth.permissions = [Permissions.DOCUMENTS_READ];
    route([['GET /documents/register/expiring', [{ id: 'd1', supplierId: 's1', supplier: 'Dawa Ltd', documentType: 'PPB_LICENCE', reference: 'PPB-1', issuedOn: null, expiresOn: '2026-11-10', daysLeft: -3, files: 1 }]]]);
    render(wrap(<DocumentsPage />, '/documents?tab=expiring', '/documents'));
    expect(await screen.findByText('Dawa Ltd')).toBeTruthy();
    expect(screen.getByText('Expired 3 days ago')).toBeTruthy();
  });
});

describe('Dashboard', () => {
  it('groups the tiles by section and draws the trends', async () => {
    const dash: Dashboard = {
      tiles: [
        { key: 'approvals', section: 'My work', label: 'Waiting for my approval', value: 3, format: 'count', link: '/approvals', tone: 'warning' },
        { key: 'stock-value', section: 'Value', label: 'Stock value', value: 1250000, format: 'money', link: '/reports?key=stock-status' },
      ],
      trends: [{ key: 'sales', label: 'Sales', format: 'money', points: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((p, i) => ({ period: p, value: (i + 1) * 1000 })) }],
    };
    route([['GET /dashboard', dash]]);
    render(wrap(<DashboardPage />, '/', '/'));
    const work = await screen.findByRole('region', { name: 'My work' });
    expect(within(work).getByText('Waiting for my approval')).toBeTruthy();
    expect(within(work).getByText('3')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Value' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sales' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pharmacy' })).toBeNull();
  });
});

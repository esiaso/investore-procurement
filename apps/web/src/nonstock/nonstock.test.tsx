import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { QueueLine, StaffRequisition } from '../api/nonstock-types';
import { visibleNav } from '../layout/nav';
import { ApproveLinkPage } from './ApproveLinkPage';
import { ProcurementQueuePage, StaffRequisitionDetailPage, StaffRequisitionFormPage } from './StaffRequisitionPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Moraa Nurse', email: 'm@example.org', roles: [], storeIds: null, departmentId: 'd1', permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const wrap = (ui: ReactNode, url: string, path: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<div>Navigated</div>} />
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

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 500 });

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
  vi.unstubAllGlobals();
});

describe('Non-stock requisitions', () => {
  it('menu: staff see My requisitions; procurement also the queue', () => {
    const nav = (perms: PermissionCode[]) => visibleNav((...p) => p.every((x) => perms.includes(x))).map((n) => n.path);
    expect(nav([Permissions.STAFF_REQUISITION_CREATE])).toContain('/staff-requisitions');
    expect(nav([Permissions.STAFF_REQUISITION_CREATE])).not.toContain('/procurement-queue');
    expect(nav([Permissions.STAFF_REQUISITION_READ_ALL])).toContain('/procurement-queue');
    expect(nav([Permissions.GL_MANAGE])).toContain('/finance/setup');
  });

  it('raises a service requisition charged to a GL account and submits it', async () => {
    auth.permissions = [Permissions.STAFF_REQUISITION_CREATE];
    let body: Record<string, unknown> | undefined;
    route([
      ['GET /departments', page([{ id: 'd1', name: 'Medical ward' }])],
      ['GET /projects', []],
      ['GET /item-categories', []],
      ['GET /uoms', [{ id: 'u1', code: 'EA', name: 'Each' }]],
      ['GET /gl-accounts', page([{ id: 'g1', code: '5110', name: 'Repairs - medical equipment', type: 'EXPENSE', isActive: true }])],
      ['POST /staff-requisitions', (o: { body: Record<string, unknown> }) => ((body = o.body), { id: 'r1', number: 'REQ-2026-00001', status: 'SUBMITTED' })],
    ]);
    render(wrap(<StaffRequisitionFormPage />, '/staff-requisitions/new', '/staff-requisitions/new'));
    fireEvent.change(await screen.findByLabelText(/Justification/), { target: { value: 'Autoclave broken' } });
    fireEvent.change(screen.getByLabelText(/What is needed/), { target: { value: 'Service the autoclave' } });
    fireEvent.change(screen.getByLabelText(/Est. unit cost/), { target: { value: '45000' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'GL account' }));
    fireEvent.click(await screen.findByRole('option', { name: '5110 · Repairs - medical equipment' }));
    expect(screen.getByText(/45,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(body).toMatchObject({ departmentId: 'd1', justification: 'Autoclave broken', submit: true, lines: [{ lineType: 'SERVICE', description: 'Service the autoclave', quantity: 1, estimatedUnitCost: 45000, glAccountId: 'g1', itemId: null }] });
    expect(await screen.findByText('Navigated')).toBeTruthy();
  });

  it('shows where each line went: the store requisition and the purchase requisition', async () => {
    auth.permissions = [Permissions.STAFF_REQUISITION_CREATE];
    const r: StaffRequisition = {
      id: 'r1', number: 'REQ-2026-00001', requestedBy: 'u1', requestedByName: 'Moraa Nurse', departmentId: 'd1', department: { name: 'Medical ward' }, onBehalfOfDepartment: false,
      projectId: null, storeId: 's1', store: { name: 'Main store' }, budgetId: null, priority: 'URGENT', requiredBy: null, justification: 'Ward needs', status: 'CONVERTED', estimatedTotal: 95000,
      submittedAt: null, approvedAt: null, lastComment: null, createdAt: '2026-10-27T08:00:00Z',
      lines: [
        { id: 'l1', lineNo: 1, lineType: 'STOCK', itemId: 'i1', description: 'Gloves', categoryId: null, quantity: 10, uomId: null, uom: { code: 'BOX' }, estimatedUnitCost: 500, glAccountId: null, status: 'TO_STORE', notes: null, storeRequisition: { id: 'sr1', number: 'SR/MS/2026/0001' } },
        { id: 'l2', lineNo: 2, lineType: 'SERVICE', itemId: null, description: 'Service the autoclave', categoryId: null, quantity: 1, uomId: null, estimatedUnitCost: 45000, glAccountId: 'g1', glAccount: { code: '5110', name: 'Repairs' }, status: 'ON_PR', notes: null, purchaseRequisition: { id: 'pr1', number: 'PR/2026/0009', status: 'DRAFT' } },
      ],
    };
    route([
      ['GET /staff-requisitions/r1', r],
      ['GET /approvals/history', []],
      ['GET /documents/chain', { nodes: [], edges: [] }],
      ['GET /attachments', []],
    ]);
    render(wrap(<StaffRequisitionDetailPage />, '/staff-requisitions/r1', '/staff-requisitions/:id'));
    expect((await screen.findByRole('link', { name: 'PR/2026/0009' })).getAttribute('href')).toBe('/requisitions/pr1');
    expect(screen.getByRole('link', { name: 'SR/MS/2026/0001' }).getAttribute('href')).toBe('/store-requisitions/sr1');
    expect(screen.getByText('5110 Repairs')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });

  it('procurement selects lines from different departments and creates one purchase requisition', async () => {
    auth.permissions = [Permissions.STAFF_REQUISITION_READ_ALL, Permissions.PURCHASING_CONSOLIDATE];
    const line = (id: string, dept: string, total: number): QueueLine => ({
      id, lineType: 'SERVICE', description: `Service ${id}`, quantity: 1, uom: null, estimatedUnitCost: total, estimatedTotal: total, category: null, glCode: '5110', glName: 'Repairs',
      requisitionId: `r-${id}`, requisitionNo: `REQ-${id}`, priority: 'ROUTINE', requiredBy: null, approvedAt: '2026-10-27T08:00:00Z', departmentId: dept, department: dept, requestedBy: 'x', project: null,
    });
    let body: Record<string, unknown> | undefined;
    route([
      ['GET /departments', page([{ id: 'd1', name: 'Medical ward' }])],
      ['GET /suppliers', page([])],
      ['GET /stores', page([{ id: 's1', name: 'Main store' }])],
      ['GET /staff-requisitions/queue', page([line('a', 'Medical ward', 45000), line('b', 'Theatre', 30000)])],
      ['POST /staff-requisitions/consolidate', (o: { body: Record<string, unknown> }) => ((body = o.body), { id: 'pr1', number: 'PR/2026/0010' })],
    ]);
    render(wrap(<ProcurementQueuePage />, '/procurement-queue', '/procurement-queue'));
    await screen.findByText('Service a');
    for (const cb of screen.getAllByRole('checkbox', { name: /select row/i })) fireEvent.click(cb);
    fireEvent.click(screen.getByRole('button', { name: 'Create purchase requisition (2)' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/Medical ward, Theatre/)).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText(/Justification/), { target: { value: 'Quarterly services' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(body).toMatchObject({ lineIds: ['a', 'b'], justification: 'Quarterly services', departmentId: 'd1' }));
    expect(await screen.findByText('Navigated')).toBeTruthy();
  });
});

describe('Approve by link', () => {
  it('shows the document and approves it once', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (!init) return new Response(JSON.stringify({ documentType: 'REQ', documentNo: 'REQ-2026-00007', amount: 45000, currency: 'KES', summary: 'routine · 1 line(s)', stepName: 'Head of department', approver: 'Akinyi Ward Sister', expiresAt: '2026-10-30T08:00:00Z' }), { status: 200 });
        return new Response(JSON.stringify({ documentNo: 'REQ-2026-00007', status: 'APPROVED' }), { status: 200 });
      }),
    );
    render(<ApproveLinkPage token="abc_123" />);
    expect(await screen.findByText('REQ-2026-00007')).toBeTruthy();
    expect(screen.getByText(/Head of department/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true); // comment first
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. REQ-2026-00007 is now approved.')).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: '/api/v1/approval-links/abc_123', init: { method: 'POST' } });
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ action: 'APPROVE' });
  });

  it('explains a used or expired link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'This approval link has already been used' }), { status: 410 })));
    render(<ApproveLinkPage token="used" />);
    expect(await screen.findByText('This approval link has already been used')).toBeTruthy();
  });
});

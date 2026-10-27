import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import { ApiError } from '../api/client';
import type { PettyFloat, PettyRequest } from '../api/petty-cash-types';
import { visibleNav } from '../layout/nav';
import { PettyRequestDetailPage, PettyRequestDialog } from './PettyCashPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[], id: 'u1' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: auth.id, fullName: 'Someone', email: 's@example.org', roles: [], storeIds: null, departmentId: 'd1', permissions: auth.permissions },
    can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)),
    canAny: (...p: string[]) => p.some((x) => auth.permissions.includes(x)),
  }),
}));

const wrap = (ui: ReactNode, url = '/x', path = '/x') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<div>Navigated</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

function route(table: [string, unknown][]) {
  const all: [string, unknown][] = [...table, ['GET /documents/chain', { nodes: [], edges: [] }], ['GET /approvals/history', []], ['GET /approvals/inbox', []], ['GET /attachments', []]];
  apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    const key = `${opts?.method ?? 'GET'} ${path}`;
    const hit = all.find(([p]) => key.startsWith(p));
    if (!hit) throw new Error(`unexpected ${key}`);
    return typeof hit[1] === 'function' ? (hit[1] as (o: unknown) => unknown)(opts) : hit[1];
  });
}

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
  auth.id = 'u1';
});

const float = (over: Partial<PettyFloat> = {}): PettyFloat => ({
  id: 'f1', code: 'PC-ADMIN', name: 'Administration petty cash', departmentId: 'd1', location: null, custodianId: 'cust', custodianName: 'Atieno Accountant',
  floatLimit: 50_000, perTransactionLimit: 20_000, replenishThreshold: 10_000, glAccountId: null, mpesaEnabled: false, mpesaShortcode: null, balance: 42_000, available: 40_000, isActive: true,
  ...over,
});

const request = (over: Partial<PettyRequest> = {}): PettyRequest => ({
  id: 'r1', number: 'PCV-2026-00001', floatId: 'f1', float: float(), kind: 'PAYMENT', status: 'APPROVED', requestedBy: 'u-req', requestedByName: 'Moraa Nurse',
  payeeType: 'VENDOR', payeeUserId: null, payeeName: 'Kamau Plumbers', purpose: 'Unblock the sluice drain', glAccountId: null, departmentId: 'd1', department: { name: 'Medical ward' },
  amount: 3_000, method: 'CASH', payeePhone: null, payeeShortcode: null, payeeAccountRef: null, duplicate: null, duplicateJustification: null, disbursedOn: null, reference: null,
  receivedByName: null, acknowledgedAt: null, retirementDueOn: null, spentAmount: null, refundAmount: null, retirementNotes: null, lastComment: null, createdAt: '2026-10-27T08:00:00Z',
  retirementLines: [], attempts: [],
  ...over,
});

describe('Petty cash', () => {
  it('menu: everyone requests; custodians and managers see the floats', () => {
    const nav = (perms: PermissionCode[]) => visibleNav((...p) => p.every((x) => perms.includes(x))).map((n) => n.path);
    expect(nav([Permissions.PETTY_CASH_REQUEST])).toContain('/petty-cash');
    expect(nav([Permissions.PETTY_CASH_REQUEST])).not.toContain('/petty-cash/floats');
    expect(nav([Permissions.PETTY_CASH_DISBURSE])).toContain('/petty-cash/floats');
  });

  it('request form: M-PESA only on floats that pay by M-PESA; a likely duplicate asks for a justification', async () => {
    const posts: unknown[] = [];
    let first = true;
    route([
      ['GET /petty-cash/floats', [float()]],
      ['GET /gl-accounts', { items: [{ id: 'g1', code: '5100', name: 'Repairs', type: 'EXPENSE' }], total: 1, page: 1, pageSize: 500 }],
      ['GET /departments', { items: [{ id: 'd1', name: 'Medical ward' }], total: 1, page: 1, pageSize: 500 }],
      [
        'POST /petty-cash/requests',
        (o: { body: unknown }) => {
          posts.push(o.body);
          if (first) {
            first = false;
            throw new ApiError(409, { code: 'POSSIBLE_DUPLICATE', message: 'Same payee', duplicateOf: 'PCV-2026-00001' } as never);
          }
          return request({ id: 'new' });
        },
      ],
    ]);
    render(wrap(<PettyRequestDialog onClose={() => {}} />));
    fireEvent.mouseDown(await screen.findByLabelText(/^Float/));
    fireEvent.click(await screen.findByRole('option', { name: /Administration petty cash/ }));
    fireEvent.mouseDown(screen.getByLabelText('Pay by'));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Cash']);
    fireEvent.click(screen.getByRole('option', { name: 'Cash' }));
    fireEvent.change(screen.getByLabelText(/Payee name/), { target: { value: 'Kamau Plumbers' } });
    fireEvent.change(screen.getByLabelText(/Purpose/), { target: { value: 'Second drain job' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText(/paid this amount recently \(PCV-2026-00001\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Why this is not a duplicate/), { target: { value: 'A different drain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ floatId: 'f1', kind: 'PAYMENT', payeeType: 'VENDOR', payeeName: 'Kamau Plumbers', amount: 3_000, method: 'CASH', duplicateJustification: 'A different drain', submit: true });
  });

  it('advances: no payee to choose; the holder retires them with receipts', async () => {
    route([
      ['GET /petty-cash/floats', [float()]],
      ['GET /gl-accounts', { items: [], total: 0, page: 1, pageSize: 500 }],
      ['GET /departments', { items: [], total: 0, page: 1, pageSize: 500 }],
    ]);
    const { unmount } = render(wrap(<PettyRequestDialog onClose={() => {}} />));
    fireEvent.mouseDown(await screen.findByLabelText('Type'));
    fireEvent.click(await screen.findByRole('option', { name: /Advance/ }));
    expect(screen.getByText(/must be retired with receipts/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Payee name/)).toBeNull();
    unmount();

    auth.id = 'u-req';
    auth.permissions = [Permissions.PETTY_CASH_REQUEST];
    const retire = vi.fn().mockReturnValue({});
    route([['GET /petty-cash/requests/r1', request({ kind: 'ADVANCE', status: 'DISBURSED', payeeType: 'STAFF', payeeUserId: 'u-req', payeeName: 'Moraa Nurse', amount: 5_000, retirementDueOn: '2026-11-03', disbursedOn: '2026-10-27', reference: 'PCV-2026-00001' })], ['POST /petty-cash/requests/r1/retirement', retire]]);
    render(wrap(<PettyRequestDetailPage />, '/petty-cash/r1', '/petty-cash/:id'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retire with receipts' }));
    fireEvent.change(screen.getByLabelText('What'), { target: { value: 'Matatu fares' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '4000' } });
    expect(screen.getByText(/hand back/)).toHaveTextContent(/1,000\.00/);
    fireEvent.click(screen.getByRole('button', { name: 'Submit receipts' }));
    await waitFor(() => expect(retire).toHaveBeenCalledWith(expect.objectContaining({ body: { lines: [{ description: 'Matatu fares', amount: 4_000 }] } })));
  });

  it('only the custodian of the float pays, and never their own request', async () => {
    auth.permissions = [Permissions.PETTY_CASH_DISBURSE, Permissions.PETTY_CASH_REQUEST];
    auth.id = 'other';
    route([['GET /petty-cash/requests/r1', request()]]);
    const { unmount } = render(wrap(<PettyRequestDetailPage />, '/petty-cash/r1', '/petty-cash/:id'));
    expect(await screen.findByText('Unblock the sluice drain')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay out cash' })).toBeNull();
    unmount();

    auth.id = 'cust';
    const pay = vi.fn().mockReturnValue({});
    route([['GET /petty-cash/requests/r1', request()], ['POST /petty-cash/requests/r1/disburse', pay]]);
    render(wrap(<PettyRequestDetailPage />, '/petty-cash/r1', '/petty-cash/:id'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pay out cash' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Collected by/), { target: { value: 'J. Kamau' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Paid' }));
    await waitFor(() => expect(pay).toHaveBeenCalledWith(expect.objectContaining({ body: { receivedByName: 'J. Kamau' } })));
  });
});

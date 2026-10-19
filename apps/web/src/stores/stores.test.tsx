import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { IssuePlan, PlanLine } from '../api/stores-types';
import { visibleNav } from '../layout/nav';
import { applyScan, initialState, issueBody, overridesFefo } from './issue-logic';
import { IssueFormPage } from './IssuePages';
import { consumptionQuery } from './ReportPages';

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

afterEach(() => apiMock.api.mockReset());

const line = (over: Partial<PlanLine> = {}): PlanLine => ({
  requisitionLineId: 'l1',
  lineNo: 1,
  itemId: 'i1',
  itemCode: 'ITM000001',
  itemName: 'Gloves M',
  barcode: '6001234567890',
  gtin: null,
  isControlled: false,
  isColdChain: false,
  uom: 'PAIR',
  patientRef: null,
  outstandingQty: 10,
  shortfall: 0,
  picks: [
    { batchId: 'bA', binId: null, binCode: null, batchNo: 'A-EARLY', expiryDate: '2027-01-01', quantity: 6 },
    { batchId: 'bB', binId: 'x', binCode: 'A-01', batchNo: 'B-LATE', expiryDate: '2028-01-01', quantity: 4 },
  ],
  candidates: [
    { batchId: 'bA', binId: null, binCode: null, batchNo: 'A-EARLY', expiryDate: '2027-01-01', available: 6 },
    { batchId: 'bB', binId: 'x', binCode: 'A-01', batchNo: 'B-LATE', expiryDate: '2028-01-01', available: 20 },
  ],
  ...over,
});

describe('issue picking logic', () => {
  it('pre-fills the FEFO suggestion and treats it (or a smaller FEFO take) as no override', () => {
    const s = initialState([line()]);
    expect(s[0].rows.map((r) => r.quantity)).toEqual([6, 4]);
    expect(overridesFefo(s)).toBe(false);
    // Issuing less, still from the earliest batch first, is FEFO.
    s[0].rows[0].quantity = 5;
    s[0].rows[1].quantity = 0;
    expect(overridesFefo(s)).toBe(false);
  });

  it('flags picks out of FEFO order', () => {
    const s = initialState([line()]);
    s[0].rows[0].quantity = 0;
    s[0].rows[1].quantity = 10;
    expect(overridesFefo(s)).toBe(true);
  });

  it('confirms picks by batch number first, then by item barcode', () => {
    let s = initialState([line()]);
    let r = applyScan(s, 'b-late');
    expect(r.matched).toEqual({ lineNo: 1, batchNo: 'B-LATE' });
    s = r.state;
    r = applyScan(s, '6001234567890');
    expect(r.matched?.batchNo).toBe('A-EARLY');
    s = r.state;
    expect(applyScan(s, '6001234567890').matched).toBeNull(); // nothing left to confirm
    expect(applyScan(s, 'UNKNOWN').matched).toBeNull();
    expect(issueBody(s)).toEqual([
      {
        requisitionLineId: 'l1',
        picks: [
          { batchId: 'bA', binId: null, quantity: 6, scannedCode: '6001234567890' },
          { batchId: 'bB', binId: 'x', quantity: 4, scannedCode: 'b-late' },
        ],
      },
    ]);
  });
});

describe('IssueFormPage', () => {
  const plan = (scanConfirm: 'OPTIONAL' | 'REQUIRED', lines = [line()]): IssuePlan => ({ requisitionId: 'sr1', scanConfirm, lines });
  const sr = { id: 'sr1', number: 'SR/MS/2026/00001', status: 'APPROVED', priority: 'ROUTINE', department: { name: 'Medical Ward' }, store: { name: 'Main Store' }, lines: [] };
  const renderAt = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/store-requisitions/sr1/issue']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/store-requisitions/:id/issue" element={<IssueFormPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  beforeEach(() => {
    auth.permissions = [Permissions.INVENTORY_ISSUE];
  });

  it('requires every pick to be scanned when scanning is mandatory', async () => {
    apiMock.api.mockImplementation(async (path: string) => (path.endsWith('/issue-plan') ? plan('REQUIRED') : sr));
    renderAt();
    const post = await screen.findByRole('button', { name: 'Post issue voucher' });
    expect(post).toBeDisabled();
    const scan = screen.getByLabelText(/Scan item barcode/);
    await userEvent.type(scan, 'A-EARLY{Enter}');
    expect(await screen.findByText(/Confirmed line 1, batch A-EARLY/)).toBeInTheDocument();
    expect(post).toBeDisabled();
    await userEvent.type(scan, 'B-LATE{Enter}');
    await waitFor(() => expect(post).toBeEnabled());
  });

  it('blocks a FEFO override without the permission and asks for a reason with it', async () => {
    apiMock.api.mockImplementation(async (path: string) => (path.endsWith('/issue-plan') ? plan('OPTIONAL') : sr));
    const { unmount } = renderAt();
    const early = await screen.findByLabelText('Issue quantity of batch A-EARLY');
    await userEvent.clear(early);
    await userEvent.type(early, '0');
    expect(screen.getByText(/do not have permission to override/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post issue voucher' })).toBeDisabled();
    unmount();

    auth.permissions = [Permissions.INVENTORY_ISSUE, Permissions.INVENTORY_OVERRIDE_FEFO];
    renderAt();
    const early2 = await screen.findByLabelText('Issue quantity of batch A-EARLY');
    await userEvent.clear(early2);
    await userEvent.type(early2, '0');
    const post = screen.getByRole('button', { name: 'Post issue voucher' });
    expect(post).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/FEFO override reason/), 'Short-dated batch kept for theatre');
    expect(post).toBeEnabled();
  });

  it('asks for a witness for controlled drugs and warns about back-orders', async () => {
    apiMock.api.mockImplementation(async (path: string) =>
      path.endsWith('/issue-plan') ? plan('OPTIONAL', [line({ isControlled: true, shortfall: 4, outstandingQty: 14 })]) : sr,
    );
    renderAt();
    const panel = await screen.findByLabelText('Line 1');
    expect(within(panel).getByText(/4 PAIR will stay on back-order/)).toBeInTheDocument();
    expect(screen.getByLabelText('Witness username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post issue voucher' })).toBeDisabled();
  });
});

describe('navigation and reports', () => {
  it('shows ward pages to ward staff and hides consumption from them', () => {
    const held: PermissionCode[] = [Permissions.INVENTORY_REQUISITION];
    const labels = visibleNav((...p) => p.every((x) => held.includes(x))).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Internal requisitions', 'Department returns', 'Back-orders']));
    expect(labels).not.toContain('Consumption');
    expect(labels).not.toContain('Supplier returns');
  });

  it('builds the consumption query used for the table and the CSV export', () => {
    expect(consumptionQuery({ from: '2026-10-01', to: '2026-10-31', groupBy: 'item', departmentId: '', storeId: 's1', patientRef: ' IP-1 ' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'item',
      departmentId: undefined,
      storeId: 's1',
      patientRef: 'IP-1',
    });
  });
});

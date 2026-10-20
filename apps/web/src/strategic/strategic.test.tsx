import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import { isPortalUser, visibleNav } from '../layout/nav';
import { PortalOrderPage, SUPPLIER_STAGES } from '../portal/PortalPages';
import type { ContractDetail, PortalOrder, TenderDetail } from './api';
import { callOffProblems, ContractDetailPage } from './ContractPages';
import { scoreColour } from './PerformancePages';
import { planLinesPayload } from './PlanPages';
import { technicalWeightProblem, TenderDetailPage } from './TenderPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[], id: 'u1', supplierId: null as string | null }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: auth.id, storeIds: null, departmentId: null, permissions: auth.permissions, supplierId: auth.supplierId },
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

/** Answers by path; anything else is an empty list. */
const route = (map: Record<string, unknown>) => apiMock.api.mockImplementation(async (path: string) => (path in map ? map[path] : []));

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
  auth.id = 'u1';
  auth.supplierId = null;
});

const P = Permissions;

describe('navigation for sourcing staff and supplier portal users', () => {
  const labels = (held: PermissionCode[], portal = false) => visibleNav((...p) => p.every((x) => held.includes(x)), portal).map((i) => i.label);

  it('shows plans, tenders, contracts and KPIs to procurement staff; never the portal', () => {
    const staff = labels([P.PLANS_READ, P.TENDERS_READ, P.CONTRACTS_READ, P.PROCUREMENT_KPIS, P.FORECASTING_READ, P.PURCHASING_READ, P.PORTAL_ACCESS]);
    expect(staff).toEqual(expect.arrayContaining(['Procurement plans', 'Tenders', 'Contracts', 'Procurement KPIs', 'Demand forecasting', 'Supply planning', 'KEMSA / MEDS orders']));
    expect(staff).not.toContain('Requests for quotation');
    expect(staff).not.toContain('Supplier home');
    // An evaluator sees tenders without broader procurement rights.
    expect(labels([P.TENDERS_EVALUATE])).toContain('Tenders');
  });

  it('shows a supplier user only the portal', () => {
    expect(isPortalUser({ supplierId: 's1' })).toBe(true);
    expect(isPortalUser({ supplierId: null })).toBe(false);
    const portal = labels(Object.values(P), true);
    expect(portal).toEqual(['Supplier home', 'Requests for quotation', 'Tenders', 'Purchase orders', 'Invoices & payments', 'My account']);
  });
});

describe('form helpers', () => {
  it('technical weights must add up to 100', () => {
    expect(technicalWeightProblem([{ stage: 'TECHNICAL', weight: 60 }, { stage: 'TECHNICAL', weight: 40 }, { stage: 'PRELIMINARY' }], 30)).toBeNull();
    expect(technicalWeightProblem([{ stage: 'TECHNICAL', weight: 60 }], 30)).toMatch(/add up to 60/);
    expect(technicalWeightProblem([{ stage: 'PRELIMINARY' }], 30)).toMatch(/needs technical criteria/);
    expect(technicalWeightProblem([], 0)).toBeNull();
  });

  it('plan lines send the item or the description, and leave the method to the recommendation when blank', () => {
    const [a, b] = planLinesPayload([
      { item: { id: 'i1' } as never, description: 'ignored', quantity: 10, estimatedUnitCost: 5, voteHead: 'PHARMA', sourcingMethod: '', plannedQuarter: 2, notes: '' },
      { item: null, description: 'Servicing of autoclaves', quantity: 1, estimatedUnitCost: 80_000, voteHead: 'MAINT', sourcingMethod: 'RFQ', plannedQuarter: 1, notes: 'Annual' },
    ]);
    expect(a).toEqual({ itemId: 'i1', description: undefined, quantity: 10, estimatedUnitCost: 5, voteHead: 'PHARMA', sourcingMethod: undefined, plannedQuarter: 2, notes: undefined });
    expect(b).toMatchObject({ itemId: undefined, description: 'Servicing of autoclaves', sourcingMethod: 'RFQ', notes: 'Annual' });
  });

  it('scorecard colours against the threshold; suppliers cannot report a delivery as received', () => {
    expect(scoreColour(null)).toBe('default');
    expect(scoreColour(50)).toBe('error');
    expect(scoreColour(70)).toBe('warning');
    expect(scoreColour(90)).toBe('success');
    expect(SUPPLIER_STAGES).not.toContain('DELIVERED');
    expect(SUPPLIER_STAGES).toContain('DISPATCHED');
  });
});

const contract = (over: Partial<ContractDetail> = {}): ContractDetail => ({
  id: 'c1', number: 'CTR/2026/000001', title: 'Gloves framework', supplierId: 's1', supplier: { id: 's1', name: 'Acme Medical' } as never, tenderId: null, type: 'FRAMEWORK', status: 'ACTIVE',
  startDate: '2026-01-01', endDate: '2099-12-31', value: 200_000, deliveryTerms: null, paymentTermsDays: 30, leadTimeDays: 7, signedAt: '2026-01-01T00:00:00Z', supplierSignatory: 'MD', terminationReason: null,
  lines: [
    { id: 'l1', itemId: 'i1', item: { id: 'i1', name: 'Gloves M' } as never, unitPrice: 100, quantity: 1000, brand: null, calledOffQty: 400, remainingQty: 600, calledOffValue: 40_000 },
    { id: 'l2', itemId: 'i2', item: { id: 'i2', name: 'Gauze' } as never, unitPrice: 50, quantity: null, brand: null, calledOffQty: 0, remainingQty: null, calledOffValue: 0 },
  ],
  securities: [], milestones: [], variations: [], callOffs: [{ id: 'po1', number: 'PO/2026/000009', status: 'SENT', orderDate: '2026-10-20', total: 40_000, store: 'Main Store' }],
  calledOffValue: 40_000, remainingValue: 160_000,
  ...over,
});

describe('contracts', () => {
  it('flags call-off quantities above the remaining balance (lines without a quantity are unlimited)', () => {
    const c = contract();
    expect(callOffProblems(c.lines, { l1: 600, l2: 5000 })).toEqual([]);
    expect(callOffProblems(c.lines, { l1: 601 })).toEqual(['Gloves M: only 600 left']);
  });

  it('shows remaining balances and call-offs; only contract managers who can order see the call-off button', async () => {
    route({ '/contracts/c1': contract() });
    auth.permissions = [P.CONTRACTS_READ];
    const { unmount } = render(wrap(<ContractDetailPage />, '/contracts/c1', '/contracts/:id'));
    const lines = await screen.findByRole('table', { name: 'Contract lines' });
    expect(within(lines).getByText('600')).toBeInTheDocument();
    expect(within(lines).getByText('price only')).toBeInTheDocument();
    expect(screen.getByText('PO/2026/000009')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New call-off order' })).not.toBeInTheDocument();
    unmount();

    auth.permissions = [P.CONTRACTS_READ, P.CONTRACTS_MANAGE, P.PURCHASING_PO];
    render(wrap(<ContractDetailPage />, '/contracts/c1', '/contracts/:id'));
    expect(await screen.findByRole('button', { name: 'New call-off order' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request variation' })).toBeInTheDocument();
  });
});

const tender = (over: Partial<TenderDetail> = {}): TenderDetail => ({
  id: 't1', number: 'TND/2026/000001', title: 'Supply of gloves', description: null, method: 'OPEN_TENDER', requisitionId: null, departmentId: null, status: 'PUBLISHED',
  estimatedValue: 2_000_000, invitedSupplierIds: [], publishedAt: '2026-10-01T00:00:00Z', closingAt: '2099-01-01T07:00:00Z', openedAt: null, bidSecurityAmount: 0, bidValidityDays: 120,
  technicalWeight: 30, technicalPassMark: 50, recommendedBidId: null, evaluationReport: null, professionalOpinion: null, awardedBidId: null, awardedAt: null, standstillUntil: null,
  contractId: null, cancellationReason: null, createdAt: '2026-10-01T00:00:00Z',
  lines: [{ id: 'tl1', lineNo: 1, itemId: 'i1', description: 'Gloves M', quantity: 1000, specification: null }],
  sealed: true,
  bids: [{ id: 'b1', supplierId: 's1', supplier: 'Acme Medical', submittedAt: '2026-10-10T08:00:00Z', status: 'SUBMITTED', viaPortal: true, bidSecurityRef: null }],
  documents: [], clarifications: [], opening: null,
  criteria: [{ id: 'c1', stage: 'PRELIMINARY', name: 'Tax compliance', weight: 0, maxScore: 1, sortOrder: 0 }],
  members: [], isMember: false,
  ...over,
});

describe('tenders', () => {
  it('keeps bids sealed before opening', async () => {
    auth.permissions = [P.TENDERS_READ, P.TENDERS_MANAGE];
    route({ '/tenders/t1': tender() });
    render(wrap(<TenderDetailPage />, '/tenders/t1', '/tenders/:id'));
    const bids = await screen.findByRole('table', { name: 'Bids' });
    expect(within(bids).getByText('sealed')).toBeInTheDocument();
    expect(screen.getByText('Bids sealed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record a physical bid' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open bids' })).not.toBeInTheDocument(); // not closed yet
  });

  it('asks a committee member to declare before scoring; a conflicted member gets no score sheet', async () => {
    auth.permissions = [P.TENDERS_EVALUATE];
    const opened = { status: 'EVALUATION', sealed: false, openedAt: '2026-10-15T08:00:00Z', closingAt: '2026-10-15T07:00:00Z', bids: [{ id: 'b1', supplierId: 's1', supplier: 'Acme Medical', submittedAt: '2026-10-10T08:00:00Z', status: 'OPENED', viaPortal: true, bidSecurityRef: null, totalPrice: 100_000 }] };
    const evaluation = { members: [], criteria: [], bids: [], complete: false, missing: [], undeclared: [] };
    route({ '/tenders/t1': tender({ ...opened, members: [{ id: 'm1', userId: 'u1', fullName: 'Me', role: 'MEMBER', declaredAt: null, hasConflict: null }], isMember: true }), '/tenders/t1/evaluation': evaluation });
    const { unmount } = render(wrap(<TenderDetailPage />, '/tenders/t1', '/tenders/:id'));
    expect(await screen.findByRole('button', { name: 'Declare conflict of interest' })).toBeInTheDocument();
    expect(screen.queryByText('My score sheet')).not.toBeInTheDocument();
    unmount();

    route({ '/tenders/t1': tender({ ...opened, members: [{ id: 'm1', userId: 'u1', fullName: 'Me', role: 'MEMBER', declaredAt: '2026-10-16T08:00:00Z', hasConflict: true }], isMember: true }), '/tenders/t1/evaluation': evaluation });
    const second = render(wrap(<TenderDetailPage />, '/tenders/t1', '/tenders/:id'));
    expect(await screen.findByText('Conflict')).toBeInTheDocument();
    expect(screen.queryByText('My score sheet')).not.toBeInTheDocument();
    second.unmount();

    route({ '/tenders/t1': tender({ ...opened, members: [{ id: 'm1', userId: 'u1', fullName: 'Me', role: 'MEMBER', declaredAt: '2026-10-16T08:00:00Z', hasConflict: false }], isMember: true }), '/tenders/t1/evaluation': evaluation });
    render(wrap(<TenderDetailPage />, '/tenders/t1', '/tenders/:id'));
    expect(await screen.findByText('My score sheet')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Tax compliance — Acme Medical' })).toBeInTheDocument();
  });
});

describe('supplier portal', () => {
  const order = (over: Partial<PortalOrder> = {}): PortalOrder => ({
    id: 'po1', number: 'PO/2026/000009', version: 1, status: 'SENT', orderDate: '2026-10-20', expectedDelivery: '2026-10-27', total: 46_400, currency: 'KES', acknowledgedAt: null, deliveryStage: 'ORDER_SENT',
    store: { id: 'st1', name: 'Main Store' },
    lines: [{ lineNo: 1, item: 'Gloves M', uom: 'PCS', quantity: 400, unitPrice: 100, lineTotal: 40_000, receivedBaseQty: 0, conversionFactor: 1 }],
    deliveries: [],
    ...over,
  });

  it('lets the supplier acknowledge its order; delivery itself is not a choice', async () => {
    auth.permissions = [P.PORTAL_ACCESS];
    auth.supplierId = 's1';
    route({ '/portal/purchase-orders/po1': order() });
    render(wrap(<PortalOrderPage />, '/portal/orders/po1', '/portal/orders/:id'));
    expect(await screen.findByRole('button', { name: 'Acknowledge order' })).toBeInTheDocument();
    expect(screen.getByText('Gloves M')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Status' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toContain('Dispatched');
    expect(options).not.toContain('Delivered');
  });

  it('shows when the order was acknowledged', async () => {
    auth.permissions = [P.PORTAL_ACCESS];
    auth.supplierId = 's1';
    route({ '/portal/purchase-orders/po1': order({ acknowledgedAt: '2026-10-20T09:00:00Z' }) });
    render(wrap(<PortalOrderPage />, '/portal/orders/po1', '/portal/orders/:id'));
    expect(await screen.findByText(/^Acknowledged /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge order' })).not.toBeInTheDocument();
  });
});

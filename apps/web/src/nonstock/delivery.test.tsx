import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from '@sil/shared';
import type { Handover, StaffRequisition } from '../api/nonstock-types';
import { ServiceCertificateDetailPage } from '../logistics/LogisticsPages';
import { DeliveryPanel, HandoverDetailPage } from './HandoverPages';

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
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

/** Answers by method + path (first matching prefix wins); side panels get empty answers. */
function route(table: [string, unknown][]) {
  const all: [string, unknown][] = [...table, ['GET /attachments', []], ['GET /documents/chain', { nodes: [], edges: [] }]];
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
});

const handover = (over: Partial<Handover> = {}): Handover => ({
  id: 'h1',
  number: 'HOV-2026-00001',
  requisitionId: 'r1',
  requisition: { number: 'REQ-2026-00001' },
  status: 'PENDING',
  preparedBy: 'u2',
  preparedByName: 'Store Keeper',
  receivedBy: 'u1',
  receivedByName: 'Moraa Nurse',
  condition: 'GOOD',
  notes: null,
  ackChannel: null,
  acknowledgedAt: null,
  ackComment: null,
  otpPending: false,
  createdAt: '2026-10-27T08:00:00Z',
  lines: [{ id: 'hl1', requisitionLineId: 'l1', quantity: 2, remarks: null, requisitionLine: { lineNo: 2, description: 'Bedside lockers', uom: { code: 'PCS' } } }],
  ...over,
});

describe('Hand-over to the final user', () => {
  it('the receiver confirms in the app', async () => {
    const posted = vi.fn().mockReturnValue({});
    route([
      ['GET /handovers/h1', handover()],
      ['POST /handovers/h1/acknowledge', posted],
    ]);
    render(wrap(<HandoverDetailPage />, '/handovers/h1', '/handovers/:id'));
    expect(await screen.findByText('2. Bedside lockers')).toBeInTheDocument();
    expect(screen.queryByText(/Send code/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'All good' } });
    fireEvent.click(screen.getByRole('button', { name: 'I have received these' }));
    await waitFor(() => expect(posted).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: { comment: 'All good' } })));
  });

  it('the officer enters the receiver’s 6-digit code', async () => {
    const verify = vi.fn().mockReturnValue({});
    route([
      ['GET /handovers/h1', handover({ preparedBy: 'u1', receivedBy: 'u3', receivedByName: 'Moraa Nurse', otpPending: true })],
      ['POST /handovers/h1/otp/verify', verify],
    ]);
    render(wrap(<HandoverDetailPage />, '/handovers/h1', '/handovers/:id'));
    const input = await screen.findByLabelText('Code from the receiver');
    expect(screen.queryByRole('button', { name: 'I have received these' })).toBeNull();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.change(input, { target: { value: '12a3' } });
    expect(input).toHaveValue('123');
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(verify).toHaveBeenCalledWith(expect.objectContaining({ body: { code: '123456' } })));
  });

  it('procurement hands over what was received and not yet delivered', async () => {
    auth.permissions = [Permissions.PURCHASING_HANDOVER];
    const created = vi.fn().mockReturnValue(handover());
    route([
      ['GET /handovers', []],
      ['POST /handovers', created],
    ]);
    const req = {
      id: 'r1',
      number: 'REQ-2026-00001',
      status: 'CONVERTED',
      requestedByName: 'Moraa Nurse',
      deliverable: [
        { requisitionLineId: 'l1', lineNo: 1, lineType: 'SERVICE', description: 'ECG recalibration', uom: 'JOB', quantity: 1, receivedQty: 1, deliveredQty: 1, pendingQty: 0, available: 0, status: 'DELIVERED' },
        { requisitionLineId: 'l2', lineNo: 2, lineType: 'NON_STOCK_GOODS', description: 'Bedside lockers', uom: 'PCS', quantity: 4, receivedQty: 3, deliveredQty: 0, pendingQty: 0, available: 3, status: 'ON_PR' },
      ],
    } as unknown as StaffRequisition;
    render(wrap(<DeliveryPanel requisition={req} />, '/x', '/x'));
    const table = screen.getByRole('table', { name: 'Delivery' });
    expect(within(table).getByText('2. Bedside lockers')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Hand over' }));
    const qty = await screen.findByLabelText('Hand over quantity for line 2');
    expect(qty).toHaveValue(3);
    expect(screen.queryByLabelText('Hand over quantity for line 1')).toBeNull(); // nothing left on the service
    fireEvent.change(qty, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ requisitionId: 'r1', lines: [{ requisitionLineId: 'l2', quantity: 2 }] }) })),
    );
  });
});

describe('Acceptance by the requesting department', () => {
  const cert = {
    id: 'c1',
    number: 'SCC/2026/0001',
    kind: 'Goods received note (non-stock)',
    purchaseOrderId: 'po1',
    purchaseOrder: { number: 'PO/2026/0001' },
    supplier: { name: 'Baraka Supplies' },
    periodFrom: null,
    periodTo: '2026-10-27',
    status: 'DRAFT',
    qualityRating: null,
    workDone: 'Lockers delivered',
    certifiedBy: 'u2',
    certifiedByName: 'Store Keeper',
    postedAt: null,
    requisitions: [{ id: 'r1', number: 'REQ-2026-00001' }],
    canSign: true,
    lines: [{ id: 'cl1', poLineId: 'p1', lineNo: 2, item: 'Bedside lockers', ordered: 4, quantity: 3, rejectedQty: 1, rejectionReason: 'Door hinge broken', uom: 'PCS', value: 37500, remarks: null }],
  };

  it('the requester accepts or rejects; there is no officer “post” for requisition orders', async () => {
    const accept = vi.fn().mockReturnValue({});
    route([
      ['GET /service-certificates/c1', cert],
      ['POST /service-certificates/c1/accept', accept],
    ]);
    render(wrap(<ServiceCertificateDetailPage />, '/service-certificates/c1', '/service-certificates/:id'));
    expect(await screen.findByText(/Goods received note \(non-stock\) SCC\/2026\/0001/)).toBeInTheDocument();
    expect(screen.getByText('1: Door hinge broken')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post certificate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept delivery' }));
    await waitFor(() => expect(accept).toHaveBeenCalled());
  });
});

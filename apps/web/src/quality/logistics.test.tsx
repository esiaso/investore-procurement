import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import { AttachmentsPanel, formatBytes } from '../files/AttachmentsPanel';
import { visibleNav } from '../layout/nav';
import { RunDetailPage } from '../logistics/LogisticsPages';
import { submissionForm } from '../portal/PortalPages';
import { HoldDetailPage, RecallDetailPage } from './QualityPages';
import type { HoldDetail, Recall, RecallTrace } from './types';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[], id: 'u1' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: auth.id, fullName: 'Test User', storeIds: null, departmentId: null, permissions: auth.permissions, supplierId: null },
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
const route = (map: Record<string, unknown>) => apiMock.api.mockImplementation(async (path: string) => (path in map ? map[path] : []));

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
  auth.id = 'u1';
});

const P = Permissions;

describe('navigation', () => {
  const labels = (held: PermissionCode[]) => visibleNav((...p) => p.every((x) => held.includes(x))).map((i) => i.label);

  it('shows the quality officer holds, cold chain, recalls, complaints and disposals', () => {
    expect(labels([P.QUALITY_READ, P.QUALITY_RELEASE, P.RECALLS_MANAGE, P.DISPOSALS_MANAGE])).toEqual(expect.arrayContaining(['Quarantine & holds', 'Cold chain', 'Recalls', 'Complaints', 'Disposals']));
  });

  it('shows a storekeeper distribution and fridge logs but not recalls', () => {
    const sk = labels([P.INVENTORY_READ, P.DISTRIBUTION_MANAGE, P.INVENTORY_HANDLE_COLD_CHAIN]);
    expect(sk).toEqual(expect.arrayContaining(['Distribution', 'Cold chain', 'Labels']));
    expect(sk).not.toContain('Recalls');
    expect(sk).not.toContain('Assets');
  });
});

const hold = (over: Partial<HoldDetail> = {}): HoldDetail => ({
  id: 'h1', number: 'QH/2026/00001', batchId: 'b1', batch: { id: 'b1', batchNo: 'B-1', expiryDate: '2027-01-01', holdStatus: 'QUARANTINE', item: { id: 'i1', name: 'Vaccine X' } as never },
  storeId: 's1', store: null, reason: 'EXCURSION', details: 'Fridge at 11 °C', sourceType: 'EXCURSION', sourceId: 'e1', quantityAtHold: 40, status: 'OPEN',
  placedBy: 'someone-else', decidedBy: null, decidedAt: null, decisionNote: null, disposalId: null, createdAt: '2026-10-25T08:00:00Z',
  locations: [{ store: 'Main Pharmacy', bin: null, onHand: 40 }], placedByName: 'Pharmacist', decidedByName: null,
  ...over,
});

describe('quality holds', () => {
  it('the Quality Officer can release or reject; the person who placed it cannot decide', async () => {
    auth.permissions = [P.QUALITY_READ, P.QUALITY_RELEASE];
    route({ '/quality/holds/h1': hold() });
    const first = render(wrap(<HoldDetailPage />, '/quality/holds/h1', '/quality/holds/:id'));
    expect(await screen.findByRole('button', { name: 'Release for use' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeInTheDocument();
    first.unmount();

    route({ '/quality/holds/h1': hold({ placedBy: 'u1' }) });
    const second = render(wrap(<HoldDetailPage />, '/quality/holds/h1', '/quality/holds/:id'));
    expect(await screen.findByText(/Another person decides/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release for use' })).not.toBeInTheDocument();
    second.unmount();

    // Recall holds are not released by hand.
    route({ '/quality/holds/h1': hold({ reason: 'RECALL' }) });
    render(wrap(<HoldDetailPage />, '/quality/holds/h1', '/quality/holds/:id'));
    expect(await screen.findByRole('button', { name: /Reject/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release for use' })).not.toBeInTheDocument();
  });
});

describe('recalls', () => {
  it('shows every store holding the batch and the patients to contact', async () => {
    auth.permissions = [P.QUALITY_READ, P.RECALLS_MANAGE];
    const recall: Recall = { id: 'r1', number: 'RCL/2026/0001', source: 'PPB', noticeReference: 'PPB/1', noticeDate: '2026-10-25', classification: 'CLASS_I', itemId: 'i1', item: { id: 'i1', name: 'Drug Y' } as never, batchNos: ['B-9'], batchIds: ['b9'], reason: 'Contamination', instructions: null, patientLevel: true, status: 'OPEN', outcome: null, closedAt: null, returns: [], holds: [] };
    const trace: RecallTrace = {
      recall,
      holdings: [{ storeId: 's1', storeCode: 'MS', storeName: 'Main Store', batchNo: 'B-9', binCode: 'A1', onHand: 110, reserved: 0, inTransit: 0 }, { storeId: 's2', storeCode: 'OPD', storeName: 'OPD Pharmacy', batchNo: 'B-9', binCode: null, onHand: 50, reserved: 0, inTransit: 0 }],
      issues: [{ id: 't1', date: '2026-10-24', docNo: 'ISS/1', fromStore: 'Main Store', departmentId: 'd1', department: 'Medical ward', batchNo: 'B-9', quantity: 30 }],
      dispenses: [{ id: 'dl1', dispenseNo: 'DSP/1', dispensedAt: '2026-10-24T10:00:00Z', store: 'OPD Pharmacy', batchNo: 'B-9', quantity: 10, returnedQty: 0, patientId: 'p1', hospitalNo: 'H123', patientName: 'Jane Doe', patientPhone: '0700' }],
      sales: [], transfers: [], otherMovements: [],
      patients: [{ patientId: 'p1', hospitalNo: 'H123', name: 'Jane Doe', phone: '0700', quantity: 10, via: ['DSP/1'] }],
      unidentifiedSales: 0,
      totals: { onHand: 160, inTransit: 0, issued: 30, dispensed: 10, sold: 0, returned: 0 },
    };
    route({ '/recalls/r1': recall, '/recalls/r1/trace': trace });
    render(wrap(<RecallDetailPage />, '/recalls/r1', '/recalls/:id'));
    const stores = await screen.findByRole('table', { name: 'Stores holding the batch' });
    expect(within(stores).getByText('Main Store')).toBeInTheDocument();
    expect(within(stores).getByText('OPD Pharmacy')).toBeInTheDocument();
    const patients = screen.getByRole('table', { name: 'Patients' });
    expect(within(patients).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(patients).getByText('0700')).toBeInTheDocument();
    expect(screen.getByText(/Patient-level recall/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record return' })).toBeInTheDocument();
  });
});

describe('distribution', () => {
  const run = (stops: { status: string }[]) => ({
    id: 'run1', number: 'DRN/MS/2026/00001', routeId: null, fromStoreId: 'ms', fromStore: { name: 'Main Store' }, runDate: '2026-10-25', vehicle: 'KCA', driver: 'D', status: 'PICKING',
    stops: stops.map((s, i) => ({ id: `s${i}`, sequence: i + 1, transferId: `t${i}`, transfer: { number: `TRF/${i}`, status: 'REQUESTED' }, toStoreId: `x${i}`, toStore: { name: `Store ${i}` }, status: s.status, packages: 1, receivedByName: null, signatureName: null, deliveredAt: null, discrepancies: [] })),
  });

  it('dispatch waits until every stop is packed; a dispatched stop asks the receiver for proof of delivery', async () => {
    auth.permissions = [P.DISTRIBUTION_MANAGE, P.INVENTORY_TRANSFER_RECEIVE];
    route({ '/distribution/runs/run1': run([{ status: 'PACKED' }, { status: 'PICKED' }]), '/distribution/runs/run1/picking-list': { run: {}, stops: [] } });
    const first = render(wrap(<RunDetailPage />, '/distribution/run1', '/distribution/:id'));
    expect(await screen.findByRole('button', { name: 'Dispatch run' })).toBeDisabled();
    first.unmount();

    route({ '/distribution/runs/run1': run([{ status: 'PACKED' }, { status: 'PACKED' }]), '/distribution/runs/run1/picking-list': { run: {}, stops: [] } });
    const second = render(wrap(<RunDetailPage />, '/distribution/run1', '/distribution/:id'));
    expect(await screen.findByRole('button', { name: 'Dispatch run' })).toBeEnabled();
    second.unmount();

    route({ '/distribution/runs/run1': { ...run([{ status: 'DISPATCHED' }]), status: 'DISPATCHED' }, '/distribution/runs/run1/picking-list': { run: {}, stops: [] } });
    render(wrap(<RunDetailPage />, '/distribution/run1', '/distribution/:id'));
    expect(await screen.findByRole('button', { name: 'Record proof of delivery' })).toBeInTheDocument();
  });
});

describe('attachments', () => {
  const file = { id: 'a1', ownerType: 'GRN', ownerId: 'g1', category: 'DELIVERY_NOTE', fileName: 'dn.pdf', mimeType: 'application/pdf', sizeBytes: 2048, sha256: 'abcdef0123456789', version: 2, isCurrent: true, generated: false, notes: null, uploadedAt: '2026-10-25T08:00:00Z', uploadedBy: 'Storekeeper' };

  it('lists files with their version and offers upload only with files.upload', async () => {
    auth.permissions = [P.PURCHASING_READ];
    apiMock.api.mockResolvedValue([file]);
    const first = render(wrap(<AttachmentsPanel ownerType="GRN" ownerId="g1" categories={['DELIVERY_NOTE']} />, '/', '/'));
    expect(await screen.findByRole('link', { name: 'dn.pdf' })).toHaveAttribute('href', '/api/v1/attachments/a1/download');
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/2.0 KB/)).toBeInTheDocument();
    expect(screen.queryByText('Attach file')).not.toBeInTheDocument();
    first.unmount();

    auth.permissions = [P.PURCHASING_READ, P.FILES_UPLOAD];
    render(wrap(<AttachmentsPanel ownerType="GRN" ownerId="g1" categories={['DELIVERY_NOTE']} />, '/', '/'));
    expect(await screen.findByText('Attach file')).toBeInTheDocument();
  });

  it('formats sizes and builds the portal upload form', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    const f = submissionForm({ type: 'INVOICE', reference: 'INV-9', documentDate: '2026-10-25', amount: 1200, notes: '' }, new File(['%PDF'], 'inv.pdf', { type: 'application/pdf' }));
    expect(f.get('type')).toBe('INVOICE');
    expect(f.get('amount')).toBe('1200');
    expect(f.get('notes')).toBeNull();
    expect((f.get('file') as File).name).toBe('inv.pdf');
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { Payable, PaymentVoucher } from '../api/payment-types';
import { visibleNav } from '../layout/nav';
import { PaymentVoucherDetailPage, VoucherDialog } from './PaymentPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[], id: 'u1' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: auth.id, fullName: 'Someone', email: 's@example.org', roles: [], storeIds: null, departmentId: null, permissions: auth.permissions },
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
  const all: [string, unknown][] = [...table, ['GET /documents/chain', { nodes: [], edges: [] }], ['GET /approvals/history', []], ['GET /approvals/inbox', []]];
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

const payable = (over: Partial<Payable> = {}): Payable => ({
  id: 'i1', number: 'INV/2026/00001', supplierInvoiceNo: 'S-1', supplierId: 's1', supplier: 'Baraka Supplies', invoiceDate: '2026-09-01', dueDate: '2026-10-01',
  currency: 'KES', total: 23_200, whtTotal: 1_000, paidAmount: 0, scheduled: 0, outstanding: 23_200, available: 23_200, daysOverdue: 26, bucket: '1-30', orderNumber: 'PO/1',
  ...over,
});

const voucher = (over: Partial<PaymentVoucher> = {}): PaymentVoucher => ({
  id: 'v1', number: 'PV/2026/00001', supplierId: 's1', supplier: { name: 'Baraka Supplies' }, status: 'APPROVED', method: 'MPESA_PAYBILL', currency: 'KES',
  grossAmount: 10_000, whtAmount: 0, amount: 10_000, dueDate: null, paidOn: null, paymentReference: null, payeeName: 'Baraka Supplies', payeePhone: null,
  payeeShortcode: '888880', payeeAccountRef: 'HOSP-001', narrative: null, preparedBy: 'u-prep', preparedByName: 'Atieno Accountant', lastComment: null, createdAt: '2026-10-27T08:00:00Z',
  lines: [{ id: 'l1', invoiceId: 'i1', amount: 10_000, whtAmount: 0, netAmount: 10_000, invoice: { number: 'INV/2026/00001', supplierInvoiceNo: 'S-1' } }],
  attempts: [],
  ...over,
});

describe('Payments', () => {
  it('menu: preparers and reconcilers see the payments pages', () => {
    const nav = (perms: PermissionCode[]) => visibleNav((...p) => p.every((x) => perms.includes(x))).map((n) => n.path);
    expect(nav([Permissions.PAYMENTS_PREPARE])).toEqual(expect.arrayContaining(['/payments', '/payment-vouchers']));
    expect(nav([Permissions.PAYMENTS_PREPARE])).not.toContain('/payments/reconciliation');
    expect(nav([Permissions.PAYMENTS_RECONCILE])).toContain('/payments/reconciliation');
    expect(nav([Permissions.PURCHASING_READ])).not.toContain('/payments');
  });

  it('prepares a voucher: WHT in proportion, payee fields by method', async () => {
    const created = vi.fn().mockReturnValue(voucher({ id: 'new' }));
    route([['POST /payment-vouchers', created]]);
    render(wrap(<VoucherDialog invoices={[payable()]} onClose={() => {}} />));
    fireEvent.change(screen.getByLabelText('Amount for INV/2026/00001'), { target: { value: '11600' } });
    // 1,000 × 11,600 / 23,200 = 500 of WHT.
    expect(screen.getByText(/withholding tax/)).toHaveTextContent(/500\.00/);
    expect(screen.getByText(/paid to the supplier/)).toHaveTextContent(/11,100\.00/);
    fireEvent.mouseDown(screen.getByLabelText('Pay by'));
    fireEvent.click(await screen.findByRole('option', { name: 'M-PESA to phone (B2C)' }));
    fireEvent.change(screen.getByLabelText(/Payee phone/), { target: { value: '0712345678' } });
    expect(screen.getByText(/whole shillings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare voucher' }));
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ supplierId: 's1', method: 'MPESA_B2C', payeePhone: '0712345678', invoices: [{ invoiceId: 'i1', amount: 11_600 }] }) })),
    );
    expect(await screen.findByText('Navigated')).toBeInTheDocument();
  });

  it('the preparer cannot release; someone else sends it via M-PESA after a warning', async () => {
    auth.permissions = [Permissions.PAYMENTS_PREPARE, Permissions.PAYMENTS_RELEASE];
    auth.id = 'u-prep';
    route([['GET /payment-vouchers/v1', voucher()]]);
    const { unmount } = render(wrap(<PaymentVoucherDetailPage />, '/payment-vouchers/v1', '/payment-vouchers/:id'));
    expect(await screen.findByText(/someone else releases it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send via M-PESA' })).toBeNull();
    unmount();

    auth.id = 'u-pay';
    const release = vi.fn().mockReturnValue(voucher({ status: 'PROCESSING' }));
    route([['GET /payment-vouchers/v1', voucher()], ['POST /payment-vouchers/v1/release', release]]);
    render(wrap(<PaymentVoucherDetailPage />, '/payment-vouchers/v1', '/payment-vouchers/:id'));
    fireEvent.click(await screen.findByRole('button', { name: 'Send via M-PESA' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/sends money now/)).toBeInTheDocument();
    expect(within(dialog).getByText(/888880 \/ HOSP-001/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(release).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: {} })));
  });

  it('review queue: a failed M-PESA payment can be sent again or resolved; a live attempt blocks a resend', async () => {
    auth.permissions = [Permissions.PAYMENTS_RELEASE, Permissions.PAYMENTS_RECONCILE];
    auth.id = 'u-pay';
    const failed = voucher({ status: 'FAILED', lastComment: 'M-PESA: The balance is insufficient for the transaction. (2001)', attempts: [{ id: 'a1', attempt: 1, commandId: 'BusinessPayBill', status: 'FAILED', resultCode: '2001', resultDesc: 'The balance is insufficient', receiptNo: null, charges: null, recipientName: null, completedAt: null, createdAt: '', statusChecks: 0, reversedAt: null }] });
    route([['GET /payment-vouchers/v1', failed]]);
    const { unmount } = render(wrap(<PaymentVoucherDetailPage />, '/payment-vouchers/v1', '/payment-vouchers/:id'));
    expect(await screen.findByRole('button', { name: 'Send again via M-PESA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'M-PESA attempts' })).toHaveTextContent('The balance is insufficient');
    unmount();

    const review = voucher({ status: 'REVIEW', attempts: [{ ...failed.attempts![0], status: 'UNKNOWN', resultDesc: null, statusChecks: 6 }] });
    route([['GET /payment-vouchers/v1', review]]);
    render(wrap(<PaymentVoucherDetailPage />, '/payment-vouchers/v1', '/payment-vouchers/:id'));
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

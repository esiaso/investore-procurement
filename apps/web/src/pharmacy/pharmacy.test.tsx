import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { ClinicalAlert, Prescription, SalesInvoice } from '../api/pharmacy-types';
import { SalesInvoiceDetailPage } from '../billing/BillingPages';
import { visibleNav } from '../layout/nav';
import { PrescriptionDetailPage } from './PharmacyPages';
import { AlertLine, ageText } from './ui';

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

const wrap = (ui: ReactNode, url: string, path: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={path} element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

afterEach(() => apiMock.api.mockReset());

const P = Permissions;
const blocking: ClinicalAlert = {
  id: 'a1', type: 'INTERACTION', severity: 'CONTRAINDICATED', message: 'Drug A + Drug B: serious', management: 'Avoid', lineIds: ['l1', 'l2'], blocking: true, override: null, createdAt: '2026-10-20T08:00:00Z',
};
const rx = (over: Partial<Prescription> = {}): Prescription => ({
  id: 'rx1', number: 'RX/OPD-PH/2026/000001', status: 'RECEIVED', patientId: 'p1', storeId: 's1', prescriber: 'Dr. Test', prescriberRegNo: null, encounterRef: null,
  receivedAt: '2026-10-20T08:00:00Z', verifiedAt: null, firstDispensedAt: null, completedAt: null, notes: null,
  patient: { id: 'p1', hospitalNo: 'H1', name: 'Jane Patient', dateOfBirth: '1990-01-01', sex: 'F', weightKg: 60, isPregnant: true, payerId: null, memberNo: null, allergies: ['penicillins'], phone: null, kraPin: null },
  lines: [{ id: 'l1', lineNo: 1, genericId: 'g1', preferredItemId: null, dose: '1', frequency: 'OD', duration: null, route: null, quantity: 10, dispensedQty: 0, cancelledQty: 0, instructions: null }],
  alerts: [blocking, { ...blocking, id: 'a2', severity: 'MODERATE', blocking: false, message: 'Mild one' }],
  dispenses: [],
  invoices: [],
  ...over,
});

describe('pharmacy and billing navigation', () => {
  const labels = (held: PermissionCode[]) => visibleNav((...p) => p.every((x) => held.includes(x))).map((i) => i.label);

  it('shows the worklist and patients to pharmacy staff, sales to cashiers and the eTIMS console to finance', () => {
    expect(labels([P.PHARMACY_READ, P.PATIENTS_READ])).toEqual(expect.arrayContaining(['Pharmacy worklist', 'Patients', 'Drug interactions']));
    const cashier = labels([P.BILLING_INVOICE, P.BILLING_READ]);
    expect(cashier).toContain('Sales & receipts');
    expect(cashier).not.toContain('KRA eTIMS');
    expect(cashier).not.toContain('Pharmacy worklist');
    expect(labels([P.ETIMS_READ, P.BILLING_READ])).toEqual(expect.arrayContaining(['KRA eTIMS', 'Tax & eTIMS reports']));
  });
});

describe('clinical alerts', () => {
  it('shows severity, advice and the override reason', () => {
    render(<AlertLine alert={{ ...blocking, override: { id: 'o1', reason: 'Prescriber confirmed', pharmacistId: 'u1', at: '2026-10-20T09:00:00Z' } }} />);
    expect(screen.getByText(/Contraindicated · Interaction/)).toBeInTheDocument();
    expect(screen.getByText(/Advice: Avoid/)).toBeInTheDocument();
    expect(screen.getByText(/Prescriber confirmed/)).toBeInTheDocument();
  });

  it('formats ages for adults and infants', () => {
    expect(ageText(null)).toBe('age unknown');
    expect(ageText(new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10))).toMatch(/^1[23] months$/);
  });

  it('blocks verification until the blocking alert is overridden; only pharmacists may override', async () => {
    auth.permissions = [P.PHARMACY_READ, P.PHARMACY_VERIFY, P.PHARMACY_DISPENSE];
    apiMock.api.mockResolvedValue(rx());
    const { unmount } = render(wrap(<PrescriptionDetailPage />, '/pharmacy/prescriptions/rx1', '/pharmacy/prescriptions/:id'));
    expect(await screen.findByText(/1 blocking alert/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Override' })).toHaveLength(1); // not on the moderate one
    expect(screen.getByText(/PREGNANT/)).toBeInTheDocument();
    expect(screen.getByText(/penicillins/)).toBeInTheDocument();
    unmount();

    auth.permissions = [P.PHARMACY_READ, P.PHARMACY_DISPENSE];
    render(wrap(<PrescriptionDetailPage />, '/pharmacy/prescriptions/rx1', '/pharmacy/prescriptions/:id'));
    expect(await screen.findByText(/1 blocking alert/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });

  it('offers dispensing once verified', async () => {
    auth.permissions = [P.PHARMACY_READ, P.PHARMACY_DISPENSE];
    apiMock.api.mockResolvedValue(rx({ status: 'VERIFIED', alerts: [{ ...blocking, override: { id: 'o', reason: 'ok reason', pharmacistId: 'u', at: '2026-10-20T09:00:00Z' } }] }));
    render(wrap(<PrescriptionDetailPage />, '/pharmacy/prescriptions/rx1', '/pharmacy/prescriptions/:id'));
    expect(await screen.findByRole('button', { name: 'Dispense' })).toBeEnabled();
  });
});

describe('sales invoice', () => {
  const inv = (over: Partial<SalesInvoice>): SalesInvoice => ({
    id: 'i1', number: 'SI/OPD-PH/2026/000001', docType: 'INVOICE', originalInvoiceId: null, status: 'ISSUED', source: 'OTC', storeId: 's1', patientId: null, customerName: null, customerPin: null,
    issuedAt: '2026-10-20T08:00:00Z', taxSummary: { B: { taxable: 116, tax: 16, rate: 16 } }, totalNet: 100, totalTax: 16, totalAmount: 116, discountAmount: 0, payerAmount: 0, patientAmount: 116, paidAmount: 116,
    etimsStatus: 'ACCEPTED', cuInvoiceNo: 'KRACU0000000001/7', rcptSign: 'ABCDEFGHIJKLMNOP', etimsError: null, notes: null,
    lines: [{ id: 'l1', lineNo: 1, itemId: 'x', description: 'Gauze', quantity: 1, unitPrice: 116, discountAmount: 0, taxTypeCode: 'B', taxRatePercent: 16, grossAmount: 116, taxAmount: 16, payerShare: 0, patientShare: 116, sourceLineId: null }],
    payments: [{ id: 'p1', modeCode: 'CASH', amount: 116, reference: null }],
    creditNotes: [],
    ...over,
  });

  it('a signed invoice shows its CU number and can be reprinted as COPY', async () => {
    auth.permissions = [P.BILLING_READ, P.BILLING_MANAGE];
    apiMock.api.mockResolvedValue(inv({}));
    render(wrap(<SalesInvoiceDetailPage />, '/sales/i1', '/sales/:id'));
    expect(await screen.findByText('KRACU0000000001/7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reprint \(COPY\)/ })).toHaveAttribute('href', expect.stringContaining('copy=true'));
    expect(screen.getByRole('button', { name: 'Credit note' })).toBeInTheDocument();
  });

  it('a pending invoice warns that the receipt is not official yet', async () => {
    auth.permissions = [P.BILLING_READ];
    apiMock.api.mockResolvedValue(inv({ etimsStatus: 'PENDING', cuInvoiceNo: null, rcptSign: null }));
    render(wrap(<SalesInvoiceDetailPage />, '/sales/i1', '/sales/:id'));
    expect(await screen.findByText(/receipt prints as “not an official receipt”/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /COPY/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Credit note' })).not.toBeInTheDocument();
  });
});

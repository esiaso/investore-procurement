import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import type { EncounterDetail, HmisDashboard, WardSupplyList } from '../api/hmis-types';
import type { Prescription } from '../api/pharmacy-types';
import { visibleNav } from '../layout/nav';
import { PrescriptionDetailPage } from '../pharmacy/PharmacyPages';
import { EncounterDetailPage, HmisConsolePage, WardSupplyPage } from './HmisPages';

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

/** Answers by path (first matching prefix wins). */
const route = (table: [string, unknown][]) =>
  apiMock.api.mockImplementation(async (path: string) => {
    const hit = table.find(([p]) => path.startsWith(p));
    if (!hit) throw new Error(`unexpected ${path}`);
    return hit[1];
  });

afterEach(() => apiMock.api.mockReset());
const P = Permissions;

describe('HMIS navigation', () => {
  const labels = (held: PermissionCode[]) => visibleNav((...p) => p.every((x) => held.includes(x))).map((i) => i.label);
  it('shows the integration console to HMIS readers, ward supply to pharmacy and encounters to ward staff', () => {
    expect(labels([P.HMIS_READ])).toEqual(expect.arrayContaining(['HMIS integration', 'Encounters']));
    expect(labels([P.PHARMACY_READ])).toEqual(expect.arrayContaining(['Ward supply', 'Pharmacy worklist']));
    const ward = labels([P.PATIENTS_READ, P.PATIENTS_CHARGE, P.INVENTORY_REQUISITION]);
    expect(ward).toContain('Encounters');
    expect(ward).not.toContain('HMIS integration');
    expect(labels([P.INVENTORY_READ])).not.toContain('Encounters');
  });
});

describe('HMIS console', () => {
  const dash: HmisDashboard = {
    connection: { id: 'c1', code: 'HMIS', name: 'Mock HMIS', adapter: 'MOCK', baseUrl: null, authHeader: 'Authorization', hasToken: false, hospitalNoSystem: 'urn:sil:hospital-no', billingMode: 'HMIS', sendDispenses: true, pollOrders: true, lastPolledAt: '2026-10-26T08:00:00Z', lastPollError: null, isActive: true },
    counts: [{ direction: 'IN', status: 'PROCESSED', n: 12 }, { direction: 'OUT', status: 'SENT', n: 30 }, { direction: 'IN', status: 'FAILED', n: 1 }],
    failed: [{ id: 'm1', direction: 'IN', type: 'MEDICATION_REQUEST', status: 'FAILED', externalId: 'mr-9', localDocNo: null, error: 'Unmapped drug code MOH-X (Drug X)', attempts: 1, createdAt: '2026-10-26T08:00:00Z' }],
    pending: { count: 2, oldestAt: '2026-10-26T07:00:00Z' },
    last24h: [{ direction: 'IN', type: 'MEDICATION_REQUEST', n: 4, duplicates: 2 }],
    unmappedDrugs: [{ code: 'MOH-X', display: 'Drug X', messages: 1 }],
  };

  it('shows health, the queue, failures and unmapped codes; actions only for managers', async () => {
    auth.permissions = [P.HMIS_READ];
    route([['/hmis/dashboard', dash]]);
    const { unmount } = render(wrap(<HmisConsolePage />, '/hmis', '/hmis'));
    expect(await screen.findByText(/Mock — not a real HMIS/)).toBeInTheDocument();
    expect(screen.getByText(/charges posted to the HMIS bill/)).toBeInTheDocument();
    expect(screen.getByText('Unmapped drug code MOH-X (Drug X)')).toBeInTheDocument();
    expect(screen.getByText(/\+2 repeats ignored/)).toBeInTheDocument();
    expect(screen.getByText('Waiting / retrying').previousSibling).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reprocess' })).not.toBeInTheDocument();
    unmount();

    auth.permissions = [P.HMIS_READ, P.HMIS_MANAGE];
    render(wrap(<HmisConsolePage />, '/hmis', '/hmis'));
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprocess' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
  });

  it('asks for a connection when none exists', async () => {
    auth.permissions = [P.HMIS_READ];
    route([['/hmis/dashboard', { ...dash, connection: null }]]);
    render(wrap(<HmisConsolePage />, '/hmis', '/hmis'));
    expect(await screen.findByText(/No HMIS is linked yet/)).toBeInTheDocument();
  });
});

describe('ward supply', () => {
  const list: WardSupplyList = {
    date: '2026-10-26',
    patients: [
      {
        patientId: 'p1', patient: 'Ochieng Otieno', hospitalNo: 'SIL-000102', ward: 'Medical Ward', bed: 'M-04',
        lines: [
          { prescriptionId: 'rx1', prescriptionNo: 'RX/1', status: 'VERIFIED', supplyMode: 'DAILY', prescriptionLineId: 'l1', lineNo: 1, genericId: 'g1', generic: 'Paracetamol 500 mg', dose: '2 tab', frequency: 'QID', route: null, dailyQuantity: 8, givenToday: 0, remaining: 40, due: 8, needsVerification: false },
          { prescriptionId: 'rx2', prescriptionNo: 'RX/2', status: 'RECEIVED', supplyMode: 'DAILY', prescriptionLineId: 'l2', lineNo: 1, genericId: 'g2', generic: 'Amlodipine 5 mg', dose: '1 tab', frequency: 'OD', route: null, dailyQuantity: 1, givenToday: 0, remaining: 5, due: 1, needsVerification: true },
        ],
      },
    ],
  };

  it('lists what is due per patient, preselects an in-stock brand and sends unverified lines to verification', async () => {
    auth.permissions = [P.PHARMACY_READ, P.PHARMACY_DISPENSE];
    route([
      ['/stores', { items: [{ id: 's1', name: 'IPD Pharmacy', type: 'SATELLITE_PHARMACY' }], total: 1 }],
      ['/departments', { items: [], total: 0 }],
      ['/pharmacy/ward-supply', list],
      ['/pharmacy/prescriptions/rx1/options', [{ prescriptionLineId: 'l1', genericId: 'g1', remaining: 40, preferredItemId: null, brands: [{ itemId: 'i1', code: 'I1', name: 'Panadol 500', brandName: 'Panadol', available: 100, earliestExpiry: '2027-01-01', preferred: false }] }]],
    ]);
    render(wrap(<WardSupplyPage />, '/pharmacy/ward-supply', '/pharmacy/ward-supply'));
    fireEvent.mouseDown(screen.getByLabelText('Inpatient pharmacy'));
    fireEvent.click(await screen.findByRole('option', { name: 'IPD Pharmacy' }));
    expect(await screen.findByText(/Ochieng Otieno · SIL-000102 · Medical Ward · bed M-04/)).toBeInTheDocument();
    const para = screen.getByText('Paracetamol 500 mg').closest('tr')!;
    expect(within(para).getByText('8', { selector: 'strong' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Dispense 1 line(s)' })).toBeEnabled();
    const amlo = screen.getByText('Amlodipine 5 mg').closest('tr')!;
    expect(within(amlo).getByRole('button', { name: 'Verify first' })).toBeInTheDocument();
  });
});

describe('HMIS billing on the prescription and encounter screens', () => {
  const rx: Prescription = {
    id: 'rx1', number: 'RX/OPD-PH/2026/000009', status: 'VERIFIED', patientId: 'p1', storeId: 's1', prescriber: 'Dr. HMIS', prescriberRegNo: null, encounterRef: 'enc-1',
    encounterId: 'e1', encounter: { id: 'e1', externalId: 'enc-1', class: 'OPD', status: 'ACTIVE', bed: null, department: null },
    billingMode: 'HMIS', supplyMode: 'STANDARD',
    receivedAt: '2026-10-26T08:00:00Z', verifiedAt: '2026-10-26T08:05:00Z', firstDispensedAt: null, completedAt: null, notes: 'Received from the HMIS',
    patient: { id: 'p1', hospitalNo: 'SIL-1', name: 'Hmis Patient', dateOfBirth: '1980-01-01', sex: 'M', weightKg: null, isPregnant: false, payerId: null, memberNo: null, allergies: [], phone: null, kraPin: null, externalId: 'pt-1' },
    lines: [{ id: 'l1', lineNo: 1, genericId: 'g1', preferredItemId: null, dose: '1 tab', frequency: 'BD', duration: null, route: null, quantity: 10, dispensedQty: 0, cancelledQty: 0, instructions: null }],
    alerts: [], dispenses: [], invoices: [],
    charges: [{ id: 'c1', sourceId: 'd0', description: 'Earlier item', quantity: 2, amount: 20, status: 'POSTED', externalId: 'ci-1', reversesId: null }],
    hmisMessages: [{ id: 'm1', type: 'MEDICATION_DISPENSE', status: 'PENDING', localDocNo: 'DSP/1', externalId: null, attempts: 2, error: 'Network error: connection refused', createdAt: '2026-10-26T08:00:00Z', processedAt: null }],
  };

  it('links the encounter, shows charges and HMIS records, and takes no payment when the HMIS bills', async () => {
    auth.permissions = [P.PHARMACY_READ, P.PHARMACY_DISPENSE];
    route([
      ['/pharmacy/prescriptions/rx1/options', [{ prescriptionLineId: 'l1', genericId: 'g1', remaining: 10, preferredItemId: null, brands: [{ itemId: 'i1', code: 'I1', name: 'Brand', brandName: 'B', available: 50, earliestExpiry: null, preferred: false }] }]],
      ['/pharmacy/prescriptions/rx1', rx],
      ['/billing/payment-modes', []],
    ]);
    render(wrap(<PrescriptionDetailPage />, '/pharmacy/prescriptions/rx1', '/pharmacy/prescriptions/:id'));
    expect(await screen.findByRole('link', { name: 'enc-1' })).toHaveAttribute('href', '/encounters/e1');
    expect(screen.getByText('Charged to the HMIS bill')).toBeInTheDocument();
    expect(screen.getByText('HMIS patient')).toBeInTheDocument();
    expect(screen.getByText('Network error: connection refused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }));
    expect(await screen.findByText(/charge goes to the patient’s HMIS bill/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount tendered')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dispense and charge' })).toBeInTheDocument();
  });

  it('the encounter lists charges with their HMIS status; reversal only for HMIS-posted charges', async () => {
    auth.permissions = [P.HMIS_READ, P.PATIENTS_CHARGE];
    const enc: EncounterDetail = {
      id: 'e1', externalId: 'enc-102', patientId: 'p1', class: 'IPD', status: 'ACTIVE', departmentId: 'd1', department: { id: 'd1', code: 'IPD-MED', name: 'Medical Ward' }, wardCode: 'HMIS-MED', bed: 'M-04',
      payerId: null, payer: null, memberNo: null, attending: 'Dr. A', startedAt: '2026-10-24T08:00:00Z', endedAt: null, syncedAt: '2026-10-26T08:00:00Z',
      patient: { id: 'p1', hospitalNo: 'SIL-000102', name: 'Ochieng Otieno', dateOfBirth: null, sex: 'M', weightKg: null, isPregnant: false, payerId: null, memberNo: null, allergies: [], phone: null, kraPin: null },
      prescriptions: [{ id: 'rx1', number: 'RX/IPD/1', status: 'PARTIALLY_DISPENSED', supplyMode: 'DAILY', receivedAt: '2026-10-25T08:00:00Z', store: 'IPD Pharmacy' }],
      charges: [
        { id: 'c1', patientId: 'p1', encounterId: 'e1', source: 'DISPENSE', sourceId: 'd1', sourceNo: 'DSP/1', storeId: 's1', description: 'Panadol', quantity: 8, unitPrice: 5, amount: 40, status: 'POSTED', invoiceId: null, externalId: 'ci-7', reversesId: null, note: null, createdAt: '2026-10-26T08:00:00Z' },
        { id: 'c2', patientId: 'p1', encounterId: 'e1', source: 'ISSUE', sourceId: 'iv1', sourceNo: 'ISS/1', storeId: 's2', description: 'Cannula', quantity: 1, unitPrice: 50, amount: 50, status: 'INVOICED', invoiceId: 'inv1', externalId: null, reversesId: null, note: null, createdAt: '2026-10-26T09:00:00Z' },
      ],
      totals: { charged: 90, pendingToHmis: 0 },
    };
    route([['/hmis/encounters/e1', enc]]);
    render(wrap(<EncounterDetailPage />, '/encounters/e1', '/encounters/:id'));
    expect(await screen.findByText('ci-7')).toBeInTheDocument();
    expect(screen.getByText('Medical Ward · M-04')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'invoice' })).toHaveAttribute('href', '/sales/inv1');
    expect(screen.getAllByRole('button', { name: 'Reverse' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Charge ward consumables' })).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Comparison, MatchView, PurchaseOrder, Rfq, SupplierEvaluation } from '../api/purchasing-types';
import { ApprovalPanel, DocumentChain } from './common';
import { ThreeWayMatch } from './InvoicePages';
import { orderKind } from './PoPages';
import { ComparativeSheet, EvaluationSummary } from './RfqPages';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

afterEach(() => apiMock.api.mockReset());

describe('DocumentChain', () => {
  it('lists linked documents in process order with links to the others', async () => {
    apiMock.api.mockResolvedValue({
      nodes: [
        { key: 'INV:3', type: 'INV', id: '3', no: 'INV/2026/00001', status: 'APPROVED · MATCHED', amount: 1350 },
        { key: 'PR:1', type: 'PR', id: '1', no: 'PR/MS/2026/00001', status: 'CLOSED' },
        { key: 'PO:2', type: 'PO', id: '2', no: 'PO/2026/00001', status: 'RECEIVED', amount: 1350 },
      ],
      edges: [],
    });
    render(wrap(<DocumentChain type="PO" id="2" />));
    const panel = await screen.findByLabelText('Document chain');
    await waitFor(() => expect(within(panel).getByText('PR/MS/2026/00001')).toBeInTheDocument());
    const text = panel.textContent!;
    expect(text.indexOf('PR/MS/2026/00001')).toBeLessThan(text.indexOf('PO/2026/00001'));
    expect(text.indexOf('PO/2026/00001')).toBeLessThan(text.indexOf('INV/2026/00001'));
    expect(within(panel).getByRole('link', { name: 'PR/MS/2026/00001' })).toHaveAttribute('href', '/requisitions/1');
    expect(within(panel).queryByRole('link', { name: 'PO/2026/00001' })).toBeNull(); // current document
  });
});

describe('ApprovalPanel', () => {
  const history = [
    {
      id: 'r1',
      status: 'PENDING',
      currentStep: 2,
      amount: 600000,
      createdAt: '2026-10-19T08:00:00Z',
      workflow: { name: 'Purchase orders 500,000 to 5,000,000', steps: [{ sequence: 1, name: 'Procurement approval', approverType: 'ROLE', role: { name: 'Procurement Manager' } }, { sequence: 2, name: 'Finance approval', approverType: 'ROLE', role: { name: 'Finance' } }] },
      actions: [
        { id: 'a1', stepSequence: 0, stepName: 'Submitted', action: 'SUBMIT', userName: 'Achieng', onBehalfOfName: null, comment: null, at: '2026-10-19T08:00:00Z' },
        { id: 'a2', stepSequence: 1, stepName: 'Procurement approval', action: 'APPROVE', userName: 'Kamau', onBehalfOfName: null, comment: null, at: '2026-10-19T09:00:00Z' },
      ],
    },
  ];

  it('shows decision buttons only to the current approver, and needs a comment to reject', async () => {
    apiMock.api.mockImplementation(async (path: string) =>
      path === '/approvals/history' ? history : [{ id: 'r1', documentId: 'po1', documentType: 'PO', stepName: 'Finance approval' }],
    );
    render(wrap(<ApprovalPanel type="PO" id="po1" />));
    expect(await screen.findByText(/Awaiting your decision/)).toBeInTheDocument();
    expect(screen.getByText('Finance approval')).toBeInTheDocument();
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Comment/), 'Price too high');
    expect(reject).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('shows no buttons to someone not on the current step', async () => {
    apiMock.api.mockImplementation(async (path: string) => (path === '/approvals/history' ? history : []));
    render(wrap(<ApprovalPanel type="PO" id="po1" />));
    expect(await screen.findByText('Purchase orders 500,000 to 5,000,000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

const evaluation = (e: Partial<SupplierEvaluation> & Pick<SupplierEvaluation, 'supplierId' | 'supplierName' | 'total'>): SupplierEvaluation => ({
  quotationId: `q-${e.supplierId}`,
  compliant: true,
  complianceNotes: null,
  deliveryDays: 5,
  paymentTermsDays: null,
  currency: null,
  quotedTotal: e.total,
  linesQuoted: 1,
  lowestOnLines: 0,
  scores: [],
  technicalScore: null,
  financialScore: null,
  combinedScore: null,
  passes: true,
  rank: null,
  recommended: false,
  ...e,
});

describe('ComparativeSheet', () => {
  const rfq = { id: 'rfq1', number: 'RFQ/2026/0001', status: 'EVALUATION', supplierIds: ['s1', 's2'], awardJustification: null, technicalWeight: 0, passMark: 70, committeeUserIds: [], recommendedSupplierId: null } as unknown as Rfq;
  const comparison: Comparison = {
    rfq,
    lines: [
      {
        rfqLineId: 'l1',
        itemId: 'i1',
        itemName: 'Gloves M',
        quantity: 100,
        awardedQuotationLineId: null,
        quotes: [
          { quotationLineId: 'q2', supplierId: 's2', supplierName: 'Baraka', unitPrice: 8, quotedUnitPrice: 8, currency: null, lineTotal: 800, deliveryDays: 3, compliant: true, offeredBrand: null, rank: 1, lowestCompliant: true },
          { quotationLineId: 'q1', supplierId: 's1', supplierName: 'Amani', unitPrice: 9, quotedUnitPrice: 9, currency: null, lineTotal: 900, deliveryDays: 5, compliant: true, offeredBrand: null, rank: 2, lowestCompliant: false },
        ],
      },
    ],
    suppliers: [
      evaluation({ supplierId: 's1', supplierName: 'Amani', total: 900 }),
      evaluation({ supplierId: 's2', supplierName: 'Baraka', deliveryDays: 3, total: 800, lowestOnLines: 1 }),
    ],
  };

  it('pre-selects the lowest compliant quote and requires justification to deviate', async () => {
    render(wrap(<ComparativeSheet rfq={rfq} comparison={comparison} canAward />));
    expect(screen.getByLabelText('Award Gloves M to Baraka')).toBeChecked();
    const awardBtn = screen.getByRole('button', { name: /Award and create/ });
    expect(awardBtn).toBeEnabled();
    expect(screen.getByText('Lowest')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Award Gloves M to Amani'));
    expect(screen.getByText(/justification is required/)).toBeInTheDocument();
    expect(awardBtn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Award justification/), 'Faster delivery needed');
    expect(awardBtn).toBeEnabled();
  });

  it('with a technical weight, awards only after the evaluation and pre-selects the recommended supplier', async () => {
    const weighted = { ...rfq, status: 'CLOSED', technicalWeight: 40 } as Rfq;
    const { unmount } = render(wrap(<ComparativeSheet rfq={weighted} comparison={comparison} canAward />));
    expect(screen.getByText(/Complete the technical evaluation before awarding/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Award and create/ })).toBeNull();
    unmount();

    render(wrap(<ComparativeSheet rfq={{ ...weighted, status: 'EVALUATED', recommendedSupplierId: 's1' } as Rfq} comparison={comparison} canAward />));
    expect(screen.getByLabelText('Award Gloves M to Amani')).toBeChecked();
    expect(screen.getByText(/justification is required/)).toBeInTheDocument(); // Amani is not the lowest price
  });

  it('shows non-stock lines with their type, the quoted currency price and a delivery address field', () => {
    const usd: Comparison = {
      ...comparison,
      lines: [{ ...comparison.lines[0], itemId: null, itemName: 'Service the autoclave', lineType: 'SERVICE', uom: 'JOB', quantity: 1, quotes: [{ ...comparison.lines[0].quotes[0], currency: 'USD', quotedUnitPrice: 300, unitPrice: 39000, lineTotal: 39000 }] }],
    };
    render(wrap(<ComparativeSheet rfq={rfq} comparison={usd} canAward />));
    expect(screen.getByText('Service')).toBeInTheDocument();
    expect(screen.getByText(/300\.00/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Delivery address/)).toBeInTheDocument();
  });
});

describe('EvaluationSummary', () => {
  it('shows each member\'s score, the combined score and who falls below the pass mark', () => {
    const rfq = { id: 'r', technicalWeight: 40, passMark: 70, recommendation: 'Baraka is technically sound' } as unknown as Rfq;
    const suppliers = [
      evaluation({ supplierId: 's1', supplierName: 'Amani', total: 76000, technicalScore: 60, financialScore: 100, combinedScore: 84, passes: false, scores: [{ memberId: 'u1', technicalScore: 60, comment: 'No service history' }] }),
      evaluation({ supplierId: 's2', supplierName: 'Baraka', total: 80600, currency: 'USD', quotedTotal: 620, technicalScore: 85, financialScore: 94.29, combinedScore: 90.57, rank: 1, recommended: true }),
    ];
    render(wrap(<EvaluationSummary rfq={rfq} suppliers={suppliers} users={[{ id: 'u1', username: 'finance', fullName: 'Fatuma Finance' }]} />));
    const table = screen.getByRole('table', { name: 'Evaluation' });
    expect(within(table).getByText('Below pass mark')).toBeInTheDocument();
    expect(within(table).getByText('Recommended')).toBeInTheDocument();
    expect(within(table).getByText(/Fatuma Finance: 60 \(No service history\)/)).toBeInTheDocument();
    expect(within(table).getByText('90.57')).toBeInTheDocument();
    expect(screen.getByText(/Committee recommendation: Baraka/)).toBeInTheDocument();
  });
});

describe('orderKind', () => {
  const po = (types: string[]) => ({ lines: types.map((lineType) => ({ lineType })) }) as unknown as PurchaseOrder;
  it('names non-stock orders LPO / LSO', () => {
    expect(orderKind(po(['STOCK', 'SERVICE']))).toBe('Purchase order');
    expect(orderKind(po(['SERVICE']))).toBe('Local service order');
    expect(orderKind(po(['SERVICE', 'NON_STOCK_GOODS']))).toBe('Local purchase order');
  });
});

describe('ThreeWayMatch', () => {
  it('highlights lines with variances', () => {
    const view = {
      invoice: { matchStatus: 'VARIANCE', variances: [{ poLineId: 'p1', code: 'PRICE_VARIANCE', message: 'Line 1 Gloves: invoice price 470 vs PO 450 (+4.44%)' }] },
      lines: [
        { poLineId: 'p1', lineNo: 1, item: 'Gloves', uom: 'BOX', orderedQty: 3, poUnitPrice: 450, receivedQty: 3, invoicedToDate: 3, thisInvoiceQty: 3, thisInvoicePrice: 470, variances: [{ code: 'PRICE_VARIANCE', message: '' }] },
        { poLineId: 'p2', lineNo: 2, item: 'Masks', uom: 'PCS', orderedQty: 10, poUnitPrice: 5, receivedQty: 10, invoicedToDate: 10, thisInvoiceQty: 10, thisInvoicePrice: 5, variances: [] },
      ],
    } as unknown as MatchView;
    render(wrap(<ThreeWayMatch view={view} />));
    expect(screen.getAllByText('Variance')).toHaveLength(2); // header + match status chip
    expect(screen.getByText('Price Variance')).toBeInTheDocument();
    expect(screen.getByText(/\+4.44%/)).toBeInTheDocument();
  });
});

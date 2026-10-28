import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReportDef, ReportResult } from '../api/report-types';
import { ReportChart } from './ReportChart';
import { ResultTable } from './ReportsPage';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', permissions: [] }, can: () => true, canAny: () => true }),
}));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const result = (over: Partial<ReportResult>): ReportResult => ({ key: 'k', title: 't', criteria: [], generatedAt: '', columns: [], rows: [], ...over });

describe('Report drill-down and charts', () => {
  it('document numbers link to the document (fixed type, or a type taken from the row)', () => {
    const r = result({
      columns: [
        { key: 'number', label: 'Order', type: 'text', link: { docType: 'PO', idKey: '_id' } },
        { key: 'document', label: 'Document', type: 'text', link: { docType: '@_docType', idKey: '_docId' } },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
      rows: [
        { _id: 'po1', number: 'PO/2026/00001', _docType: 'PCV', _docId: 'pc1', document: 'PCV-2026-00001', amount: 100 },
        { _id: null, number: 'PO/2026/00002', _docType: 'XYZ', _docId: 'x', document: 'Unknown', amount: 5 },
      ],
    });
    render(wrap(<ResultTable r={r} />));
    expect(screen.getByRole('link', { name: 'PO/2026/00001' })).toHaveAttribute('href', '/purchase-orders/po1');
    expect(screen.getByRole('link', { name: 'PCV-2026-00001' })).toHaveAttribute('href', '/petty-cash/pc1');
    // No id, or a type with no page: plain text.
    expect(screen.queryByRole('link', { name: 'PO/2026/00002' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Unknown' })).toBeNull();
    // Hidden drill-down keys are not columns.
    expect(screen.queryByText('pc1')).toBeNull();
  });

  it('draws the trend of a report, summing rows per period', () => {
    const def = { key: 'purchases-over-time', chart: { type: 'line', x: 'period', series: ['value'] } } as unknown as ReportDef;
    const r = result({
      columns: [{ key: 'period', label: 'Period', type: 'text' }, { key: 'value', label: 'Value', type: 'money' }],
      rows: [
        { period: '2026-08', value: 1_000 },
        { period: '2026-09', value: 2_000 },
        { period: '2026-09', value: 500 },
        { period: '2026-10', value: 4_000 },
      ],
    });
    render(wrap(<ReportChart def={def} r={r} />));
    const chart = screen.getByRole('img', { name: 'Value chart' });
    expect(within(chart).getByText('2.5k')).toBeInTheDocument(); // September summed
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    expect(chart.querySelector('polyline')).not.toBeNull();
  });
});

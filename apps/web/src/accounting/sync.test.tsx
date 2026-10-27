import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncChip } from './SyncChip';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));

const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;

afterEach(() => apiMock.api.mockReset());

describe('SyncChip', () => {
  it('shows the QuickBooks status of a document and, on hover, what failed', async () => {
    apiMock.api.mockResolvedValue([{ localDocId: 'r1', status: 'FAILED', postings: [{ docType: 'PURCHASE', status: 'BLOCKED', externalId: null, error: 'Map: QuickBooks account for GL 5300' }] }]);
    render(wrap(<SyncChip id="r1" />));
    const chip = await screen.findByText('QuickBooks: failed');
    expect(apiMock.api).toHaveBeenCalledWith('/accounting/sync-status', { query: { ids: 'r1' } });
    fireEvent.mouseOver(chip);
    expect(await screen.findByText(/QuickBooks account for GL 5300/)).toBeInTheDocument();
  });

  it('synced documents show their QuickBooks id', async () => {
    apiMock.api.mockResolvedValue([{ localDocId: 'v1', status: 'SYNCED', postings: [{ docType: 'BILL_PAYMENT', status: 'POSTED', externalId: '1042', error: null }, { docType: 'VENDOR_CREDIT', status: 'POSTED', externalId: '1041', error: null }] }]);
    render(wrap(<SyncChip id="v1" />));
    fireEvent.mouseOver(await screen.findByText('QuickBooks: synced'));
    expect(await screen.findByText(/bill payment: posted \(#1042\)/)).toBeInTheDocument();
  });
});

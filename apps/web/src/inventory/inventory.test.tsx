import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StockTakeStatus, StockTakeType } from '@sil/shared';
import type { StockTake } from '../api/inventory-types';
import { daysUntil, ExpiryChip, ItemPicker, StatusChip } from './components';
import { CountSheet } from './StockTakesPage';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));

const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
const isoInDays = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86_400_000));

afterEach(() => apiMock.api.mockReset());

describe('ExpiryChip', () => {
  it('flags expired stock', () => {
    render(<ExpiryChip date={isoInDays(-3)} />);
    expect(screen.getByText(/expired/)).toBeInTheDocument();
  });

  it('colours by the configured warning buckets', () => {
    const { container, rerender } = render(<ExpiryChip date={isoInDays(10)} />);
    expect(container.querySelector('.MuiChip-colorError')).not.toBeNull();
    rerender(<ExpiryChip date={isoInDays(45)} />);
    expect(container.querySelector('.MuiChip-colorWarning')).not.toBeNull();
    rerender(<ExpiryChip date={isoInDays(150)} />);
    expect(container.querySelector('.MuiChip-colorInfo')).not.toBeNull();
    rerender(<ExpiryChip date={isoInDays(400)} />);
    expect(screen.queryByText(/\dd$/)).toBeNull();
  });

  it('says when there is no expiry', () => {
    render(<ExpiryChip date={null} />);
    expect(screen.getByText('No expiry')).toBeInTheDocument();
  });

  it('counts days in the business timezone', () => {
    expect(daysUntil(isoInDays(7), 'Africa/Nairobi')).toBe(7);
  });
});

describe('ItemPicker barcode scanning', () => {
  it('selects the exact GTIN match when a scanner types the code and presses Enter', async () => {
    const amoxil = { id: 'i1', code: 'ITM000023', name: 'Amoxil 500 mg Capsule', gtin: '2000000000237', barcode: null };
    apiMock.api.mockResolvedValue({ items: [{ ...amoxil, id: 'other', gtin: '2000000000999' }, amoxil], total: 2 });
    const onChange = vi.fn();
    render(wrap(<ItemPicker value={null} onChange={onChange} />));
    await userEvent.type(screen.getByLabelText(/item/i), '2000000000237{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(amoxil));
  });

  it('reports an unknown barcode', async () => {
    apiMock.api.mockResolvedValue({ items: [], total: 0 });
    render(wrap(<ItemPicker value={null} onChange={vi.fn()} />));
    await userEvent.type(screen.getByLabelText(/item/i), '2999999999999{Enter}');
    expect(await screen.findByText(/No item with code or barcode 2999999999999/)).toBeInTheDocument();
  });
});

describe('CountSheet', () => {
  const st = (status: StockTakeStatus, blind: boolean): StockTake =>
    ({
      id: 's1',
      number: 'STK/MS/2026/0001',
      storeId: 'm',
      type: StockTakeType.CYCLE,
      blind,
      status,
      itemIds: [],
      notes: null,
      submittedBy: null,
      lines: [
        { id: 'l1', itemId: 'i', item: { name: 'Amoxil' }, batchId: 'b', batch: { batchNo: 'B1', expiryDate: null }, binId: null, systemQty: status === StockTakeStatus.COUNTING && blind ? null : 40, countedQty: 38, variance: status === StockTakeStatus.COUNTING && blind ? null : -2, varianceValue: -10, notes: null },
        { id: 'l2', itemId: 'i', item: { name: 'Amoxil' }, batchId: 'c', batch: { batchNo: 'B2', expiryDate: null }, binId: null, systemQty: 5, countedQty: null, variance: null, varianceValue: null, notes: null },
      ],
    }) as unknown as StockTake;

  it('hides system quantities during a blind count and moves to the next line on Enter', async () => {
    const setCounts = vi.fn();
    render(<CountSheet st={st(StockTakeStatus.COUNTING, true)} editable counts={{}} setCounts={setCounts} />);
    expect(screen.queryByText('System')).toBeNull();
    expect(screen.queryByText('Variance')).toBeNull();
    const first = screen.getByLabelText('Counted quantity for Amoxil B1');
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Counted quantity for Amoxil B2')).toHaveFocus();
  });

  it('shows variances during review', () => {
    render(<CountSheet st={st(StockTakeStatus.REVIEW, true)} editable={false} counts={{}} setCounts={() => {}} />);
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
  });
});

describe('StatusChip', () => {
  it('humanises document statuses', () => {
    render(<StatusChip status="RECEIVED_WITH_DISCREPANCY" />);
    expect(screen.getByText('Received With Discrepancy')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ControlledSchedule } from '@sil/shared';
import type { Generic, Item } from '../api/types';
import { formatDate, formatMoney } from '../lib/format';
import { BrandsPanel } from '../pages/GenericsPage';
import { PageHeader } from './PageHeader';

describe('PageHeader keyboard shortcuts', () => {
  it('"/" focuses search and Alt+N opens the New dialog', async () => {
    const onNew = vi.fn();
    render(<PageHeader title="Items" search="" onSearch={() => {}} onNew={onNew} />);
    const search = screen.getByRole('textbox', { name: 'Search' });
    expect(search).not.toHaveFocus();
    fireEvent.keyDown(window, { key: '/' });
    expect(search).toHaveFocus();
    fireEvent.keyDown(window, { key: 'n', altKey: true });
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('does not steal "/" while typing in a field', async () => {
    const onSearch = vi.fn();
    render(
      <>
        <input aria-label="other" />
        <PageHeader title="Items" search="" onSearch={onSearch} />
      </>,
    );
    const other = screen.getByLabelText('other');
    other.focus();
    await userEvent.keyboard('/');
    expect(other).toHaveFocus();
  });
});

describe('BrandsPanel', () => {
  const generic = {
    id: 'g1',
    innName: 'Amoxicillin',
    strength: '500 mg',
    dosageForm: 'Capsule',
    route: 'Oral',
    atcCode: 'J01CA04',
    isKeml: true,
    controlledSchedule: ControlledSchedule.NONE,
    items: [
      { id: 'i1', name: 'Amoxil 500 mg Capsule', brandName: 'Amoxil', manufacturer: 'GSK', packSize: '10x10', code: 'ITM000001', unitPrice: 22 },
      { id: 'i2', name: 'Amoxicillin Cosmos', brandName: 'Amoxicillin Cosmos', manufacturer: 'Cosmos Ltd', packSize: '10x10', code: 'ITM000002', unitPrice: 4 },
    ] as Item[],
  } as Generic;

  it('lists the brands mapped to a generic with prices', () => {
    render(<BrandsPanel generic={generic} />);
    expect(screen.getByText('Brands (2)')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Mapped brands' });
    expect(list).toHaveTextContent('Amoxil');
    expect(list).toHaveTextContent('Cosmos Ltd');
    // Intl puts a non-breaking space between symbol and amount.
    expect(list.textContent).toContain(formatMoney(22, 'KES'));
    expect(list.textContent).toContain(formatMoney(4, 'KES'));
    expect(screen.getByText('KEML')).toBeInTheDocument();
  });

  it('says when no brands are mapped', () => {
    render(<BrandsPanel generic={{ ...generic, items: [] }} />);
    expect(screen.getByText('No brands mapped yet.')).toBeInTheDocument();
  });
});

describe('formatting', () => {
  it('formats dates as DD/MM/YYYY in Africa/Nairobi', () => {
    // 21:30 UTC is 00:30 the next day in Nairobi (UTC+3).
    expect(formatDate('2026-01-31T21:30:00Z', 'DD/MM/YYYY', 'Africa/Nairobi')).toBe('01/02/2026');
    expect(formatDate('2026-01-31T21:30:00Z', 'DD/MM/YYYY', 'Africa/Nairobi', true)).toBe('01/02/2026 00:30');
    expect(formatDate(null, 'DD/MM/YYYY', 'Africa/Nairobi')).toBe('');
  });

  it('formats money in the configured currency', () => {
    expect(formatMoney(1250.5, 'KES')).toMatch(/1,250\.50/);
    expect(formatMoney(1250.5, 'KES')).toMatch(/Ksh|KES/);
  });
});

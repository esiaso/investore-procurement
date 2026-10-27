import { Alert, Autocomplete, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { KeyboardEvent, useState } from 'react';
import { BatchHoldStatus, Paginated } from '@sil/shared';
import { api } from '../api/client';
import { useAll } from '../api/hooks';
import type { Item, Store } from '../api/types';
import { useDebounced } from '../lib/useDebounced';
import { formatDate, humanise } from '../lib/format';
import { useSettings } from '../settings/SettingsContext';

/** Days from today (Nairobi business date) to an ISO date. */
export function daysUntil(date: string, timeZone: string): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Expiry date coloured by the configured warning buckets. */
export function ExpiryChip({ date }: { date: string | null | undefined }) {
  const { dateFormat, timezone, expiryWarningDays } = useSettings();
  if (!date) return <Typography variant="body2" color="text.secondary">No expiry</Typography>;
  const days = daysUntil(date, timezone);
  const buckets = [...expiryWarningDays].sort((a, b) => a - b);
  const label = formatDate(`${date}T12:00:00Z`, dateFormat, timezone);
  if (days <= 0) return <Chip size="small" color="error" label={`${label} · expired`} />;
  const bucket = buckets.find((b) => days <= b);
  if (bucket === undefined) return <Chip size="small" variant="outlined" label={label} />;
  const color = bucket === buckets[0] ? 'error' : bucket === buckets[1] ? 'warning' : 'info';
  return <Chip size="small" color={color} variant="outlined" label={`${label} · ${days}d`} />;
}

export function HoldChip({ status }: { status: BatchHoldStatus | undefined }) {
  if (!status || status === BatchHoldStatus.NONE) return null;
  return <Chip size="small" color="warning" label={humanise(status)} />;
}

const STATUS_COLOURS: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  DRAFT: 'default',
  SUBMITTED: 'info',
  PARTIALLY_APPROVED: 'warning',
  POSTED: 'success',
  REJECTED: 'error',
  REQUESTED: 'info',
  DISPATCHED: 'warning',
  RECEIVED: 'success',
  RECEIVED_WITH_DISCREPANCY: 'warning',
  CANCELLED: 'default',
  COUNTING: 'warning',
  REVIEW: 'info',
  PENDING_APPROVAL: 'info',
  PENDING: 'info',
  APPROVED: 'success',
  RETURNED: 'warning',
  PARTIALLY_ISSUED: 'warning',
  ISSUED: 'success',
  CLOSED: 'default',
  CREDITED: 'success',
  SUCCEEDED: 'success',
  FAILED: 'error',
  RUNNING: 'info',
  PARTLY_CONVERTED: 'warning',
  CONVERTED: 'success',
  OPEN: 'info',
  TO_STORE: 'success',
  ON_PR: 'success',
  DELIVERED: 'success',
  RFQ_ISSUED: 'info',
  PARTIALLY_FULFILLED: 'warning',
  LPO_RAISED: 'success',
  EVALUATED: 'success',
  EXPIRED: 'error',
  INVOICED: 'info',
  PAID: 'success',
};

export function StatusChip({ status }: { status: string }) {
  return <Chip size="small" color={STATUS_COLOURS[status] ?? 'default'} label={humanise(status)} />;
}

/** Stores the user can see (store scope applies server-side). */
export function useStores() {
  return useAll<Store>('/stores', { active: true });
}

export function StoreSelect({
  value,
  onChange,
  label = 'Store',
  allowAll,
  exclude,
  sx,
  stores,
}: {
  value: string;
  onChange(id: string): void;
  label?: string;
  allowAll?: string;
  exclude?: string;
  sx?: object;
  /** Override the list (e.g. every store as a transfer source). */
  stores?: Store[];
}) {
  const accessible = useStores();
  const list = (stores ?? accessible.data ?? []).filter((s) => s.id !== exclude);
  return (
    <TextField select label={label} value={value} onChange={(e) => onChange(e.target.value)} sx={sx}>
      {allowAll !== undefined && <MenuItem value="">{allowAll}</MenuItem>}
      {list.map((s) => (
        <MenuItem key={s.id} value={s.id}>
          {s.name}
        </MenuItem>
      ))}
    </TextField>
  );
}

/**
 * Item search that also works with a barcode scanner: scanners type the GTIN
 * and press Enter, which selects the exact GTIN/barcode/code match.
 */
export function ItemPicker({
  value,
  onChange,
  label = 'Item (search or scan)',
  autoFocus,
  error,
}: {
  value: Item | null;
  onChange(item: Item | null): void;
  label?: string;
  autoFocus?: boolean;
  error?: string;
}) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 200);
  const { data, isFetching } = useQuery({
    queryKey: ['/items', 'picker', q],
    queryFn: () => api<Paginated<Item>>('/items', { query: { search: q, pageSize: 20, active: true } }),
    enabled: q.trim().length >= 2,
  });
  const [scanError, setScanError] = useState<string | null>(null);

  const onKeyDown = async (e: KeyboardEvent) => {
    const code = input.trim();
    if (e.key !== 'Enter' || !/^\d{8,14}$|^[A-Z]{2,}\d+$/i.test(code)) return;
    e.preventDefault();
    const res = await api<Paginated<Item>>('/items', { query: { search: code, pageSize: 5 } });
    const exact = res.items.find((i) => i.gtin === code || i.barcode === code || i.code.toLowerCase() === code.toLowerCase());
    if (exact) {
      setScanError(null);
      onChange(exact);
      setInput('');
    } else {
      setScanError(`No item with code or barcode ${code}`);
    }
  };

  return (
    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 220 }}>
      <Autocomplete
        value={value}
        options={data?.items ?? (value ? [value] : [])}
        loading={isFetching}
        getOptionLabel={(i) => `${i.code} · ${i.name}`}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        filterOptions={(x) => x}
        inputValue={input}
        onInputChange={(_, v, reason) => reason !== 'reset' && setInput(v)}
        onChange={(_, v) => {
          onChange(v);
          setInput('');
        }}
        renderInput={(params) => (
          <TextField {...params} label={label} autoFocus={autoFocus} onKeyDown={onKeyDown} error={!!error || !!scanError} helperText={error ?? scanError ?? undefined} />
        )}
      />
    </Stack>
  );
}

export interface WitnessValue {
  username: string;
  password: string;
}

/** Second signatory for controlled drugs. */
export function WitnessFields({ value, onChange }: { value: WitnessValue; onChange(v: WitnessValue): void }) {
  return (
    <Stack spacing={1}>
      <Alert severity="warning" variant="outlined">
        Controlled drugs: a second authorised person must sign off with their own credentials.
      </Alert>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Witness username" value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} autoComplete="off" />
        <TextField
          label="Witness password"
          type="password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
          autoComplete="new-password"
        />
      </Stack>
    </Stack>
  );
}

export const witnessOrUndefined = (needed: boolean, w: WitnessValue) => (needed && w.username ? w : undefined);

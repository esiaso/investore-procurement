import { Alert, Autocomplete, Box, Button, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { KeyboardEvent, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Paginated, Permissions, StockTakeStatus, StockTakeType } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { StockTake, StockTakeLine } from '../api/inventory-types';
import type { Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { formatMoney, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';
import { ExpiryChip, StatusChip, StoreSelect } from './components';

function NewStockTakeDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState('');
  const [type, setType] = useState<StockTakeType>(StockTakeType.CYCLE);
  const [blind, setBlind] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const q = useDebounced(input);
  const search = useQuery({
    queryKey: ['/items', 'stocktake', q],
    queryFn: () => api<Paginated<Item>>('/items', { query: { search: q, pageSize: 20 } }),
    enabled: q.length >= 2,
  });
  const create = useApiMutation<void, StockTake>(
    () => ['/inventory/stock-takes', { method: 'POST', body: { storeId, type, blind, itemIds: type === StockTakeType.CYCLE ? items.map((i) => i.id) : undefined } }],
    { invalidate: ['/inventory/stock-takes'], success: 'Stock take created' },
  );
  return (
    <FormDialog
      open
      title="New stock take"
      submitLabel="Create"
      onClose={onClose}
      submitting={create.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined, { onSuccess: (st) => navigate(`/stock-takes/${st.id}`) });
      }}
    >
      <StoreSelect value={storeId} onChange={setStoreId} />
      <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value as StockTakeType)}>
        <MenuItem value={StockTakeType.CYCLE}>Cycle count (selected items)</MenuItem>
        <MenuItem value={StockTakeType.FULL}>Full count (whole store is frozen)</MenuItem>
      </TextField>
      {type === StockTakeType.CYCLE && (
        <Autocomplete
          multiple
          options={search.data?.items ?? []}
          value={items}
          filterOptions={(x) => x}
          getOptionLabel={(i) => `${i.code} · ${i.name}`}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onInputChange={(_, v) => setInput(v)}
          onChange={(_, v) => setItems(v)}
          renderInput={(p) => <TextField {...p} label="Items to count" />}
        />
      )}
      <FormControlLabel control={<Switch checked={blind} onChange={(e) => setBlind(e.target.checked)} />} label="Blind count (hide system quantities from counters)" />
    </FormDialog>
  );
}

/** Count sheet: Enter moves to the next quantity, so counts can be keyed (or scanned) quickly. */
export function CountSheet({ st, editable, counts, setCounts }: { st: StockTake; editable: boolean; counts: Record<string, string>; setCounts(c: Record<string, string>): void }) {
  const { currency } = useSettings();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const showSystem = !(st.blind && st.status === StockTakeStatus.COUNTING);
  const lines = st.lines ?? [];
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      refs.current[i + 1]?.focus();
    }
  };
  return (
    <TableContainer component={Paper} sx={{ maxHeight: 560 }}>
      <Table size="small" stickyHeader aria-label="Count sheet">
        <TableHead>
          <TableRow>
            <TableCell>Item</TableCell>
            <TableCell>Batch</TableCell>
            <TableCell>Expiry</TableCell>
            {showSystem && <TableCell align="right">System</TableCell>}
            <TableCell align="right" width={140}>Counted</TableCell>
            {showSystem && <TableCell align="right">Variance</TableCell>}
            {showSystem && <TableCell align="right">Value</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((l: StockTakeLine, i) => (
            <TableRow key={l.id} hover selected={!!l.variance}>
              <TableCell>{l.item?.name}</TableCell>
              <TableCell>{l.batch?.batchNo}</TableCell>
              <TableCell><ExpiryChip date={l.batch?.expiryDate} /></TableCell>
              {showSystem && <TableCell align="right">{l.systemQty}</TableCell>}
              <TableCell align="right">
                {editable ? (
                  <TextField
                    inputRef={(el) => (refs.current[i] = el)}
                    type="number"
                    value={counts[l.id] ?? (l.countedQty ?? '')}
                    onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })}
                    onKeyDown={onKey(i)}
                    slotProps={{ htmlInput: { 'aria-label': `Counted quantity for ${l.item?.name} ${l.batch?.batchNo}`, min: 0 } }}
                  />
                ) : (
                  l.countedQty
                )}
              </TableCell>
              {showSystem && (
                <TableCell align="right">
                  {l.variance ? <Chip size="small" color={l.variance < 0 ? 'error' : 'success'} label={l.variance > 0 ? `+${l.variance}` : l.variance} /> : l.variance}
                </TableCell>
              )}
              {showSystem && <TableCell align="right">{l.varianceValue ? formatMoney(l.varianceValue, currency) : ''}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function useStockTakeAction(id: string, action: string, success: string) {
  return useApiMutation<void>(() => [`/inventory/stock-takes/${id}/${action}`, { method: 'POST' }], { invalidate: ['/inventory'], success });
}

export function StockTakeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const { currency } = useSettings();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const { data: st } = useQuery({ queryKey: ['/inventory/stock-takes', id], queryFn: () => api<StockTake>(`/inventory/stock-takes/${id}`) });
  const freeze = useStockTakeAction(id!, 'freeze', 'Stock frozen; counting can start');
  const submit = useStockTakeAction(id!, 'submit', 'Counts submitted for review');
  const approve = useStockTakeAction(id!, 'approve', 'Variances posted');
  const cancel = useStockTakeAction(id!, 'cancel', 'Stock take cancelled');
  const save = useApiMutation<void>(
    () => [
      `/inventory/stock-takes/${id}/counts`,
      { method: 'POST', body: { lines: Object.entries(counts).filter(([, v]) => v !== '').map(([lineId, v]) => ({ lineId, countedQty: Number(v) })) } },
    ],
    { invalidate: ['/inventory/stock-takes'], success: 'Counts saved' },
  );
  const totalVariance = useMemo(() => (st?.lines ?? []).reduce((s, l) => s + (l.varianceValue ?? 0), 0), [st]);
  if (!st) return null;
  const counting = st.status === StockTakeStatus.COUNTING;
  const pendingCounts = Object.keys(counts).length > 0;

  return (
    <>
      <PageHeader title={`Stock take ${st.number}`} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <StatusChip status={st.status} />
        <Typography>{st.store?.name} · {humanise(st.type)} count{st.blind ? ' · blind' : ''} · {(st.lines ?? []).length} lines</Typography>
      </Stack>
      {st.status === StockTakeStatus.DRAFT && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Freezing takes a snapshot and blocks all movements of {st.type === StockTakeType.FULL ? 'this store' : 'the selected items'} until the count is posted or cancelled.
        </Alert>
      )}
      {st.status === StockTakeStatus.REVIEW && (
        <Alert severity={totalVariance ? 'warning' : 'success'} sx={{ mb: 2 }}>
          Net variance value: {formatMoney(totalVariance, currency)}. {st.submittedBy === user?.id ? 'Another user must approve.' : ''}
        </Alert>
      )}
      {st.status !== StockTakeStatus.DRAFT && <CountSheet st={st} editable={counting && can(Permissions.INVENTORY_STOCKTAKE)} counts={counts} setCounts={setCounts} />}
      <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
        {st.status === StockTakeStatus.DRAFT && can(Permissions.INVENTORY_STOCKTAKE) && <Button variant="contained" onClick={() => freeze.mutate()}>Freeze and start counting</Button>}
        {counting && (
          <>
            <Button variant="outlined" disabled={!pendingCounts || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setCounts({}) })}>Save counts</Button>
            <Button variant="contained" disabled={pendingCounts} title={pendingCounts ? 'Save counts first' : ''} onClick={() => submit.mutate()}>Submit for review</Button>
          </>
        )}
        {st.status === StockTakeStatus.REVIEW && can(Permissions.INVENTORY_STOCKTAKE_APPROVE) && st.submittedBy !== user?.id && (
          <Button variant="contained" color="success" onClick={() => approve.mutate()}>Approve and post variances</Button>
        )}
        {[StockTakeStatus.DRAFT, StockTakeStatus.COUNTING, StockTakeStatus.REVIEW].includes(st.status) && can(Permissions.INVENTORY_STOCKTAKE) && (
          <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>
        )}
      </Stack>
      <Box sx={{ height: 16 }} />
    </>
  );
}

export function StockTakesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [open, setOpen] = useState(false);
  const { data, isFetching } = usePaged<StockTake>('/inventory/stock-takes', { ...pagination, storeId });
  const columns: GridColDef<StockTake>[] = [
    { field: 'number', headerName: 'Number', width: 190 },
    { field: 'store', headerName: 'Store', flex: 1, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'type', headerName: 'Type', width: 100, valueFormatter: (v: string) => humanise(v) },
    { field: 'blind', headerName: 'Blind', type: 'boolean', width: 80 },
    { field: 'status', headerName: 'Status', width: 140, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader
        title="Stock takes"
        onNew={can(Permissions.INVENTORY_STOCKTAKE) ? () => setOpen(true) : undefined}
        actions={<StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', sm: 220 } }} />}
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/stock-takes/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
      {open && <NewStockTakeDialog onClose={() => setOpen(false)} />}
    </>
  );
}

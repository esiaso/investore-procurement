import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ForecastMethod, Permissions, QuantificationMethod } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department, Item, ItemCategory } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StoreSelect, useStores } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useDate, useMoney } from '../purchasing/common';
import type {
  AccuracyReport,
  DemandForecast,
  DonorStockRow,
  ForecastAdjustment,
  ForecastDetail,
  FundingSource,
  OrderSchedule,
  Programme,
  Quantification,
  SupplyPlanRow,
} from './api';

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' }).format(new Date());
export const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function useDefaultStore() {
  const stores = useStores();
  const [storeId, setStoreId] = useState('');
  useEffect(() => {
    if (!storeId && stores.data?.length) setStoreId(stores.data[0].id);
  }, [storeId, stores.data]);
  return [storeId, setStoreId] as const;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);

// ------------------------------------------------------------------ forecasts

function ForecastDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { data } = useQuery({ queryKey: ['/forecasting/forecasts', id], queryFn: () => api<ForecastDetail>(`/forecasting/forecasts/${id}`) });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{data ? `${data.item?.name} — ${data.store?.name}` : 'Forecast'}</DialogTitle>
      <DialogContent dividers>
        {data && (
          <Stack spacing={2}>
            <Typography variant="body2">
              Method <b>{humanise(data.method)}</b>
              {data.backtestMape !== null && <> · back-tested MAPE {data.backtestMape}%</>} · position (available + on order + in transit) {data.position} · demand over lead time and review {data.demandOverCover} · safety stock {data.safetyStock} →{' '}
              <b>suggested order {data.suggestedQty}</b>
            </Typography>
            {data.adjustments.length > 0 && (
              <Alert severity="info">Adjustments applied: {data.adjustments.map((a) => `${humanise(a.reasonCode)} ×${a.factor} (${a.months.join(', ')})`).join('; ')}</Alert>
            )}
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Consumption and forecast by month">
                <TableHead>
                  <TableRow>
                    <TableCell>Month</TableCell>
                    {data.historyMonths.map((m) => <TableCell key={m} align="right">{m}</TableCell>)}
                    {data.months.map((m) => <TableCell key={m} align="right" sx={{ fontWeight: 600 }}>{m}</TableCell>)}
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell>Actual</TableCell>
                    {data.history.map((v, i) => <TableCell key={i} align="right">{v}</TableCell>)}
                    {data.months.map((m) => <TableCell key={m} />)}
                  </TableRow>
                  <TableRow>
                    <TableCell>Baseline</TableCell>
                    {data.history.map((_, i) => <TableCell key={i} />)}
                    {data.baseline.map((v, i) => <TableCell key={i} align="right">{v}</TableCell>)}
                  </TableRow>
                  <TableRow>
                    <TableCell>Forecast</TableCell>
                    {data.history.map((_, i) => <TableCell key={i} />)}
                    {data.adjusted.map((v, i) => <TableCell key={i} align="right" sx={{ fontWeight: 600 }}>{v}</TableCell>)}
                  </TableRow>
                </TableBody>
              </Table>
            </Box>
            {data.accuracy.length > 0 && (
              <>
                <Typography variant="subtitle2">Forecast vs actual</Typography>
                <Table size="small" aria-label="Accuracy">
                  <TableHead><TableRow><TableCell>Month</TableCell><TableCell>Method</TableCell><TableCell align="right">Forecast</TableCell><TableCell align="right">Actual</TableCell><TableCell align="right">Error</TableCell></TableRow></TableHead>
                  <TableBody>
                    {data.accuracy.map((a) => (
                      <TableRow key={a.month}><TableCell>{a.month}</TableCell><TableCell>{humanise(a.method)}</TableCell><TableCell align="right">{a.forecastQty}</TableCell><TableCell align="right">{a.actualQty}</TableCell><TableCell align="right">{pct(a.ape)}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function ForecastList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useDefaultStore();
  const [search, setSearch] = useState('');
  const [onlySuggested, setOnlySuggested] = useState(false);
  const [method, setMethod] = useState<string>('');
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [prDialog, setPrDialog] = useState(false);
  const q = useDebounced(search);
  const query = { storeId, search: q || undefined, onlySuggested: onlySuggested || undefined };
  const { data, isFetching } = useQuery({ queryKey: ['/forecasting/forecasts', query], queryFn: () => api<DemandForecast[]>('/forecasting/forecasts', { query }), enabled: !!storeId });
  const run = useApiMutation<void, { forecasts: number; method: string; startMonth: string }>(() => ['/forecasting/forecasts/run', { method: 'POST', body: { storeId, method: method || undefined } }], {
    invalidate: ['/forecasting'],
    success: 'Forecasts updated',
  });
  const columns: GridColDef<DemandForecast>[] = [
    { field: 'item', headerName: 'Item', flex: 1, minWidth: 220, valueGetter: (_v, r) => r.item?.name ?? '' },
    { field: 'method', headerName: 'Method', width: 130, valueFormatter: (v: string) => humanise(v) },
    { field: 'last', headerName: 'Last 3 months', width: 150, valueGetter: (_v, r) => r.history.slice(-3).join(' · ') },
    { field: 'next', headerName: 'Next month', type: 'number', width: 110, valueGetter: (_v, r) => r.adjusted[0] ?? 0 },
    { field: 'adjusted', headerName: 'Adj.', width: 70, renderCell: ({ row }) => (row.adjustments.length ? <Chip size="small" label={row.adjustments.length} /> : '') },
    { field: 'backtestMape', headerName: 'MAPE', type: 'number', width: 90, valueFormatter: (v: number | null) => pct(v) },
    { field: 'position', headerName: 'Position', type: 'number', width: 100 },
    { field: 'suggestedQty', headerName: 'Suggested', type: 'number', width: 110, renderCell: ({ value }) => (value > 0 ? <b>{value}</b> : value) },
  ];
  return (
    <>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <StoreSelect value={storeId} onChange={(v) => { setStoreId(v); setSelected([]); }} sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField label="Search items" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ width: { xs: '100%', md: 240 } }} />
        <FormControlLabel control={<Switch checked={onlySuggested} onChange={(e) => setOnlySuggested(e.target.checked)} />} label="With a suggested order only" />
        <Box sx={{ flexGrow: 1 }} />
        {can(Permissions.FORECASTING_MANAGE) && (
          <>
            <TextField select label="Method" value={method} onChange={(e) => setMethod(e.target.value)} sx={{ width: 190 }}>
              <MenuItem value="">Default (setting)</MenuItem>
              {Object.values(ForecastMethod).map((m) => <MenuItem key={m} value={m}>{humanise(m)}</MenuItem>)}
            </TextField>
            <Button variant="outlined" disabled={!storeId || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Forecasting…' : 'Run forecast'}</Button>
          </>
        )}
        {can(Permissions.INVENTORY_PLANNING) && (
          <Button variant="contained" disabled={!selected.length} onClick={() => setPrDialog(true)}>Create draft PR ({selected.length})</Button>
        )}
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          columns={columns}
          loading={isFetching}
          checkboxSelection={can(Permissions.INVENTORY_PLANNING)}
          isRowSelectable={({ row }) => row.suggestedQty > 0}
          rowSelectionModel={selected}
          onRowSelectionModelChange={(m) => setSelected(m.map(String))}
          onRowClick={({ row }) => setOpen(row.id)}
          disableRowSelectionOnClick
          pageSizeOptions={[50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">
        Suggested order = forecast demand over the lead time and review period + safety stock − position. AUTO picks the method with the lowest back-tested error for each item.
      </Typography>
      {open && <ForecastDialog id={open} onClose={() => setOpen(null)} />}
      {prDialog && <ForecastPrDialog storeId={storeId} forecastIds={selected} onClose={() => setPrDialog(false)} onDone={(link) => navigate(link)} />}
    </>
  );
}

function ForecastPrDialog({ storeId, forecastIds, onClose, onDone }: { storeId: string; forecastIds: string[]; onClose(): void; onDone(link: string): void }) {
  const { user } = useAuth();
  const departments = useAll<Department>('/departments');
  const [departmentId, setDepartmentId] = useState(user?.departmentId ?? '');
  const create = useApiMutation<void, { link: string }>(() => ['/forecasting/forecasts/requisition', { method: 'POST', body: { storeId, departmentId: departmentId || undefined, forecastIds } }], {
    invalidate: ['/requisitions', '/inventory'],
    success: 'Draft created from the forecast',
  });
  return (
    <FormDialog open title="Order the suggested quantities" submitLabel="Create draft" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (r) => onDone(r.link) }); }}>
      <Typography>{forecastIds.length} item(s). A satellite store gets a transfer request from its parent store; a main store a draft purchase requisition.</Typography>
      <TextField select label="Department charged" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
        {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
      </TextField>
    </FormDialog>
  );
}

function AdjustmentDialog({ row, onClose }: { row: ForecastAdjustment | null; onClose(): void }) {
  const categories = useList<ItemCategory>('/item-categories');
  const [item, setItem] = useState<Item | null>((row?.item as Item) ?? null);
  const [form, setForm] = useState({
    storeId: row?.storeId ?? '',
    categoryId: row?.categoryId ?? '',
    reasonCode: row?.reasonCode ?? 'MORBIDITY',
    description: row?.description ?? '',
    factor: row?.factor ?? 1.2,
    fromMonth: row?.fromMonth ?? thisMonth(),
    toMonth: row?.toMonth ?? '',
    isActive: row?.isActive ?? true,
  });
  const save = useApiMutation<void>(
    () => [
      row ? `/forecasting/adjustments/${row.id}` : '/forecasting/adjustments',
      { method: row ? 'PUT' : 'POST', body: { ...form, storeId: form.storeId || null, itemId: item?.id ?? null, categoryId: item ? null : form.categoryId || null, toMonth: form.toMonth || null, factor: Number(form.factor) } },
    ],
    { invalidate: ['/forecasting'], success: 'Adjustment saved; re-run the forecast to apply it' },
  );
  return (
    <FormDialog open title={row ? 'Edit adjustment' : 'New forecast adjustment'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <ItemPicker value={item} onChange={setItem} label="Item (or leave blank and choose a category)" />
      {!item && (
        <TextField select label="Category" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
          {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
        </TextField>
      )}
      <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v })} allowAll="All stores" />
      <Stack direction="row" spacing={2}>
        <TextField label="Reason code" value={form.reasonCode} onChange={(e) => setForm({ ...form, reasonCode: e.target.value.toUpperCase() })} helperText="e.g. MORBIDITY, NEW_SERVICE, PROGRAMME" />
        <TextField label="Factor" type="number" value={form.factor} onChange={(e) => setForm({ ...form, factor: Number(e.target.value) })} helperText="1.2 = +20%" slotProps={{ htmlInput: { step: 0.05, min: 0 } }} />
      </Stack>
      <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
      <Stack direction="row" spacing={2}>
        <TextField label="From month" type="month" value={form.fromMonth} onChange={(e) => setForm({ ...form, fromMonth: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To month (blank = open)" type="month" value={form.toMonth} onChange={(e) => setForm({ ...form, toMonth: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function AdjustmentList() {
  const { can } = useAuth();
  const { data, isFetching } = useList<ForecastAdjustment>('/forecasting/adjustments');
  const [editing, setEditing] = useState<ForecastAdjustment | null | 'new'>(null);
  const columns: GridColDef<ForecastAdjustment>[] = [
    { field: 'item', headerName: 'Applies to', flex: 1, minWidth: 220, valueGetter: (_v, r) => r.item?.name ?? (r.categoryId ? 'Category' : '') },
    { field: 'reasonCode', headerName: 'Reason', width: 140, valueFormatter: (v: string) => humanise(v) },
    { field: 'description', headerName: 'Description', flex: 1, minWidth: 200 },
    { field: 'factor', headerName: 'Factor', type: 'number', width: 90 },
    { field: 'fromMonth', headerName: 'From', width: 100 },
    { field: 'toMonth', headerName: 'To', width: 100, valueFormatter: (v: string | null) => v ?? 'open' },
    { field: 'isActive', headerName: 'Active', width: 80, type: 'boolean' },
  ];
  return (
    <>
      {can(Permissions.FORECASTING_MANAGE) && (
        <Stack direction="row" sx={{ mb: 2 }}><Button startIcon={<AddIcon />} variant="contained" onClick={() => setEditing('new')}>New adjustment</Button></Stack>
      )}
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => can(Permissions.FORECASTING_MANAGE) && setEditing(row)} disableRowSelectionOnClick />
      </Paper>
      {editing && <AdjustmentDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AccuracyView() {
  const { can } = useAuth();
  const [storeId, setStoreId] = useState('');
  const [fromMonth, setFrom] = useState(shiftMonth(thisMonth(), -6));
  const [toMonth, setTo] = useState(shiftMonth(thisMonth(), -1));
  const query = { fromMonth, toMonth, storeId: storeId || undefined };
  const { data } = useQuery({ queryKey: ['/forecasting/accuracy', query], queryFn: () => api<AccuracyReport>('/forecasting/accuracy', { query }) });
  const run = useApiMutation<void>(() => ['/forecasting/accuracy/run', { method: 'POST', body: {} }], { invalidate: ['/forecasting'], success: 'Last month compared with its forecasts' });
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
        <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField label="From" type="month" value={fromMonth} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To" type="month" value={toMonth} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <Box sx={{ flexGrow: 1 }} />
        {can(Permissions.FORECASTING_MANAGE) && <Button variant="outlined" disabled={run.isPending} onClick={() => run.mutate()}>Compare last month now</Button>}
      </Stack>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2">Overall MAPE</Typography>
        <Typography variant="h4">{pct(data?.overall?.mape)}</Typography>
        <Typography variant="caption" color="text.secondary">{data?.overall?.pairs ?? 0} item-months with demand. Lower is better; months without demand are left out.</Typography>
        <Stack direction="row" spacing={3} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
          {(data?.byMethod ?? []).map((m) => (
            <Box key={m.method}><Typography variant="caption">{humanise(m.method)}</Typography><Typography variant="h6">{pct(m.mape)}</Typography><Typography variant="caption">{m.pairs} item-months</Typography></Box>
          ))}
        </Stack>
      </Paper>
      <Typography variant="subtitle1" fontWeight={600}>Least accurate items</Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          getRowId={(r) => `${r.code}:${r.store}`}
          rows={data?.worst ?? []}
          columns={[
            { field: 'code', headerName: 'Code', width: 110 },
            { field: 'name', headerName: 'Item', flex: 1, minWidth: 200 },
            { field: 'store', headerName: 'Store', width: 160 },
            { field: 'mape', headerName: 'MAPE', type: 'number', width: 100, valueFormatter: (v: number) => pct(v) },
            { field: 'months', headerName: 'Months', type: 'number', width: 90 },
          ]}
          hideFooter
        />
      </Paper>
    </Stack>
  );
}

export function ForecastsPage() {
  const [tab, setTab] = useState(0);
  return (
    <>
      <PageHeader title="Demand forecasting" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Forecasts" />
        <Tab label="Adjustments" />
        <Tab label="Accuracy" />
      </Tabs>
      {tab === 0 && <ForecastList />}
      {tab === 1 && <AdjustmentList />}
      {tab === 2 && <AccuracyView />}
    </>
  );
}

// ------------------------------------------------------------------ supply planning

const MOS_CHIP: Record<SupplyPlanRow['status'], { label: string; color: 'error' | 'warning' | 'info' | 'success' }> = {
  STOCK_OUT: { label: 'Stock-out', color: 'error' },
  BELOW_MIN: { label: 'Below min', color: 'error' },
  BELOW_MIN_COVERED: { label: 'Below min (on order)', color: 'warning' },
  ABOVE_MAX: { label: 'Above max', color: 'info' },
  OK: { label: 'OK', color: 'success' },
};

function ScheduleDialog({ storeId, itemId, onClose }: { storeId: string; itemId: string; onClose(): void }) {
  const date = useDate();
  const { data } = useQuery({ queryKey: ['/supply-planning/schedule', storeId, itemId], queryFn: () => api<OrderSchedule>('/supply-planning/schedule', { query: { storeId, itemId } }) });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Order schedule — {data?.item.itemName}</DialogTitle>
      <DialogContent dividers>
        {data && (
          <Stack spacing={2}>
            <Typography variant="body2">Keep between {data.item.minMonths} and {data.item.maxMonths} months of stock; lead time {data.item.leadTimeDays} days.</Typography>
            {data.orders.length ? (
              <Alert severity="info">{data.orders.map((o) => `Order ${o.quantity} ${data.item.uom} by ${date(o.orderBy)} (arrives ${o.arrivalMonth})`).join(' · ')}</Alert>
            ) : (
              <Alert severity="success">No order needed in the forecast horizon.</Alert>
            )}
            <Table size="small" aria-label="Projected stock">
              <TableHead><TableRow><TableCell>Month</TableCell><TableCell align="right">Opening</TableCell><TableCell align="right">Demand</TableCell><TableCell align="right">Arrival</TableCell><TableCell align="right">Closing</TableCell><TableCell align="right">MOS</TableCell></TableRow></TableHead>
              <TableBody>
                {data.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{m.month}</TableCell><TableCell align="right">{m.opening}</TableCell><TableCell align="right">{m.demand}</TableCell>
                    <TableCell align="right">{m.arrival || ''}</TableCell><TableCell align="right">{m.closing}</TableCell><TableCell align="right">{m.monthsOfStock ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export function SupplyPlanPage() {
  const money = useMoney();
  const [storeId, setStoreId] = useDefaultStore();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = useQuery({ queryKey: ['/supply-planning', storeId, q], queryFn: () => api<SupplyPlanRow[]>('/supply-planning', { query: { storeId, search: q || undefined } }), enabled: !!storeId });
  const rows = (data ?? []).filter((r) => !status || r.status === status);
  const columns: GridColDef<SupplyPlanRow>[] = [
    { field: 'itemCode', headerName: 'Code', width: 110 },
    { field: 'itemName', headerName: 'Item', flex: 1, minWidth: 220 },
    { field: 'forecastMonthly', headerName: 'Monthly demand', type: 'number', width: 130 },
    { field: 'available', headerName: 'Available', type: 'number', width: 100 },
    { field: 'onOrder', headerName: 'On order', type: 'number', width: 90 },
    { field: 'inTransit', headerName: 'In transit', type: 'number', width: 90 },
    { field: 'monthsOfStock', headerName: 'MOS', type: 'number', width: 80, valueFormatter: (v: number | null) => v ?? '—' },
    { field: 'pipelineMonthsOfStock', headerName: 'Pipeline MOS', type: 'number', width: 110, valueFormatter: (v: number | null) => v ?? '—' },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <Chip size="small" color={MOS_CHIP[value as SupplyPlanRow['status']].color} label={MOS_CHIP[value as SupplyPlanRow['status']].label} /> },
    { field: 'value', headerName: 'Stock value', type: 'number', width: 120, valueGetter: (_v, r) => r.available * r.unitCost, valueFormatter: (v: number) => money(v) },
  ];
  return (
    <>
      <PageHeader title="Supply planning (months of stock)" search={search} onSearch={setSearch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <StoreSelect value={storeId} onChange={setStoreId} sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', md: 220 } }}>
          <MenuItem value="">All</MenuItem>
          {Object.entries(MOS_CHIP).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
        </TextField>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" getRowId={(r) => r.itemId} rows={rows} columns={columns} loading={isFetching} onRowClick={({ row }) => setOpen(row.itemId)} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
      <Typography variant="caption" color="text.secondary">Pipeline = available + on order + in transit. Monthly demand is the current forecast (or the AMC). Click an item for its month-by-month order schedule.</Typography>
      {open && <ScheduleDialog storeId={storeId} itemId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ programmes and quantification

function ProgrammeDialog({ row, onClose }: { row: Programme | null; onClose(): void }) {
  const [form, setForm] = useState({ code: row?.code ?? '', name: row?.name ?? '', description: row?.description ?? '', isActive: row?.isActive ?? true });
  const [lines, setLines] = useState<{ item: Item | null; unitsPerPatientMonth: number; regimenSharePercent: number; protocolNotes: string }[]>(
    (row?.commodities ?? []).map((c) => ({ item: (c.item as Item) ?? null, unitsPerPatientMonth: c.unitsPerPatientMonth, regimenSharePercent: c.regimenSharePercent, protocolNotes: c.protocolNotes ?? '' })),
  );
  const save = useApiMutation<void>(
    () => [
      row ? `/forecasting/programmes/${row.id}` : '/forecasting/programmes',
      {
        method: row ? 'PUT' : 'POST',
        body: { ...form, description: form.description || undefined, commodities: lines.filter((l) => l.item).map((l) => ({ itemId: l.item!.id, unitsPerPatientMonth: Number(l.unitsPerPatientMonth), regimenSharePercent: Number(l.regimenSharePercent), protocolNotes: l.protocolNotes || undefined })) },
      },
    ],
    { invalidate: ['/forecasting/programmes'], success: 'Programme saved' },
  );
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <FormDialog open maxWidth="md" title={row ? `Programme ${row.code}` : 'New programme'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required />
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <Typography variant="subtitle2">Commodities and treatment protocol</Typography>
      {lines.map((l, i) => (
        <Stack key={i} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
          <ItemPicker value={l.item} onChange={(item) => set(i, { item })} />
          <TextField label="Units / patient-month" type="number" value={l.unitsPerPatientMonth} onChange={(e) => set(i, { unitsPerPatientMonth: Number(e.target.value) })} sx={{ width: { md: 150 } }} />
          <TextField label="Regimen share %" type="number" value={l.regimenSharePercent} onChange={(e) => set(i, { regimenSharePercent: Number(e.target.value) })} sx={{ width: { md: 130 } }} />
          <TextField label="Protocol notes" value={l.protocolNotes} onChange={(e) => set(i, { protocolNotes: e.target.value })} sx={{ width: { md: 200 } }} />
          <IconButton aria-label={`Remove commodity ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><DeleteIcon /></IconButton>
        </Stack>
      ))}
      <Box><Button startIcon={<AddIcon />} onClick={() => setLines([...lines, { item: null, unitsPerPatientMonth: 1, regimenSharePercent: 100, protocolNotes: '' }])}>Add commodity</Button></Box>
      <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function QuantifyDialog({ programmes, onClose, onDone }: { programmes: Programme[]; onClose(): void; onDone(q: Quantification): void }) {
  const [form, setForm] = useState({ programmeId: programmes[0]?.id ?? '', storeId: '', title: '', periodMonths: 12, targetPopulation: 100, coveragePercent: 80, wastagePercent: 5, method: QuantificationMethod.MORBIDITY as string, notes: '' });
  const run = useApiMutation<void, Quantification>(
    () => ['/forecasting/quantifications', { method: 'POST', body: { ...form, storeId: form.storeId || undefined, notes: form.notes || undefined, periodMonths: +form.periodMonths, targetPopulation: +form.targetPopulation, coveragePercent: +form.coveragePercent, wastagePercent: +form.wastagePercent } }],
    { invalidate: ['/forecasting/quantifications'], success: 'Quantification saved' },
  );
  const num = (k: 'periodMonths' | 'targetPopulation' | 'coveragePercent' | 'wastagePercent', label: string, helper?: string) => (
    <TextField label={label} type="number" value={form[k]} helperText={helper} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
  );
  return (
    <FormDialog open title="Quantify a programme" submitLabel="Calculate" onClose={onClose} submitting={run.isPending} onSubmit={(e) => { e.preventDefault(); run.mutate(undefined, { onSuccess: onDone }); }}>
      <TextField select label="Programme" value={form.programmeId} onChange={(e) => setForm({ ...form, programmeId: e.target.value })}>
        {programmes.map((p) => <MenuItem key={p.id} value={p.id}>{p.code} · {p.name}</MenuItem>)}
      </TextField>
      <TextField label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
      <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v })} label="Consumption and stock of" allowAll="All stores" />
      <Stack direction="row" spacing={2}>
        {num('targetPopulation', 'Target population', 'Patients treated per month in the protocol')}
        {num('periodMonths', 'Period (months)')}
      </Stack>
      <Stack direction="row" spacing={2}>
        {num('coveragePercent', 'Coverage %')}
        {num('wastagePercent', 'Wastage %')}
      </Stack>
      <TextField select label="Final quantity from" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
        {Object.values(QuantificationMethod).map((m) => <MenuItem key={m} value={m}>{humanise(m)} method</MenuItem>)}
      </TextField>
      <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} multiline minRows={2} />
    </FormDialog>
  );
}

function QuantificationDialog({ q, onClose }: { q: Quantification; onClose(): void }) {
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{q.title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {q.programme?.name} · {q.targetPopulation} patients/month × {q.coveragePercent}% coverage × {q.periodMonths} months · wastage {q.wastagePercent}% · final quantity from the <b>{humanise(q.method).toLowerCase()}</b> method
        </Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Quantification lines">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell><TableCell align="right">Morbidity</TableCell><TableCell align="right">AMC</TableCell><TableCell align="right">Consumption</TableCell>
                <TableCell align="right">Difference</TableCell><TableCell align="right">Final</TableCell><TableCell align="right">Usable stock</TableCell><TableCell align="right">To procure</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {q.lines.map((l) => (
                <TableRow key={l.itemId}>
                  <TableCell>{l.itemCode} · {l.itemName}</TableCell><TableCell align="right">{l.morbidityQty}</TableCell><TableCell align="right">{l.amc}</TableCell><TableCell align="right">{l.consumptionQty}</TableCell>
                  <TableCell align="right">{l.differencePercent === null ? '—' : `${l.differencePercent > 0 ? '+' : ''}${l.differencePercent}%`}</TableCell>
                  <TableCell align="right"><b>{l.finalQty}</b></TableCell><TableCell align="right">{l.available}</TableCell><TableCell align="right"><b>{l.toProcure}</b></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        {q.lines.some((l) => l.differencePercent !== null && Math.abs(l.differencePercent) > 25) && (
          <Alert severity="warning" sx={{ mt: 2 }}>The two methods differ by more than 25% for some items: check the caseload, the protocol and past stock-outs before ordering.</Alert>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export function QuantificationPage() {
  const { can } = useAuth();
  const date = useDate();
  const programmes = useList<Programme>('/forecasting/programmes');
  const quantifications = useList<Quantification>('/forecasting/quantifications');
  const [editing, setEditing] = useState<Programme | null | 'new'>(null);
  const [quantify, setQuantify] = useState(false);
  const [open, setOpen] = useState<Quantification | null>(null);
  const manage = can(Permissions.FORECASTING_MANAGE);
  return (
    <>
      <PageHeader title="Programme quantification" />
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center">
        <Typography variant="subtitle1" fontWeight={600} sx={{ flexGrow: 1 }}>Programmes</Typography>
        {manage && <Button startIcon={<AddIcon />} onClick={() => setEditing('new')}>New programme</Button>}
      </Stack>
      <Paper sx={{ mb: 3 }}>
        <DataGrid
          autoHeight
          density="compact"
          rows={programmes.data ?? []}
          columns={[
            { field: 'code', headerName: 'Code', width: 130 },
            { field: 'name', headerName: 'Programme', flex: 1, minWidth: 220 },
            { field: 'commodities', headerName: 'Commodities', flex: 1, minWidth: 220, valueGetter: (_v, r: Programme) => (r.commodities ?? []).map((c) => c.item?.name).join(', ') },
            { field: 'isActive', headerName: 'Active', type: 'boolean', width: 80 },
          ]}
          onRowClick={({ row }) => manage && setEditing(row)}
          hideFooter
        />
      </Paper>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center">
        <Typography variant="subtitle1" fontWeight={600} sx={{ flexGrow: 1 }}>Quantifications</Typography>
        {manage && <Button variant="contained" disabled={!programmes.data?.length} onClick={() => setQuantify(true)}>Quantify</Button>}
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={quantifications.data ?? []}
          columns={[
            { field: 'title', headerName: 'Title', flex: 1, minWidth: 240 },
            { field: 'programme', headerName: 'Programme', width: 160, valueGetter: (_v, r: Quantification) => r.programme?.code ?? '' },
            { field: 'periodMonths', headerName: 'Months', type: 'number', width: 90 },
            { field: 'method', headerName: 'Method', width: 130, valueFormatter: (v: string) => humanise(v) },
            { field: 'toProcure', headerName: 'Lines to procure', type: 'number', width: 140, valueGetter: (_v, r: Quantification) => r.lines.filter((l) => l.toProcure > 0).length },
            { field: 'createdAt', headerName: 'Made', width: 110, valueFormatter: (v: string) => date(v) },
          ]}
          onRowClick={({ row }) => setOpen(row)}
          pageSizeOptions={[25, 50]}
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">
        Morbidity method: target population × coverage × regimen share × units per patient-month × months, plus wastage. Consumption method: AMC × months. Both are shown with their difference.
      </Typography>
      {editing && <ProgrammeDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {quantify && <QuantifyDialog programmes={programmes.data ?? []} onClose={() => setQuantify(false)} onDone={(q) => { setQuantify(false); setOpen(q); }} />}
      {open && <QuantificationDialog q={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ funding sources and donor stock

function FundingDialog({ row, onClose }: { row: FundingSource | null; onClose(): void }) {
  const stores = useStores();
  const departments = useAll<Department>('/departments');
  const programmes = useList<Programme>('/forecasting/programmes');
  const [form, setForm] = useState({
    code: row?.code ?? '',
    name: row?.name ?? '',
    donor: row?.donor ?? '',
    programmeId: row?.programmeId ?? '',
    allowSale: row?.allowSale ?? false,
    allowedStoreIds: row?.allowedStoreIds ?? [],
    allowedDepartmentIds: row?.allowedDepartmentIds ?? [],
    notes: row?.notes ?? '',
    isActive: row?.isActive ?? true,
  });
  const save = useApiMutation<void>(
    () => [row ? `/funding-sources/${row.id}` : '/funding-sources', { method: row ? 'PUT' : 'POST', body: { ...form, donor: form.donor || undefined, programmeId: form.programmeId || undefined, notes: form.notes || undefined } }],
    { invalidate: ['/funding-sources'], success: 'Funding source saved' },
  );
  return (
    <FormDialog open title={row ? `Funding source ${row.code}` : 'New funding source'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code (as on batches)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required disabled={!!row} />
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <TextField label="Donor" value={form.donor} onChange={(e) => setForm({ ...form, donor: e.target.value })} />
      <TextField select label="Programme" value={form.programmeId} onChange={(e) => setForm({ ...form, programmeId: e.target.value })}>
        <MenuItem value="">None</MenuItem>
        {(programmes.data ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
      </TextField>
      <FormControlLabel control={<Switch checked={form.allowSale} onChange={(e) => setForm({ ...form, allowSale: e.target.checked })} />} label="May be sold (off: free issue / dispensing only)" />
      <TextField select label="Only in these stores (none = any)" value={form.allowedStoreIds} onChange={(e) => setForm({ ...form, allowedStoreIds: e.target.value as unknown as string[] })} slotProps={{ select: { multiple: true } }}>
        {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField select label="Only issued to these departments (none = any)" value={form.allowedDepartmentIds} onChange={(e) => setForm({ ...form, allowedDepartmentIds: e.target.value as unknown as string[] })} slotProps={{ select: { multiple: true } }}>
        {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
      </TextField>
      <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} multiline minRows={2} />
      <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

export function FundingSourcesPage() {
  const { can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const sources = useList<FundingSource>('/funding-sources');
  const [editing, setEditing] = useState<FundingSource | null | 'new'>(null);
  const [fundingSource, setFundingSource] = useState('');
  const [storeId, setStoreId] = useState('');
  const query = { fundingSource: fundingSource || undefined, storeId: storeId || undefined };
  const stock = useQuery({ queryKey: ['/funding-sources/stock', query], queryFn: () => api<DonorStockRow[]>('/funding-sources/stock', { query }) });
  const manage = can(Permissions.FORECASTING_MANAGE);
  return (
    <>
      <PageHeader title="Funding sources and donor stock" onNew={manage ? () => setEditing('new') : undefined} newLabel="New funding source" />
      <Paper sx={{ mb: 3 }}>
        <DataGrid
          autoHeight
          density="compact"
          rows={sources.data ?? []}
          columns={[
            { field: 'code', headerName: 'Code', width: 150 },
            { field: 'name', headerName: 'Name', flex: 1, minWidth: 220 },
            { field: 'donor', headerName: 'Donor', width: 180 },
            { field: 'allowSale', headerName: 'Sale', width: 120, renderCell: ({ value }) => (value ? 'Allowed' : <Chip size="small" color="warning" label="Not for sale" />) },
            { field: 'restrict', headerName: 'Restrictions', width: 220, valueGetter: (_v, r: FundingSource) => [r.allowedStoreIds.length ? `${r.allowedStoreIds.length} store(s)` : '', r.allowedDepartmentIds.length ? `${r.allowedDepartmentIds.length} department(s)` : ''].filter(Boolean).join(', ') || 'None' },
            { field: 'isActive', headerName: 'Active', type: 'boolean', width: 80 },
          ]}
          onRowClick={({ row }) => manage && setEditing(row)}
          hideFooter
        />
      </Paper>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Donor stock report</Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Funding source" value={fundingSource} onChange={(e) => setFundingSource(e.target.value)} sx={{ width: { xs: '100%', md: 240 } }}>
          <MenuItem value="">All</MenuItem>
          {(sources.data ?? []).map((s) => <MenuItem key={s.code} value={s.code}>{s.name}</MenuItem>)}
        </TextField>
        <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', md: 220 } }} />
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          getRowId={(r) => `${r.funding_source}:${r.store_id}:${r.item_id}`}
          rows={stock.data ?? []}
          loading={stock.isFetching}
          columns={[
            { field: 'funder', headerName: 'Funding source', width: 180, valueGetter: (_v, r: DonorStockRow) => r.funder ?? r.funding_source },
            { field: 'store', headerName: 'Store', width: 150 },
            { field: 'name', headerName: 'Item', flex: 1, minWidth: 200 },
            { field: 'on_hand', headerName: 'On hand', type: 'number', width: 100 },
            { field: 'value', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
            { field: 'earliest_expiry', headerName: 'Earliest expiry', width: 130, valueFormatter: (v: string | null) => date(v) },
            { field: 'monthlyUse', headerName: 'Monthly use', type: 'number', width: 110 },
            { field: 'monthsOfStock', headerName: 'MOS', type: 'number', width: 80, valueFormatter: (v: number | null) => v ?? '—' },
          ]}
          pageSizeOptions={[50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      {editing && <FundingDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

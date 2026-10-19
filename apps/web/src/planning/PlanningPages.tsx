import DownloadIcon from '@mui/icons-material/Download';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { ExpiryRow, JobRun, JobStatus, PlanningDashboard, ReorderRow, StockAlertRow, StoreItemSetting } from '../api/planning-types';
import type { Department, ItemCategory, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ExpiryChip, StatusChip, StoreSelect, useStores } from '../inventory/components';
import { formatMoney, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';
import { useDate, useMoney } from '../purchasing/common';

/** Lines for the one-click requisition: selected rows with a positive quantity (edited or suggested). */
export function reorderLines(rows: ReorderRow[], selected: Set<string>, qty: Record<string, number>) {
  return rows
    .filter((r) => selected.has(r.itemId))
    .map((r) => ({ itemId: r.itemId, quantity: qty[r.itemId] ?? r.suggestedQty }))
    .filter((l) => l.quantity > 0);
}

/** Remembers the store chosen on planning screens; defaults to the first accessible one or ?storeId=. */
function useStoreParam() {
  const [params] = useSearchParams();
  const stores = useStores();
  const [storeId, setStoreId] = useState(params.get('storeId') ?? '');
  useEffect(() => {
    if (!storeId && stores.data?.length) setStoreId(stores.data[0].id);
  }, [storeId, stores.data]);
  return { storeId, setStoreId, stores: stores.data ?? [] };
}

function ExportButtons({ path, query }: { path: string; query: Record<string, string | number | boolean | undefined> }) {
  return (
    <Stack direction="row" spacing={1}>
      <Button size="small" startIcon={<DownloadIcon />} href={buildUrl(path, { ...query, format: 'csv' })}>CSV</Button>
      <Button size="small" startIcon={<DownloadIcon />} href={buildUrl(path, { ...query, format: 'xlsx' })}>Excel</Button>
    </Stack>
  );
}

// ------------------------------------------------------------------ reorder

function RequisitionDialog({ store, lines, onClose }: { store: Store; lines: { itemId: string; quantity: number }[]; onClose(): void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const departments = useAll<Department>('/departments');
  const [departmentId, setDepartmentId] = useState(user?.departmentId ?? '');
  const satellite = !!store.parentStoreId;
  const create = useApiMutation<void, { kind: string; id: string; number: string; link: string }>(
    () => ['/stock-planning/reorder/requisition', { method: 'POST', body: { storeId: store.id, departmentId: satellite ? undefined : departmentId || undefined, lines } }],
    { invalidate: ['/requisitions', '/inventory', '/stock-planning'], success: satellite ? 'Transfer request raised' : 'Draft purchase requisition created' },
  );
  return (
    <FormDialog
      open
      title={satellite ? 'Request stock from the parent store' : 'Create a draft purchase requisition'}
      submitLabel={satellite ? 'Raise transfer request' : 'Create draft PR'}
      onClose={onClose}
      submitting={create.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined, { onSuccess: (r) => navigate(r.link) });
      }}
    >
      <Typography>
        {lines.length} item(s) for {store.name}.{' '}
        {satellite ? 'A transfer request goes to the parent store, which dispatches it as usual.' : 'The draft is yours to review and submit; it then follows the approval workflow.'}
      </Typography>
      {!satellite && (
        <TextField select label="Department charged" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      )}
    </FormDialog>
  );
}

export function ReorderPage() {
  const { can, canAny } = useAuth();
  const money = useMoney();
  const { storeId, setStoreId, stores } = useStoreParam();
  const categories = useList<ItemCategory>('/item-categories');
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [belowOnly, setBelowOnly] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, number>>({});
  const [dialog, setDialog] = useState(false);
  const q = useDebounced(search);
  const query = { storeId, categoryId: categoryId || undefined, search: q || undefined, belowOnly };
  const { data, isFetching } = useQuery({ queryKey: ['/stock-planning/reorder', query], queryFn: () => api<ReorderRow[]>('/stock-planning/reorder', { query }), enabled: !!storeId });
  const rows = useMemo(() => data ?? [], [data]);
  const store = stores.find((s) => s.id === storeId);
  const lines = reorderLines(rows, selected, qty);
  const canOrder = can(Permissions.INVENTORY_PLANNING) && (store?.parentStoreId ? can(Permissions.INVENTORY_TRANSFER_REQUEST) : canAny(Permissions.PURCHASING_REQUISITION));
  const columns: GridColDef<ReorderRow>[] = [
    { field: 'itemCode', headerName: 'Code', width: 110 },
    {
      field: 'itemName',
      headerName: 'Item',
      flex: 1,
      minWidth: 220,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
          <span>{row.itemName}</span>
          {row.stockOut && <Chip size="small" color="error" label="Stock-out" />}
          {row.mode === 'MANUAL' && <Chip size="small" variant="outlined" label="Manual" />}
        </Stack>
      ),
    },
    { field: 'amc', headerName: 'AMC', type: 'number', width: 90 },
    { field: 'available', headerName: 'Available', type: 'number', width: 100 },
    { field: 'onOrder', headerName: 'On order', type: 'number', width: 90, valueFormatter: (v: number) => v || '' },
    { field: 'inTransit', headerName: 'In transit', type: 'number', width: 90, valueFormatter: (v: number) => v || '' },
    { field: 'reorderLevel', headerName: 'Reorder at', type: 'number', width: 100 },
    { field: 'maxLevel', headerName: 'Max', type: 'number', width: 90 },
    { field: 'daysOfStock', headerName: 'Days left', type: 'number', width: 90, valueFormatter: (v: number | null) => (v === null ? '—' : v) },
    {
      field: 'suggestedQty',
      headerName: 'Order qty',
      width: 120,
      renderCell: ({ row }) => (
        <TextField
          size="small"
          type="number"
          value={qty[row.itemId] ?? row.suggestedQty}
          onChange={(e) => setQty({ ...qty, [row.itemId]: Math.max(0, Number(e.target.value) || 0) })}
          onClick={(e) => e.stopPropagation()}
          slotProps={{ htmlInput: { min: 0, 'aria-label': `Order quantity of ${row.itemName}` } }}
          sx={{ width: 100 }}
        />
      ),
    },
    { field: 'uom', headerName: 'Unit', width: 70 },
    { field: 'suggestedValue', headerName: 'Value', type: 'number', width: 120, valueGetter: (_v, r) => (qty[r.itemId] ?? r.suggestedQty) * r.unitCost, valueFormatter: (v: number) => money(v) },
  ];
  return (
    <>
      <PageHeader title="Suggested reorder" search={search} onSearch={setSearch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <StoreSelect value={storeId} onChange={(v) => { setStoreId(v); setSelected(new Set()); setQty({}); }} sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} sx={{ width: { xs: '100%', md: 220 } }}>
          <MenuItem value="">All</MenuItem>
          {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch checked={belowOnly} onChange={(e) => setBelowOnly(e.target.checked)} />} label="At or below reorder level only" />
        <Box sx={{ flexGrow: 1 }} />
        <ExportButtons path="/stock-planning/reorder" query={query} />
        {canOrder && (
          <Button variant="contained" disabled={!lines.length} onClick={() => setDialog(true)}>
            {store?.parentStoreId ? 'Request from parent store' : 'Create draft PR'} ({lines.length})
          </Button>
        )}
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          getRowId={(r) => r.itemId}
          rows={rows}
          columns={columns}
          loading={isFetching}
          checkboxSelection
          disableRowSelectionOnClick
          rowSelectionModel={[...selected]}
          onRowSelectionModelChange={(m) => setSelected(new Set(m.map(String)))}
          pageSizeOptions={[50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">
        Available = on hand − reserved (usable stock only). Position also counts open purchase orders and stock in transit when the setting is on. Levels come from
        the AMC (AUTO) or are entered by hand (Manual) under Stock levels.
      </Typography>
      {dialog && store && <RequisitionDialog store={store} lines={lines} onClose={() => setDialog(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ expiry

function RedistributeDialog({ row, stores, onClose }: { row: ExpiryRow; stores: Store[]; onClose(): void }) {
  const navigate = useNavigate();
  const [toStoreId, setTo] = useState(row.suggestedStore?.id ?? '');
  const [quantity, setQuantity] = useState(row.quantity - row.reserved);
  const send = useApiMutation<void>(
    () => ['/stock-planning/expiry/redistribute', { method: 'POST', body: { batchId: row.batchId, fromStoreId: row.storeId, toStoreId, quantity } }],
    { invalidate: ['/inventory'], success: 'Transfer raised; dispatch it from Transfers' },
  );
  return (
    <FormDialog open title={`Redistribute ${row.itemName} · ${row.batchNo}`} submitLabel="Raise transfer" onClose={onClose} submitting={send.isPending} onSubmit={(e) => { e.preventDefault(); send.mutate(undefined, { onSuccess: () => navigate('/transfers') }); }}>
      {row.suggestedStore && <Alert severity="info">{row.suggestedStore.name} uses the most ({row.suggestedStore.amc} {row.uom} a month).</Alert>}
      <TextField select label="To store" value={toStoreId} onChange={(e) => setTo(e.target.value)} required>
        {stores.filter((s) => s.id !== row.storeId).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField label={`Quantity (${row.uom})`} type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
    </FormDialog>
  );
}

function WriteOffDialog({ row, onClose }: { row: ExpiryRow; onClose(): void }) {
  const [lines, setLines] = useState(row.bins.map((b) => ({ ...b, take: b.quantity })));
  const [notes, setNotes] = useState('');
  const send = useApiMutation<void>(
    () => [
      '/stock-planning/expiry/write-off',
      { method: 'POST', body: { storeId: row.storeId, notes: notes || undefined, lines: lines.filter((l) => l.take > 0).map((l) => ({ batchId: row.batchId, binId: l.binId, quantity: l.take })) } },
    ],
    { invalidate: ['/inventory', '/stock-planning'], success: 'Write-off submitted for approval' },
  );
  return (
    <FormDialog open title={`Write off ${row.itemName} · ${row.batchNo}`} submitLabel="Submit write-off" onClose={onClose} submitting={send.isPending} onSubmit={(e) => { e.preventDefault(); send.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">A stock adjustment with the disposal reason is submitted for approval. Once posted, print the disposal certificate from Adjustments.</Typography>
      {lines.map((l, i) => (
        <TextField key={l.binId ?? 'none'} label={`Bin ${l.binCode ?? '—'} (has ${l.quantity})`} type="number" value={l.take} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, take: Math.max(0, Number(e.target.value) || 0) } : x)))} />
      ))}
      <TextField label="Notes (method of disposal, etc.)" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
    </FormDialog>
  );
}

export function ExpiryPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const { expiryWarningDays } = useSettings();
  const horizons = [...expiryWarningDays].sort((a, b) => a - b);
  const { storeId, setStoreId, stores } = useStoreParam();
  const [horizon, setHorizon] = useState(horizons.at(-1) ?? 180);
  const [includeExpired, setIncludeExpired] = useState(true);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<{ kind: 'move' | 'writeoff'; row: ExpiryRow } | null>(null);
  const q = useDebounced(search);
  const query = { storeId, horizonDays: horizon, includeExpired, search: q || undefined };
  const { data, isFetching } = useQuery({ queryKey: ['/stock-planning/expiry', query], queryFn: () => api<ExpiryRow[]>('/stock-planning/expiry', { query }), enabled: !!storeId });
  const rows = data ?? [];
  const total = rows.reduce((s, r) => s + r.value, 0);
  const columns: GridColDef<ExpiryRow>[] = [
    { field: 'itemName', headerName: 'Item', flex: 1, minWidth: 200 },
    { field: 'batchNo', headerName: 'Batch', width: 120 },
    { field: 'expiryDate', headerName: 'Expiry', width: 170, renderCell: ({ value }) => <ExpiryChip date={value} /> },
    { field: 'quantity', headerName: 'Qty', type: 'number', width: 80 },
    { field: 'uom', headerName: 'Unit', width: 70 },
    { field: 'value', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
    { field: 'daysToConsume', headerName: 'Days to use up', type: 'number', width: 120, valueFormatter: (v: number | null) => (v === null ? 'no use' : v) },
    { field: 'atRisk', headerName: 'At risk', width: 80, renderCell: ({ value }) => (value ? <Chip size="small" color="warning" label="Yes" /> : '') },
    { field: 'suggestedStore', headerName: 'Uses more', width: 150, valueGetter: (_v, r) => r.suggestedStore?.name ?? '' },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 300,
      sortable: false,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} sx={{ height: '100%' }} alignItems="center">
          {row.daysLeft > 0 && row.holdStatus === 'NONE' && can(Permissions.INVENTORY_PLANNING, Permissions.INVENTORY_TRANSFER_REQUEST) && (
            <Button size="small" onClick={() => setAction({ kind: 'move', row })}>Redistribute</Button>
          )}
          {can(Permissions.INVENTORY_SUPPLIER_RETURN) && <Button size="small" onClick={() => navigate(`/supplier-returns/new?storeId=${row.storeId}`)}>Return</Button>}
          {can(Permissions.INVENTORY_PLANNING, Permissions.INVENTORY_ADJUST) && <Button size="small" color="error" onClick={() => setAction({ kind: 'writeoff', row })}>Write off</Button>}
        </Stack>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Near-expiry and expired stock" search={search} onSearch={setSearch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <StoreSelect value={storeId} onChange={setStoreId} sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField select label="Expiring within" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} sx={{ width: { xs: '100%', md: 180 } }}>
          {horizons.map((h) => <MenuItem key={h} value={h}>{h} days</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} />} label="Include expired" />
        <Typography sx={{ flexGrow: 1 }}>Value at risk: <b>{money(total)}</b></Typography>
        <ExportButtons path="/stock-planning/expiry" query={query} />
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" getRowId={(r) => `${r.storeId}:${r.batchId}`} rows={rows} columns={columns} loading={isFetching} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
      {action?.kind === 'move' && <RedistributeDialog row={action.row} stores={stores} onClose={() => setAction(null)} />}
      {action?.kind === 'writeoff' && <WriteOffDialog row={action.row} onClose={() => setAction(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ stock levels (store item settings)

function SettingDialog({ s, onClose }: { s: StoreItemSetting; onClose(): void }) {
  const [form, setForm] = useState({
    mode: s.mode,
    minLevel: s.minLevel,
    reorderLevel: s.reorderLevel,
    maxLevel: s.maxLevel,
    reorderQty: s.reorderQty,
    safetyStock: s.safetyStock,
    leadTimeDays: s.leadTimeDays ?? '',
    reviewPeriodDays: s.reviewPeriodDays ?? '',
  });
  const manual = form.mode === 'MANUAL';
  const save = useApiMutation<void>(
    () => [
      `/stock-planning/settings/${s.id}`,
      {
        method: 'PUT',
        body: {
          mode: form.mode,
          leadTimeDays: form.leadTimeDays === '' ? null : Number(form.leadTimeDays),
          reviewPeriodDays: form.reviewPeriodDays === '' ? null : Number(form.reviewPeriodDays),
          ...(manual ? { minLevel: +form.minLevel, reorderLevel: +form.reorderLevel, maxLevel: +form.maxLevel, reorderQty: +form.reorderQty, safetyStock: +form.safetyStock } : {}),
        },
      },
    ],
    { invalidate: ['/stock-planning'], success: 'Stock levels saved' },
  );
  const num = (k: keyof typeof form, label: string, disabled = false) => (
    <TextField label={label} type="number" value={form[k]} disabled={disabled} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );
  return (
    <FormDialog open title={`${s.item?.name} — stock levels`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">AMC {s.amc} {s.item?.baseUom?.code}/month{s.amcDays ? ` (averaged over ${s.amcDays} days with stock)` : ''}.</Typography>
      <TextField select label="Mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'AUTO' | 'MANUAL' })}>
        <MenuItem value="AUTO">AUTO — recalculated nightly from the AMC</MenuItem>
        <MenuItem value="MANUAL">MANUAL — keep the levels I enter</MenuItem>
      </TextField>
      <Stack direction="row" spacing={2}>{num('leadTimeDays', 'Lead time (days, blank = default)')}{num('reviewPeriodDays', 'Review period (days, blank = default)')}</Stack>
      <Stack direction="row" spacing={2}>{num('minLevel', 'Min', !manual)}{num('safetyStock', 'Safety stock', !manual)}</Stack>
      <Stack direction="row" spacing={2}>{num('reorderLevel', 'Reorder level', !manual)}{num('maxLevel', 'Max', !manual)}{num('reorderQty', 'Reorder qty', !manual)}</Stack>
    </FormDialog>
  );
}

export function StockLevelsPage() {
  const { can } = useAuth();
  const { storeId, setStoreId } = useStoreParam();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<StoreItemSetting | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = useQuery({
    queryKey: ['/stock-planning/settings', storeId, q],
    queryFn: () => api<StoreItemSetting[]>('/stock-planning/settings', { query: { storeId, search: q || undefined } }),
    enabled: !!storeId,
  });
  const recalc = useApiMutation<void>(() => ['/stock-planning/recalculate', { method: 'POST', query: { storeId } }], { invalidate: ['/stock-planning'], success: 'Recalculated' });
  const columns: GridColDef<StoreItemSetting>[] = [
    { field: 'item', headerName: 'Item', flex: 1, minWidth: 220, valueGetter: (_v, r) => r.item?.name ?? '' },
    { field: 'mode', headerName: 'Mode', width: 90 },
    { field: 'amc', headerName: 'AMC', type: 'number', width: 90 },
    { field: 'minLevel', headerName: 'Min', type: 'number', width: 80 },
    { field: 'safetyStock', headerName: 'Safety', type: 'number', width: 80 },
    { field: 'reorderLevel', headerName: 'Reorder at', type: 'number', width: 100 },
    { field: 'maxLevel', headerName: 'Max', type: 'number', width: 90 },
    { field: 'reorderQty', headerName: 'Reorder qty', type: 'number', width: 100 },
    { field: 'leadTimeDays', headerName: 'Lead time', type: 'number', width: 90, valueFormatter: (v: number | null) => (v === null ? 'default' : v) },
    { field: 'amcCalculatedAt', headerName: 'Updated', width: 110, valueFormatter: (v: string | null) => date(v) },
  ];
  return (
    <>
      <PageHeader title="Stock levels (min / max / reorder)" search={search} onSearch={setSearch} />
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} alignItems="center">
        <StoreSelect value={storeId} onChange={setStoreId} sx={{ width: 240 }} />
        {can(Permissions.INVENTORY_PLANNING) && <Button variant="outlined" disabled={recalc.isPending || !storeId} onClick={() => recalc.mutate()}>Recalculate now</Button>}
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => can(Permissions.INVENTORY_PLANNING) && setEditing(row)} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
      {editing && <SettingDialog s={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ alerts, jobs, dashboard

const ALERT_COLOURS: Record<string, 'warning' | 'error' | 'info'> = { REORDER: 'warning', STOCKOUT: 'error', NEAR_EXPIRY: 'info', EXPIRED: 'error' };

export function AlertsPage() {
  const date = useDate();
  const money = useMoney();
  const [params] = useSearchParams();
  const [storeId, setStoreId] = useState(params.get('storeId') ?? '');
  const [type, setType] = useState(params.get('type') ?? '');
  const [status, setStatus] = useState('OPEN');
  const { data, isFetching } = useList<StockAlertRow>('/stock-planning/alerts', { storeId, type, status });
  const columns: GridColDef<StockAlertRow>[] = [
    { field: 'type', headerName: 'Type', width: 130, renderCell: ({ value }) => <Chip size="small" color={ALERT_COLOURS[value]} label={humanise(value)} /> },
    { field: 'storeName', headerName: 'Store', width: 150 },
    { field: 'message', headerName: 'Alert', flex: 1, minWidth: 320 },
    { field: 'horizonDays', headerName: 'Horizon', width: 90, valueFormatter: (v: number | null) => (v ? `${v} d` : '') },
    { field: 'value', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number | null) => (v == null ? '' : money(v)) },
    { field: 'raisedAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader title="Stock alerts" />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value)} sx={{ width: { xs: '100%', md: 180 } }}>
          <MenuItem value="">All</MenuItem>
          {Object.keys(ALERT_COLOURS).map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
        </TextField>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', md: 150 } }}>
          <MenuItem value="OPEN">Open</MenuItem>
          <MenuItem value="RESOLVED">Resolved</MenuItem>
        </TextField>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
    </>
  );
}

export function JobsPage() {
  const date = useDate();
  const status = useQuery({ queryKey: ['/jobs'], queryFn: () => api<JobStatus>('/jobs'), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ['/jobs/runs'], queryFn: () => api<JobRun[]>('/jobs/runs'), refetchInterval: 15_000 });
  const run = useApiMutation<string>((name) => [`/jobs/${name}/run`, { method: 'POST', body: {} }], { invalidate: ['/jobs'], success: 'Job started' });
  const when = (v: string | null | undefined) => (v ? `${date(v)} ${new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');
  return (
    <>
      <PageHeader title="Background jobs" />
      <Alert severity="info" sx={{ mb: 2 }}>
        Mode: <b>{status.data?.mode}</b>. Schedules are cron expressions in the hospital time zone, set in the setting <code>jobs.schedules</code>; the worker applies changes when it restarts.
      </Alert>
      <Paper sx={{ mb: 2 }}>
        <Table size="small" aria-label="Jobs">
          <TableHead><TableRow><TableCell>Job</TableCell><TableCell>Schedule</TableCell><TableCell>Last run</TableCell><TableCell>Result</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {(status.data?.jobs ?? []).map((j) => (
              <TableRow key={j.name}>
                <TableCell><b>{j.name}</b><Typography variant="caption" display="block">{j.description}</Typography></TableCell>
                <TableCell><code>{j.schedule ?? 'on demand / event'}</code></TableCell>
                <TableCell>{j.lastRun ? <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={j.lastRun.status} /><span>{when(j.lastRun.startedAt)}</span></Stack> : '—'}</TableCell>
                <TableCell sx={{ maxWidth: 360, fontFamily: 'monospace', fontSize: 12 }}>{j.lastRun?.error ? j.lastRun.error.split('\n')[0] : JSON.stringify(j.lastRun?.result ?? '')}</TableCell>
                <TableCell>{j.name !== 'stores.replan' && <Button size="small" disabled={run.isPending} onClick={() => run.mutate(j.name)}>Run now</Button>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Recent runs</Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={runs.data ?? []}
          columns={[
            { field: 'name', headerName: 'Job', width: 170 },
            { field: 'trigger', headerName: 'Trigger', width: 100 },
            { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'startedAt', headerName: 'Started', width: 160, valueFormatter: (v: string) => when(v) },
            { field: 'result', headerName: 'Result', flex: 1, minWidth: 260, valueGetter: (_v, r: JobRun) => (r.error ? r.error.split('\n')[0] : JSON.stringify(r.result ?? '')) },
          ]}
          disableRowSelectionOnClick
          pageSizeOptions={[25, 50]}
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        />
      </Paper>
    </>
  );
}

/** Dashboard widgets for store roles: reorder alerts, stock-outs, near-expiry value by horizon. */
export function PlanningWidgets() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { currency } = useSettings();
  const enabled = can(Permissions.INVENTORY_READ);
  const { data } = useQuery({ queryKey: ['/stock-planning/dashboard'], queryFn: () => api<PlanningDashboard>('/stock-planning/dashboard'), enabled });
  if (!enabled || !data) return null;
  const card = (label: string, value: string | number, path: string, tone?: 'error' | 'warning') => (
    <Grid size={{ xs: 12, sm: 6, lg: 3 }} key={label}>
      <Card>
        <CardActionArea onClick={() => navigate(path)}>
          <CardContent>
            <Typography color="text.secondary" variant="body2">{label}</Typography>
            <Typography variant="h5" color={tone ? `${tone}.main` : undefined}>{value}</Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
  return (
    <Box sx={{ mb: 3 }} aria-label="Stock alerts summary">
      <Typography variant="h6" gutterBottom>Stock</Typography>
      <Grid container spacing={2}>
        {card('Items at reorder level', data.reorderAlerts, '/stock-planning/reorder', data.reorderAlerts ? 'warning' : undefined)}
        {card('Stock-outs', data.stockOuts, '/stock-planning/alerts?type=STOCKOUT', data.stockOuts ? 'error' : undefined)}
        {card('Expired stock on hand', formatMoney(data.expired.value, currency), '/stock-planning/expiry', data.expired.value ? 'error' : undefined)}
        {card('New expiry alerts (7 days)', data.newExpiryAlerts, '/stock-planning/alerts?type=NEAR_EXPIRY')}
      </Grid>
      <Paper sx={{ p: 2, mt: 2 }}>
        <Typography variant="subtitle2" gutterBottom>Near-expiry stock value</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
          {data.nearExpiry.map((b) => (
            <Box key={b.horizonDays} sx={{ cursor: 'pointer' }} onClick={() => navigate('/stock-planning/expiry')}>
              <Typography variant="caption" color="text.secondary">{b.label}</Typography>
              <Typography variant="h6">{formatMoney(b.value, currency)}</Typography>
              <Typography variant="caption">{b.batches} batch(es)</Typography>
            </Box>
          ))}
        </Stack>
      </Paper>
    </Box>
  );
}

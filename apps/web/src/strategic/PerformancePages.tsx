import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Link,
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
import Grid from '@mui/material/Grid2';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { DeliveryStage, Permissions, SanctionType } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip, StoreSelect } from '../inventory/components';
import { humanise } from '../lib/format';
import { ApprovalPanel, useDate, useMoney } from '../purchasing/common';
import { useSupplierOptions } from '../purchasing/RequisitionsPages';
import { shiftMonth } from './ForecastPages';
import type { AgencyOrder, CorrectiveAction, DeliveryEvent, Kpis, OrderTemplate, Sanction, Scorecard } from './api';

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const rate = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);

/** Colour for an overall score against the action threshold. */
export function scoreColour(score: number | null, threshold = 60): 'success' | 'warning' | 'error' | 'default' {
  if (score === null) return 'default';
  if (score < threshold) return 'error';
  if (score < threshold + 15) return 'warning';
  return 'success';
}

// ------------------------------------------------------------------ supplier performance

function Scorecards() {
  const { can } = useAuth();
  const [period, setPeriod] = useState(shiftMonth(todayStr().slice(0, 7), -1));
  const { data, isFetching } = useList<Scorecard>('/supplier-performance/scorecards', { period });
  const compute = useApiMutation<void>(() => ['/supplier-performance/scorecards/compute', { method: 'POST', body: { period } }], { invalidate: ['/supplier-performance'], success: 'Scorecards computed' });
  const columns: GridColDef<Scorecard>[] = [
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 220, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'overallScore', headerName: 'Score', width: 100, renderCell: ({ value }) => <Chip size="small" color={scoreColour(value)} label={value ?? '—'} /> },
    { field: 'onTimeRate', headerName: 'On time', width: 90, valueFormatter: rate },
    { field: 'inFullRate', headerName: 'In full', width: 90, valueFormatter: rate },
    { field: 'otifRate', headerName: 'OTIF', width: 90, valueFormatter: rate },
    { field: 'qualityRejectRate', headerName: 'Rejected', width: 90, valueFormatter: rate },
    { field: 'priceComplianceRate', headerName: 'Price', width: 90, valueFormatter: rate },
    { field: 'documentComplianceRate', headerName: 'Documents', width: 100, valueFormatter: rate },
    { field: 'ordersDue', headerName: 'Orders due', type: 'number', width: 100 },
  ];
  return (
    <>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} alignItems="center">
        <TextField label="Month" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        {can(Permissions.SUPPLIERS_PERFORMANCE) && <Button variant="outlined" disabled={compute.isPending} onClick={() => compute.mutate()}>Compute now</Button>}
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
      <Typography variant="caption" color="text.secondary">
        Weights and the threshold below which a corrective action is raised automatically are in the settings suppliers.scorecardWeights and suppliers.scorecardActionThreshold. Quality is scored as 100 − reject rate.
      </Typography>
    </>
  );
}

function ActionDialog({ onClose }: { onClose(): void }) {
  const suppliers = useSupplierOptions();
  const [form, setForm] = useState({ supplierId: '', issue: '', actionRequired: '', dueDate: '' });
  const save = useApiMutation<void>(() => ['/supplier-performance/corrective-actions', { method: 'POST', body: { ...form, dueDate: form.dueDate || undefined } }], { invalidate: ['/supplier-performance'], success: 'Corrective action raised' });
  return (
    <FormDialog open title="Corrective action" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Supplier" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} required>
        {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField label="Issue" value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} required multiline minRows={2} />
      <TextField label="Action required" value={form.actionRequired} onChange={(e) => setForm({ ...form, actionRequired: e.target.value })} required multiline minRows={2} />
      <TextField label="Due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
    </FormDialog>
  );
}

function CloseActionDialog({ action, onClose }: { action: CorrectiveAction; onClose(): void }) {
  const [outcome, setOutcome] = useState('');
  const save = useApiMutation<void>(() => [`/supplier-performance/corrective-actions/${action.id}/close`, { method: 'POST', body: { outcome } }], { invalidate: ['/supplier-performance'], success: 'Closed' });
  return (
    <FormDialog open title="Close corrective action" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">{action.supplier?.name}: {action.issue}</Typography>
      <TextField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} required multiline minRows={2} />
    </FormDialog>
  );
}

function CorrectiveActions() {
  const { can } = useAuth();
  const date = useDate();
  const [status, setStatus] = useState('OPEN');
  const { data, isFetching } = useList<CorrectiveAction>('/supplier-performance/corrective-actions', { status: status || undefined });
  const [dialog, setDialog] = useState<CorrectiveAction | 'new' | null>(null);
  const manage = can(Permissions.SUPPLIERS_PERFORMANCE);
  return (
    <>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: 160 }}>
          <MenuItem value="">All</MenuItem>
          <MenuItem value="OPEN">Open</MenuItem>
          <MenuItem value="CLOSED">Closed</MenuItem>
        </TextField>
        {manage && <Button startIcon={<AddIcon />} onClick={() => setDialog('new')}>Raise action</Button>}
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'supplier', headerName: 'Supplier', width: 200, valueGetter: (_v, r: CorrectiveAction) => r.supplier?.name ?? '' },
            { field: 'issue', headerName: 'Issue', flex: 1, minWidth: 220 },
            { field: 'actionRequired', headerName: 'Action required', flex: 1, minWidth: 220 },
            { field: 'dueDate', headerName: 'Due', width: 110, valueFormatter: (v: string | null) => date(v) },
            { field: 'status', headerName: 'Status', width: 110, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'outcome', headerName: 'Outcome', width: 200 },
          ]}
          onRowClick={({ row }) => manage && row.status === 'OPEN' && setDialog(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      {dialog === 'new' && <ActionDialog onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'new' && <CloseActionDialog action={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

function SanctionDialog({ onClose }: { onClose(): void }) {
  const suppliers = useAll<{ id: string; name: string; status: string }>('/suppliers');
  const [form, setForm] = useState({ supplierId: '', type: SanctionType.SUSPEND as string, reason: '', effectiveFrom: todayStr(), effectiveTo: '' });
  const save = useApiMutation<void>(
    () => ['/supplier-performance/sanctions', { method: 'POST', body: { ...form, effectiveTo: form.type === SanctionType.SUSPEND && form.effectiveTo ? form.effectiveTo : undefined } }],
    { invalidate: ['/supplier-performance', '/approvals'], success: 'Sent for approval' },
  );
  return (
    <FormDialog open title="Suspend, blacklist or reinstate a supplier" submitLabel="Submit for approval" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Supplier" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} required>
        {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name} ({humanise(s.status)})</MenuItem>)}
      </TextField>
      <TextField select label="Action" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
        {Object.values(SanctionType).map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
      </TextField>
      <TextField label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required multiline minRows={2} />
      <Stack direction="row" spacing={2}>
        <TextField label="From" type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        {form.type === SanctionType.SUSPEND && <TextField label="Until (blank = indefinite)" type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />}
      </Stack>
    </FormDialog>
  );
}

function Sanctions() {
  const { can } = useAuth();
  const date = useDate();
  const { data, isFetching } = useList<Sanction>('/supplier-performance/sanctions');
  const [dialog, setDialog] = useState(false);
  const [open, setOpen] = useState<Sanction | null>(null);
  return (
    <>
      {can(Permissions.SUPPLIERS_PERFORMANCE) && <Stack direction="row" sx={{ mb: 2 }}><Button startIcon={<AddIcon />} onClick={() => setDialog(true)}>New request</Button></Stack>}
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'Number', width: 140 },
            { field: 'supplier', headerName: 'Supplier', width: 200, valueGetter: (_v, r: Sanction) => r.supplier?.name ?? '' },
            { field: 'type', headerName: 'Action', width: 120, valueFormatter: (v: string) => humanise(v) },
            { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 220 },
            { field: 'effectiveFrom', headerName: 'From', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'effectiveTo', headerName: 'Until', width: 110, valueFormatter: (v: string | null) => (v ? date(v) : '') },
            { field: 'status', headerName: 'Status', width: 150, renderCell: ({ value }) => <StatusChip status={value} /> },
          ]}
          onRowClick={({ row }) => setOpen(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      {dialog && <SanctionDialog onClose={() => setDialog(false)} />}
      {open && (
        <Dialog open onClose={() => setOpen(null)} maxWidth="sm" fullWidth>
          <DialogTitle>{open.number} · {humanise(open.type)} {open.supplier?.name}</DialogTitle>
          <DialogContent dividers>
            <Typography variant="body2" sx={{ mb: 2 }}>{open.reason}</Typography>
            <ApprovalPanel type="SSN" id={open.id} />
          </DialogContent>
          <DialogActions><Button onClick={() => setOpen(null)}>Close</Button></DialogActions>
        </Dialog>
      )}
    </>
  );
}

export function SupplierPerformancePage() {
  const [tab, setTab] = useState(0);
  return (
    <>
      <PageHeader title="Supplier performance" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Scorecards" />
        <Tab label="Corrective actions" />
        <Tab label="Suspension and blacklisting" />
      </Tabs>
      {tab === 0 && <Scorecards />}
      {tab === 1 && <CorrectiveActions />}
      {tab === 2 && <Sanctions />}
    </>
  );
}

// ------------------------------------------------------------------ KEMSA / MEDS order cycles

function TemplateDialog({ row, onClose }: { row: OrderTemplate | null; onClose(): void }) {
  const suppliers = useAll<{ id: string; name: string; nationalAgency: string | null }>('/suppliers', { status: 'ACTIVE' });
  const departments = useAll<Department>('/departments');
  const [form, setForm] = useState({
    name: row?.name ?? '',
    supplierId: row?.supplierId ?? '',
    storeId: row?.storeId ?? '',
    departmentId: row?.departmentId ?? '',
    frequencyMonths: row?.frequencyMonths ?? 1,
    nextOrderDate: row?.nextOrderDate ?? todayStr(),
    leadTimeDays: row?.leadTimeDays ?? 21,
    quantityMode: row?.quantityMode ?? 'SUGGESTED',
    isActive: row?.isActive ?? true,
  });
  const [lines, setLines] = useState<{ item: Item | null; itemId: string; quantity: number }[]>((row?.lines ?? []).map((l) => ({ item: null, itemId: l.itemId, quantity: l.quantity })));
  const agencies = (suppliers.data ?? []).filter((s) => s.nationalAgency);
  const save = useApiMutation<void>(
    () => [row ? `/order-templates/${row.id}` : '/order-templates', { method: row ? 'PUT' : 'POST', body: { ...form, frequencyMonths: Number(form.frequencyMonths), leadTimeDays: Number(form.leadTimeDays), lines: lines.filter((l) => l.item || l.itemId).map((l) => ({ itemId: l.item?.id ?? l.itemId, quantity: Number(l.quantity) })) } }],
    { invalidate: ['/order-templates'], success: 'Order template saved' },
  );
  return (
    <FormDialog open maxWidth="md" title={row ? row.name : 'New order template'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <Stack direction="row" spacing={2}>
        <TextField select label="Agency" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} sx={{ flex: 1 }} helperText={agencies.length ? undefined : 'Mark the supplier as KEMSA or MEDS first'}>
          {agencies.map((s) => <MenuItem key={s.id} value={s.id}>{s.name} ({s.nationalAgency})</MenuItem>)}
        </TextField>
        <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v })} sx={{ flex: 1 }} />
        <TextField select label="Department" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} sx={{ flex: 1 }}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      </Stack>
      <Stack direction="row" spacing={2}>
        <TextField label="Every (months)" type="number" value={form.frequencyMonths} onChange={(e) => setForm({ ...form, frequencyMonths: Number(e.target.value) })} />
        <TextField label="Next order" type="date" value={form.nextOrderDate} onChange={(e) => setForm({ ...form, nextOrderDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Lead time (days)" type="number" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: Number(e.target.value) })} />
        <TextField select label="Quantities" value={form.quantityMode} onChange={(e) => setForm({ ...form, quantityMode: e.target.value as 'FIXED' | 'SUGGESTED' })}>
          <MenuItem value="SUGGESTED">Forecast suggestion</MenuItem>
          <MenuItem value="FIXED">Fixed (below)</MenuItem>
        </TextField>
      </Stack>
      {lines.map((l, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
          <ItemPicker value={l.item} onChange={(item) => setLines(lines.map((x, j) => (j === i ? { ...x, item, itemId: item?.id ?? '' } : x)))} label={l.item || !l.itemId ? 'Item' : 'Item (saved — search to change)'} />
          <TextField label="Quantity" type="number" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} sx={{ width: 130 }} />
          <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><DeleteIcon /></IconButton>
        </Stack>
      ))}
      <Box><Button startIcon={<AddIcon />} onClick={() => setLines([...lines, { item: null, itemId: '', quantity: 0 }])}>Add item</Button></Box>
      <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label="Active (the order-cycle job raises a draft PO when due)" />
    </FormDialog>
  );
}

function DeliveryDialog({ order, onClose }: { order: AgencyOrder; onClose(): void }) {
  const date = useDate();
  const events = useQuery({ queryKey: ['/purchase-orders', order.id, 'deliveries'], queryFn: () => api<DeliveryEvent[]>(`/purchase-orders/${order.id}/deliveries`) });
  const [form, setForm] = useState({ stage: DeliveryStage.DISPATCHED as string, reference: '', expectedDate: '', note: '' });
  const track = useApiMutation<void>(() => [`/purchase-orders/${order.id}/deliveries`, { method: 'POST', body: { stage: form.stage, reference: form.reference || undefined, expectedDate: form.expectedDate || undefined, note: form.note || undefined } }], {
    invalidate: ['/purchase-orders', '/order-templates'],
    success: 'Delivery status recorded',
  });
  return (
    <FormDialog open title={`Delivery tracking · ${order.number}`} submitLabel="Record" onClose={onClose} submitting={track.isPending} onSubmit={(e) => { e.preventDefault(); track.mutate(undefined, { onSuccess: () => setForm({ ...form, reference: '', note: '' }) }); }}>
      {(events.data ?? []).map((ev) => (
        <Typography key={ev.id} variant="body2">{date(ev.at)} · {humanise(ev.stage)}{ev.reference ? ` · ${ev.reference}` : ''}{ev.expectedDate ? ` · expected ${date(ev.expectedDate)}` : ''}{ev.viaPortal ? ' (portal)' : ''}{ev.note ? ` — ${ev.note}` : ''}</Typography>
      ))}
      <Stack direction="row" spacing={2}>
        <TextField select label="Stage" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} sx={{ minWidth: 160, width: 'auto' }}>
          {Object.values(DeliveryStage).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        <TextField label="Reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        <TextField label="Expected" type="date" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <TextField label="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
    </FormDialog>
  );
}

export function AgencyOrdersPage() {
  const { can } = useAuth();
  const date = useDate();
  const money = useMoney();
  const templates = useList<OrderTemplate>('/order-templates');
  const orders = useList<AgencyOrder>('/order-templates/agency-orders');
  const [editing, setEditing] = useState<OrderTemplate | null | 'new'>(null);
  const [tracking, setTracking] = useState<AgencyOrder | null>(null);
  const raise = useApiMutation<string, { purchaseOrderId: string | null; skipped: string | null }>((id) => [`/order-templates/${id}/raise`, { method: 'POST' }], { invalidate: ['/order-templates', '/purchase-orders'], success: 'Draft order raised' });
  const manage = can(Permissions.PURCHASING_PO);
  return (
    <>
      <PageHeader title="KEMSA / MEDS order cycles" onNew={manage ? () => setEditing('new') : undefined} newLabel="New template" />
      <Paper sx={{ mb: 3 }}>
        <Table size="small" aria-label="Order templates">
          <TableHead><TableRow><TableCell>Template</TableCell><TableCell>Agency</TableCell><TableCell>Store</TableCell><TableCell>Cycle</TableCell><TableCell>Next order</TableCell><TableCell>Last</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {(templates.data ?? []).map((t) => (
              <TableRow key={t.id} hover>
                <TableCell><Link component="button" onClick={() => manage && setEditing(t)}>{t.name}</Link>{!t.isActive && <Chip size="small" label="Inactive" sx={{ ml: 1 }} />}</TableCell>
                <TableCell>{t.supplier?.name}</TableCell>
                <TableCell>{t.store?.name}</TableCell>
                <TableCell>Every {t.frequencyMonths} month(s) · {t.quantityMode === 'SUGGESTED' ? 'forecast quantities' : 'fixed quantities'}</TableCell>
                <TableCell>{date(t.nextOrderDate)}</TableCell>
                <TableCell>{date(t.lastOrderedOn)}</TableCell>
                <TableCell>{manage && t.isActive && <Button size="small" disabled={raise.isPending} onClick={() => raise.mutate(t.id)}>Raise now</Button>}</TableCell>
              </TableRow>
            ))}
            {!templates.data?.length && <TableRow><TableCell colSpan={7}><Typography color="text.secondary">No templates.</Typography></TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Open agency orders</Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={orders.data ?? []}
          loading={orders.isFetching}
          columns={[
            { field: 'number', headerName: 'PO', width: 150, renderCell: ({ row }) => <Link component={RouterLink} to={`/purchase-orders/${row.id}`}>{row.number}</Link> },
            { field: 'agency', headerName: 'Agency', width: 100 },
            { field: 'store', headerName: 'Store', width: 160 },
            { field: 'orderDate', headerName: 'Ordered', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'status', headerName: 'Status', width: 140, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'deliveryStage', headerName: 'Delivery', width: 140, valueFormatter: (v: string | null) => (v ? humanise(v) : '—') },
            { field: 'expectedDelivery', headerName: 'Expected', width: 110, valueFormatter: (v: string | null) => date(v) },
            { field: 'total', headerName: 'Total', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
          ]}
          onRowClick={({ row }) => setTracking(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      {editing && <TemplateDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {tracking && <DeliveryDialog order={tracking} onClose={() => setTracking(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ KPIs

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
      <Card>
        <CardContent>
          <Typography color="text.secondary" variant="body2">{label}</Typography>
          <Typography variant="h5">{value}</Typography>
          {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
        </CardContent>
      </Card>
    </Grid>
  );
}

function SpendBars({ title, rows }: { title: string; rows: { label: string; spend: number }[] }) {
  const money = useMoney();
  const max = Math.max(1, ...rows.map((r) => r.spend));
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>{title}</Typography>
      {rows.length === 0 && <Typography color="text.secondary">No spend in the period.</Typography>}
      <Stack spacing={1}>
        {rows.map((r) => (
          <Box key={r.label}>
            <Stack direction="row" justifyContent="space-between"><Typography variant="body2">{r.label}</Typography><Typography variant="body2">{money(r.spend)}</Typography></Stack>
            <LinearProgress variant="determinate" value={(100 * r.spend) / max} aria-label={`${r.label} spend`} />
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

export function KpiPage() {
  const money = useMoney();
  const date = useDate();
  const today = todayStr();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const { data } = useQuery({ queryKey: ['/procurement/kpis', from, to], queryFn: () => api<Kpis>('/procurement/kpis', { query: { from, to } }), enabled: !!from && !!to && from <= to });
  const days = (v: number | null) => (v === null ? '—' : `${v} days`);
  const methodLabel = (m: string) => humanise(m);
  return (
    <>
      <PageHeader title="Procurement KPIs" />
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      {data && (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">{date(data.period.from)} – {date(data.period.to)} · {data.leadTimes.orders} committed purchase orders · values VAT exclusive</Typography>
          <Grid container spacing={2}>
            <Kpi label="PR approved → PO" value={days(data.leadTimes.prToPoDays)} />
            <Kpi label="PO approved → first GRN" value={days(data.leadTimes.poToGrnDays)} />
            <Kpi label="PR → GRN" value={days(data.leadTimes.prToGrnDays)} />
            <Kpi label="On time in full" value={rate(data.otif.percent)} hint={`${data.otif.otif} of ${data.otif.ordersDue} orders due`} />
            <Kpi label="Total spend" value={money(data.spend.total)} />
            <Kpi label="Spend under contract" value={rate(data.spend.underContractPercent)} hint={money(data.spend.underContract)} />
            <Kpi label="Savings vs estimates" value={money(data.savings.saved)} hint={`${rate(data.savings.percent)} of ${money(data.savings.estimate)} estimated`} />
            <Kpi label="Forecast accuracy (MAPE)" value={rate(data.forecastAccuracy.mape)} hint={`${data.forecastAccuracy.pairs} item-months`} />
          </Grid>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600}>Plan execution · FY {data.planExecution.financialYear}</Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>{data.planExecution.basis === 'HOSPITAL_PLAN' ? 'Approved hospital plan' : 'Approved departmental plans'}</Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Box sx={{ flex: 1 }}><LinearProgress variant="determinate" value={Math.min(100, data.planExecution.rate ?? 0)} aria-label="Plan execution" /></Box>
              <Typography>{money(data.planExecution.procured)} of {money(data.planExecution.planned)} ({rate(data.planExecution.rate)})</Typography>
            </Stack>
          </Paper>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 4 }}><SpendBars title="Spend by supplier" rows={data.spend.bySupplier.map((r) => ({ label: r.supplier, spend: r.spend }))} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><SpendBars title="Spend by category" rows={data.spend.byCategory.map((r) => ({ label: r.category, spend: r.spend }))} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><SpendBars title="Spend by method" rows={data.spend.byMethod.map((r) => ({ label: methodLabel(r.method), spend: r.spend }))} /></Grid>
          </Grid>
          {data.agpo && <SpendBars title="Spend by AGPO category (PPADA rule set)" rows={data.agpo.map((r) => ({ label: humanise(r.category), spend: r.spend }))} />}
        </Stack>
      )}
    </>
  );
}

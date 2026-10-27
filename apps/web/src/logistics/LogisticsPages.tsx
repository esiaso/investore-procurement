import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Link, MenuItem, Paper, Rating, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useApiMutation, useList } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { StatusChip, StoreSelect, useStores } from '../inventory/components';
import { humanise } from '../lib/format';
import { DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDays = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Route { id: string; code: string; name: string; fromStoreId: string; fromStore?: { name: string }; stopStoreIds: string[]; isActive: boolean }
interface Stop {
  id: string;
  sequence: number;
  transferId: string;
  transfer?: { number: string; status: string };
  toStoreId: string;
  toStore?: { name: string };
  status: string;
  packages: number;
  receivedByName: string | null;
  signatureName: string | null;
  deliveredAt: string | null;
  discrepancies: { allocationId: string; item: string; batchNo: string; dispatched: number; received: number; reasonCode: string | null; notes: string | null }[];
}
interface Run { id: string; number: string; routeId: string | null; route?: Route | null; fromStoreId: string; fromStore?: { name: string }; runDate: string; vehicle: string | null; driver: string | null; status: string; stops?: Stop[] }
interface PickingList {
  run: { id: string; number: string; runDate: string; fromStore: string; status: string };
  stops: { stopId: string; sequence: number; status: string; transferNo: string; toStore: string; lines: { lineId: string; itemId: string; itemCode: string; itemName: string; uom: string; requested: number; confirmed: boolean; shortfall: number; picks: { batchId: string; binId: string | null; binCode: string | null; batchNo: string; expiryDate: string | null; quantity: number }[] }[] }[];
}

// ------------------------------------------------------------------ distribution

function NewRunDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const [fromStoreId, setFrom] = useState('');
  const routes = useList<Route>('/distribution/routes');
  const pending = useQuery({ queryKey: ['/distribution/pending', fromStoreId], queryFn: () => api<{ id: string; number: string; toStore: string; lines: number; requestedAt: string }[]>('/distribution/pending', { query: { storeId: fromStoreId } }), enabled: !!fromStoreId });
  const [form, setForm] = useState({ routeId: '', runDate: today(), vehicle: '', driver: '' });
  const [chosen, setChosen] = useState<string[]>([]);
  const create = useApiMutation<void, Run>(() => ['/distribution/runs', { method: 'POST', body: { fromStoreId, routeId: form.routeId || undefined, runDate: form.runDate, vehicle: form.vehicle || undefined, driver: form.driver || undefined, transferIds: chosen } }], { invalidate: ['/distribution'], success: 'Run planned' });
  return (
    <FormDialog open maxWidth="md" title="Plan a delivery run" submitLabel="Plan run" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (r) => navigate(`/distribution/${r.id}`) }); }}>
      <StoreSelect value={fromStoreId} onChange={(v) => { setFrom(v); setChosen([]); }} label="From store" />
      <Stack direction="row" spacing={2}>
        <TextField select label="Route" value={form.routeId} onChange={(e) => setForm({ ...form, routeId: e.target.value })} sx={{ flex: 1 }}>
          <MenuItem value="">No route (stops by name)</MenuItem>
          {(routes.data ?? []).filter((r) => r.fromStoreId === fromStoreId).map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
        </TextField>
        <TextField label="Date" type="date" value={form.runDate} onChange={(e) => setForm({ ...form, runDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <Stack direction="row" spacing={2}>
        <TextField label="Vehicle" value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} sx={{ flex: 1 }} />
        <TextField label="Driver" value={form.driver} onChange={(e) => setForm({ ...form, driver: e.target.value })} sx={{ flex: 1 }} />
      </Stack>
      <Typography variant="subtitle2">Transfer requests waiting</Typography>
      {fromStoreId && !pending.data?.length && <Typography color="text.secondary">None waiting.</Typography>}
      {(pending.data ?? []).map((t) => (
        <FormControlLabel key={t.id} control={<Checkbox checked={chosen.includes(t.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} />} label={`${t.number} → ${t.toStore} (${t.lines} line${t.lines === 1 ? '' : 's'})`} />
      ))}
    </FormDialog>
  );
}

function RouteDialog({ onClose }: { onClose(): void }) {
  const stores = useStores();
  const [form, setForm] = useState({ code: '', name: '', fromStoreId: '', stopStoreIds: [] as string[] });
  const save = useApiMutation<void>(() => ['/distribution/routes', { method: 'POST', body: { ...form, isActive: true } }], { invalidate: ['/distribution'], success: 'Route saved' });
  return (
    <FormDialog open title="New delivery route" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required />
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <StoreSelect value={form.fromStoreId} onChange={(v) => setForm({ ...form, fromStoreId: v })} label="From store" />
      <TextField select label="Stops (in order of selection)" value={form.stopStoreIds} onChange={(e) => setForm({ ...form, stopStoreIds: e.target.value as unknown as string[] })} slotProps={{ select: { multiple: true } }}>
        {(stores.data ?? []).filter((s) => s.id !== form.fromStoreId).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
    </FormDialog>
  );
}

export function DistributionPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const date = useDate();
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<null | 'run' | 'route'>(null);
  const { data, isFetching } = useList<Run>('/distribution/runs', { status: status || undefined });
  const manage = can(Permissions.DISTRIBUTION_MANAGE);
  return (
    <>
      <PageHeader title="Distribution" onNew={manage ? () => setDialog('run') : undefined} newLabel="Plan delivery run" actions={manage ? <Button onClick={() => setDialog('route')}>New route</Button> : undefined} />
      <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ mb: 2, width: 200 }}>
        <MenuItem value="">All</MenuItem>
        {['PLANNED', 'PICKING', 'DISPATCHED', 'COMPLETED', 'CANCELLED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
      </TextField>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'Run', width: 170 },
            { field: 'runDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'fromStore', headerName: 'From', width: 160, valueGetter: (_v, r: Run) => r.fromStore?.name ?? '' },
            { field: 'stops', headerName: 'Stops', flex: 1, minWidth: 240, valueGetter: (_v, r: Run) => (r.stops ?? []).map((s) => s.toStore?.name).join(' → ') },
            { field: 'driver', headerName: 'Driver', width: 150 },
            { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value} /> },
          ]}
          onRowClick={({ row }) => navigate(`/distribution/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
      {dialog === 'run' && <NewRunDialog onClose={() => setDialog(null)} />}
      {dialog === 'route' && <RouteDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function PodDialog({ run, stop, onClose }: { run: Run; stop: Stop; onClose(): void }) {
  const { user } = useAuth();
  const transfer = useQuery({ queryKey: ['/inventory/transfers', stop.transferId], queryFn: () => api<{ lines: { itemId: string; item?: { name: string }; allocations: { id: string; dispatchedQty: number; batch?: { batchNo: string } }[] }[] }>(`/inventory/transfers/${stop.transferId}`) });
  const reasons = useList<{ code: string; name: string; direction: string }>('/inventory/adjustments/reasons');
  const [form, setForm] = useState({ receivedByName: user?.fullName ?? '', signatureName: '', notes: '' });
  const [got, setGot] = useState<Record<string, { receivedQty: number; reason: string; notes: string }>>({});
  const allocations = (transfer.data?.lines ?? []).flatMap((l) => l.allocations.map((a) => ({ ...a, item: l.item?.name ?? '' })));
  const deliver = useApiMutation<void>(
    () => [
      `/distribution/runs/${run.id}/stops/${stop.id}/deliver`,
      {
        method: 'POST',
        body: {
          ...form,
          notes: form.notes || undefined,
          allocations: allocations.map((a) => {
            const g = got[a.id];
            return { allocationId: a.id, receivedQty: g ? g.receivedQty : a.dispatchedQty, discrepancyReasonCode: g && g.receivedQty < a.dispatchedQty ? g.reason : undefined, discrepancyNotes: g?.notes || undefined };
          }),
        },
      },
    ],
    { invalidate: ['/distribution', '/inventory'], success: 'Delivery confirmed; stock received' },
  );
  return (
    <FormDialog open maxWidth="md" title={`Proof of delivery · ${stop.toStore?.name}`} submitLabel="Confirm delivery" onClose={onClose} submitting={deliver.isPending} onSubmit={(e) => { e.preventDefault(); deliver.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Received by" value={form.receivedByName} onChange={(e) => setForm({ ...form, receivedByName: e.target.value })} required sx={{ flex: 1 }} />
        <TextField label="Name as signed" value={form.signatureName} onChange={(e) => setForm({ ...form, signatureName: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <Table size="small" aria-label="Received quantities">
        <TableHead><TableRow><TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell align="right">Sent</TableCell><TableCell>Received</TableCell><TableCell>Reason if short</TableCell></TableRow></TableHead>
        <TableBody>
          {allocations.map((a) => {
            const g = got[a.id] ?? { receivedQty: a.dispatchedQty, reason: '', notes: '' };
            return (
              <TableRow key={a.id}>
                <TableCell>{a.item}</TableCell>
                <TableCell>{a.batch?.batchNo}</TableCell>
                <TableCell align="right">{a.dispatchedQty}</TableCell>
                <TableCell><TextField size="small" type="number" value={g.receivedQty} onChange={(e) => setGot({ ...got, [a.id]: { ...g, receivedQty: Number(e.target.value) } })} slotProps={{ htmlInput: { min: 0, max: a.dispatchedQty, 'aria-label': `Received ${a.item}` } }} sx={{ width: 100 }} /></TableCell>
                <TableCell>
                  {g.receivedQty < a.dispatchedQty && (
                    <TextField select size="small" value={g.reason} onChange={(e) => setGot({ ...got, [a.id]: { ...g, reason: e.target.value } })} sx={{ minWidth: 180 }} slotProps={{ htmlInput: { 'aria-label': `Reason ${a.item}` } }}>
                      {(reasons.data ?? []).filter((r) => r.direction !== 'INCREASE').map((r) => <MenuItem key={r.code} value={r.code}>{r.name}</MenuItem>)}
                    </TextField>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <TextField label="Notes (condition, seals, temperature)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} multiline minRows={2} />
    </FormDialog>
  );
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const date = useDate();
  const run = useQuery({ queryKey: ['/distribution/runs', id], queryFn: () => api<Run>(`/distribution/runs/${id}`) });
  const picking = useQuery({ queryKey: ['/distribution/runs', id, 'picking'], queryFn: () => api<PickingList>(`/distribution/runs/${id}/picking-list`), enabled: can(Permissions.DISTRIBUTION_MANAGE) });
  const [qty, setQty] = useState<Record<string, number>>({});
  const [packages, setPackages] = useState<Record<string, number>>({});
  const [pod, setPod] = useState<Stop | null>(null);
  const pick = useApiMutation<string>((stopId) => {
    const stop = picking.data?.stops.find((s) => s.stopId === stopId);
    return [`/distribution/runs/${id}/stops/${stopId}/pick`, { method: 'POST', body: { lines: (stop?.lines ?? []).filter((l) => qty[l.lineId] !== undefined).map((l) => ({ lineId: l.lineId, quantity: qty[l.lineId] })) } }];
  }, { invalidate: ['/distribution'], success: 'Picks confirmed' });
  const pack = useApiMutation<string>((stopId) => [`/distribution/runs/${id}/stops/${stopId}/pack`, { method: 'POST', body: { packages: packages[stopId] ?? 1 } }], { invalidate: ['/distribution'], success: 'Packed' });
  const dispatch = useApiMutation<void>(() => [`/distribution/runs/${id}/dispatch`, { method: 'POST', body: {} }], { invalidate: ['/distribution', '/inventory'], success: 'Dispatched' });
  const cancel = useApiMutation<void>(() => [`/distribution/runs/${id}/cancel`, { method: 'POST' }], { invalidate: ['/distribution'], success: 'Run cancelled' });
  const r = run.data;
  if (!r) return null;
  const manage = can(Permissions.DISTRIBUTION_MANAGE);
  const stops = r.stops ?? [];
  const readyToDispatch = stops.length > 0 && stops.every((s) => s.status === 'PACKED');
  return (
    <>
      <PageHeader title={`${r.number} · ${r.fromStore?.name}`} />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <StatusChip status={r.status} />
          <Typography>{date(r.runDate)} · {r.route?.name ?? 'no route'} · {r.vehicle ?? '—'} · {r.driver ?? '—'}</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button href={buildUrl(`/distribution/runs/${r.id}/dispatch-note`)} target="_blank">Dispatch note / manifest</Button>
          {manage && r.status === 'PICKING' && <Button variant="contained" disabled={!readyToDispatch || dispatch.isPending} onClick={() => dispatch.mutate()}>Dispatch run</Button>}
          {manage && ['PLANNED', 'PICKING'].includes(r.status) && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
        </Stack>
        {r.status === 'PICKING' && !readyToDispatch && <Typography variant="caption">Pick and pack every stop, then dispatch the run.</Typography>}
      </Paper>
      <Stack spacing={2}>
        {stops.map((s) => {
          const list = picking.data?.stops.find((x) => x.stopId === s.id);
          return (
            <Paper key={s.id} sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                <Typography variant="subtitle1" fontWeight={600}>Stop {s.sequence}: {s.toStore?.name}</Typography>
                <Link component={RouterLink} to={`/transfers?search=${s.transfer?.number}`}>{s.transfer?.number}</Link>
                <StatusChip status={s.status} />
                {s.packages > 0 && <Chip size="small" label={`${s.packages} package(s)`} />}
              </Stack>
              {list && ['PENDING', 'PICKED', 'PACKED'].includes(s.status) && (
                <Table size="small" aria-label={`Picking list stop ${s.sequence}`}>
                  <TableHead><TableRow><TableCell>Item</TableCell><TableCell align="right">Requested</TableCell><TableCell>Pick from (FEFO)</TableCell><TableCell>Quantity</TableCell></TableRow></TableHead>
                  <TableBody>
                    {list.lines.map((l) => (
                      <TableRow key={l.lineId}>
                        <TableCell>{l.itemCode} · {l.itemName}</TableCell>
                        <TableCell align="right">{l.requested} {l.uom}</TableCell>
                        <TableCell>
                          {l.picks.map((p, i) => <Typography key={i} variant="body2">{p.binCode ?? 'no bin'} · {p.batchNo} · exp {date(p.expiryDate) || '—'} · {p.quantity}</Typography>)}
                          {l.shortfall > 0 && <Typography variant="body2" color="error">Short by {l.shortfall}</Typography>}
                        </TableCell>
                        <TableCell>
                          {s.status === 'PENDING' ? (
                            <TextField size="small" type="number" value={qty[l.lineId] ?? l.requested - l.shortfall} onChange={(e) => setQty({ ...qty, [l.lineId]: Number(e.target.value) })} slotProps={{ htmlInput: { min: 0, max: l.requested, 'aria-label': `Pick ${l.itemName}` } }} sx={{ width: 100 }} />
                          ) : (
                            l.picks.reduce((x, p) => x + p.quantity, 0)
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {manage && (
                <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                  {['PENDING', 'PICKED'].includes(s.status) && ['PLANNED', 'PICKING'].includes(r.status) && <Button size="small" variant="outlined" onClick={() => pick.mutate(s.id)}>Confirm picks</Button>}
                  {s.status === 'PICKED' && (
                    <>
                      <TextField size="small" type="number" label="Packages" value={packages[s.id] ?? 1} onChange={(e) => setPackages({ ...packages, [s.id]: Number(e.target.value) })} sx={{ width: 110 }} />
                      <Button size="small" variant="outlined" onClick={() => pack.mutate(s.id)}>Packed</Button>
                    </>
                  )}
                </Stack>
              )}
              {s.status === 'DISPATCHED' && can(Permissions.INVENTORY_TRANSFER_RECEIVE) && <Button sx={{ mt: 1 }} variant="contained" onClick={() => setPod(s)}>Record proof of delivery</Button>}
              {s.deliveredAt && (
                <Alert severity={s.discrepancies.length ? 'warning' : 'success'} sx={{ mt: 1 }}>
                  Received by {s.receivedByName} (signed “{s.signatureName}”) on {date(s.deliveredAt)}.
                  {s.discrepancies.map((d) => ` ${d.item} ${d.batchNo}: ${d.received} of ${d.dispatched} (${humanise(d.reasonCode ?? '')}).`).join('')}
                </Alert>
              )}
            </Paper>
          );
        })}
      </Stack>
      {pod && <PodDialog run={r} stop={pod} onClose={() => setPod(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ shipments

interface Shipment {
  id: string;
  number: string;
  purchaseOrderId: string;
  purchaseOrder?: { number: string };
  supplier?: { name: string };
  shippedOn: string | null;
  expectedOn: string;
  expectedHistory: { date: string; reason: string | null; at: string }[];
  carrier: string | null;
  trackingRef: string | null;
  status: string;
  notes: string | null;
  lines?: { id: string; poLineId: string; lineNo?: number; item?: string; uom?: string; quantity: number; receivedQty: number }[];
  grns?: { id: string; number: string; status: string; receivedDate: string }[];
}

function ShipmentDialog({ onClose }: { onClose(): void }) {
  const pos = useQuery({ queryKey: ['/purchase-orders', 'open'], queryFn: () => api<{ items: { id: string; number: string; status: string; supplier?: { name: string } }[] }>('/purchase-orders', { query: { pageSize: 200, status: 'SENT' } }) });
  const [form, setForm] = useState({ purchaseOrderId: '', shippedOn: '', expectedOn: plusDays(7), carrier: '', trackingRef: '', notes: '' });
  const save = useApiMutation<void>(() => ['/shipments', { method: 'POST', body: { ...form, shippedOn: form.shippedOn || undefined, carrier: form.carrier || undefined, trackingRef: form.trackingRef || undefined, notes: form.notes || undefined } }], { invalidate: ['/shipments'], success: 'Shipment recorded' });
  return (
    <FormDialog open title="Expected shipment" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Purchase order" value={form.purchaseOrderId} onChange={(e) => setForm({ ...form, purchaseOrderId: e.target.value })} required>
        {(pos.data?.items ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.number} · {p.supplier?.name}</MenuItem>)}
      </TextField>
      <Stack direction="row" spacing={2}>
        <TextField label="Shipped on" type="date" value={form.shippedOn} onChange={(e) => setForm({ ...form, shippedOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Expected on" type="date" value={form.expectedOn} onChange={(e) => setForm({ ...form, expectedOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <Stack direction="row" spacing={2}>
        <TextField label="Carrier" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} sx={{ flex: 1 }} />
        <TextField label="Tracking / waybill" value={form.trackingRef} onChange={(e) => setForm({ ...form, trackingRef: e.target.value })} sx={{ flex: 1 }} />
      </Stack>
      <Typography variant="caption">The shipment covers everything still outstanding on the order; receive it with a GRN that names the shipment.</Typography>
    </FormDialog>
  );
}

function ShipmentDetailDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { canAny } = useAuth();
  const date = useDate();
  const { data: s } = useQuery({ queryKey: ['/shipments', id], queryFn: () => api<Shipment>(`/shipments/${id}`) });
  const [expectedOn, setExpected] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (s) setExpected(s.expectedOn);
  }, [s]);
  const update = useApiMutation<void>(() => [`/shipments/${id}`, { method: 'PUT', body: { expectedOn, reason: reason || undefined } }], { invalidate: ['/shipments'], success: 'Expected date changed' });
  if (!s) return null;
  const manage = canAny(Permissions.SHIPMENTS_MANAGE, Permissions.PURCHASING_PO) && !['RECEIVED', 'CANCELLED'].includes(s.status);
  return (
    <FormDialog open maxWidth="md" title={`${s.number} · ${s.supplier?.name}`} submitLabel={manage ? 'Save new date' : 'Close'} onClose={onClose} submitting={update.isPending} onSubmit={(e) => { e.preventDefault(); if (manage && expectedOn !== s.expectedOn) update.mutate(undefined, { onSuccess: onClose }); else onClose(); }}>
      <Stack direction="row" spacing={1} alignItems="center"><StatusChip status={s.status} /><Typography>PO <Link component={RouterLink} to={`/purchase-orders/${s.purchaseOrderId}`}>{s.purchaseOrder?.number}</Link> · {s.carrier ?? '—'} {s.trackingRef ?? ''}</Typography></Stack>
      <Table size="small" aria-label="Shipment lines">
        <TableHead><TableRow><TableCell>Line</TableCell><TableCell>Item</TableCell><TableCell align="right">On shipment</TableCell><TableCell align="right">Received</TableCell></TableRow></TableHead>
        <TableBody>{(s.lines ?? []).map((l) => <TableRow key={l.id}><TableCell>{l.lineNo}</TableCell><TableCell>{l.item}</TableCell><TableCell align="right">{l.quantity} {l.uom}</TableCell><TableCell align="right">{l.receivedQty}</TableCell></TableRow>)}</TableBody>
      </Table>
      {(s.grns ?? []).map((g) => <Typography key={g.id} variant="body2">Received on <Link component={RouterLink} to={`/grns/${g.id}`}>{g.number}</Link> ({date(g.receivedDate)}, {humanise(g.status)})</Typography>)}
      {s.expectedHistory.length > 0 && <Typography variant="body2">Earlier dates: {s.expectedHistory.map((h) => `${date(h.date)}${h.reason ? ` (${h.reason})` : ''}`).join(' → ')}</Typography>}
      {manage && (
        <Stack direction="row" spacing={2}>
          <TextField label="Expected on" type="date" value={expectedOn} onChange={(e) => setExpected(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="Reason for the change" value={reason} onChange={(e) => setReason(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
      )}
    </FormDialog>
  );
}

export function ShipmentsPage() {
  const { canAny } = useAuth();
  const date = useDate();
  const [tab, setTab] = useState(0);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shipments = useList<Shipment>('/shipments', { status: status || undefined });
  const lead = useList<{ supplierId: string; supplier: string; orders: number; avgDays: number; minDays: number; maxDays: number; p90Days: number; late: number; delayedShipments: number; observedLeadTimeDays: number | null }>('/shipments/lead-times');
  return (
    <>
      <PageHeader title="Inbound shipments" onNew={canAny(Permissions.SHIPMENTS_MANAGE, Permissions.PURCHASING_PO) ? () => setDialog(true) : undefined} newLabel="Expected shipment" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Shipments" />
        <Tab label="Supplier lead times" />
      </Tabs>
      {tab === 0 && (
        <>
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ mb: 2, width: 220 }}>
            <MenuItem value="">All</MenuItem>
            {['EXPECTED', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
          <Paper>
            <DataGrid
              autoHeight
              density="compact"
              rows={shipments.data ?? []}
              loading={shipments.isFetching}
              columns={[
                { field: 'number', headerName: 'Shipment', width: 150 },
                { field: 'po', headerName: 'PO', width: 150, valueGetter: (_v, r: Shipment) => r.purchaseOrder?.number ?? '' },
                { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 200, valueGetter: (_v, r: Shipment) => r.supplier?.name ?? '' },
                { field: 'expectedOn', headerName: 'Expected', width: 120, valueFormatter: (v: string) => date(v) },
                { field: 'changes', headerName: 'Date changes', type: 'number', width: 120, valueGetter: (_v, r: Shipment) => r.expectedHistory.length },
                { field: 'carrier', headerName: 'Carrier', width: 150 },
                { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
              ]}
              onRowClick={({ row }) => setOpen(row.id)}
              disableRowSelectionOnClick
            />
          </Paper>
        </>
      )}
      {tab === 1 && (
        <Paper>
          <DataGrid
            autoHeight
            density="compact"
            getRowId={(r) => r.supplierId}
            rows={lead.data ?? []}
            loading={lead.isFetching}
            columns={[
              { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 220 },
              { field: 'orders', headerName: 'Orders', type: 'number', width: 90 },
              { field: 'avgDays', headerName: 'Average days', type: 'number', width: 120 },
              { field: 'minDays', headerName: 'Min', type: 'number', width: 80 },
              { field: 'maxDays', headerName: 'Max', type: 'number', width: 80 },
              { field: 'p90Days', headerName: '90th pct', type: 'number', width: 100 },
              { field: 'late', headerName: 'Late orders', type: 'number', width: 110 },
              { field: 'delayedShipments', headerName: 'Slipped shipments', type: 'number', width: 150 },
              { field: 'observedLeadTimeDays', headerName: 'Default for new POs', type: 'number', width: 170, valueFormatter: (v: number | null) => (v === null ? '—' : `${v} days`) },
            ]}
            disableRowSelectionOnClick
          />
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>Days from the PO being sent to its first goods received note. The monthly job suppliers.leadtimes stores the average as the supplier's default delivery time; it also feeds the scorecards.</Typography>
        </Paper>
      )}
      {dialog && <ShipmentDialog onClose={() => setDialog(false)} />}
      {open && <ShipmentDetailDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ service certificates

interface Certificate {
  id: string;
  number: string;
  purchaseOrderId: string;
  purchaseOrder?: { number: string };
  supplier?: { name: string };
  periodFrom: string | null;
  periodTo: string;
  status: string;
  qualityRating: number | null;
  workDone: string;
  certifiedBy: string;
  certifiedByName?: string;
  postedAt: string | null;
  kind?: string;
  acceptedByName?: string | null;
  rejectionReason?: string | null;
  /** Staff requisitions it was bought for: their requester / department signs it off. */
  requisitions?: { id: string; number: string }[];
  canSign?: boolean;
  lines?: { id: string; poLineId: string; lineNo?: number; item?: string; lineType?: string; ordered?: number; quantity: number; rejectedQty?: number; rejectionReason?: string | null; uom?: string; value?: number | null; remarks: string | null }[];
}

type CertLine = { quantity?: number; rejectedQty?: number; rejectionReason?: string };

function CertificateDialog({ onClose }: { onClose(): void }) {
  const orders = useList<{ id: string; number: string; supplier: string }>('/service-certificates/open-orders');
  const [poId, setPoId] = useState('');
  const po = useQuery({ queryKey: ['/purchase-orders', poId], queryFn: () => api<{ lines: { id: string; lineNo: number; item?: { name: string } | null; description?: string | null; lineType?: string; quantity: number; receivedBaseQty: number; conversionFactor: number }[] }>(`/purchase-orders/${poId}`), enabled: !!poId });
  const [form, setForm] = useState({ periodFrom: '', periodTo: today(), workDone: '', qualityRating: 4 as number | null });
  const [qty, setQty] = useState<Record<string, CertLine>>({});
  const set = (id: string, patch: CertLine) => setQty({ ...qty, [id]: { ...qty[id], ...patch } });
  const lines = Object.entries(qty)
    .filter(([, l]) => (l.quantity ?? 0) > 0 || (l.rejectedQty ?? 0) > 0)
    .map(([poLineId, l]) => ({ poLineId, quantity: l.quantity ?? 0, rejectedQty: l.rejectedQty || undefined, rejectionReason: l.rejectionReason || undefined }));
  const save = useApiMutation<void>(
    () => ['/service-certificates', { method: 'POST', body: { purchaseOrderId: poId, periodFrom: form.periodFrom || undefined, periodTo: form.periodTo, workDone: form.workDone, qualityRating: form.qualityRating ?? undefined, lines } }],
    { invalidate: ['/service-certificates'], success: 'Recorded: waiting for sign-off' },
  );
  return (
    <FormDialog open maxWidth="md" title="Record a delivery / completed work" submitLabel="Save draft" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Service order" value={poId} onChange={(e) => { setPoId(e.target.value); setQty({}); }} required>
        {(orders.data ?? []).map((o) => <MenuItem key={o.id} value={o.id}>{o.number} · {o.supplier}</MenuItem>)}
      </TextField>
      {(po.data?.lines ?? []).map((l) => (
        <Stack key={l.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Typography sx={{ flex: 1 }}>{l.lineNo}. {l.item?.name ?? l.description} (ordered {l.quantity}, received {l.receivedBaseQty / l.conversionFactor})</Typography>
          <TextField size="small" type="number" label="Accepted" value={qty[l.id]?.quantity ?? ''} onChange={(e) => set(l.id, { quantity: Number(e.target.value) })} sx={{ width: 110 }} slotProps={{ htmlInput: { 'aria-label': `Accepted quantity for line ${l.lineNo}` } }} />
          <TextField size="small" type="number" label="Rejected" value={qty[l.id]?.rejectedQty ?? ''} onChange={(e) => set(l.id, { rejectedQty: Number(e.target.value) })} sx={{ width: 110 }} />
          {(qty[l.id]?.rejectedQty ?? 0) > 0 && <TextField size="small" label="Reason rejected" value={qty[l.id]?.rejectionReason ?? ''} onChange={(e) => set(l.id, { rejectionReason: e.target.value })} required />}
        </Stack>
      ))}
      <Stack direction="row" spacing={2}>
        <TextField label="Period from" type="date" value={form.periodFrom} onChange={(e) => setForm({ ...form, periodFrom: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Period to" type="date" value={form.periodTo} onChange={(e) => setForm({ ...form, periodTo: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <TextField label="Work done / inspection notes" value={form.workDone} onChange={(e) => setForm({ ...form, workDone: e.target.value })} multiline minRows={3} required />
      <Stack direction="row" spacing={1} alignItems="center"><Typography>Quality of the work</Typography><Rating value={form.qualityRating} onChange={(_, v) => setForm({ ...form, qualityRating: v })} /></Stack>
    </FormDialog>
  );
}

export function ServiceCertificatesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const date = useDate();
  const [dialog, setDialog] = useState(false);
  const { data, isFetching } = useList<Certificate>('/service-certificates');
  return (
    <>
      <PageHeader title="Service completion certificates" onNew={can(Permissions.SERVICES_CERTIFY) || can(Permissions.PURCHASING_RECEIVE) ? () => setDialog(true) : undefined} newLabel="Record delivery / completed work" />
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'Certificate', width: 150 },
            { field: 'po', headerName: 'PO', width: 150, valueGetter: (_v, r: Certificate) => r.purchaseOrder?.number ?? '' },
            { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 200, valueGetter: (_v, r: Certificate) => r.supplier?.name ?? '' },
            { field: 'periodTo', headerName: 'Period to', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'qualityRating', headerName: 'Rating', width: 90, valueFormatter: (v: number | null) => (v ? `${v}/5` : '') },
            { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
          ]}
          onRowClick={({ row }) => navigate(`/service-certificates/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">Services and works are certified instead of received on a GRN; posting the certificate lets the supplier’s invoice match the order.</Typography>
      {dialog && <CertificateDialog onClose={() => setDialog(false)} />}
    </>
  );
}

export function ServiceCertificateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const { data: c } = useQuery({ queryKey: ['/service-certificates', id], queryFn: () => api<Certificate>(`/service-certificates/${id}`) });
  const post = useApiMutation<void>(() => [`/service-certificates/${id}/post`, { method: 'POST' }], { invalidate: ['/service-certificates', '/purchase-orders'], success: 'Posted: counts as received' });
  const cancel = useApiMutation<void>(() => [`/service-certificates/${id}/cancel`, { method: 'POST' }], { invalidate: ['/service-certificates'], success: 'Cancelled' });
  const accept = useApiMutation<void>(() => [`/service-certificates/${id}/accept`, { method: 'POST' }], { invalidate: ['/service-certificates', '/purchase-orders', '/staff-requisitions'], success: 'Accepted: counts as received' });
  const [rejecting, setRejecting] = useState(false);
  if (!c) return null;
  const mine = c.certifiedBy === user?.id && c.status === 'DRAFT';
  const forRequisitions = (c.requisitions ?? []).length > 0;
  const rejected = (c.lines ?? []).some((l) => (l.rejectedQty ?? 0) > 0);
  return (
    <>
      <PageHeader title={`${c.kind ?? 'Certificate'} ${c.number} · ${c.supplier?.name}`} />
      <DetailLayout
        main={
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={c.status} /><Typography>PO <Link component={RouterLink} to={`/purchase-orders/${c.purchaseOrderId}`}>{c.purchaseOrder?.number}</Link></Typography></Stack>
            <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
              <Field label="Period">{date(c.periodFrom) || '—'} – {date(c.periodTo)}</Field>
              <Field label="Recorded by">{c.certifiedByName}</Field>
              {forRequisitions && <Field label="Requisition">{(c.requisitions ?? []).map((r) => r.number).join(', ')}</Field>}
              {c.acceptedByName && <Field label={c.status === 'REJECTED' ? 'Rejected by' : 'Accepted by'}>{c.acceptedByName}</Field>}
              <Field label="Rating">{c.qualityRating ? `${c.qualityRating}/5` : '—'}</Field>
            </Stack>
            <Typography sx={{ mb: 2 }}>{c.workDone}</Typography>
            {c.rejectionReason && <Alert severity="warning" sx={{ mb: 2 }}>Rejected: {c.rejectionReason}</Alert>}
            {c.canSign && <Alert severity="info" sx={{ mb: 2 }}>Please confirm what was delivered. Accepting counts the accepted quantities as received from the supplier.</Alert>}
            <Table size="small" aria-label="Certified lines">
              <TableHead><TableRow><TableCell>Line</TableCell><TableCell>Goods / service</TableCell><TableCell align="right">Ordered</TableCell><TableCell align="right">Accepted</TableCell>{rejected && <TableCell>Rejected</TableCell>}<TableCell align="right">Value</TableCell></TableRow></TableHead>
              <TableBody>
                {(c.lines ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.lineNo}</TableCell><TableCell>{l.item}</TableCell><TableCell align="right">{l.ordered}</TableCell><TableCell align="right">{l.quantity} {l.uom}</TableCell>
                    {rejected && <TableCell>{l.rejectedQty ? `${l.rejectedQty}: ${l.rejectionReason ?? ''}` : ''}</TableCell>}
                    <TableCell align="right">{l.value == null ? '' : money(l.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button href={buildUrl(`/service-certificates/${c.id}/pdf`)} target="_blank">Printable certificate</Button>
              {mine && !forRequisitions && <Button variant="contained" disabled={post.isPending} onClick={() => post.mutate()}>Post certificate</Button>}
              {c.canSign && <Button variant="contained" disabled={accept.isPending} onClick={() => accept.mutate()}>Accept delivery</Button>}
              {c.canSign && <Button color="error" onClick={() => setRejecting(true)}>Reject</Button>}
              {mine && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
            </Stack>
          </Paper>
        }
        side={
          <>
            <AttachmentsPanel ownerType="SERVICE_CERTIFICATE" ownerId={c.id} categories={['SIGNED_CERTIFICATE', 'JOB_CARD', 'PHOTO']} />
            <DocumentChain type="SCC" id={c.id} />
          </>
        }
      />
      {rejecting && <RejectCertificateDialog id={c.id} onClose={() => setRejecting(false)} />}
    </>
  );
}

function RejectCertificateDialog({ id, onClose }: { id: string; onClose(): void }) {
  const [reason, setReason] = useState('');
  const reject = useApiMutation<void>(() => [`/service-certificates/${id}/reject`, { method: 'POST', body: { reason } }], { invalidate: ['/service-certificates'], success: 'Rejected; the recording officer is told' });
  return (
    <FormDialog open title="Reject the delivery" submitLabel="Reject" onClose={onClose} submitting={reject.isPending} onSubmit={(e) => { e.preventDefault(); reject.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Why" value={reason} onChange={(e) => setReason(e.target.value)} multiline minRows={2} required slotProps={{ htmlInput: { minLength: 5 } }} />
    </FormDialog>
  );
}

import { Alert, Box, Button, Chip, FormControlLabel, Link, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { ComplaintCategory, DisposalMethod, Permissions, RecallClass, RecallSource } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { ItemPicker, StatusChip, StoreSelect, useStores } from '../inventory/components';
import { humanise } from '../lib/format';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import type { BatchRef, Complaint, DisposalDetail, Disposal, Excursion, ExcursionDetail, HoldDetail, QualityHold, Reading, Recall, RecallDashboard, RecallTrace, StorageUnit } from './types';

const nowLocal = () => {
  const d = new Date(Date.now() + 3 * 3600_000);
  return d.toISOString().slice(0, 16);
};
const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/** Item, then one of its batches. */
export function BatchPicker({ value, onChange, label = 'Batch' }: { value: BatchRef | null; onChange(b: BatchRef | null): void; label?: string }) {
  const [item, setItem] = useState<Item | null>((value?.item as Item) ?? null);
  const batches = useAll<BatchRef>('/inventory/batches', { itemId: item?.id }, !!item);
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <ItemPicker value={item} onChange={(i) => { setItem(i); onChange(null); }} />
      <TextField select label={label} value={value?.id ?? ''} onChange={(e) => onChange((batches.data ?? []).find((b) => b.id === e.target.value) ?? null)} disabled={!item} sx={{ minWidth: 200, width: 'auto' }}>
        {(batches.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.batchNo} · exp {b.expiryDate ?? '—'}{b.holdStatus !== 'NONE' ? ` · ${b.holdStatus}` : ''}</MenuItem>)}
      </TextField>
    </Stack>
  );
}

// ------------------------------------------------------------------ holds

function HoldDialog({ onClose }: { onClose(): void }) {
  const [batch, setBatch] = useState<BatchRef | null>(null);
  const [form, setForm] = useState({ storeId: '', reason: 'INSPECTION', details: '' });
  const save = useApiMutation<void>(() => ['/quality/holds', { method: 'POST', body: { batchId: batch?.id, storeId: form.storeId || undefined, reason: form.reason, details: form.details } }], { invalidate: ['/quality'], success: 'Batch quarantined' });
  return (
    <FormDialog open maxWidth="md" title="Quarantine a batch" submitLabel="Place hold" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <BatchPicker value={batch} onChange={setBatch} />
      <Stack direction="row" spacing={2}>
        <TextField select label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} sx={{ flex: 1 }}>
          {['INSPECTION', 'INVESTIGATION', 'COMPLAINT', 'EXCURSION'].map((r) => <MenuItem key={r} value={r}>{humanise(r)}</MenuItem>)}
        </TextField>
        <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v })} label="Found in" allowAll="—" sx={{ flex: 1 }} />
      </Stack>
      <TextField label="Details" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} multiline minRows={3} required />
      <Typography variant="caption">The batch cannot be issued, dispensed, sold or transferred in any store until the hold is released.</Typography>
    </FormDialog>
  );
}

export function HoldsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const date = useDate();
  const [status, setStatus] = useState('OPEN');
  const [dialog, setDialog] = useState(false);
  const { data, isFetching } = useList<QualityHold>('/quality/holds', { status: status || undefined });
  const columns: GridColDef<QualityHold>[] = [
    { field: 'number', headerName: 'Hold', width: 140 },
    { field: 'item', headerName: 'Item', flex: 1, minWidth: 200, valueGetter: (_v, r) => r.batch?.item?.name ?? '' },
    { field: 'batch', headerName: 'Batch', width: 130, valueGetter: (_v, r) => r.batch?.batchNo ?? '' },
    { field: 'reason', headerName: 'Reason', width: 130, renderCell: ({ value }) => <Chip size="small" color={value === 'RECALL' ? 'error' : 'warning'} label={humanise(value)} /> },
    { field: 'quantityAtHold', headerName: 'Qty held', type: 'number', width: 100 },
    { field: 'details', headerName: 'Details', flex: 1, minWidth: 240 },
    { field: 'status', headerName: 'Status', width: 110, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'createdAt', headerName: 'Placed', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader title="Quarantine and holds" onNew={can(Permissions.QUALITY_MANAGE) ? () => setDialog(true) : undefined} newLabel="Quarantine a batch" />
      <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ mb: 2, width: 180 }}>
        <MenuItem value="">All</MenuItem>
        {['OPEN', 'RELEASED', 'REJECTED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
      </TextField>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => navigate(`/quality/holds/${row.id}`)} disableRowSelectionOnClick pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} />
      </Paper>
      {dialog && <HoldDialog onClose={() => setDialog(false)} />}
    </>
  );
}

export function HoldDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const date = useDate();
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const { data: h } = useQuery({ queryKey: ['/quality/holds', id], queryFn: () => api<HoldDetail>(`/quality/holds/${id}`) });
  const decide = useApiMutation<'release' | 'reject', QualityHold>((d) => [`/quality/holds/${id}/${d}`, { method: 'POST', body: { note } }], { invalidate: ['/quality', '/disposals'], success: 'Decision recorded' });
  if (!h) return null;
  const mayDecide = can(Permissions.QUALITY_RELEASE) && h.status === 'OPEN' && h.placedBy !== user?.id;
  return (
    <>
      <PageHeader title={`${h.number} · ${h.batch?.item?.name} batch ${h.batch?.batchNo}`} />
      <DetailLayout
        main={
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={h.status} /><Chip size="small" label={humanise(h.reason)} /></Stack>
            <Typography sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>{h.details}</Typography>
            <Stack direction="row" spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <Field label="Placed">{date(h.createdAt)} · {h.placedByName ?? 'system'}</Field>
              <Field label="Quantity held">{h.quantityAtHold}</Field>
              <Field label="Expiry">{date(h.batch?.expiryDate) || '—'}</Field>
              <Field label="Source">{humanise(h.sourceType)}</Field>
            </Stack>
            <Typography variant="subtitle2">Where the batch is</Typography>
            <Table size="small" aria-label="Locations"><TableBody>{h.locations.map((l, i) => <TableRow key={i}><TableCell>{l.store}</TableCell><TableCell>{l.bin ?? '—'}</TableCell><TableCell align="right">{l.onHand}</TableCell></TableRow>)}</TableBody></Table>
            {h.status !== 'OPEN' && <Alert severity={h.status === 'RELEASED' ? 'success' : 'error'} sx={{ mt: 2 }}>{humanise(h.status)} by {h.decidedByName} on {date(h.decidedAt)}: {h.decisionNote}{h.disposalId && <> — <Link component={RouterLink} to={`/disposals/${h.disposalId}`}>disposal raised</Link></>}</Alert>}
            {mayDecide && (
              <Stack spacing={1} sx={{ mt: 2 }}>
                <TextField label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} />
                <Stack direction="row" spacing={1}>
                  {h.reason !== 'RECALL' && <Button variant="contained" color="success" disabled={note.length < 5 || decide.isPending} onClick={() => decide.mutate('release')}>Release for use</Button>}
                  <Button variant="contained" color="error" disabled={note.length < 5 || decide.isPending} onClick={() => decide.mutate('reject', { onSuccess: (r) => r.disposalId && navigate(`/disposals/${r.disposalId}`) })}>Reject (raise disposal)</Button>
                </Stack>
              </Stack>
            )}
            {h.status === 'OPEN' && h.placedBy === user?.id && <Alert severity="info" sx={{ mt: 2 }}>Another person decides on a hold you placed.</Alert>}
          </Paper>
        }
        side={<Paper sx={{ p: 2 }}><Button href={buildUrl('/labels/batches', { batchIds: h.batchId })} target="_blank">Print batch label</Button></Paper>}
      />
    </>
  );
}

// ------------------------------------------------------------------ cold chain

function UnitDialog({ row, onClose }: { row: StorageUnit | null; onClose(): void }) {
  const [form, setForm] = useState({ code: row?.code ?? '', name: row?.name ?? '', storeId: row?.storeId ?? '', type: row?.type ?? 'FRIDGE', loggerSerial: row?.loggerSerial ?? '', isActive: row?.isActive ?? true, binIds: row?.binIds ?? [] });
  const bins = useAll<{ id: string; code: string; name: string }>('/bins', { storeId: form.storeId }, !!form.storeId);
  const save = useApiMutation<void>(() => [row ? `/cold-chain/units/${row.id}` : '/cold-chain/units', { method: row ? 'PUT' : 'POST', body: { ...form, loggerSerial: form.loggerSerial || null } }], { invalidate: ['/cold-chain'], success: 'Storage unit saved' });
  return (
    <FormDialog open title={row ? row.name : 'New fridge / cold room'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField sx={{ flex: 1 }} label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required />
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v, binIds: [] })} />
      <TextField select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as StorageUnit['type'] })}>
        {['FRIDGE', 'FREEZER', 'COLD_ROOM', 'AMBIENT'].map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
      </TextField>
      <TextField select label="Bins inside the unit (none = all cold-chain stock of the store)" value={form.binIds} onChange={(e) => setForm({ ...form, binIds: e.target.value as unknown as string[] })} slotProps={{ select: { multiple: true } }}>
        {(bins.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.code} · {b.name}</MenuItem>)}
      </TextField>
      <TextField label="Data logger serial (for CSV imports)" value={form.loggerSerial} onChange={(e) => setForm({ ...form, loggerSerial: e.target.value })} />
      <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function UnitReadings({ unit }: { unit: StorageUnit }) {
  const { can, canAny } = useAuth();
  const [t, setT] = useState<number | ''>('');
  const [at, setAt] = useState(nowLocal());
  const [note, setNote] = useState('');
  const { data } = useQuery({ queryKey: ['/cold-chain/units', unit.id, 'readings'], queryFn: () => api<Reading[]>(`/cold-chain/units/${unit.id}/readings`) });
  const record = useApiMutation<void, { newExcursions: number }>(() => [`/cold-chain/units/${unit.id}/readings`, { method: 'POST', body: { readings: [{ recordedAt: new Date(`${at}:00+03:00`).toISOString(), temperatureC: Number(t), note: note || undefined }] } }], { invalidate: ['/cold-chain', '/quality'], success: 'Reading recorded' });
  const upload = useApiMutation<File>((file) => {
    const form = new FormData();
    form.set('unitId', unit.id);
    form.set('file', file);
    return ['/cold-chain/readings/import', { method: 'POST', form }];
  }, { invalidate: ['/cold-chain', '/quality'], success: 'Logger file imported' });
  const rows = data ?? [];
  const recent = rows.slice(0, 48).reverse();
  const max = Math.max(10, ...recent.map((r) => r.temperatureC));
  const min = Math.min(0, ...recent.map((r) => r.temperatureC));
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>{unit.code} · {unit.name} <Typography component="span" variant="body2" color="text.secondary">({humanise(unit.type)}, {unit.store?.name})</Typography></Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: 80, mb: 1 }} aria-label="Recent temperatures">
        {recent.map((r) => (
          <Box key={r.id} title={`${when(r.recordedAt)}: ${r.temperatureC} °C`} sx={{ flex: 1, minWidth: 3, height: `${((r.temperatureC - min) / (max - min)) * 100}%`, bgcolor: r.inRange ? 'success.main' : 'error.main', borderRadius: '2px 2px 0 0' }} />
        ))}
      </Box>
      {canAny(Permissions.QUALITY_MANAGE, Permissions.INVENTORY_HANDLE_COLD_CHAIN) && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }} sx={{ mb: 1 }}>
          <TextField size="small" label="°C" type="number" value={t} onChange={(e) => setT(e.target.value === '' ? '' : Number(e.target.value))} sx={{ width: 100 }} />
          <TextField sx={{ flex: 1 }} size="small" label="At" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField size="small" label="Note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ flex: 1 }} />
          <Button variant="contained" disabled={t === '' || record.isPending} onClick={() => record.mutate(undefined, { onSuccess: () => { setT(''); setNote(''); } })}>Record</Button>
          <Button component="label" variant="outlined" disabled={upload.isPending}>Import logger CSV<input hidden type="file" accept=".csv,text/csv" aria-label="Logger CSV" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} /></Button>
        </Stack>
      )}
      {!can(Permissions.QUALITY_READ) && <Typography variant="caption">Excursions are reviewed by the Quality Officer.</Typography>}
      <Table size="small" aria-label={`Readings of ${unit.code}`}>
        <TableHead><TableRow><TableCell>When</TableCell><TableCell align="right">°C</TableCell><TableCell>Source</TableCell><TableCell>Note</TableCell></TableRow></TableHead>
        <TableBody>{rows.slice(0, 10).map((r) => <TableRow key={r.id}><TableCell>{when(r.recordedAt)}</TableCell><TableCell align="right" sx={{ color: r.inRange ? undefined : 'error.main', fontWeight: r.inRange ? 400 : 700 }}>{r.temperatureC}</TableCell><TableCell>{humanise(r.source)}</TableCell><TableCell>{r.note}</TableCell></TableRow>)}</TableBody>
      </Table>
    </Paper>
  );
}

function ExcursionDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth();
  const [note, setNote] = useState('');
  const { data: e } = useQuery({ queryKey: ['/cold-chain/excursions', id], queryFn: () => api<ExcursionDetail>(`/cold-chain/excursions/${id}`) });
  const review = useApiMutation<void>(() => [`/cold-chain/excursions/${id}/review`, { method: 'POST', body: { note } }], { invalidate: ['/cold-chain'], success: 'Excursion reviewed' });
  if (!e) return null;
  return (
    <FormDialog open maxWidth="md" title={`Excursion · ${e.unit?.name}`} submitLabel="Mark reviewed" onClose={onClose} submitting={review.isPending} onSubmit={(ev) => { ev.preventDefault(); if (e.status === 'OPEN' && can(Permissions.QUALITY_RELEASE)) review.mutate(undefined, { onSuccess: onClose }); else onClose(); }}>
      <Typography>{when(e.startedAt)} – {e.endedAt ? when(e.endedAt) : 'ongoing'} · {e.minTemperatureC}–{e.maxTemperatureC} °C (range {e.rangeMin}–{e.rangeMax} °C)</Typography>
      <Typography variant="subtitle2">Batches on hold</Typography>
      {e.holds.length === 0 && <Typography color="text.secondary">None (automatic quarantine off, or the unit was empty).</Typography>}
      {e.holds.map((h) => <Typography key={h.id} variant="body2"><Link component={RouterLink} to={`/quality/holds/${h.id}`}>{h.number}</Link> · {h.item} batch {h.batchNo} · {h.quantityAtHold} · {humanise(h.status)}</Typography>)}
      {e.status === 'OPEN' && can(Permissions.QUALITY_RELEASE) ? (
        <TextField label="Review (stability data, decision)" value={note} onChange={(ev) => setNote(ev.target.value)} multiline minRows={2} required />
      ) : (
        e.reviewNote && <Alert severity="info">Reviewed: {e.reviewNote}</Alert>
      )}
      <Typography variant="caption">Release or reject each batch on its hold.</Typography>
    </FormDialog>
  );
}

export function ColdChainPage() {
  const { can } = useAuth();
  const date = useDate();
  const [tab, setTab] = useState(0);
  const [storeId, setStoreId] = useState('');
  const [editing, setEditing] = useState<StorageUnit | null | 'new'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const units = useList<StorageUnit>('/cold-chain/units', { storeId: storeId || undefined });
  const excursions = useList<Excursion>('/cold-chain/excursions');
  const openCount = (excursions.data ?? []).filter((e) => e.status === 'OPEN').length;
  return (
    <>
      <PageHeader title="Cold chain" onNew={can(Permissions.QUALITY_MANAGE) ? () => setEditing('new') : undefined} newLabel="New fridge / cold room" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Temperature logs" />
        <Tab label={`Excursions${openCount ? ` (${openCount} open)` : ''}`} />
      </Tabs>
      {tab === 0 && (
        <Stack spacing={2}>
          <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: 240 }} />
          {(units.data ?? []).map((u) => (
            <Box key={u.id}>
              <UnitReadings unit={u} />
              {can(Permissions.QUALITY_MANAGE) && <Button size="small" onClick={() => setEditing(u)}>Edit unit</Button>}
            </Box>
          ))}
          {!units.data?.length && <Typography color="text.secondary">No storage units.</Typography>}
        </Stack>
      )}
      {tab === 1 && (
        <Paper>
          <DataGrid
            autoHeight
            density="compact"
            rows={excursions.data ?? []}
            loading={excursions.isFetching}
            columns={[
              { field: 'unit', headerName: 'Unit', flex: 1, minWidth: 200, valueGetter: (_v, r: Excursion) => `${r.unit?.code ?? ''} · ${r.unit?.name ?? ''}` },
              { field: 'startedAt', headerName: 'Started', width: 160, valueFormatter: (v: string) => when(v) },
              { field: 'endedAt', headerName: 'Ended', width: 160, valueFormatter: (v: string | null) => (v ? when(v) : 'ongoing') },
              { field: 'temps', headerName: 'Temperature', width: 150, valueGetter: (_v, r: Excursion) => `${r.minTemperatureC}–${r.maxTemperatureC} °C` },
              { field: 'holds', headerName: 'Batches held', type: 'number', width: 120, valueGetter: (_v, r: Excursion) => r.holdIds.length },
              { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
            ]}
            onRowClick={({ row }) => setOpen(row.id)}
            disableRowSelectionOnClick
          />
        </Paper>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Ranges per unit type are set in coldChain.ranges (fridge 2–8 °C by default). Today: {date(new Date().toISOString())}.</Typography>
      {editing && <UnitDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {open && <ExcursionDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ complaints

function ComplaintDialog({ onClose }: { onClose(): void }) {
  const { user, can } = useAuth();
  const [batch, setBatch] = useState<BatchRef | null>(null);
  const [form, setForm] = useState({ category: ComplaintCategory.QUALITY_DEFECT as string, description: '', reportedByName: user?.fullName ?? '', severity: 'MODERATE', sampleRetained: false, holdStock: false, storeId: '' });
  const save = useApiMutation<void>(() => ['/quality/complaints', { method: 'POST', body: { ...form, itemId: batch?.item?.id, batchId: batch?.id, storeId: form.storeId || undefined } }], { invalidate: ['/quality'], success: 'Complaint logged' });
  return (
    <FormDialog open maxWidth="md" title="Report a product quality problem" submitLabel="Log complaint" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <BatchPicker value={batch} onChange={setBatch} />
      <Stack direction="row" spacing={2}>
        <TextField select label="Problem" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} sx={{ flex: 1 }}>
          {Object.values(ComplaintCategory).map((c) => <MenuItem key={c} value={c}>{humanise(c)}</MenuItem>)}
        </TextField>
        <TextField select label="Severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} sx={{ width: 200 }}>
          {['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
      </Stack>
      <TextField label="What happened" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={3} required />
      <Stack direction="row" spacing={2} alignItems="center">
        <TextField label="Reported by" value={form.reportedByName} onChange={(e) => setForm({ ...form, reportedByName: e.target.value })} sx={{ flex: 1 }} />
        <StoreSelect value={form.storeId} onChange={(v) => setForm({ ...form, storeId: v })} allowAll="—" label="Store" sx={{ flex: 1 }} />
      </Stack>
      <FormControlLabel control={<Switch checked={form.sampleRetained} onChange={(e) => setForm({ ...form, sampleRetained: e.target.checked })} />} label="Sample retained" />
      {can(Permissions.QUALITY_MANAGE) && <FormControlLabel control={<Switch checked={form.holdStock} onChange={(e) => setForm({ ...form, holdStock: e.target.checked })} />} label="Quarantine the batch pending investigation" />}
    </FormDialog>
  );
}

function ComplaintEditDialog({ c, onClose }: { c: Complaint; onClose(): void }) {
  const [form, setForm] = useState({ investigation: c.investigation ?? '', outcome: c.outcome ?? '', ppbReportType: c.ppbReportType ?? 'PQM', ppbReference: c.ppbReference ?? '', reportedToPpbOn: c.reportedToPpbOn ?? '', status: c.status });
  const save = useApiMutation<void>(() => [`/quality/complaints/${c.id}`, { method: 'PUT', body: { ...form, ppbReference: form.ppbReference || undefined, reportedToPpbOn: form.reportedToPpbOn || undefined } }], { invalidate: ['/quality'], success: 'Complaint updated' });
  return (
    <FormDialog open maxWidth="md" title={`${c.number} · ${c.item?.name}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">{c.description}</Typography>
      <TextField label="Investigation" value={form.investigation} onChange={(e) => setForm({ ...form, investigation: e.target.value })} multiline minRows={2} />
      <TextField label="Outcome / action taken" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} multiline minRows={2} />
      <Stack direction="row" spacing={2}>
        <TextField select label="PPB report" value={form.ppbReportType} onChange={(e) => setForm({ ...form, ppbReportType: e.target.value })}>
          <MenuItem value="PQM">Poor-quality medicine (PQM)</MenuItem>
          <MenuItem value="ADR">Adverse drug reaction (ADR)</MenuItem>
        </TextField>
        <TextField label="PPB reference" value={form.ppbReference} onChange={(e) => setForm({ ...form, ppbReference: e.target.value })} />
        <TextField label="Sent to PPB on" type="date" value={form.reportedToPpbOn} onChange={(e) => setForm({ ...form, reportedToPpbOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <TextField select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Complaint['status'] })}>
        {['OPEN', 'INVESTIGATING', 'CLOSED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
      </TextField>
      <Button href={buildUrl(`/quality/complaints/${c.id}/pdf`)} target="_blank">Printable PPB report</Button>
      <AttachmentsPanel ownerType="COMPLAINT" ownerId={c.id} categories={['PHOTO', 'REPORT', 'CORRESPONDENCE']} />
    </FormDialog>
  );
}

export function ComplaintsPage() {
  const { can, canAny } = useAuth();
  const date = useDate();
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<Complaint | null>(null);
  const { data, isFetching } = useList<Complaint>('/quality/complaints', { status: status || undefined }, can(Permissions.QUALITY_READ));
  return (
    <>
      <PageHeader title="Product quality complaints" onNew={canAny(Permissions.QUALITY_MANAGE, Permissions.PHARMACY_READ, Permissions.INVENTORY_READ) ? () => setDialog(true) : undefined} newLabel="Report a problem" />
      {can(Permissions.QUALITY_READ) ? (
        <>
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ mb: 2, width: 180 }}>
            <MenuItem value="">All</MenuItem>
            {['OPEN', 'INVESTIGATING', 'CLOSED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
          <Paper>
            <DataGrid
              autoHeight
              density="compact"
              rows={data ?? []}
              loading={isFetching}
              columns={[
                { field: 'number', headerName: 'Ref', width: 140 },
                { field: 'reportedOn', headerName: 'Reported', width: 110, valueFormatter: (v: string) => date(v) },
                { field: 'item', headerName: 'Product', flex: 1, minWidth: 200, valueGetter: (_v, r: Complaint) => r.item?.name ?? '' },
                { field: 'batch', headerName: 'Batch', width: 120, valueGetter: (_v, r: Complaint) => r.batch?.batchNo ?? '' },
                { field: 'supplier', headerName: 'Supplier', width: 170, valueGetter: (_v, r: Complaint) => r.supplier?.name ?? '' },
                { field: 'category', headerName: 'Problem', width: 160, valueFormatter: (v: string) => humanise(v) },
                { field: 'severity', headerName: 'Severity', width: 110, valueFormatter: (v: string) => humanise(v) },
                { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
              ]}
              onRowClick={({ row }) => can(Permissions.QUALITY_MANAGE) && setEditing(row)}
              disableRowSelectionOnClick
            />
          </Paper>
        </>
      ) : (
        <Alert severity="info">Report a problem with a product; the Quality Officer investigates and reports to the PPB.</Alert>
      )}
      {dialog && <ComplaintDialog onClose={() => setDialog(false)} />}
      {editing && <ComplaintEditDialog c={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ recalls

function RecallDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const [item, setItem] = useState<Item | null>(null);
  const [form, setForm] = useState({ source: RecallSource.PPB as string, noticeReference: '', noticeDate: new Date().toISOString().slice(0, 10), classification: RecallClass.CLASS_II as string, batchNos: '', reason: '', instructions: '' });
  const save = useApiMutation<void, Recall>(
    () => ['/recalls', { method: 'POST', body: { ...form, itemId: item?.id, batchNos: form.batchNos.split(/[,\s]+/).filter(Boolean), noticeReference: form.noticeReference || undefined, instructions: form.instructions || undefined } }],
    { invalidate: ['/recalls', '/quality'], success: 'Recall received: affected batches quarantined in every store' },
  );
  return (
    <FormDialog open maxWidth="md" title="Receive a recall notice" submitLabel="Quarantine and trace" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (r) => navigate(`/recalls/${r.id}`) }); }}>
      <Stack direction="row" spacing={2}>
        <TextField sx={{ flex: 1 }} select label="From" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
          {Object.values(RecallSource).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        <TextField label="Notice reference" value={form.noticeReference} onChange={(e) => setForm({ ...form, noticeReference: e.target.value })} sx={{ flex: 1 }} />
        <TextField sx={{ flex: 1 }} label="Notice date" type="date" value={form.noticeDate} onChange={(e) => setForm({ ...form, noticeDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <ItemPicker value={item} onChange={setItem} label="Product recalled" />
      <TextField label="Batch numbers (comma-separated; blank = all batches)" value={form.batchNos} onChange={(e) => setForm({ ...form, batchNos: e.target.value })} />
      <TextField select label="Class" value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value })} helperText="Class I: patients are contacted">
        {Object.values(RecallClass).map((c) => <MenuItem key={c} value={c}>{humanise(c)}</MenuItem>)}
      </TextField>
      <TextField label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required multiline minRows={2} />
      <TextField label="Instructions in the notice" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} multiline minRows={2} />
    </FormDialog>
  );
}

export function RecallsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const date = useDate();
  const [dialog, setDialog] = useState(false);
  const dash = useQuery({ queryKey: ['/recalls/dashboard'], queryFn: () => api<RecallDashboard>('/recalls/dashboard') });
  const all = useList<Recall>('/recalls');
  return (
    <>
      <PageHeader title="Recalls" onNew={can(Permissions.RECALLS_MANAGE) ? () => setDialog(true) : undefined} newLabel="Receive recall notice" />
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Open recalls</Typography>
      <Paper sx={{ mb: 3 }}>
        <Table size="small" aria-label="Open recalls">
          <TableHead><TableRow><TableCell>Recall</TableCell><TableCell>Product</TableCell><TableCell>Class</TableCell><TableCell>Batches</TableCell><TableCell align="right">Stores holding</TableCell><TableCell align="right">On hand</TableCell><TableCell align="right">Distributed</TableCell><TableCell align="right">Recovered</TableCell><TableCell align="right">Patients</TableCell></TableRow></TableHead>
          <TableBody>
            {(dash.data?.open ?? []).map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/recalls/${r.id}`)}>
                <TableCell>{r.number}<Typography variant="caption" display="block">{date(r.noticeDate)}</Typography></TableCell>
                <TableCell>{r.item}</TableCell>
                <TableCell><Chip size="small" color={r.classification === 'CLASS_I' ? 'error' : 'warning'} label={humanise(r.classification)} /></TableCell>
                <TableCell>{r.batches.join(', ')}</TableCell>
                <TableCell align="right">{r.storesHolding}</TableCell>
                <TableCell align="right">{r.onHand}</TableCell>
                <TableCell align="right">{r.distributed}</TableCell>
                <TableCell align="right">{r.returned}</TableCell>
                <TableCell align="right">{r.patients}</TableCell>
              </TableRow>
            ))}
            {!dash.data?.open.length && <TableRow><TableCell colSpan={9}><Typography color="text.secondary">No open recalls.</Typography></TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>All recalls ({dash.data?.closedLastYear ?? 0} closed in the last year)</Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={all.data ?? []}
          loading={all.isFetching}
          columns={[
            { field: 'number', headerName: 'Recall', width: 140 },
            { field: 'noticeDate', headerName: 'Notice', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'source', headerName: 'From', width: 110, valueFormatter: (v: string) => humanise(v) },
            { field: 'item', headerName: 'Product', flex: 1, minWidth: 200, valueGetter: (_v, r: Recall) => r.item?.name ?? '' },
            { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 200 },
            { field: 'status', headerName: 'Status', width: 110, renderCell: ({ value }) => <StatusChip status={value} /> },
          ]}
          onRowClick={({ row }) => navigate(`/recalls/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
      {dialog && <RecallDialog onClose={() => setDialog(false)} />}
    </>
  );
}

function ReturnDialog({ r, onClose }: { r: Recall; onClose(): void }) {
  const departments = useAll<Department>('/departments');
  const stores = useStores();
  const [form, setForm] = useState({ batchId: r.batchIds[0] ?? '', source: 'DEPARTMENT', fromId: '', fromName: '', quantity: 0, intoStoreId: '', outcome: '', notes: '' });
  const save = useApiMutation<void>(() => [`/recalls/${r.id}/returns`, { method: 'POST', body: { ...form, fromId: form.fromId || undefined, fromName: form.fromName || undefined, intoStoreId: form.intoStoreId || undefined, outcome: form.outcome || undefined, notes: form.notes || undefined } }], { invalidate: ['/recalls'], success: 'Return recorded' });
  return (
    <FormDialog open title="Record a recall return" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Batch" value={form.batchId} onChange={(e) => setForm({ ...form, batchId: e.target.value })}>
        {r.batchIds.map((b, i) => <MenuItem key={b} value={b}>{r.batchNos[i] ?? (r.holds ?? [])[i]?.batchNo ?? `batch ${i + 1}`}</MenuItem>)}
      </TextField>
      <TextField select label="Returned from" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value, fromId: '' })}>
        <MenuItem value="DEPARTMENT">Department / ward</MenuItem>
        <MenuItem value="PATIENT">Patient</MenuItem>
        <MenuItem value="STORE">Store (already in stock)</MenuItem>
      </TextField>
      {form.source === 'DEPARTMENT' && (
        <TextField select label="Department" value={form.fromId} onChange={(e) => setForm({ ...form, fromId: e.target.value, fromName: departments.data?.find((d) => d.id === e.target.value)?.name ?? '' })}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      )}
      {form.source !== 'DEPARTMENT' && <TextField label={form.source === 'PATIENT' ? 'Patient (name / hospital no.)' : 'Store'} value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />}
      <TextField label="Quantity" type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
      {form.source !== 'STORE' && (
        <TextField select label="Put into store (stays quarantined)" value={form.intoStoreId} onChange={(e) => setForm({ ...form, intoStoreId: e.target.value })}>
          <MenuItem value="">Not into stock (e.g. destroyed on site)</MenuItem>
          {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
      )}
      <TextField label="Outcome" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} helperText="e.g. RETURNED_TO_SUPPLIER, DESTROYED" />
      <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
    </FormDialog>
  );
}

export function RecallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const date = useDate();
  const [dialog, setDialog] = useState<null | 'return' | 'close'>(null);
  const [outcome, setOutcome] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const recall = useQuery({ queryKey: ['/recalls', id], queryFn: () => api<Recall>(`/recalls/${id}`) });
  const trace = useQuery({ queryKey: ['/recalls', id, 'trace'], queryFn: () => api<RecallTrace>(`/recalls/${id}/trace`) });
  const close = useApiMutation<void>(() => [`/recalls/${id}/close`, { method: 'POST', body: { outcome, withdrawn } }], { invalidate: ['/recalls', '/quality'], success: 'Recall closed' });
  const r = recall.data;
  const t = trace.data;
  if (!r) return null;
  const manage = can(Permissions.RECALLS_MANAGE) && r.status === 'OPEN';
  const table = (label: string, head: string[], rows: (string | number | null | undefined)[][]) => (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>{label} ({rows.length})</Typography>
      {rows.length === 0 ? <Typography color="text.secondary">None.</Typography> : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={label}>
            <TableHead><TableRow>{head.map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>{rows.map((row, i) => <TableRow key={i}>{row.map((c, j) => <TableCell key={j}>{c ?? ''}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
        </Box>
      )}
    </Paper>
  );
  return (
    <>
      <PageHeader title={`${r.number} · ${r.item?.name}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={r.status} />
                <Chip size="small" color={r.classification === 'CLASS_I' ? 'error' : 'warning'} label={humanise(r.classification)} />
                <Typography>{humanise(r.source)}{r.noticeReference ? ` · ${r.noticeReference}` : ''} · {date(r.noticeDate)} · batches {r.batchNos.length ? r.batchNos.join(', ') : 'all'}</Typography>
              </Stack>
              <Typography sx={{ mb: 1 }}>{r.reason}</Typography>
              {r.instructions && <Alert severity="info" sx={{ mb: 1 }}>{r.instructions}</Alert>}
              {r.patientLevel && <Alert severity="warning" sx={{ mb: 1 }}>Patient-level recall: contact the patients below.</Alert>}
              {t && (
                <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
                  <Field label="On hand (quarantined)">{t.totals.onHand}</Field>
                  <Field label="In transit">{t.totals.inTransit}</Field>
                  <Field label="Issued to wards">{t.totals.issued}</Field>
                  <Field label="Dispensed">{t.totals.dispensed}</Field>
                  <Field label="Sold">{t.totals.sold}</Field>
                  <Field label="Recovered">{t.totals.returned}</Field>
                </Stack>
              )}
              {r.outcome && <Alert severity="success" sx={{ mt: 2 }}>Closed: {r.outcome}</Alert>}
              {manage && (
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <Button variant="contained" onClick={() => setDialog('return')}>Record return</Button>
                  <Button onClick={() => setDialog('close')}>Close recall</Button>
                </Stack>
              )}
            </Paper>
            {t && (
              <>
                {table('Stores holding the batch', ['Store', 'Batch', 'Bin', 'On hand', 'In transit'], t.holdings.map((h) => [h.storeName, h.batchNo, h.binCode, h.onHand, h.inTransit]))}
                {table('Patients', ['Hospital no.', 'Name', 'Phone', 'Quantity', 'Via'], t.patients.map((p) => [p.hospitalNo, p.name, p.phone, p.quantity, p.via.join(', ')]))}
                {table('Issues to departments', ['Date', 'Document', 'From', 'Department', 'Batch', 'Qty'], t.issues.map((x) => [date(x.date), x.docNo, x.fromStore, x.department, x.batchNo, x.quantity]))}
                {table('Dispenses', ['When', 'Dispense', 'Store', 'Patient', 'Batch', 'Qty', 'Returned'], t.dispenses.map((x) => [when(x.dispensedAt), x.dispenseNo, x.store, `${x.hospitalNo} ${x.patientName}`, x.batchNo, x.quantity, x.returnedQty]))}
                {table('Sales', ['When', 'Invoice', 'Store', 'Customer', 'Phone', 'Batch', 'Qty'], t.sales.map((x) => [when(x.issuedAt), x.invoiceNo, x.store, x.customerName, x.phone, x.batchNo, x.quantity]))}
                {table('Transfers', ['Date', 'Document', 'From', 'To', 'Batch', 'Qty'], t.transfers.map((x) => [date(x.date), x.docNo, x.fromStore, x.toStore, x.batchNo, x.quantity]))}
                {table('Returns recorded', ['Date', 'From', 'Qty', 'Outcome', 'Notes'], (r.returns ?? []).map((x) => [date(x.returnedOn), `${humanise(x.source)} ${x.fromName ?? ''}`, x.quantity, x.outcome, x.notes]))}
              </>
            )}
          </>
        }
        side={
          <>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Holds</Typography>
              {(r.holds ?? []).map((h) => <Typography key={h.id} variant="body2"><Link component={RouterLink} to={`/quality/holds/${h.id}`}>{h.number}</Link> · batch {h.batchNo} · {humanise(h.status)}</Typography>)}
            </Paper>
            <AttachmentsPanel ownerType="RECALL" ownerId={r.id} categories={['NOTICE', 'CORRESPONDENCE', 'REPORT']} />
          </>
        }
      />
      {dialog === 'return' && <ReturnDialog r={r} onClose={() => setDialog(null)} />}
      {dialog === 'close' && (
        <FormDialog open title={`Close ${r.number}`} submitLabel="Close recall" onClose={() => setDialog(null)} submitting={close.isPending} onSubmit={(e) => { e.preventDefault(); close.mutate(undefined, { onSuccess: () => setDialog(null) }); }}>
          <TextField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} multiline minRows={3} required />
          <FormControlLabel control={<Switch checked={withdrawn} onChange={(e) => setWithdrawn(e.target.checked)} />} label="The recall was withdrawn: release the stock" />
          {!withdrawn && <Typography variant="caption">Remaining stock stays quarantined for return to the supplier or disposal.</Typography>}
        </FormDialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ disposals

export function DisposalsPage() {
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [status, setStatus] = useState('');
  const { data, isFetching } = useList<Disposal>('/disposals', { status: status || undefined });
  return (
    <>
      <PageHeader title="Disposals" />
      <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ mb: 2, width: 200 }}>
        <MenuItem value="">All</MenuItem>
        {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
      </TextField>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'Disposal', width: 170 },
            { field: 'store', headerName: 'Store', width: 160, valueGetter: (_v, r: Disposal) => r.store?.name ?? '' },
            { field: 'method', headerName: 'Method', width: 150, valueFormatter: (v: string) => humanise(v) },
            { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 240 },
            { field: 'totalValue', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
            { field: 'status', headerName: 'Status', width: 150, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
          ]}
          onRowClick={({ row }) => navigate(`/disposals/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">Disposals are raised when a quality hold is rejected. Expired stock is written off from Near expiry.</Typography>
    </>
  );
}

function CommitteeDialog({ d, onClose }: { d: DisposalDetail; onClose(): void }) {
  const users = useList<{ id: string; fullName: string; username: string }>('/disposals/committee-candidates');
  const [members, setMembers] = useState(d.members.map((m) => ({ userId: m.userId, role: m.role })));
  const save = useApiMutation<void>(() => [`/disposals/${d.id}/committee`, { method: 'PUT', body: { members } }], { invalidate: ['/disposals'], success: 'Committee saved' });
  return (
    <FormDialog open title="Disposal committee" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {members.map((m, i) => (
        <Stack key={i} direction="row" spacing={1}>
          <TextField select label="Member" value={m.userId} onChange={(e) => setMembers(members.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)))} sx={{ flex: 1 }}>
            {(users.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.fullName}</MenuItem>)}
            {!users.data?.some((u) => u.id === m.userId) && <MenuItem value={m.userId}>{d.members.find((x) => x.userId === m.userId)?.fullName ?? m.userId}</MenuItem>}
          </TextField>
          <TextField select label="Role" value={m.role} onChange={(e) => setMembers(members.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} sx={{ width: 140 }}>
            {['CHAIR', 'MEMBER', 'SECRETARY', 'WITNESS'].map((r) => <MenuItem key={r} value={r}>{humanise(r)}</MenuItem>)}
          </TextField>
          <Button color="error" onClick={() => setMembers(members.filter((_, j) => j !== i))}>Remove</Button>
        </Stack>
      ))}
      <Box><Button onClick={() => setMembers([...members, { userId: '', role: 'MEMBER' }])}>Add member</Button></Box>
      <Typography variant="caption">Members need the disposals.manage permission. Changing the disposal clears earlier sign-offs.</Typography>
    </FormDialog>
  );
}

export function DisposalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const { data: d } = useQuery({ queryKey: ['/disposals', id], queryFn: () => api<DisposalDetail>(`/disposals/${id}`) });
  const [dialog, setDialog] = useState<null | 'committee' | 'complete'>(null);
  const [form, setForm] = useState({ method: '', recipient: '', publicNoticeRef: '' });
  const [done, setDone] = useState({ place: '', agent: '', wasteTransferNote: '', proceeds: '' as number | '' });
  useEffect(() => {
    if (d) setForm({ method: d.method, recipient: d.recipient ?? '', publicNoticeRef: d.publicNoticeRef ?? '' });
  }, [d]);
  const update = useApiMutation<void>(() => [`/disposals/${id}`, { method: 'PUT', body: { method: form.method, recipient: form.recipient || undefined, publicNoticeRef: form.publicNoticeRef || undefined } }], { invalidate: ['/disposals'], success: 'Saved (sign-offs cleared)' });
  const sign = useApiMutation<void>(() => [`/disposals/${id}/sign`, { method: 'POST', body: {} }], { invalidate: ['/disposals'], success: 'Signed' });
  const submit = useApiMutation<void>(() => [`/disposals/${id}/submit`, { method: 'POST' }], { invalidate: ['/disposals', '/approvals'], success: 'Submitted for approval' });
  const complete = useApiMutation<void>(() => [`/disposals/${id}/complete`, { method: 'POST', body: { place: done.place, agent: done.agent, wasteTransferNote: done.wasteTransferNote || undefined, proceeds: done.proceeds === '' ? undefined : Number(done.proceeds) } }], { invalidate: ['/disposals', '/attachments'], success: 'Completed; certificate stored' });
  if (!d) return null;
  const manage = can(Permissions.DISPOSALS_MANAGE);
  const editable = manage && ['DRAFT', 'RETURNED'].includes(d.status);
  const me = d.members.find((m) => m.userId === user?.id);
  return (
    <>
      <PageHeader title={`${d.number} · ${humanise(d.method)}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={d.status} /><Typography>{d.store?.name} · {money(d.totalValue)}</Typography></Stack>
              {d.lastComment && <Alert severity="warning" sx={{ mb: 2 }}>{d.lastComment}</Alert>}
              <Typography sx={{ mb: 2 }}>{d.reason}</Typography>
              <Table size="small" aria-label="Disposal lines">
                <TableHead><TableRow><TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell>Expiry</TableCell><TableCell>Bin</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Value</TableCell></TableRow></TableHead>
                <TableBody>{d.lines.map((l) => <TableRow key={l.id}><TableCell>{l.item?.name}</TableCell><TableCell>{l.batch?.batchNo}</TableCell><TableCell>{date(l.batch?.expiryDate)}</TableCell><TableCell>{l.bin?.code ?? '—'}</TableCell><TableCell align="right">{l.quantity}</TableCell><TableCell align="right">{money(l.quantity * l.unitCost)}</TableCell></TableRow>)}</TableBody>
              </Table>
              {editable && (
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mt: 2 }}>
                  <TextField select size="small" label="Method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
                    {Object.values(DisposalMethod).map((m) => <MenuItem key={m} value={m}>{humanise(m)}</MenuItem>)}
                  </TextField>
                  <TextField size="small" label="Buyer / recipient / supplier" value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} sx={{ flex: 1 }} />
                  <TextField sx={{ flex: 1 }} size="small" label="Public notice ref (PPADA)" value={form.publicNoticeRef} onChange={(e) => setForm({ ...form, publicNoticeRef: e.target.value })} />
                  <Button disabled={update.isPending} onClick={() => update.mutate()}>Save</Button>
                </Stack>
              )}
              {d.status === 'COMPLETED' && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  Disposed of on {date(d.completedOn)} at {d.place} by {d.agent}{d.wasteTransferNote ? ` (waste-transfer note ${d.wasteTransferNote})` : ''}. <Link href={buildUrl(`/disposals/${d.id}/certificate`)} target="_blank">Certificate</Link>
                </Alert>
              )}
              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                {editable && <Button onClick={() => setDialog('committee')}>Committee</Button>}
                {editable && me && !me.signedAt && <Button variant="outlined" disabled={sign.isPending} onClick={() => sign.mutate()}>Sign recommendation</Button>}
                {editable && <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
                {manage && d.status === 'APPROVED' && <Button variant="contained" onClick={() => setDialog('complete')}>Record completion</Button>}
              </Stack>
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Committee</Typography>
              {d.members.map((m) => <Typography key={m.id} variant="body2">{m.fullName} · {humanise(m.role)} · {m.signedAt ? `signed ${date(m.signedAt)}` : 'not signed'}{m.comment ? ` — ${m.comment}` : ''}</Typography>)}
            </Paper>
          </>
        }
        side={
          <>
            {['PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED', 'RETURNED'].includes(d.status) && <ApprovalPanel type="DSL" id={d.id} />}
            <AttachmentsPanel ownerType="DISPOSAL" ownerId={d.id} categories={['CERTIFICATE', 'WASTE_TRANSFER_NOTE', 'PHOTO']} />
            <DocumentChain type="DSL" id={d.id} />
          </>
        }
      />
      {dialog === 'committee' && <CommitteeDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'complete' && (
        <FormDialog open title="Record completion" submitLabel="Complete and file certificate" onClose={() => setDialog(null)} submitting={complete.isPending} onSubmit={(e) => { e.preventDefault(); complete.mutate(undefined, { onSuccess: () => setDialog(null) }); }}>
          <TextField label="Place" value={done.place} onChange={(e) => setDone({ ...done, place: e.target.value })} required />
          <TextField label="Disposal agent / licensed handler / buyer" value={done.agent} onChange={(e) => setDone({ ...done, agent: e.target.value })} required />
          <TextField label="Waste-transfer note no." value={done.wasteTransferNote} onChange={(e) => setDone({ ...done, wasteTransferNote: e.target.value })} />
          {d.method === 'SALE' && <TextField label="Proceeds" type="number" value={done.proceeds} onChange={(e) => setDone({ ...done, proceeds: e.target.value === '' ? '' : Number(e.target.value) })} required />}
        </FormDialog>
      )}
    </>
  );
}

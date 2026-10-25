import { Alert, Button, Chip, Link, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { ItemPicker, StatusChip, StoreSelect, useStores } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { DetailLayout, Field, useDate, useMoney } from '../purchasing/common';
import { BatchPicker } from '../quality/QualityPages';
import type { BatchRef } from '../quality/types';

interface Asset {
  id: string;
  tagNo: string;
  itemId: string;
  item?: Item;
  description: string;
  serialNo: string | null;
  model: string | null;
  grnId: string | null;
  acquiredOn: string;
  cost: number;
  storeId: string | null;
  store?: { name: string } | null;
  departmentId: string | null;
  department?: Department | null;
  location: string | null;
  custodianName: string | null;
  warrantyEndsOn: string | null;
  maintenanceIntervalMonths: number | null;
  lastMaintenanceOn: string | null;
  nextMaintenanceOn: string | null;
  status: string;
  notes: string | null;
}

interface AssetDetail extends Asset {
  supplier?: { name: string } | null;
  grn: { id: string; number: string } | null;
  movements: { id: string; movedOn: string; reason: string; fromLocation: { location: string | null; custodianName: string | null }; toLocation: { location: string | null; custodianName: string | null } }[];
  maintenance: { id: string; performedOn: string; kind: string; performedBy: string | null; cost: number | null; notes: string | null; nextDueOn: string | null }[];
}

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const soon = (d: string | null, days: number) => !!d && d <= new Date(Date.parse(`${todayStr()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function AssetsPage() {
  const navigate = useNavigate();
  const date = useDate();
  const money = useMoney();
  const departments = useAll<Department>('/departments');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [due, setDue] = useState('');
  const q = useDebounced(search);
  const { data, isFetching } = useList<Asset>('/assets', { search: q || undefined, departmentId: departmentId || undefined, due: due || undefined });
  return (
    <>
      <PageHeader title="Asset register" search={search} onSearch={setSearch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ width: { xs: '100%', md: 240 } }}>
          <MenuItem value="">All</MenuItem>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <TextField select label="Due" value={due} onChange={(e) => setDue(e.target.value)} sx={{ width: { xs: '100%', md: 240 } }}>
          <MenuItem value="">Any</MenuItem>
          <MenuItem value="maintenance">Maintenance in 30 days</MenuItem>
          <MenuItem value="warranty">Warranty ending in 60 days</MenuItem>
        </TextField>
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'tagNo', headerName: 'Tag', width: 120 },
            { field: 'description', headerName: 'Asset', flex: 1, minWidth: 220 },
            { field: 'serialNo', headerName: 'Serial', width: 140 },
            { field: 'where', headerName: 'Location', width: 220, valueGetter: (_v, r: Asset) => [r.department?.name ?? r.store?.name, r.location].filter(Boolean).join(' · ') },
            { field: 'custodianName', headerName: 'Custodian', width: 170 },
            { field: 'warrantyEndsOn', headerName: 'Warranty', width: 130, renderCell: ({ row }) => (row.warrantyEndsOn ? <span style={{ color: soon(row.warrantyEndsOn, 60) ? '#c62828' : undefined }}>{date(row.warrantyEndsOn)}</span> : '—') },
            { field: 'nextMaintenanceOn', headerName: 'Next maintenance', width: 150, renderCell: ({ row }) => (row.nextMaintenanceOn ? <span style={{ color: soon(row.nextMaintenanceOn, 14) ? '#c62828' : undefined }}>{date(row.nextMaintenanceOn)}</span> : '—') },
            { field: 'cost', headerName: 'Cost', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
            { field: 'status', headerName: 'Status', width: 110, renderCell: ({ value }) => <StatusChip status={value} /> },
          ]}
          onRowClick={({ row }) => navigate(`/assets/${row.id}`)}
          disableRowSelectionOnClick
          pageSizeOptions={[50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">Assets are tagged automatically when equipment (categories in assets.categoryCodes) is received on a GRN, one per unit. No depreciation is calculated.</Typography>
    </>
  );
}

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const date = useDate();
  const money = useMoney();
  const departments = useAll<Department>('/departments');
  const { data: a } = useQuery({ queryKey: ['/assets', id], queryFn: () => api<AssetDetail>(`/assets/${id}`) });
  const [dialog, setDialog] = useState<null | 'edit' | 'move' | 'maintain'>(null);
  const [edit, setEdit] = useState({ serialNo: '', model: '', warrantyEndsOn: '', maintenanceIntervalMonths: '' as number | '', nextMaintenanceOn: '', status: 'ACTIVE' });
  const [move, setMove] = useState({ storeId: '', departmentId: '', location: '', custodianName: '', reason: '' });
  const [maint, setMaint] = useState({ kind: 'PREVENTIVE', performedOn: todayStr(), performedBy: '', cost: '' as number | '', notes: '' });
  const save = useApiMutation<void>(() => [`/assets/${id}`, { method: 'PUT', body: { serialNo: edit.serialNo || undefined, model: edit.model || undefined, warrantyEndsOn: edit.warrantyEndsOn || undefined, maintenanceIntervalMonths: edit.maintenanceIntervalMonths === '' ? undefined : Number(edit.maintenanceIntervalMonths), nextMaintenanceOn: edit.nextMaintenanceOn || undefined, status: edit.status } }], { invalidate: ['/assets'], success: 'Asset updated' });
  const doMove = useApiMutation<void>(() => [`/assets/${id}/move`, { method: 'POST', body: { storeId: move.storeId || undefined, departmentId: move.departmentId || undefined, location: move.location || undefined, custodianName: move.custodianName || undefined, reason: move.reason } }], { invalidate: ['/assets'], success: 'Asset moved' });
  const doMaint = useApiMutation<void>(() => [`/assets/${id}/maintenance`, { method: 'POST', body: { kind: maint.kind, performedOn: maint.performedOn, performedBy: maint.performedBy || undefined, cost: maint.cost === '' ? undefined : Number(maint.cost), notes: maint.notes || undefined } }], { invalidate: ['/assets'], success: 'Maintenance recorded' });
  if (!a) return null;
  const manage = can(Permissions.ASSETS_MANAGE) && a.status !== 'DISPOSED';
  const openEdit = () => {
    setEdit({ serialNo: a.serialNo ?? '', model: a.model ?? '', warrantyEndsOn: a.warrantyEndsOn ?? '', maintenanceIntervalMonths: a.maintenanceIntervalMonths ?? '', nextMaintenanceOn: a.nextMaintenanceOn ?? '', status: a.status });
    setDialog('edit');
  };
  return (
    <>
      <PageHeader title={`${a.tagNo} · ${a.description}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={a.status} />{soon(a.warrantyEndsOn, 60) && <Chip size="small" color="warning" label="Warranty ending" />}{soon(a.nextMaintenanceOn, 14) && <Chip size="small" color="warning" label="Maintenance due" />}</Stack>
              <Stack direction="row" spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Field label="Serial / model">{a.serialNo ?? '—'} · {a.model ?? '—'}</Field>
                <Field label="Acquired">{date(a.acquiredOn)} · {money(a.cost)}{a.grn && <> · <Link component={RouterLink} to={`/grns/${a.grn.id}`}>{a.grn.number}</Link></>}</Field>
                <Field label="Supplier">{a.supplier?.name ?? '—'}</Field>
                <Field label="Location">{[a.department?.name ?? a.store?.name, a.location].filter(Boolean).join(' · ')}</Field>
                <Field label="Custodian">{a.custodianName ?? '—'}</Field>
                <Field label="Warranty ends">{date(a.warrantyEndsOn) || '—'}</Field>
                <Field label="Maintenance">{a.maintenanceIntervalMonths ? `every ${a.maintenanceIntervalMonths} months` : '—'} · next {date(a.nextMaintenanceOn) || '—'}</Field>
              </Stack>
              {manage && (
                <Stack direction="row" spacing={1}>
                  <Button onClick={openEdit}>Edit</Button>
                  <Button onClick={() => setDialog('move')}>Move / change custodian</Button>
                  <Button variant="contained" onClick={() => setDialog('maintain')}>Record maintenance</Button>
                </Stack>
              )}
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Maintenance</Typography>
              <Table size="small" aria-label="Maintenance history">
                <TableHead><TableRow><TableCell>Date</TableCell><TableCell>Kind</TableCell><TableCell>By</TableCell><TableCell align="right">Cost</TableCell><TableCell>Notes</TableCell><TableCell>Next due</TableCell></TableRow></TableHead>
                <TableBody>{a.maintenance.map((m) => <TableRow key={m.id}><TableCell>{date(m.performedOn)}</TableCell><TableCell>{humanise(m.kind)}</TableCell><TableCell>{m.performedBy}</TableCell><TableCell align="right">{m.cost == null ? '' : money(m.cost)}</TableCell><TableCell>{m.notes}</TableCell><TableCell>{date(m.nextDueOn)}</TableCell></TableRow>)}</TableBody>
              </Table>
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Movements</Typography>
              {a.movements.length === 0 && <Typography color="text.secondary">Not moved since receipt.</Typography>}
              {a.movements.map((m) => <Typography key={m.id} variant="body2">{date(m.movedOn)}: {m.fromLocation.location ?? '—'} ({m.fromLocation.custodianName ?? 'no custodian'}) → {m.toLocation.location ?? '—'} ({m.toLocation.custodianName ?? 'no custodian'}) — {m.reason}</Typography>)}
            </Paper>
          </>
        }
        side={<AttachmentsPanel ownerType="ASSET" ownerId={a.id} categories={['MANUAL', 'WARRANTY', 'SERVICE_REPORT', 'PHOTO']} />}
      />
      {dialog === 'edit' && (
        <FormDialog open title="Edit asset" onClose={() => setDialog(null)} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setDialog(null) }); }}>
          <Stack direction="row" spacing={2}>
            <TextField label="Serial number" value={edit.serialNo} onChange={(e) => setEdit({ ...edit, serialNo: e.target.value })} sx={{ flex: 1 }} />
            <TextField label="Model" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} sx={{ flex: 1 }} />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Warranty ends" type="date" value={edit.warrantyEndsOn} onChange={(e) => setEdit({ ...edit, warrantyEndsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="Maintenance every (months)" type="number" value={edit.maintenanceIntervalMonths} onChange={(e) => setEdit({ ...edit, maintenanceIntervalMonths: e.target.value === '' ? '' : Number(e.target.value) })} />
            <TextField label="Next maintenance" type="date" value={edit.nextMaintenanceOn} onChange={(e) => setEdit({ ...edit, nextMaintenanceOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          <TextField select label="Status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
            {['ACTIVE', 'IN_REPAIR', 'DISPOSED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        </FormDialog>
      )}
      {dialog === 'move' && (
        <FormDialog open title="Move asset" submitLabel="Move" onClose={() => setDialog(null)} submitting={doMove.isPending} onSubmit={(e) => { e.preventDefault(); doMove.mutate(undefined, { onSuccess: () => setDialog(null) }); }}>
          <TextField select label="Department" value={move.departmentId} onChange={(e) => setMove({ ...move, departmentId: e.target.value, storeId: '' })}>
            <MenuItem value="">—</MenuItem>
            {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
          {!move.departmentId && <StoreSelect value={move.storeId} onChange={(v) => setMove({ ...move, storeId: v })} label="Or a store" />}
          <TextField label="Room / location" value={move.location} onChange={(e) => setMove({ ...move, location: e.target.value })} />
          <TextField label="Custodian" value={move.custodianName} onChange={(e) => setMove({ ...move, custodianName: e.target.value })} />
          <TextField label="Reason" value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} required />
        </FormDialog>
      )}
      {dialog === 'maintain' && (
        <FormDialog open title="Record maintenance" onClose={() => setDialog(null)} submitting={doMaint.isPending} onSubmit={(e) => { e.preventDefault(); doMaint.mutate(undefined, { onSuccess: () => setDialog(null) }); }}>
          <Stack direction="row" spacing={2}>
            <TextField select label="Kind" value={maint.kind} onChange={(e) => setMaint({ ...maint, kind: e.target.value })} sx={{ flex: 1 }}>
              {['PREVENTIVE', 'CORRECTIVE', 'CALIBRATION', 'INSPECTION'].map((k) => <MenuItem key={k} value={k}>{humanise(k)}</MenuItem>)}
            </TextField>
            <TextField label="Date" type="date" value={maint.performedOn} onChange={(e) => setMaint({ ...maint, performedOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Done by" value={maint.performedBy} onChange={(e) => setMaint({ ...maint, performedBy: e.target.value })} sx={{ flex: 1 }} />
            <TextField label="Cost" type="number" value={maint.cost} onChange={(e) => setMaint({ ...maint, cost: e.target.value === '' ? '' : Number(e.target.value) })} />
          </Stack>
          <TextField label="Notes" value={maint.notes} onChange={(e) => setMaint({ ...maint, notes: e.target.value })} multiline minRows={2} />
          <Typography variant="caption">The next due date is set from the maintenance interval.</Typography>
        </FormDialog>
      )}
    </>
  );
}

/** Shelf labels for a store (or chosen items) and batch labels (GS1 DataMatrix when the item has a GTIN). */
export function LabelsPage() {
  const stores = useStores();
  const [storeId, setStoreId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [item, setItem] = useState<Item | null>(null);
  const [batches, setBatches] = useState<BatchRef[]>([]);
  const [batch, setBatch] = useState<BatchRef | null>(null);
  const [copies, setCopies] = useState(1);
  return (
    <>
      <PageHeader title="Labels" />
      <Stack spacing={2}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Shelf labels (Code128)</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
            <StoreSelect value={storeId} onChange={setStoreId} sx={{ width: 240 }} />
            <ItemPicker value={item} onChange={(i) => { if (i && !items.some((x) => x.id === i.id)) setItems([...items, i]); setItem(null); }} label="Add an item (blank = everything in stock)" />
          </Stack>
          <Stack direction="row" spacing={1} sx={{ my: 1 }} flexWrap="wrap" useFlexGap>{items.map((i) => <Chip key={i.id} label={i.name} onDelete={() => setItems(items.filter((x) => x.id !== i.id))} />)}</Stack>
          <Button variant="contained" disabled={!storeId && !items.length} href={buildUrl('/labels/shelf', { storeId: storeId || undefined, itemIds: items.map((i) => i.id).join(',') || undefined })} target="_blank">Print shelf labels</Button>
          {!stores.data?.length && <Alert severity="info" sx={{ mt: 1 }}>No stores in your scope.</Alert>}
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Batch labels (GS1 DataMatrix: GTIN, expiry, batch)</Typography>
          <BatchPicker value={batch} onChange={(b) => { if (b && !batches.some((x) => x.id === b.id)) setBatches([...batches, b]); setBatch(null); }} />
          <Stack direction="row" spacing={1} sx={{ my: 1 }} flexWrap="wrap" useFlexGap>{batches.map((b) => <Chip key={b.id} label={`${b.item?.name ?? ''} ${b.batchNo}`} onDelete={() => setBatches(batches.filter((x) => x.id !== b.id))} />)}</Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField size="small" label="Copies" type="number" value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value)))} sx={{ width: 100 }} />
            <Button variant="contained" disabled={!batches.length} href={buildUrl('/labels/batches', { batchIds: batches.map((b) => b.id).join(','), copies })} target="_blank">Print batch labels</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">Items without a valid GTIN get a Code128 of item code and batch. Label size is the setting labels.size.</Typography>
        </Paper>
      </Stack>
    </>
  );
}

import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
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
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import { LINE_TYPES, type GlAccount, type LineType, type Project, type QueueLine, type StaffRequisition } from '../api/nonstock-types';
import type { Supplier } from '../api/purchasing-types';
import type { Department, Item, ItemCategory, Uom } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { FormDialog } from '../components/FormDialog';
import { useNotify } from '../components/Notify';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip, StoreSelect } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import { AwaitingMePanel, DeliveryPanel } from './HandoverPages';

const P = Permissions;
const PRIORITIES = ['ROUTINE', 'URGENT', 'EMERGENCY'];
const EDITABLE = ['DRAFT', 'RETURNED'];

// ------------------------------------------------------------------ list

/** My requisitions, my department's, or (procurement / finance) everyone's. */
export function StaffRequisitionsPage() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [scope, setScope] = useState<'mine' | 'department' | 'all'>('mine');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<StaffRequisition>('/staff-requisitions', { ...pagination, scope, search: q, status });
  const columns: GridColDef<StaffRequisition>[] = [
    { field: 'number', headerName: 'Number', width: 170 },
    { field: 'department', headerName: 'Department', width: 170, valueGetter: (_v, r) => r.department?.name ?? '' },
    { field: 'requestedByName', headerName: 'Requested by', width: 170 },
    { field: 'justification', headerName: 'Justification', flex: 1, minWidth: 220 },
    { field: 'priority', headerName: 'Priority', width: 110, valueFormatter: (v: string) => humanise(v) },
    { field: 'estimatedTotal', headerName: 'Estimate', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Requisitions"
        search={search}
        onSearch={setSearch}
        onNew={can(P.STAFF_REQUISITION_CREATE) ? () => navigate('/staff-requisitions/new') : undefined}
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 190 } }}>
            <MenuItem value="">Any</MenuItem>
            {['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTLY_CONVERTED', 'CONVERTED', 'RETURNED', 'REJECTED', 'CLOSED', 'CANCELLED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <AwaitingMePanel />
      <Tabs value={scope} onChange={(_, v) => setScope(v)} sx={{ mb: 2 }}>
        <Tab value="mine" label="Mine" />
        {user?.departmentId && <Tab value="department" label="My department" />}
        {can(P.STAFF_REQUISITION_READ_ALL) && <Tab value="all" label="All departments" />}
      </Tabs>
      <Paper>
        <DataGrid
          autoHeight
          rows={data?.items ?? []}
          rowCount={data?.total ?? 0}
          columns={columns}
          loading={isFetching}
          paginationMode="server"
          paginationModel={pagination}
          onPaginationModelChange={setPagination}
          pageSizeOptions={[25, 50, 100]}
          onRowClick={({ row }) => navigate(`/staff-requisitions/${row.id}`)}
          localeText={{ noRowsLabel: 'No requisitions' }}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ form

interface LineForm {
  lineType: LineType;
  item: Item | null;
  description: string;
  categoryId: string;
  quantity: string;
  uomId: string;
  estimatedUnitCost: string;
  glAccountId: string;
  notes: string;
}

const blankLine = (lineType: LineType = 'SERVICE'): LineForm => ({ lineType, item: null, description: '', categoryId: '', quantity: '1', uomId: '', estimatedUnitCost: '', glAccountId: '', notes: '' });

export function StaffRequisitionFormPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const notify = useNotify();
  const money = useMoney();
  const existing = useQuery({ queryKey: ['/staff-requisitions', id], queryFn: () => api<StaffRequisition>(`/staff-requisitions/${id}`), enabled: !!id });
  const departments = useAll<Department>('/departments');
  const projects = useList<Project>('/projects', { active: true });
  const categories = useList<ItemCategory>('/item-categories');
  const uoms = useList<Uom>('/uoms');
  const gl = useAll<GlAccount>('/gl-accounts', { active: true });
  const [head, setHead] = useState({ departmentId: user?.departmentId ?? '', projectId: '', storeId: '', priority: 'ROUTINE', requiredBy: '', justification: '' });
  const [lines, setLines] = useState<LineForm[]>([blankLine()]);
  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setHead({ departmentId: r.departmentId, projectId: r.projectId ?? '', storeId: r.storeId ?? '', priority: r.priority, requiredBy: r.requiredBy ?? '', justification: r.justification });
    setLines(
      (r.lines ?? []).map((l) => ({
        lineType: l.lineType,
        item: (l.item as Item | null) ?? null,
        description: l.description,
        categoryId: l.categoryId ?? '',
        quantity: String(l.quantity),
        uomId: l.uomId ?? '',
        estimatedUnitCost: String(l.estimatedUnitCost),
        glAccountId: l.glAccountId ?? '',
        notes: l.notes ?? '',
      })),
    );
  }, [existing.data]);
  const total = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.estimatedUnitCost || 0), 0);
  const hasStock = lines.some((l) => l.lineType === 'STOCK');
  const body = (submit: boolean) => ({
    departmentId: head.departmentId,
    projectId: head.projectId || null,
    storeId: head.storeId || null,
    priority: head.priority,
    requiredBy: head.requiredBy || null,
    justification: head.justification,
    submit,
    lines: lines.map((l) => ({
      lineType: l.lineType,
      itemId: l.item?.id ?? null,
      description: l.description || undefined,
      categoryId: l.categoryId || null,
      quantity: Number(l.quantity),
      uomId: l.uomId || null,
      estimatedUnitCost: l.estimatedUnitCost === '' ? undefined : Number(l.estimatedUnitCost),
      glAccountId: l.glAccountId || null,
      notes: l.notes || undefined,
    })),
  });
  const save = useApiMutation<boolean, StaffRequisition>((submit) => [id ? `/staff-requisitions/${id}` : '/staff-requisitions', { method: id ? 'PUT' : 'POST', body: body(submit) }], {
    invalidate: ['/staff-requisitions', '/approvals'],
  });
  const done = (r: StaffRequisition) => {
    if (r.budgetWarning) notify.info(r.budgetWarning);
    notify.success(r.status === 'SUBMITTED' ? `${r.number} submitted for approval` : `${r.number} saved`);
    navigate(`/staff-requisitions/${r.id}`);
  };
  const set = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <>
      <PageHeader title={id ? `Edit ${existing.data?.number ?? ''}` : 'New requisition'} />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <TextField select required label="Department / cost centre" value={head.departmentId} onChange={(e) => setHead({ ...head, departmentId: e.target.value })} sx={{ minWidth: 240, width: 'auto' }}
            helperText={head.departmentId && head.departmentId !== user?.departmentId ? 'On behalf of another department: its head approves' : ' '}>
            {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
          <TextField select label="Project" value={head.projectId} onChange={(e) => setHead({ ...head, projectId: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
            <MenuItem value="">None</MenuItem>
            {(projects.data ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.code} · {p.name}</MenuItem>)}
          </TextField>
          <TextField select label="Priority" value={head.priority} onChange={(e) => setHead({ ...head, priority: e.target.value })} sx={{ width: 150 }}>
            {PRIORITIES.map((p) => <MenuItem key={p} value={p}>{humanise(p)}</MenuItem>)}
          </TextField>
          <TextField type="date" label="Required by" value={head.requiredBy} onChange={(e) => setHead({ ...head, requiredBy: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        </Stack>
        <TextField label="Justification" required fullWidth multiline minRows={2} value={head.justification} onChange={(e) => setHead({ ...head, justification: e.target.value })} sx={{ mb: 2 }} />
        {hasStock && <StoreSelect label="Store for the stock items" value={head.storeId} onChange={(v) => setHead({ ...head, storeId: v })} sx={{ minWidth: 260, mb: 2 }} />}
        <Typography variant="subtitle2" gutterBottom>Lines</Typography>
        <Stack spacing={1.5}>
          {lines.map((l, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
                <TextField select label="Type" value={l.lineType} onChange={(e) => set(i, { lineType: e.target.value as LineType, item: null })} sx={{ minWidth: 210, width: 'auto' }}>
                  {LINE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
                </TextField>
                {l.lineType === 'STOCK' ? (
                  <Box sx={{ flex: 2, minWidth: 260 }}>
                    <ItemPicker label="Item (search or scan)" value={l.item} onChange={(item) => set(i, { item })} />
                  </Box>
                ) : (
                  <TextField label="What is needed" required value={l.description} onChange={(e) => set(i, { description: e.target.value })} sx={{ flex: 2, minWidth: 260 }} />
                )}
                <TextField label="Qty" type="number" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} sx={{ width: 100 }} />
                {l.lineType !== 'STOCK' && (
                  <TextField select label="Unit" value={l.uomId} onChange={(e) => set(i, { uomId: e.target.value })} sx={{ width: 120 }}>
                    <MenuItem value="">—</MenuItem>
                    {(uoms.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.code}</MenuItem>)}
                  </TextField>
                )}
                <TextField label={l.lineType === 'STOCK' ? 'Est. cost (default: store cost)' : 'Est. unit cost'} type="number" value={l.estimatedUnitCost} onChange={(e) => set(i, { estimatedUnitCost: e.target.value })} sx={{ width: 170 }} />
                <IconButton aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
              {l.lineType !== 'STOCK' && (
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mt: 1.5 }}>
                  <TextField select label="GL account" value={l.glAccountId} onChange={(e) => set(i, { glAccountId: e.target.value })} sx={{ minWidth: 280, width: 'auto' }} helperText="What it is charged to (finance can recode)">
                    <MenuItem value="">Not sure</MenuItem>
                    {(gl.data ?? []).filter((a) => ['EXPENSE', 'ASSET'].includes(a.type)).map((a) => <MenuItem key={a.id} value={a.id}>{a.code} · {a.name}</MenuItem>)}
                  </TextField>
                  <TextField select label="Category" value={l.categoryId} onChange={(e) => set(i, { categoryId: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
                    <MenuItem value="">—</MenuItem>
                    {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
                  </TextField>
                  <TextField label="Notes / specification" value={l.notes} onChange={(e) => set(i, { notes: e.target.value })} sx={{ flex: 1 }} />
                </Stack>
              )}
            </Paper>
          ))}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
          <Button startIcon={<AddIcon />} onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
          <Typography sx={{ ml: 'auto' }}>Estimated total: <b>{money(total)}</b></Typography>
        </Stack>
      </Paper>
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" disabled={save.isPending} onClick={() => save.mutate(false, { onSuccess: done })}>Save draft</Button>
        <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate(true, { onSuccess: done })}>Submit for approval</Button>
        <Button onClick={() => navigate(-1)}>Cancel</Button>
      </Stack>
    </>
  );
}

// ------------------------------------------------------------------ detail

export function StaffRequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();
  const { user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const { data: r } = useQuery({ queryKey: ['/staff-requisitions', id], queryFn: () => api<StaffRequisition>(`/staff-requisitions/${id}`) });
  const submit = useApiMutation<void, StaffRequisition>(() => [`/staff-requisitions/${id}/submit`, { method: 'POST' }], { invalidate: ['/staff-requisitions', '/approvals'], success: 'Submitted for approval' });
  const cancel = useApiMutation<void>(() => [`/staff-requisitions/${id}/cancel`, { method: 'POST', body: { reason } }], { invalidate: ['/staff-requisitions', '/approvals'], success: 'Cancelled' });
  if (!r) return null;
  const mine = r.requestedBy === user?.id;
  return (
    <>
      <PageHeader title={`Requisition ${r.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={r.status} />
                <Typography>{humanise(r.priority)} · {r.department?.name}{r.onBehalfOfDepartment ? ' (on behalf of the department)' : ''}</Typography>
              </Stack>
              {r.lastComment && ['RETURNED', 'REJECTED', 'CANCELLED'].includes(r.status) && <Alert severity="warning" sx={{ mb: 2 }}>{r.lastComment}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Requested by">{r.requestedByName}</Field>
                <Field label="Estimated total">{money(r.estimatedTotal)}</Field>
                <Field label="Required by">{date(r.requiredBy) || '—'}</Field>
                {r.project && <Field label="Project">{r.project.code} · {r.project.name}</Field>}
                {r.store && <Field label="Stock items from">{r.store.name}</Field>}
              </Stack>
              <Typography variant="body2" sx={{ mb: 2 }}>{r.justification}</Typography>
              <Table size="small" aria-label="Requisition lines">
                <TableHead>
                  <TableRow><TableCell>#</TableCell><TableCell>What</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Est. total</TableCell><TableCell>GL</TableCell><TableCell>Where it is</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {(r.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.lineNo}</TableCell>
                      <TableCell>
                        {l.description}
                        <Typography variant="caption" display="block" color="text.secondary">{LINE_TYPES.find((t) => t.value === l.lineType)?.label}{l.notes ? ` · ${l.notes}` : ''}</Typography>
                      </TableCell>
                      <TableCell align="right">{l.quantity} {l.uom?.code}</TableCell>
                      <TableCell align="right">{money(l.quantity * l.estimatedUnitCost)}</TableCell>
                      <TableCell>{l.glAccount ? `${l.glAccount.code} ${l.glAccount.name}` : '—'}</TableCell>
                      <TableCell>
                        <StatusChip status={l.status} />
                        {l.lineType !== 'STOCK' && !!l.receivedQty && l.status !== 'DELIVERED' && <Typography variant="caption" sx={{ ml: 1 }}>received {l.receivedQty}, delivered {l.deliveredQty ?? 0}</Typography>}
                        {l.purchaseRequisition && <Link component={RouterLink} to={`/requisitions/${l.purchaseRequisition.id}`} sx={{ ml: 1 }}>{l.purchaseRequisition.number}</Link>}
                        {l.storeRequisition && <Link component={RouterLink} to={`/store-requisitions/${l.storeRequisition.id}`} sx={{ ml: 1 }}>{l.storeRequisition.number}</Link>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            <DeliveryPanel requisition={r} />
            <AttachmentsPanel ownerType="STAFF_REQUISITION" ownerId={r.id} categories={['QUOTE', 'SPECIFICATION', 'PHOTO', 'GENERAL']} canUpload={mine && EDITABLE.includes(r.status)} />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {mine && EDITABLE.includes(r.status) && <Button variant="outlined" onClick={() => navigate(`/staff-requisitions/${r.id}/edit`)}>Edit</Button>}
              {mine && EDITABLE.includes(r.status) && (
                <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate(undefined, { onSuccess: (x) => x.budgetWarning && notify.info(x.budgetWarning) })}>
                  Submit for approval
                </Button>
              )}
              <Button component="a" href={buildUrl(`/staff-requisitions/${r.id}/pdf`)} target="_blank">PDF</Button>
              {mine && [...EDITABLE, 'SUBMITTED', 'APPROVED'].includes(r.status) && <Button color="error" onClick={() => setCancelling(true)}>Cancel requisition</Button>}
            </Stack>
          </>
        }
        side={
          <>
            <ApprovalPanel type="REQ" id={r.id} />
            <DocumentChain type="REQ" id={r.id} />
          </>
        }
      />
      {cancelling && (
        <FormDialog open title="Cancel requisition" submitLabel="Cancel it" onClose={() => setCancelling(false)} submitting={cancel.isPending} onSubmit={(e) => { e.preventDefault(); cancel.mutate(undefined, { onSuccess: () => setCancelling(false) }); }}>
          <TextField label="Reason" required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormDialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ procurement queue

/** Approved non-stock lines from every department, to consolidate into purchase requisitions. */
export function ProcurementQueuePage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [consolidating, setConsolidating] = useState(false);
  const departments = useAll<Department>('/departments');
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<QueueLine>('/staff-requisitions/queue', { page: 0, pageSize: 500, search: q, departmentId });
  const rows = data?.items ?? [];
  const chosen = useMemo(() => rows.filter((r) => selected.includes(r.id)), [rows, selected]);
  const columns: GridColDef<QueueLine>[] = [
    { field: 'requisitionNo', headerName: 'Requisition', width: 160, renderCell: (p) => <Link component={RouterLink} to={`/staff-requisitions/${p.row.requisitionId}`} onClick={(e) => e.stopPropagation()}>{p.value}</Link> },
    { field: 'department', headerName: 'Department', width: 150 },
    { field: 'description', headerName: 'What', flex: 1, minWidth: 220 },
    { field: 'lineType', headerName: 'Type', width: 130, valueFormatter: (v: string) => humanise(v) },
    { field: 'quantity', headerName: 'Qty', width: 90, valueGetter: (_v, r) => `${r.quantity} ${r.uom ?? ''}` },
    { field: 'estimatedTotal', headerName: 'Estimate', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
    { field: 'glCode', headerName: 'GL', width: 90 },
    { field: 'priority', headerName: 'Priority', width: 110, valueFormatter: (v: string) => humanise(v) },
    { field: 'approvedAt', headerName: 'Approved', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Procurement queue"
        search={search}
        onSearch={setSearch}
        actions={
          <TextField select label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ width: { xs: '100%', sm: 200 } }}>
            <MenuItem value="">All</MenuItem>
            {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
        }
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Approved non-stock lines (goods, services, capital items expensed) waiting to be bought. Select lines — from any departments — and put them on one purchase requisition.
      </Typography>
      {can(P.PURCHASING_CONSOLIDATE) && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Button variant="contained" disabled={!chosen.length} onClick={() => setConsolidating(true)}>
            Create purchase requisition ({chosen.length})
          </Button>
          {chosen.length > 0 && <Chip label={`Estimate ${money(chosen.reduce((s, r) => s + r.estimatedTotal, 0))}`} />}
        </Stack>
      )}
      <Paper>
        <DataGrid
          autoHeight
          rows={rows}
          columns={columns}
          loading={isFetching}
          checkboxSelection={can(P.PURCHASING_CONSOLIDATE)}
          rowSelectionModel={selected}
          onRowSelectionModelChange={(m) => setSelected(m as string[])}
          localeText={{ noRowsLabel: 'Nothing waiting to be bought' }}
          disableRowSelectionOnClick={false}
          pageSizeOptions={[25, 50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      {consolidating && (
        <ConsolidateDialog
          lines={chosen}
          onClose={() => setConsolidating(false)}
          onDone={(prId) => {
            setSelected([]);
            navigate(`/requisitions/${prId}`);
          }}
        />
      )}
    </>
  );
}

function ConsolidateDialog({ lines, onClose, onDone }: { lines: QueueLine[]; onClose(): void; onDone(prId: string): void }) {
  const { user } = useAuth();
  const money = useMoney();
  const departments = useAll<Department>('/departments');
  const suppliers = useAll<Supplier>('/suppliers', { status: 'ACTIVE' });
  const [f, setF] = useState({ departmentId: user?.departmentId ?? '', storeId: '', justification: '', sourcingMethod: '', sourcingJustification: '', suggestedSupplierIds: [] as string[] });
  const save = useApiMutation<void, { id: string; number: string }>(
    () => ['/staff-requisitions/consolidate', { method: 'POST', body: { ...f, lineIds: lines.map((l) => l.id), sourcingMethod: f.sourcingMethod || null, sourcingJustification: f.sourcingJustification || null } }],
    { invalidate: ['/staff-requisitions', '/requisitions'] },
  );
  return (
    <FormDialog open maxWidth="md" title={`Purchase requisition from ${lines.length} line(s)`} submitLabel="Create draft" submitting={save.isPending} onClose={onClose} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (pr) => onDone(pr.id) }); }}>
      <Typography variant="body2">
        {[...new Set(lines.map((l) => l.department))].join(', ')} · estimate {money(lines.reduce((s, l) => s + l.estimatedTotal, 0))}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select required label="Owning department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} sx={{ minWidth: 220, width: 'auto' }}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <StoreSelect label="Delivery location" value={f.storeId} onChange={(v) => setF({ ...f, storeId: v })} sx={{ minWidth: 220 }} />
        <TextField select label="Procurement method" value={f.sourcingMethod} onChange={(e) => setF({ ...f, sourcingMethod: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
          <MenuItem value="">Recommended by value</MenuItem>
          {['DIRECT', 'LOW_VALUE', 'RFQ', 'RFP', 'RESTRICTED_TENDER', 'OPEN_TENDER', 'FRAMEWORK'].map((m) => <MenuItem key={m} value={m}>{humanise(m)}</MenuItem>)}
        </TextField>
      </Stack>
      {['DIRECT', 'RESTRICTED_TENDER'].includes(f.sourcingMethod) && <TextField label="Method justification" required value={f.sourcingJustification} onChange={(e) => setF({ ...f, sourcingJustification: e.target.value })} />}
      <TextField select SelectProps={{ multiple: true }} label="Suggested suppliers" value={f.suggestedSupplierIds} onChange={(e) => setF({ ...f, suggestedSupplierIds: e.target.value as unknown as string[] })}>
        {(suppliers.data ?? []).map((s) => (
          <MenuItem key={s.id} value={s.id}><Checkbox size="small" checked={f.suggestedSupplierIds.includes(s.id)} />{s.name}</MenuItem>
        ))}
      </TextField>
      <TextField label="Justification" required multiline minRows={2} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} />
      <Typography variant="caption" color="text.secondary">The purchase requisition is created as a draft: open it to submit for approval.</Typography>
    </FormDialog>
  );
}

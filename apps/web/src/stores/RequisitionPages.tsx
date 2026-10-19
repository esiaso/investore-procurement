import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  Link,
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
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Permissions, RequisitionPriority, StoreRequisitionStatus } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { BackorderRow, StoreRequisition } from '../api/stores-types';
import type { Department, Item, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';

const ISSUABLE: string[] = [StoreRequisitionStatus.APPROVED, StoreRequisitionStatus.PARTIALLY_ISSUED];

/** Whether the user can issue from a store (permission + store scope). */
export function useCanIssue() {
  const { can, user } = useAuth();
  return (storeId: string) => can(Permissions.INVENTORY_ISSUE) && (user?.storeIds === null || !!user?.storeIds?.includes(storeId));
}

const schema = z.object({
  departmentId: z.string().uuid('Choose the department'),
  storeId: z.string().uuid('Choose the issuing store'),
  priority: z.nativeEnum(RequisitionPriority),
  requiredBy: z.string().optional(),
  notes: z.string().max(1000).optional(),
  lines: z
    .array(
      z.object({
        item: z.custom<Item>((v) => !!v, 'Choose an item'),
        quantity: z.coerce.number().positive('> 0'),
        patientRef: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .refine((ls) => new Set(ls.map((l) => l.item?.id)).size === ls.length, 'Each item may appear only once'),
});
type FormValues = z.infer<typeof schema>;

export function StoreRequisitionFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const departments = useAll<Department>('/departments');
  const stores = useList<Store>('/stores/directory');
  const existing = useQuery({ queryKey: ['/store-requisitions', id], queryFn: () => api<StoreRequisition>(`/store-requisitions/${id}`), enabled: !!id });
  const [submitNow, setSubmitNow] = useState(true);
  const ownOnly = user?.storeIds !== null && !!user?.departmentId;
  const { control, handleSubmit, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: existing.data
      ? {
          departmentId: existing.data.departmentId,
          storeId: existing.data.storeId,
          priority: existing.data.priority,
          requiredBy: existing.data.requiredBy ?? '',
          notes: existing.data.notes ?? '',
          lines: (existing.data.lines ?? []).map((l) => ({ item: l.item as Item, quantity: l.requestedQty, patientRef: l.patientRef ?? '' })),
        }
      : undefined,
    defaultValues: {
      departmentId: user?.departmentId ?? '',
      storeId: '',
      priority: RequisitionPriority.ROUTINE,
      requiredBy: '',
      notes: '',
      lines: [{ item: null as unknown as Item, quantity: 0, patientRef: '' }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const save = useApiMutation<FormValues, StoreRequisition>(
    (v) => [
      id ? `/store-requisitions/${id}` : '/store-requisitions',
      {
        method: id ? 'PUT' : 'POST',
        body: {
          departmentId: v.departmentId,
          storeId: v.storeId,
          priority: v.priority,
          requiredBy: v.requiredBy || undefined,
          notes: v.notes || undefined,
          submit: submitNow,
          lines: v.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, patientRef: l.patientRef || undefined })),
        },
      },
    ],
    { invalidate: ['/store-requisitions', '/approvals'], success: submitNow ? 'Submitted for approval' : 'Draft saved' },
  );
  const deptOptions = (departments.data ?? []).filter((d) => !ownOnly || d.id === user?.departmentId);
  const linesError = (formState.errors.lines as { root?: { message?: string }; message?: string } | undefined);
  return (
    <>
      <PageHeader title={id ? `Edit ${existing.data?.number ?? 'requisition'}` : 'New internal requisition'} />
      <Paper sx={{ p: 2 }}>
        <form noValidate onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: (sr) => navigate(`/store-requisitions/${sr.id}`) }))}>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Controller control={control} name="departmentId" render={({ field, fieldState }) => (
                <TextField select label="Department / ward" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ minWidth: 220 }}>
                  {deptOptions.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="storeId" render={({ field, fieldState }) => (
                <TextField select label="Request from" {...field} disabled={!!id} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ minWidth: 220 }}>
                  {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="priority" render={({ field }) => (
                <TextField select label="Priority" {...field} sx={{ minWidth: 150 }}>
                  {Object.values(RequisitionPriority).map((p) => <MenuItem key={p} value={p}>{humanise(p)}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="requiredBy" render={({ field }) => <TextField label="Required by" type="date" {...field} slotProps={{ inputLabel: { shrink: true } }} />} />
            </Stack>
            <Controller control={control} name="notes" render={({ field }) => <TextField label="Notes" multiline minRows={2} {...field} />} />
            <Typography variant="subtitle2">Items (quantities in base units)</Typography>
            {fields.map((f, i) => (
              <Stack key={f.id} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
                <Controller control={control} name={`lines.${i}.item`} render={({ field, fieldState }) => (
                  <ItemPicker value={field.value} onChange={field.onChange} autoFocus={i > 0 && i === fields.length - 1} error={fieldState.error?.message} />
                )} />
                <Controller control={control} name={`lines.${i}.quantity`} render={({ field, fieldState }) => (
                  <TextField label="Quantity" type="number" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { md: 130 } }} />
                )} />
                <Controller control={control} name={`lines.${i}.patientRef`} render={({ field }) => (
                  <TextField label="Patient / encounter ref" {...field} helperText="Optional, for patient-charged consumables" sx={{ width: { md: 230 } }} />
                )} />
                <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)} disabled={fields.length === 1}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            {linesError?.root?.message && <Alert severity="error">{linesError.root.message}</Alert>}
            <Box>
              <Button startIcon={<AddIcon />} onClick={() => append({ item: null as unknown as Item, quantity: 0, patientRef: '' })}>
                Add item
              </Button>
            </Box>
            <Stack direction="row" spacing={2} alignItems="center">
              <FormControlLabel control={<Switch checked={submitNow} onChange={(e) => setSubmitNow(e.target.checked)} />} label="Submit for approval now" />
              <Button type="submit" variant="contained" disabled={save.isPending}>
                {submitNow ? 'Save and submit' : 'Save draft'}
              </Button>
            </Stack>
          </Stack>
        </form>
      </Paper>
    </>
  );
}

function ReasonDialog({ title, label, onClose, onSubmit, pending }: { title: string; label: string; onClose(): void; onSubmit(reason: string): void; pending: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog open title={title} onClose={onClose} submitting={pending} submitLabel="Confirm" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); }}>
      <TextField label={label} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus multiline minRows={2} />
    </FormDialog>
  );
}

export function StoreRequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canIssue = useCanIssue();
  const money = useMoney();
  const date = useDate();
  const [dialog, setDialog] = useState<'cancel' | 'backorder' | null>(null);
  const { data: sr } = useQuery({ queryKey: ['/store-requisitions', id], queryFn: () => api<StoreRequisition>(`/store-requisitions/${id}`) });
  const inv = ['/store-requisitions', '/approvals', '/documents', '/inventory'];
  const submit = useApiMutation<void>(() => [`/store-requisitions/${id}/submit`, { method: 'POST' }], { invalidate: inv, success: 'Submitted for approval' });
  const cancel = useApiMutation<string>((reason) => [`/store-requisitions/${id}/cancel`, { method: 'POST', body: { reason } }], { invalidate: inv, success: 'Requisition cancelled' });
  const cancelBo = useApiMutation<string>((reason) => [`/store-requisitions/${id}/cancel-backorder`, { method: 'POST', body: { reason } }], { invalidate: inv, success: 'Back-order cancelled' });
  const reserve = useApiMutation<void>(() => [`/store-requisitions/${id}/reserve`, { method: 'POST' }], { invalidate: inv, success: 'Reservations updated' });
  if (!sr) return null;
  const mine = sr.requestedBy === user?.id;
  const editable = mine && ['DRAFT', 'RETURNED'].includes(sr.status);
  const store = canIssue(sr.storeId);
  const issuable = ISSUABLE.includes(sr.status);
  return (
    <>
      <PageHeader title={`Internal requisition ${sr.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={sr.status} />
                {sr.priority !== 'ROUTINE' && <Chip size="small" color={sr.priority === 'EMERGENCY' ? 'error' : 'warning'} label={humanise(sr.priority)} />}
                <Typography>{sr.department?.name} ← {sr.store?.name}</Typography>
              </Stack>
              {sr.lastComment && ['RETURNED', 'REJECTED', 'CANCELLED'].includes(sr.status) && <Alert severity="warning" sx={{ mb: 2 }}>{sr.lastComment}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Requested by">{sr.requestedByName ?? '—'}</Field>
                <Field label="Estimated value">{money(sr.estimatedValue)}</Field>
                <Field label="Required by">{date(sr.requiredBy) || '—'}</Field>
                <Field label="Raised">{date(sr.createdAt)}</Field>
              </Stack>
              {sr.notes && <Typography variant="body2" sx={{ mb: 2 }}>{sr.notes}</Typography>}
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Requisition lines">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell align="right">Requested</TableCell>
                      <TableCell align="right">Issued</TableCell>
                      <TableCell align="right">Outstanding</TableCell>
                      <TableCell align="right">Reserved</TableCell>
                      <TableCell align="right">Available</TableCell>
                      <TableCell>Patient</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(sr.lines ?? []).map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>
                          {l.item?.name}
                          {l.cancelledQty > 0 && <Typography variant="caption" display="block" color="text.secondary">{l.cancelledQty} cancelled: {l.cancelReason}</Typography>}
                          {l.reservations.length > 0 && (
                            <Typography variant="caption" display="block" color="text.secondary">
                              Reserved: {l.reservations.map((r) => `${r.batchNo}${r.binCode ? ` @${r.binCode}` : ''} × ${r.quantity}`).join(', ')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right">{l.requestedQty} {l.item?.baseUom?.code}</TableCell>
                        <TableCell align="right">{l.issuedQty}</TableCell>
                        <TableCell align="right">{l.outstandingQty > 0 ? <b>{l.outstandingQty}</b> : 0}</TableCell>
                        <TableCell align="right">{l.reservedQty}</TableCell>
                        <TableCell align="right">{issuable ? l.availableQty : ''}</TableCell>
                        <TableCell>{l.patientRef}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Paper>
            {(sr.issues ?? []).length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Issue vouchers</Typography>
                {sr.issues!.map((v) => (
                  <Stack key={v.id} direction="row" spacing={2}>
                    <Link component={RouterLink} to={`/issues/${v.id}`}>{v.number}</Link>
                    <Typography variant="body2">{date(v.issueDate)}</Typography>
                    <Typography variant="body2">{money(v.totalValue)}</Typography>
                  </Stack>
                ))}
              </Paper>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {editable && <Button variant="outlined" onClick={() => navigate(`/store-requisitions/${sr.id}/edit`)}>Edit</Button>}
              {editable && <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
              {issuable && store && <Button variant="contained" onClick={() => navigate(`/store-requisitions/${sr.id}/issue`)}>Issue stock</Button>}
              {issuable && store && <Button variant="outlined" disabled={reserve.isPending} onClick={() => reserve.mutate()}>Re-plan reservations</Button>}
              {sr.status === 'PARTIALLY_ISSUED' && (mine || store) && <Button color="warning" onClick={() => setDialog('backorder')}>Cancel back-order</Button>}
              {(mine || store) && ['DRAFT', 'RETURNED', 'PENDING_APPROVAL', 'APPROVED'].includes(sr.status) && <Button color="error" onClick={() => setDialog('cancel')}>Cancel requisition</Button>}
            </Stack>
          </>
        }
        side={
          <>
            <ApprovalPanel type="SR" id={sr.id} />
            <DocumentChain type="SR" id={sr.id} />
          </>
        }
      />
      {dialog === 'cancel' && (
        <ReasonDialog title="Cancel requisition" label="Reason" pending={cancel.isPending} onClose={() => setDialog(null)} onSubmit={(r) => cancel.mutate(r, { onSuccess: () => setDialog(null) })} />
      )}
      {dialog === 'backorder' && (
        <ReasonDialog title="Cancel the outstanding back-order" label="Reason (e.g. patient discharged)" pending={cancelBo.isPending} onClose={() => setDialog(null)} onSubmit={(r) => cancelBo.mutate(r, { onSuccess: () => setDialog(null) })} />
      )}
    </>
  );
}

export function StoreRequisitionsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<StoreRequisition>('/store-requisitions', { ...pagination, search: q, status, open: open || undefined });
  const columns: GridColDef<StoreRequisition>[] = [
    { field: 'number', headerName: 'Number', width: 180 },
    { field: 'department', headerName: 'Department', width: 170, valueGetter: (_v, r) => r.department?.name ?? '' },
    { field: 'store', headerName: 'From', width: 160, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'priority', headerName: 'Priority', width: 110, valueFormatter: (v: string) => humanise(v) },
    { field: 'estimatedValue', headerName: 'Est. value', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
    { field: 'status', headerName: 'Status', width: 160, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'requiredBy', headerName: 'Required by', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Internal requisitions"
        search={search}
        onSearch={setSearch}
        onNew={can(Permissions.INVENTORY_REQUISITION) ? () => navigate('/store-requisitions/new') : undefined}
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 180 } }}>
              <MenuItem value="">Any</MenuItem>
              {Object.values(StoreRequisitionStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
            </TextField>
            <FormControlLabel control={<Switch checked={open} onChange={(e) => setOpen(e.target.checked)} />} label="To issue" />
          </Stack>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/store-requisitions/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

export function BackordersPage() {
  const navigate = useNavigate();
  const canIssue = useCanIssue();
  const date = useDate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, isFetching } = useList<BackorderRow>('/store-requisitions/backorders', { search: q });
  const columns: GridColDef<BackorderRow>[] = [
    { field: 'number', headerName: 'Requisition', width: 170 },
    { field: 'department', headerName: 'Department', width: 160 },
    { field: 'store', headerName: 'From', width: 140 },
    { field: 'itemName', headerName: 'Item', flex: 1, minWidth: 200 },
    { field: 'outstandingQty', headerName: 'Owed', type: 'number', width: 80 },
    { field: 'uom', headerName: 'Unit', width: 70 },
    { field: 'reservedQty', headerName: 'Reserved', type: 'number', width: 90 },
    {
      field: 'availableQty',
      headerName: 'Available now',
      type: 'number',
      width: 120,
      renderCell: ({ value }) => (value > 0 ? <Chip size="small" color="success" label={value} /> : <span>0</span>),
    },
    { field: 'priority', headerName: 'Priority', width: 100, valueFormatter: (v: string) => humanise(v) },
    { field: 'requiredBy', headerName: 'Required by', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'ageDays', headerName: 'Age (days)', type: 'number', width: 100 },
    {
      field: 'actions',
      headerName: '',
      width: 110,
      sortable: false,
      renderCell: ({ row }) =>
        canIssue(row.storeId) && row.availableQty > 0 ? (
          <Button size="small" onClick={(e) => { e.stopPropagation(); navigate(`/store-requisitions/${row.requisitionId}/issue`); }}>
            Fill now
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader title="Back-orders" search={search} onSearch={setSearch} searchPlaceholder="Search requisition or item" />
      <Alert severity="info" sx={{ mb: 2 }}>
        Quantities still owed to departments after a partial issue. Fill them when stock arrives, or cancel the back-order from the requisition.
      </Alert>
      <Paper>
        <DataGrid autoHeight density="compact" getRowId={(r) => r.lineId} rows={data ?? []} columns={columns} loading={isFetching} pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} onRowClick={({ row }) => navigate(`/store-requisitions/${row.requisitionId}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

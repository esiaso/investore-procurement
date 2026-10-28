import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  Stack,
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
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Permissions, RequisitionPriority, RequisitionStatus } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { PurchaseOrder, Requisition, Rfq, Supplier } from '../api/purchasing-types';
import type { Department, Item, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { useNotify } from '../components/Notify';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSourcingMethods } from '../strategic/api';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from './common';

const schema = z.object({
  departmentId: z.string().uuid('Choose a department'),
  storeId: z.string().uuid('Choose the store'),
  budgetId: z.string().optional(),
  priority: z.nativeEnum(RequisitionPriority),
  requiredBy: z.string().optional(),
  justification: z.string().trim().min(5, 'Explain why this is needed').max(2000),
  sourcingMethod: z.string().optional(),
  sourcingJustification: z.string().max(2000).optional(),
  lines: z
    .array(z.object({ item: z.custom<Item>((v) => !!v, 'Choose an item'), quantity: z.coerce.number().positive('> 0'), estimatedUnitPrice: z.coerce.number().min(0).optional() }))
    .min(1),
});
type FormValues = z.infer<typeof schema>;

export function useSupplierOptions() {
  return useAll<Supplier>('/suppliers', { status: 'ACTIVE' });
}

export function RequisitionFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const departments = useAll<Department>('/departments');
  const stores = useList<Store>('/stores/directory');
  const existing = useQuery({ queryKey: ['/requisitions', id], queryFn: () => api<Requisition>(`/requisitions/${id}`), enabled: !!id });
  const { control, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: existing.data
      ? {
          departmentId: existing.data.departmentId,
          storeId: existing.data.storeId,
          budgetId: existing.data.budgetId ?? '',
          priority: existing.data.priority as RequisitionPriority,
          requiredBy: existing.data.requiredBy ?? '',
          justification: existing.data.justification,
          sourcingMethod: existing.data.sourcingMethod ?? '',
          sourcingJustification: existing.data.sourcingJustification ?? '',
          lines: (existing.data.lines ?? []).map((l) => ({ item: l.item as Item, quantity: l.quantity, estimatedUnitPrice: l.estimatedUnitPrice })),
        }
      : undefined,
    defaultValues: { departmentId: '', storeId: '', budgetId: '', priority: RequisitionPriority.ROUTINE, requiredBy: '', justification: '', sourcingMethod: '', sourcingJustification: '', lines: [{ item: null as unknown as Item, quantity: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const departmentId = useWatch({ control, name: 'departmentId' });
  const method = useWatch({ control, name: 'sourcingMethod' });
  const methods = useSourcingMethods();
  const needsJustification = !!methods.data?.find((m) => m.code === method)?.requiresJustification;
  const budgets = useList<{ id: string; label: string }>('/budgets/options', { departmentId }, !!departmentId);
  const save = useApiMutation<FormValues, Requisition>(
    (v) => [
      id ? `/requisitions/${id}` : '/requisitions',
      {
        method: id ? 'PUT' : 'POST',
        body: {
          departmentId: v.departmentId,
          storeId: v.storeId,
          budgetId: v.budgetId || null,
          priority: v.priority,
          requiredBy: v.requiredBy || null,
          justification: v.justification,
          sourcingMethod: v.sourcingMethod || null,
          sourcingJustification: v.sourcingJustification || null,
          lines: v.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, estimatedUnitPrice: l.estimatedUnitPrice || undefined })),
        },
      },
    ],
    { invalidate: ['/requisitions'], success: 'Requisition saved' },
  );
  return (
    <>
      <PageHeader title={id ? `Edit ${existing.data?.number ?? 'requisition'}` : 'New purchase requisition'} />
      <Paper sx={{ p: 2 }}>
        <form noValidate onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: (pr) => { reset(); navigate(`/requisitions/${pr.id}`); } }))}>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Controller control={control} name="departmentId" render={({ field, fieldState }) => (
                <TextField select label="Department" {...field} error={!!fieldState.error} helperText={fieldState.error?.message}>
                  {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="storeId" render={({ field, fieldState }) => (
                <TextField select label="For store" {...field} error={!!fieldState.error} helperText={fieldState.error?.message}>
                  {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="budgetId" render={({ field }) => (
                <TextField select label="Budget" {...field}>
                  <MenuItem value="">No budget</MenuItem>
                  {(budgets.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>)}
                </TextField>
              )} />
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Controller control={control} name="priority" render={({ field }) => (
                <TextField select label="Priority" {...field}>
                  {Object.values(RequisitionPriority).map((p) => <MenuItem key={p} value={p}>{humanise(p)}</MenuItem>)}
                </TextField>
              )} />
              <Controller control={control} name="requiredBy" render={({ field }) => <TextField label="Required by" type="date" {...field} slotProps={{ inputLabel: { shrink: true } }} />} />
              <Controller control={control} name="sourcingMethod" render={({ field }) => (
                <TextField select label="Sourcing method" {...field} value={field.value ?? ''} helperText="Checked against the value bands when submitted" sx={{ minWidth: 240, width: 'auto' }}>
                  <MenuItem value="">Recommended for the value</MenuItem>
                  {(methods.data ?? []).filter((m) => m.isActive).map((m) => <MenuItem key={m.code} value={m.code}>{m.label}</MenuItem>)}
                </TextField>
              )} />
            </Stack>
            {needsJustification && (
              <Controller control={control} name="sourcingJustification" render={({ field }) => (
                <TextField label="Why this method (required)" multiline minRows={2} {...field} value={field.value ?? ''} />
              )} />
            )}
            <Controller control={control} name="justification" render={({ field, fieldState }) => (
              <TextField label="Justification" multiline minRows={2} {...field} error={!!fieldState.error} helperText={fieldState.error?.message} />
            )} />
            <Typography variant="subtitle2">Items (quantities in base units)</Typography>
            {fields.map((f, i) => (
              <Stack key={f.id} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
                <Controller control={control} name={`lines.${i}.item`} render={({ field, fieldState }) => (
                  <ItemPicker value={field.value} onChange={field.onChange} autoFocus={i > 0 && i === fields.length - 1} error={fieldState.error?.message} />
                )} />
                <Controller control={control} name={`lines.${i}.quantity`} render={({ field, fieldState }) => (
                  <TextField label="Quantity" type="number" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { md: 140 } }} />
                )} />
                <Controller control={control} name={`lines.${i}.estimatedUnitPrice`} render={({ field }) => (
                  <TextField label="Est. unit price" type="number" {...field} value={field.value ?? ''} helperText="Blank = last cost" sx={{ width: { md: 160 } }} />
                )} />
                <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)} disabled={fields.length === 1}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Box>
              <Button startIcon={<AddIcon />} onClick={() => append({ item: null as unknown as Item, quantity: 0 })}>
                Add item
              </Button>
            </Box>
            <Box>
              <Button type="submit" variant="contained" disabled={save.isPending}>
                Save draft
              </Button>
            </Box>
          </Stack>
        </form>
      </Paper>
    </>
  );
}

function RfqDialog({ pr, onClose }: { pr: Requisition; onClose(): void }) {
  const navigate = useNavigate();
  const suppliers = useSupplierOptions();
  const [form, setForm] = useState<{ title: string; closingDate: string; suppliers: Supplier[] }>({ title: pr.justification.slice(0, 100), closingDate: '', suppliers: [] });
  const create = useApiMutation<void, Rfq>(() => ['/rfqs', { method: 'POST', body: { requisitionId: pr.id, title: form.title, closingDate: form.closingDate, supplierIds: form.suppliers.map((s) => s.id) } }], {
    invalidate: ['/rfqs', '/documents'],
    success: 'RFQ created',
  });
  return (
    <FormDialog open title="Request quotations" submitLabel="Create RFQ" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (r) => navigate(`/rfqs/${r.id}`) }); }}>
      <TextField label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <TextField label="Closing date" type="date" value={form.closingDate} onChange={(e) => setForm({ ...form, closingDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      <Autocomplete multiple options={suppliers.data ?? []} getOptionLabel={(s) => s.name} value={form.suppliers} onChange={(_, v) => setForm({ ...form, suppliers: v })} renderInput={(p) => <TextField {...p} label="Invite suppliers" />} />
    </FormDialog>
  );
}

function PoDialog({ pr, onClose }: { pr: Requisition; onClose(): void }) {
  const navigate = useNavigate();
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const remaining = (pr.lines ?? []).filter((l) => l.quantity > l.orderedQty);
  const create = useApiMutation<void, PurchaseOrder>(
    () => [
      '/purchase-orders',
      { method: 'POST', body: { supplierId, requisitionId: pr.id, expectedDelivery: expectedDelivery || null, lines: remaining.map((l) => ({ requisitionLineId: l.id })) } },
    ],
    { invalidate: ['/purchase-orders', '/requisitions', '/documents'], success: 'Draft PO created' },
  );
  return (
    <FormDialog open title="Order directly (no RFQ)" submitLabel="Create draft PO" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (po) => navigate(`/purchase-orders/${po.id}`) }); }}>
      <Typography variant="body2" color="text.secondary">
        Prices come from the supplier's contract price list when there is one, otherwise from the requisition estimate. You can amend lines before submitting.
      </Typography>
      <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
        {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField label="Expected delivery" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      <Typography variant="body2">{remaining.length} line(s) still to order.</Typography>
    </FormDialog>
  );
}

export function RequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const notify = useNotify();
  const { can, user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [dialog, setDialog] = useState<'rfq' | 'po' | null>(null);
  const { data: pr } = useQuery({ queryKey: ['/requisitions', id], queryFn: () => api<Requisition>(`/requisitions/${id}`) });
  const submit = useApiMutation<void, Requisition & { budgetWarning?: string }>(() => [`/requisitions/${id}/submit`, { method: 'POST' }], {
    invalidate: ['/requisitions', '/approvals'],
    success: 'Submitted for approval',
  });
  const cancel = useApiMutation<void>(() => [`/requisitions/${id}/cancel`, { method: 'POST' }], { invalidate: ['/requisitions', '/approvals'], success: 'Cancelled' });
  if (!pr) return null;
  const mine = pr.requestedBy === user?.id;
  const editable = mine && [RequisitionStatus.DRAFT, RequisitionStatus.RETURNED].includes(pr.status as RequisitionStatus);
  /** Consolidated from staff requisitions (goods / services not held in stock). */
  const nonStock = (pr.lines ?? []).some((l) => l.lineType && l.lineType !== 'STOCK');
  return (
    <>
      <PageHeader title={`Requisition ${pr.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={pr.status} />
                <Typography>{humanise(pr.priority)} · {pr.department?.name} → {pr.store?.name}</Typography>
              </Stack>
              {pr.lastComment && ['RETURNED', 'REJECTED'].includes(pr.status) && <Alert severity="warning" sx={{ mb: 2 }}>{pr.lastComment}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Estimated total">{money(pr.estimatedTotal)}</Field>
                <Field label="Required by">{date(pr.requiredBy) || '—'}</Field>
                <Field label="Raised">{date(pr.createdAt)}</Field>
                <Field label="Sourcing method">{pr.sourcingMethod ? humanise(pr.sourcingMethod) : 'Recommended on submission'}</Field>
              </Stack>
              {pr.sourcingJustification && <Typography variant="body2" sx={{ mb: 1 }}>Method justification: {pr.sourcingJustification}</Typography>}
              <Typography variant="body2" sx={{ mb: 2 }}>{pr.justification}</Typography>
              <Table size="small" aria-label="Requisition lines">
                <TableHead>
                  <TableRow><TableCell>Item</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Ordered</TableCell><TableCell align="right">Est. price</TableCell><TableCell align="right">Est. total</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {(pr.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        {l.item?.name ?? l.description}
                        {l.lineType && l.lineType !== 'STOCK' && (
                          <Typography variant="caption" display="block" color="text.secondary">
                            {humanise(l.lineType)}{l.notes ? ` · ${l.notes}` : ''}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{l.quantity} {l.item?.baseUom?.code ?? l.uom?.code}</TableCell>
                      <TableCell align="right">{l.orderedQty}</TableCell>
                      <TableCell align="right">{money(l.estimatedUnitPrice)}</TableCell>
                      <TableCell align="right">{money(l.quantity * l.estimatedUnitPrice)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {editable && !nonStock && <Button variant="outlined" onClick={() => navigate(`/requisitions/${pr.id}/edit`)}>Edit</Button>}
              {editable && (
                <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate(undefined, { onSuccess: (r) => r.budgetWarning && notify.info(r.budgetWarning) })}>
                  Submit for approval
                </Button>
              )}
              {mine && ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'].includes(pr.status) && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
              {pr.status === 'APPROVED' && !nonStock && can(Permissions.PURCHASING_RFQ) && <Button variant="contained" onClick={() => setDialog('rfq')}>Request quotations</Button>}
              {pr.status === 'APPROVED' && !nonStock && can(Permissions.PURCHASING_PO) && <Button variant="outlined" onClick={() => setDialog('po')}>Order directly</Button>}
              {nonStock && pr.status === 'APPROVED' && <Alert severity="info">Non-stock lines are quoted and ordered through the non-stock LPO cycle.</Alert>}
            </Stack>
          </>
        }
        side={
          <>
            <ApprovalPanel type="PR" id={pr.id} />
            <DocumentChain type="PR" id={pr.id} />
          </>
        }
      />
      {dialog === 'rfq' && <RfqDialog pr={pr} onClose={() => setDialog(null)} />}
      {dialog === 'po' && <PoDialog pr={pr} onClose={() => setDialog(null)} />}
    </>
  );
}

export function RequisitionsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Requisition>('/requisitions', { ...pagination, search: q, status });
  const columns: GridColDef<Requisition>[] = [
    { field: 'number', headerName: 'Number', width: 180 },
    { field: 'department', headerName: 'Department', width: 170, valueGetter: (_v, r) => r.department?.name ?? '' },
    { field: 'justification', headerName: 'Justification', flex: 1, minWidth: 220 },
    { field: 'priority', headerName: 'Priority', width: 110, valueFormatter: (v: string) => humanise(v) },
    { field: 'estimatedTotal', headerName: 'Estimate', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Purchase requisitions"
        search={search}
        onSearch={setSearch}
        onNew={can(Permissions.PURCHASING_REQUISITION) ? () => navigate('/requisitions/new') : undefined}
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 190 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(RequisitionStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/requisitions/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}


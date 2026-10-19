import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Box,
  Button,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { AdjustmentStatus, Paginated, Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { AdjustmentReason, StockAdjustment, StockRow } from '../api/inventory-types';
import type { Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { formatMoney, humanise } from '../lib/format';
import { useSettings } from '../settings/SettingsContext';
import { ExpiryChip, ItemPicker, StatusChip, StoreSelect } from './components';

/** Batches of an item in a store, from stock on hand. */
export function BatchSelect({ storeId, itemId, value, onChange, error }: { storeId: string; itemId?: string; value: string; onChange(batchId: string, row?: StockRow): void; error?: string }) {
  const { data } = useQuery({
    queryKey: ['/inventory/stock', 'batches', storeId, itemId],
    queryFn: () => api<Paginated<StockRow>>('/inventory/stock', { query: { storeId, itemId, groupBy: 'batch', pageSize: 100 } }),
    enabled: !!storeId && !!itemId,
  });
  return (
    <TextField select label="Batch" value={value} onChange={(e) => onChange(e.target.value, data?.items.find((r) => r.batchId === e.target.value))} error={!!error} helperText={error} sx={{ width: { md: 260 } }}>
      <MenuItem value="">New / found batch</MenuItem>
      {(data?.items ?? []).map((r) => (
        <MenuItem key={`${r.batchId}:${r.binId}`} value={r.batchId}>
          {r.batchNo} {r.binCode ? `(${r.binCode})` : ''} · {r.onHand} on hand · {r.expiryDate ?? 'no expiry'}
        </MenuItem>
      ))}
    </TextField>
  );
}

const schema = z.object({
  storeId: z.string().uuid('Choose a store'),
  reasonCode: z.string().min(1, 'Choose a reason'),
  notes: z.string().max(1000).optional(),
  lines: z
    .array(
      z.object({
        item: z.custom<Item>((v) => !!v, 'Choose an item'),
        batchId: z.string().optional(),
        binId: z.string().nullable().optional(),
        newBatchNo: z.string().optional(),
        newBatchExpiryDate: z.string().optional(),
        quantity: z.coerce.number().refine((n) => n !== 0, 'Cannot be zero'),
      }),
    )
    .min(1),
});
type FormValues = z.infer<typeof schema>;

function AdjustmentDialog({ onClose }: { onClose(): void }) {
  const reasons = useList<AdjustmentReason>('/inventory/adjustments/reasons');
  const { control, handleSubmit, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { storeId: '', reasonCode: '', notes: '', lines: [{ item: null as unknown as Item, batchId: '', quantity: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const storeId = useWatch({ control, name: 'storeId' });
  const lines = useWatch({ control, name: 'lines' });
  const reasonCode = useWatch({ control, name: 'reasonCode' });
  const reason = reasons.data?.find((r) => r.code === reasonCode);
  const save = useApiMutation<FormValues>(
    (v) => [
      '/inventory/adjustments',
      {
        method: 'POST',
        body: {
          storeId: v.storeId,
          reasonCode: v.reasonCode,
          notes: v.notes || undefined,
          lines: v.lines.map((l) => ({
            itemId: l.item.id,
            batchId: l.batchId || undefined,
            binId: l.binId ?? null,
            newBatchNo: l.batchId ? undefined : l.newBatchNo || undefined,
            newBatchExpiryDate: l.batchId ? undefined : l.newBatchExpiryDate || undefined,
            quantity: l.quantity,
          })),
        },
      },
    ],
    { invalidate: ['/inventory'], success: 'Adjustment submitted for approval' },
  );

  return (
    <FormDialog open maxWidth="lg" title="New stock adjustment" submitLabel="Submit for approval" onClose={onClose} submitting={save.isPending} onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <Controller control={control} name="storeId" render={({ field }) => <StoreSelect value={field.value} onChange={field.onChange} sx={{ flex: 1 }} />} />
        <Controller control={control} name="reasonCode" render={({ field, fieldState }) => (
          <TextField select label="Reason" {...field} error={!!fieldState.error} helperText={fieldState.error?.message ?? (reason ? `Allows: ${humanise(reason.direction)}` : undefined)} sx={{ flex: 1 }}>
            {(reasons.data ?? []).filter((r) => r.isActive).map((r) => <MenuItem key={r.code} value={r.code}>{r.name}</MenuItem>)}
          </TextField>
        )} />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Enter negative quantities for decreases (damage, loss, expiry) and positive for gains.
      </Typography>
      {fields.map((f, i) => (
        <Stack key={f.id} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          <Controller control={control} name={`lines.${i}.item`} render={({ field, fieldState }) => (
            <ItemPicker value={field.value} onChange={(v) => { field.onChange(v); setValue(`lines.${i}.batchId`, ''); }} autoFocus={i === fields.length - 1} error={fieldState.error?.message} />
          )} />
          <Controller control={control} name={`lines.${i}.batchId`} render={({ field }) => (
            <BatchSelect storeId={storeId} itemId={lines[i]?.item?.id} value={field.value ?? ''} onChange={(id, row) => { field.onChange(id); setValue(`lines.${i}.binId`, row?.binId ?? null); }} />
          )} />
          {!lines[i]?.batchId && (
            <>
              <Controller control={control} name={`lines.${i}.newBatchNo`} render={({ field }) => <TextField label="New batch no." {...field} sx={{ width: { md: 130 } }} />} />
              <Controller control={control} name={`lines.${i}.newBatchExpiryDate`} render={({ field }) => (
                <TextField label="Expiry" type="date" {...field} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: { md: 160 } }} />
              )} />
            </>
          )}
          <Controller control={control} name={`lines.${i}.quantity`} render={({ field, fieldState }) => (
            <TextField label="Qty (±)" type="number" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { md: 110 } }} />
          )} />
          <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)} disabled={fields.length === 1}>
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Box>
        <Button startIcon={<AddIcon />} onClick={() => append({ item: null as unknown as Item, batchId: '', quantity: 0 })}>
          Add line
        </Button>
      </Box>
      <Controller control={control} name="notes" render={({ field }) => <TextField label="Notes" {...field} multiline minRows={2} />} />
    </FormDialog>
  );
}

function AdjustmentDetails({ id, onClose }: { id: string; onClose(): void }) {
  const { can, user } = useAuth();
  const { currency } = useSettings();
  const [rejectReason, setRejectReason] = useState('');
  const { data: adj } = useQuery({ queryKey: ['/inventory/adjustments', id], queryFn: () => api<StockAdjustment>(`/inventory/adjustments/${id}`) });
  const approve = useApiMutation<void>(() => [`/inventory/adjustments/${id}/approve`, { method: 'POST' }], { invalidate: ['/inventory'], success: 'Approved' });
  const reject = useApiMutation<void>(() => [`/inventory/adjustments/${id}/reject`, { method: 'POST', body: { reason: rejectReason } }], { invalidate: ['/inventory'], success: 'Rejected' });
  const submit = useApiMutation<void>(() => [`/inventory/adjustments/${id}/submit`, { method: 'POST' }], { invalidate: ['/inventory'], success: 'Submitted' });
  if (!adj) return null;
  const pending = adj.status === AdjustmentStatus.SUBMITTED || adj.status === AdjustmentStatus.PARTIALLY_APPROVED;
  const canApprove = can(Permissions.INVENTORY_ADJUST_APPROVE) && pending && adj.submittedBy !== user?.id && adj.firstApprovedBy !== user?.id;

  return (
    <Box sx={{ width: { xs: '100vw', sm: 520 }, p: 2 }} role="region" aria-label="Adjustment details">
      <Stack direction="row" alignItems="center">
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{adj.number}</Typography>
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <StatusChip status={adj.status} />
        <Typography variant="body2">{adj.store?.name} · {adj.reasonCode} · {formatMoney(adj.totalValue, currency)}</Typography>
      </Stack>
      {adj.requiresSecondApproval && <Alert severity="info" sx={{ mb: 1 }}>Above the approval threshold: two different approvers are required.</Alert>}
      {adj.rejectionReason && <Alert severity="error" sx={{ mb: 1 }}>Rejected: {adj.rejectionReason}</Alert>}
      <List dense>
        {(adj.lines ?? []).map((l) => (
          <ListItem key={l.id} divider>
            <ListItemText primary={`${l.item?.name} · batch ${l.batch?.batchNo}`} secondary={<ExpiryChip date={l.batch?.expiryDate} />} />
            <Typography color={l.quantity < 0 ? 'error' : 'success.main'}>{l.quantity > 0 ? `+${l.quantity}` : l.quantity}</Typography>
          </ListItem>
        ))}
      </List>
      <Stack spacing={1} sx={{ mt: 2 }}>
        {adj.status === AdjustmentStatus.DRAFT && can(Permissions.INVENTORY_ADJUST) && <Button variant="contained" onClick={() => submit.mutate()}>Submit for approval</Button>}
        {canApprove && (
          <Button variant="contained" color="success" disabled={approve.isPending} onClick={() => approve.mutate()}>
            {adj.status === AdjustmentStatus.PARTIALLY_APPROVED || !adj.requiresSecondApproval ? 'Approve and post' : 'Approve (first of two)'}
          </Button>
        )}
        {pending && adj.submittedBy === user?.id && <Typography variant="body2" color="text.secondary">Waiting for another user to approve.</Typography>}
        {can(Permissions.INVENTORY_ADJUST_APPROVE) && pending && (
          <Stack direction="row" spacing={1}>
            <TextField label="Rejection reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <Button color="error" disabled={!rejectReason || reject.isPending} onClick={() => reject.mutate()}>Reject</Button>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

export function AdjustmentsPage() {
  const { can } = useAuth();
  const { currency } = useSettings();
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isFetching } = usePaged<StockAdjustment>('/inventory/adjustments', { ...pagination, storeId, status });
  const columns: GridColDef<StockAdjustment>[] = [
    { field: 'number', headerName: 'Number', width: 190 },
    { field: 'store', headerName: 'Store', width: 160, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'reasonCode', headerName: 'Reason', width: 130 },
    { field: 'totalValue', headerName: 'Value', type: 'number', width: 130, valueFormatter: (v: number) => formatMoney(v, currency) },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'adjustmentDate', headerName: 'Date', width: 120 },
  ];
  return (
    <>
      <PageHeader
        title="Stock adjustments"
        onNew={can(Permissions.INVENTORY_ADJUST) ? () => setOpen(true) : undefined}
        actions={
          <>
            <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', sm: 200 } }} />
            <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 190 } }}>
              <MenuItem value="">Any</MenuItem>
              {Object.values(AdjustmentStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
            </TextField>
          </>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => setSelected(row.id)} disableRowSelectionOnClick />
      </Paper>
      {open && <AdjustmentDialog onClose={() => setOpen(false)} />}
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
        {selected && <AdjustmentDetails id={selected} onClose={() => setSelected(null)} />}
      </Drawer>
    </>
  );
}

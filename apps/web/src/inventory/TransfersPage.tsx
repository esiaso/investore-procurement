import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import { Alert, Box, Button, Divider, Drawer, IconButton, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Permissions, TransferStatus } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { AdjustmentReason, FefoResult, StockTransfer } from '../api/inventory-types';
import type { Bin, Item, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { BatchSelect } from './AdjustmentsPage';
import { ExpiryChip, ItemPicker, StatusChip, StoreSelect, useStores, WitnessFields, witnessOrUndefined } from './components';

const schema = z.object({
  fromStoreId: z.string().uuid('Choose the source store'),
  toStoreId: z.string().uuid('Choose your store'),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ item: z.custom<Item>((v) => !!v, 'Choose an item'), quantity: z.coerce.number().positive('Must be > 0') })).min(1),
});
type FormValues = z.infer<typeof schema>;

function RequestDialog({ onClose }: { onClose(): void }) {
  const directory = useList<Store>('/stores/directory');
  const { control, handleSubmit, watch } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { fromStoreId: '', toStoreId: '', notes: '', lines: [{ item: null as unknown as Item, quantity: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const save = useApiMutation<FormValues>(
    (v) => ['/inventory/transfers', { method: 'POST', body: { fromStoreId: v.fromStoreId, toStoreId: v.toStoreId, notes: v.notes || undefined, lines: v.lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity })) } }],
    { invalidate: ['/inventory'], success: 'Transfer requested' },
  );
  return (
    <FormDialog open maxWidth="md" title="Request stock from another store" submitLabel="Send request" onClose={onClose} submitting={save.isPending} onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <Controller control={control} name="toStoreId" render={({ field }) => <StoreSelect label="Deliver to (your store)" value={field.value} onChange={field.onChange} sx={{ flex: 1 }} />} />
        <Controller control={control} name="fromStoreId" render={({ field }) => (
          <StoreSelect label="Request from" value={field.value} onChange={field.onChange} stores={directory.data} exclude={watch('toStoreId')} sx={{ flex: 1 }} />
        )} />
      </Stack>
      {fields.map((f, i) => (
        <Stack key={f.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
          <Controller control={control} name={`lines.${i}.item`} render={({ field, fieldState }) => <ItemPicker value={field.value} onChange={field.onChange} autoFocus={i === fields.length - 1} error={fieldState.error?.message} />} />
          <Controller control={control} name={`lines.${i}.quantity`} render={({ field, fieldState }) => (
            <TextField label="Quantity (base units)" type="number" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { sm: 170 } }} />
          )} />
          <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)} disabled={fields.length === 1}><DeleteIcon /></IconButton>
        </Stack>
      ))}
      <Box><Button startIcon={<AddIcon />} onClick={() => append({ item: null as unknown as Item, quantity: 0 })}>Add item</Button></Box>
      <Controller control={control} name="notes" render={({ field }) => <TextField label="Notes" {...field} multiline minRows={2} />} />
    </FormDialog>
  );
}

function FefoHint({ storeId, itemId, quantity }: { storeId: string; itemId: string; quantity: number }) {
  const { data } = useQuery({
    queryKey: ['/inventory/fefo', storeId, itemId, quantity],
    queryFn: () => api<FefoResult>('/inventory/fefo', { query: { storeId, itemId, quantity } }),
    enabled: quantity > 0,
  });
  if (!data) return null;
  return (
    <Box sx={{ fontSize: 13, color: 'text.secondary' }}>
      FEFO: {data.allocations.map((a) => `${a.batchNo} × ${a.quantity}`).join(', ') || 'no usable stock'}
      {data.shortfall > 0 && <Box component="span" sx={{ color: 'error.main' }}> · short by {data.shortfall}</Box>}
    </Box>
  );
}

function TransferDetails({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth();
  const stores = useStores();
  const { data: t } = useQuery({ queryKey: ['/inventory/transfers', id], queryFn: () => api<StockTransfer>(`/inventory/transfers/${id}`) });
  const reasons = useList<AdjustmentReason>('/inventory/adjustments/reasons');
  const bins = useAll<Bin>('/bins', { storeId: t?.toStoreId }, !!t);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [manual, setManual] = useState<Record<string, { batchId: string; binId: string | null }>>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [received, setReceived] = useState<Record<string, { qty?: number; reason?: string; notes?: string }>>({});
  const [toBinId, setToBinId] = useState('');
  const [witness, setWitness] = useState({ username: '', password: '' });

  const access = new Set((stores.data ?? []).map((s) => s.id));
  const controlled = (t?.lines ?? []).some((l) => l.item?.isControlled);
  const dispatch = useApiMutation<void>(
    () => [
      `/inventory/transfers/${id}/dispatch`,
      {
        method: 'POST',
        body: {
          lines: (t?.lines ?? []).map((l) => {
            const q = qty[l.id] ?? l.requestedQty;
            const m = manual[l.id];
            return { lineId: l.id, quantity: q, picks: m?.batchId ? [{ batchId: m.batchId, binId: m.binId, quantity: q }] : undefined };
          }),
          fefoOverrideReason: overrideReason || undefined,
          witness: witnessOrUndefined(controlled, witness),
        },
      },
    ],
    { invalidate: ['/inventory'], success: 'Dispatched' },
  );
  const receive = useApiMutation<void>(
    () => [
      `/inventory/transfers/${id}/receive`,
      {
        method: 'POST',
        body: {
          toBinId: toBinId || null,
          witness: witnessOrUndefined(controlled, witness),
          allocations: (t?.lines ?? []).flatMap((l) =>
            (l.allocations ?? []).map((a) => ({
              allocationId: a.id,
              receivedQty: received[a.id]?.qty ?? a.dispatchedQty,
              discrepancyReasonCode: received[a.id]?.reason || undefined,
              discrepancyNotes: received[a.id]?.notes || undefined,
            })),
          ),
        },
      },
    ],
    { invalidate: ['/inventory'], success: 'Received' },
  );
  const cancel = useApiMutation<void>(() => [`/inventory/transfers/${id}/cancel`, { method: 'POST' }], { invalidate: ['/inventory'], success: 'Cancelled' });
  if (!t) return null;

  const canDispatch = t.status === TransferStatus.REQUESTED && can(Permissions.INVENTORY_TRANSFER_DISPATCH) && access.has(t.fromStoreId);
  const canReceive = t.status === TransferStatus.DISPATCHED && can(Permissions.INVENTORY_TRANSFER_RECEIVE) && access.has(t.toStoreId);
  const anyManual = Object.values(manual).some((m) => m.batchId);

  return (
    <Box sx={{ width: { xs: '100vw', sm: 640 }, p: 2 }} role="region" aria-label="Transfer details">
      <Stack direction="row" alignItems="center">
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{t.number}</Typography>
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <StatusChip status={t.status} />
        <Typography variant="body2">{t.fromStore?.name} → {t.toStore?.name}</Typography>
      </Stack>
      <Stack spacing={2} divider={<Divider />}>
        {(t.lines ?? []).map((l) => (
          <Box key={l.id}>
            <Typography fontWeight={600}>{l.item?.name}</Typography>
            <Typography variant="body2" color="text.secondary">Requested {l.requestedQty}</Typography>
            {canDispatch && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField label="Send" type="number" value={qty[l.id] ?? l.requestedQty} onChange={(e) => setQty({ ...qty, [l.id]: Number(e.target.value) })} sx={{ width: { sm: 120 } }} />
                  {can(Permissions.INVENTORY_OVERRIDE_FEFO) && (
                    <BatchSelect storeId={t.fromStoreId} itemId={l.itemId} value={manual[l.id]?.batchId ?? ''} onChange={(batchId, row) => setManual({ ...manual, [l.id]: { batchId, binId: row?.binId ?? null } })} />
                  )}
                </Stack>
                <FefoHint storeId={t.fromStoreId} itemId={l.itemId} quantity={qty[l.id] ?? l.requestedQty} />
              </Stack>
            )}
            {(l.allocations ?? []).map((a) => {
              const r = received[a.id]?.qty ?? a.dispatchedQty;
              return (
                <Stack key={a.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mt: 1 }}>
                  <Typography variant="body2" sx={{ minWidth: 150 }}>Batch {a.batch?.batchNo} × {a.dispatchedQty}</Typography>
                  <ExpiryChip date={a.batch?.expiryDate} />
                  {canReceive ? (
                    <>
                      <TextField label="Received" type="number" value={r} onChange={(e) => setReceived({ ...received, [a.id]: { ...received[a.id], qty: Number(e.target.value) } })} sx={{ width: { sm: 110 } }} />
                      {r < a.dispatchedQty && (
                        <TextField select label="Discrepancy reason" value={received[a.id]?.reason ?? ''} onChange={(e) => setReceived({ ...received, [a.id]: { ...received[a.id], reason: e.target.value } })} sx={{ width: { sm: 200 } }}>
                          {(reasons.data ?? []).filter((x) => x.direction !== 'INCREASE').map((x) => <MenuItem key={x.code} value={x.code}>{x.name}</MenuItem>)}
                        </TextField>
                      )}
                    </>
                  ) : (
                    a.receivedQty !== null && (
                      <Typography variant="body2">received {a.receivedQty}{a.discrepancyReasonCode ? ` · ${humanise(a.discrepancyReasonCode)}` : ''}</Typography>
                    )
                  )}
                </Stack>
              );
            })}
          </Box>
        ))}
      </Stack>
      <Stack spacing={1.5} sx={{ mt: 3 }}>
        {canDispatch && anyManual && (
          <TextField label="Reason for overriding FEFO" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} required />
        )}
        {canReceive && (
          <TextField select label="Put away to bin" value={toBinId} onChange={(e) => setToBinId(e.target.value)}>
            <MenuItem value="">No bin</MenuItem>
            {(bins.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.code}</MenuItem>)}
          </TextField>
        )}
        {(canDispatch || canReceive) && controlled && <WitnessFields value={witness} onChange={setWitness} />}
        {canDispatch && <Button variant="contained" disabled={dispatch.isPending} onClick={() => dispatch.mutate()}>Dispatch</Button>}
        {canReceive && <Button variant="contained" color="success" disabled={receive.isPending} onClick={() => receive.mutate()}>Confirm receipt</Button>}
        {t.status === TransferStatus.REQUESTED && can(Permissions.INVENTORY_TRANSFER_REQUEST) && (
          <Button color="error" onClick={() => cancel.mutate()}>Cancel request</Button>
        )}
        {t.status === TransferStatus.RECEIVED_WITH_DISCREPANCY && <Alert severity="warning">Received with a discrepancy; the shortfall was written off from in-transit.</Alert>}
      </Stack>
    </Box>
  );
}

export function TransfersPage() {
  const { can } = useAuth();
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isFetching } = usePaged<StockTransfer>('/inventory/transfers', { ...pagination, storeId, status });
  const columns: GridColDef<StockTransfer>[] = [
    { field: 'number', headerName: 'Number', width: 190 },
    { field: 'fromStore', headerName: 'From', flex: 1, minWidth: 150, valueGetter: (_v, r) => r.fromStore?.name ?? '' },
    { field: 'toStore', headerName: 'To', flex: 1, minWidth: 150, valueGetter: (_v, r) => r.toStore?.name ?? '' },
    { field: 'status', headerName: 'Status', width: 210, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader
        title="Inter-store transfers"
        onNew={can(Permissions.INVENTORY_TRANSFER_REQUEST) ? () => setOpen(true) : undefined}
        newLabel="Request stock"
        actions={
          <>
            <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', sm: 200 } }} />
            <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 210 } }}>
              <MenuItem value="">Any</MenuItem>
              {Object.values(TransferStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
            </TextField>
          </>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => setSelected(row.id)} disableRowSelectionOnClick />
      </Paper>
      {open && <RequestDialog onClose={() => setOpen(false)} />}
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
        {selected && <TransferDetails id={selected} onClose={() => setSelected(null)} />}
      </Drawer>
    </>
  );
}

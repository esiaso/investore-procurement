import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { Box, Button, IconButton, MenuItem, Paper, Stack, TextField } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Permissions, StockReceiptType } from '@sil/shared';
import { useAll, useApiMutation, usePaged } from '../api/hooks';
import type { StockReceipt } from '../api/inventory-types';
import type { Bin, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { formatDate, humanise } from '../lib/format';
import { useSettings } from '../settings/SettingsContext';
import { ItemPicker, StoreSelect, WitnessFields, witnessOrUndefined } from './components';

const lineSchema = z
  .object({
    item: z.custom<Item>((v) => !!v, 'Choose an item'),
    batchNo: z.string().trim().max(60).optional(),
    expiryDate: z.string().optional(),
    binId: z.string().optional(),
    quantity: z.coerce.number().positive('Must be > 0'),
    unitCost: z.coerce.number().min(0),
  })
  .superRefine((l, ctx) => {
    if (l.item?.isBatchTracked && !l.batchNo) ctx.addIssue({ code: 'custom', path: ['batchNo'], message: 'Required' });
    if (l.item?.isBatchTracked && !l.expiryDate) ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Required' });
  });

const schema = z.object({
  storeId: z.string().uuid('Choose a store'),
  type: z.nativeEnum(StockReceiptType),
  notes: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(1),
});
type FormValues = z.infer<typeof schema>;
const emptyLine = { item: null as unknown as Item, batchNo: '', expiryDate: '', binId: '', quantity: 0, unitCost: 0 };

function ReceiptDialog({ onClose }: { onClose(): void }) {
  const [witness, setWitness] = useState({ username: '', password: '' });
  const { control, handleSubmit, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { storeId: '', type: StockReceiptType.RECEIPT, notes: '', lines: [emptyLine] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const storeId = useWatch({ control, name: 'storeId' });
  const lines = useWatch({ control, name: 'lines' });
  const bins = useAll<Bin>('/bins', { storeId }, !!storeId);
  const needsWitness = lines.some((l) => l.item?.isControlled);
  const save = useApiMutation<FormValues>(
    (v) => [
      '/inventory/receipts',
      {
        method: 'POST',
        body: {
          storeId: v.storeId,
          type: v.type,
          notes: v.notes || undefined,
          witness: witnessOrUndefined(needsWitness, witness),
          lines: v.lines.map((l) => ({
            itemId: l.item.id,
            batchNo: l.batchNo || undefined,
            expiryDate: l.expiryDate || undefined,
            binId: l.binId || null,
            quantity: l.quantity,
            unitCost: l.unitCost,
          })),
        },
      },
    ],
    { invalidate: ['/inventory'], success: 'Stock received and posted' },
  );

  return (
    <FormDialog open maxWidth="lg" title="Receive stock" submitLabel="Post receipt" onClose={onClose} submitting={save.isPending} onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <Controller control={control} name="storeId" render={({ field, fieldState }) => (
          <Box sx={{ flex: 1 }}>
            <StoreSelect value={field.value} onChange={field.onChange} sx={{ width: '100%' }} />
            {fieldState.error && <Box sx={{ color: 'error.main', fontSize: 12 }}>{fieldState.error.message}</Box>}
          </Box>
        )} />
        <Controller control={control} name="type" render={({ field }) => (
          <TextField select label="Type" {...field} sx={{ flex: 1 }}>
            {Object.values(StockReceiptType).map((t) => <MenuItem key={t} value={t}>{t === 'OPENING' ? 'Opening balance' : 'Stock-in receipt'}</MenuItem>)}
          </TextField>
        )} />
      </Stack>
      {fields.map((f, i) => (
        <Stack key={f.id} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          <Controller control={control} name={`lines.${i}.item`} render={({ field, fieldState }) => (
            <ItemPicker value={field.value} onChange={field.onChange} autoFocus={i === fields.length - 1} error={fieldState.error?.message} />
          )} />
          <Controller control={control} name={`lines.${i}.batchNo`} render={({ field, fieldState }) => (
            <TextField label="Batch no." {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { md: 130 } }} />
          )} />
          <Controller control={control} name={`lines.${i}.expiryDate`} render={({ field, fieldState }) => (
            <TextField label="Expiry" type="date" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: { md: 160 } }} />
          )} />
          <Controller control={control} name={`lines.${i}.binId`} render={({ field }) => (
            <TextField select label="Bin" {...field} sx={{ width: { md: 130 } }}>
              <MenuItem value="">—</MenuItem>
              {(bins.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.code}</MenuItem>)}
            </TextField>
          )} />
          <Controller control={control} name={`lines.${i}.quantity`} render={({ field, fieldState }) => (
            <TextField label={`Qty (${lines[i]?.item?.baseUom?.code ?? 'base'})`} type="number" {...field} error={!!fieldState.error} helperText={fieldState.error?.message} sx={{ width: { md: 110 } }} />
          )} />
          <Controller control={control} name={`lines.${i}.unitCost`} render={({ field }) => (
            <TextField label="Unit cost" type="number" {...field} sx={{ width: { md: 110 } }} slotProps={{ htmlInput: { step: 'any' } }} />
          )} />
          <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)} disabled={fields.length === 1}>
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Box>
        <Button startIcon={<AddIcon />} onClick={() => append(emptyLine)}>
          Add line
        </Button>
      </Box>
      {formState.errors.lines?.message && <Box sx={{ color: 'error.main' }}>{formState.errors.lines.message}</Box>}
      {needsWitness && <WitnessFields value={witness} onChange={setWitness} />}
      <Controller control={control} name="notes" render={({ field }) => <TextField label="Notes" {...field} multiline minRows={2} />} />
    </FormDialog>
  );
}

export function ReceiptsPage() {
  const { can } = useAuth();
  const { dateFormat, timezone } = useSettings();
  const [storeId, setStoreId] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [open, setOpen] = useState(false);
  const { data, isFetching } = usePaged<StockReceipt>('/inventory/receipts', { ...pagination, storeId });
  const columns: GridColDef<StockReceipt>[] = [
    { field: 'number', headerName: 'Number', width: 200 },
    { field: 'type', headerName: 'Type', width: 140, valueFormatter: (v: string) => humanise(v) },
    { field: 'store', headerName: 'Store', flex: 1, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'receiptDate', headerName: 'Date', width: 120, valueFormatter: (v: string) => formatDate(`${v}T12:00:00Z`, dateFormat, timezone) },
  ];
  return (
    <>
      <PageHeader
        title="Stock receipts"
        onNew={can(Permissions.INVENTORY_RECEIVE) ? () => setOpen(true) : undefined}
        newLabel="Receive stock"
        actions={<StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { xs: '100%', sm: 220 } }} />}
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} disableRowSelectionOnClick />
      </Paper>
      {open && <ReceiptDialog onClose={() => setOpen(false)} />}
    </>
  );
}

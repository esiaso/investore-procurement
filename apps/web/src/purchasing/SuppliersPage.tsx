import { zodResolver } from '@hookform/resolvers/zod';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { kraPinSchema, Permissions, PrequalificationStatus, SupplierStatus } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { ContractPrice, Supplier } from '../api/purchasing-types';
import type { Item, ItemCategory } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { enumOptions, RHFMultiSelect, RHFNumber, RHFSelect, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { ExpiryChip, ItemPicker } from '../inventory/components';
import { emptyToNull, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useDate, useMoney } from './common';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(200),
  kraPin: kraPinSchema,
  email: z.string().email().or(z.literal('')).nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(500).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365),
  prequalificationStatus: z.nativeEnum(PrequalificationStatus),
  prequalifiedUntil: z.string().nullish(),
  categoryIds: z.array(z.string()),
  bankName: z.string().max(100).nullish(),
  bankBranch: z.string().max(100).nullish(),
  bankAccountNo: z.string().regex(/^[0-9 -]{5,34}$/, 'Digits only').or(z.literal('')).nullish(),
});
type FormValues = z.infer<typeof schema>;

const STATUS_COLOUR: Record<string, 'success' | 'warning' | 'error'> = { ACTIVE: 'success', SUSPENDED: 'warning', BLACKLISTED: 'error' };
const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

function SupplierDialog({ supplier, onClose }: { supplier: Supplier | 'new'; onClose(): void }) {
  const isNew = supplier === 'new';
  const categories = useList<ItemCategory>('/item-categories');
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: isNew
      ? { name: '', kraPin: '', email: '', phone: '', address: '', paymentTermsDays: 30, prequalificationStatus: PrequalificationStatus.PENDING, prequalifiedUntil: '', categoryIds: [], bankName: '', bankBranch: '', bankAccountNo: '' }
      : {
          name: supplier.name,
          kraPin: supplier.kraPin,
          email: supplier.email ?? '',
          phone: supplier.phone ?? '',
          address: supplier.address ?? '',
          paymentTermsDays: supplier.paymentTermsDays,
          prequalificationStatus: supplier.prequalificationStatus as PrequalificationStatus,
          prequalifiedUntil: supplier.prequalifiedUntil ?? '',
          categoryIds: supplier.categoryIds,
          bankName: supplier.bankName ?? '',
          bankBranch: supplier.bankBranch ?? '',
          bankAccountNo: '',
        },
  });
  const save = useApiMutation<FormValues>(
    (v) => {
      const body = emptyToNull(v) as Record<string, unknown>;
      if (!isNew && !v.bankAccountNo) delete body.bankAccountNo; // blank = keep
      return isNew ? ['/suppliers', { method: 'POST', body }] : [`/suppliers/${supplier.id}`, { method: 'PATCH', body }];
    },
    { invalidate: ['/suppliers'], success: 'Supplier saved' },
  );
  return (
    <FormDialog open maxWidth="md" title={isNew ? 'New supplier' : `Edit ${supplier.name}`} onClose={onClose} submitting={save.isPending} onSubmit={handleSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="name" label="Name" autoFocus />
        <RHFText control={control} name="kraPin" label="KRA PIN" placeholder="P051234567X" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="email" label="Orders email" />
        <RHFText control={control} name="phone" label="Phone" />
        <RHFNumber control={control} name="paymentTermsDays" label="Payment terms (days)" />
      </Stack>
      <RHFText control={control} name="address" label="Address" />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFSelect control={control} name="prequalificationStatus" label="Prequalification" options={enumOptions(PrequalificationStatus, humanise)} />
        <RHFText control={control} name="prequalifiedUntil" label="Prequalified until" type="date" slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <RHFMultiSelect control={control} name="categoryIds" label="Categories supplied" options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      <Typography variant="subtitle2">Bank details (account number is stored encrypted)</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="bankName" label="Bank" />
        <RHFText control={control} name="bankBranch" label="Branch" />
        <RHFText control={control} name="bankAccountNo" label={isNew ? 'Account number' : `Account number (${supplier.bankAccountMasked ?? 'none'}; blank = keep)`} />
      </Stack>
    </FormDialog>
  );
}

function SupplierDetails({ id, onClose, onEdit }: { id: string; onClose(): void; onEdit(s: Supplier): void }) {
  const { can } = useAuth();
  const date = useDate();
  const money = useMoney();
  const [tab, setTab] = useState(0);
  const { data: s } = useQuery({ queryKey: ['/suppliers', id], queryFn: () => api<Supplier>(`/suppliers/${id}`) });
  const prices = useList<ContractPrice>('/suppliers/contract-prices', { supplierId: id });
  const [doc, setDoc] = useState({ documentType: 'PPB_LICENCE', reference: '', expiresOn: '' });
  const [price, setPrice] = useState<{ item: Item | null; unitPrice: string; validFrom: string; validTo: string }>({ item: null, unitPrice: '', validFrom: '', validTo: '' });
  const [status, setStatus] = useState({ status: '', reason: '' });
  const addDoc = useApiMutation<void>(() => [`/suppliers/${id}/documents`, { method: 'POST', body: { ...doc, expiresOn: doc.expiresOn || null } }], { invalidate: ['/suppliers'], success: 'Document added' });
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const removeDoc = useApiMutation<string>((docId) => [`/suppliers/${id}/documents/${docId}`, { method: 'DELETE' }], { invalidate: ['/suppliers'], success: 'Document removed' });
  const addPrice = useApiMutation<void>(
    () => [`/suppliers/${id}/contract-prices`, { method: 'POST', body: { itemId: price.item?.id, unitPrice: Number(price.unitPrice), validFrom: price.validFrom, validTo: price.validTo || null } }],
    { invalidate: ['/suppliers'], success: 'Contract price added' },
  );
  const setSupplierStatus = useApiMutation<void>(() => [`/suppliers/${id}/status`, { method: 'POST', body: { status: status.status, reason: status.reason || undefined } }], {
    invalidate: ['/suppliers'],
    success: 'Status changed',
  });
  if (!s) return null;
  const manage = can(Permissions.SUPPLIERS_MANAGE);
  return (
    <Box sx={{ width: { xs: '100vw', md: 720 }, p: 2 }} role="region" aria-label="Supplier details">
      <Stack direction="row" alignItems="center">
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{s.name}</Typography>
        {manage && <Button onClick={() => onEdit(s)}>Edit</Button>}
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        <Chip size="small" color={STATUS_COLOUR[s.status]} label={humanise(s.status)} />
        <Chip size="small" variant="outlined" label={`${humanise(s.prequalificationStatus)}${s.prequalifiedUntil ? ` until ${date(s.prequalifiedUntil)}` : ''}`} />
        <Typography variant="body2" color="text.secondary">{s.code} · KRA PIN {s.kraPin} · {s.paymentTermsDays} days</Typography>
      </Stack>
      {s.statusReason && <Typography color="error" variant="body2">{s.statusReason}</Typography>}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="Overview" />
        <Tab label="Documents" />
        <Tab label="Contract prices" />
      </Tabs>
      {tab === 0 && (
        <Stack spacing={2}>
          <List dense>
            <ListItem disableGutters><ListItemText primary="Contact" secondary={[s.email, s.phone, s.address].filter(Boolean).join(' · ')} /></ListItem>
            {(s.contacts ?? []).map((c) => (
              <ListItem key={c.id} disableGutters>
                <ListItemText primary={`${c.name}${c.isPrimary ? ' (primary)' : ''}`} secondary={[c.role, c.email, c.phone].filter(Boolean).join(' · ')} />
              </ListItem>
            ))}
            <ListItem disableGutters>
              <ListItemText primary="Bank" secondary={`${s.bankName ?? '—'} ${s.bankBranch ?? ''} · ${s.bankAccountNo ?? s.bankAccountMasked ?? 'no account'}`} />
            </ListItem>
          </List>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2">Performance (from {s.grnCount} posted GRNs)</Typography>
            <Typography variant="body2">
              On-time delivery {pct(s.onTimeDeliveryRate)} · quality rejects {pct(s.qualityRejectRate)} · price variance{' '}
              {s.avgPriceVariancePct === null ? '—' : `${s.avgPriceVariancePct.toFixed(2)}%`}
            </Typography>
          </Paper>
          {manage && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField select label="Change status" value={status.status} onChange={(e) => setStatus({ ...status, status: e.target.value })} sx={{ minWidth: 180, width: 'auto' }}>
                {Object.values(SupplierStatus).map((v) => <MenuItem key={v} value={v}>{humanise(v)}</MenuItem>)}
              </TextField>
              <TextField label="Reason" value={status.reason} onChange={(e) => setStatus({ ...status, reason: e.target.value })} />
              <Button disabled={!status.status} onClick={() => setSupplierStatus.mutate()}>Apply</Button>
            </Stack>
          )}
        </Stack>
      )}
      {tab === 1 && (
        <Stack spacing={1}>
          {(s.documents ?? []).map((d) => (
            <Box key={d.id}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography sx={{ minWidth: 160 }}>{humanise(d.documentType)}</Typography>
                <Typography variant="body2" sx={{ flexGrow: 1 }}>{d.reference}</Typography>
                <ExpiryChip date={d.expiresOn} />
                <Button size="small" onClick={() => setFilesFor(filesFor === d.id ? null : d.id)}>{filesFor === d.id ? 'Hide scan' : 'Scan'}</Button>
                {manage && <IconButton aria-label="Remove document" onClick={() => removeDoc.mutate(d.id)}><DeleteIcon /></IconButton>}
              </Stack>
              {filesFor === d.id && <AttachmentsPanel ownerType="SUPPLIER_DOCUMENT" ownerId={d.id} title={`${humanise(d.documentType)} scan`} categories={['SCAN']} canUpload={manage} />}
            </Box>
          ))}
          {manage && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ pt: 1 }}>
              <TextField select label="Type" value={doc.documentType} onChange={(e) => setDoc({ ...doc, documentType: e.target.value })} sx={{ minWidth: 180, width: 'auto' }}>
                {['PPB_LICENCE', 'BUSINESS_PERMIT', 'TAX_COMPLIANCE', 'CR12', 'KEBS_CERTIFICATE', 'GMP_CERTIFICATE'].map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
              </TextField>
              <TextField label="Reference" value={doc.reference} onChange={(e) => setDoc({ ...doc, reference: e.target.value })} />
              <TextField label="Expires" type="date" value={doc.expiresOn} onChange={(e) => setDoc({ ...doc, expiresOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
              <Button onClick={() => addDoc.mutate()}>Add</Button>
            </Stack>
          )}
        </Stack>
      )}
      {tab === 2 && (
        <Stack spacing={1}>
          {(prices.data ?? []).map((p) => (
            <Stack key={p.id} direction="row" spacing={1}>
              <Typography sx={{ flexGrow: 1 }}>{p.item?.name}</Typography>
              <Typography>{money(p.unitPrice)} / {p.item?.baseUom?.code ?? 'unit'}</Typography>
              <Typography variant="body2" color="text.secondary">{date(p.validFrom)} – {p.validTo ? date(p.validTo) : 'open'}</Typography>
            </Stack>
          ))}
          {manage && (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ pt: 1 }}>
              <ItemPicker value={price.item} onChange={(item) => setPrice({ ...price, item })} />
              <TextField label="Price per base unit" type="number" value={price.unitPrice} onChange={(e) => setPrice({ ...price, unitPrice: e.target.value })} sx={{ width: 160 }} />
              <TextField label="From" type="date" value={price.validFrom} onChange={(e) => setPrice({ ...price, validFrom: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField label="To" type="date" value={price.validTo} onChange={(e) => setPrice({ ...price, validTo: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
              <Button disabled={!price.item || !price.unitPrice || !price.validFrom} onClick={() => addPrice.mutate()}>Add</Button>
            </Stack>
          )}
        </Stack>
      )}
    </Box>
  );
}

export function SuppliersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Supplier>('/suppliers', { ...pagination, search: q, status });
  const columns: GridColDef<Supplier>[] = [
    { field: 'code', headerName: 'Code', width: 100 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 220 },
    { field: 'kraPin', headerName: 'KRA PIN', width: 130 },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <Chip size="small" color={STATUS_COLOUR[value]} label={humanise(value)} /> },
    { field: 'prequalifiedUntil', headerName: 'Prequalified until', width: 170, renderCell: ({ value }) => <ExpiryChip date={value} /> },
    { field: 'onTimeDeliveryRate', headerName: 'On time', width: 90, valueFormatter: (v: number | null) => pct(v) },
    { field: 'qualityRejectRate', headerName: 'Rejects', width: 90, valueFormatter: (v: number | null) => pct(v) },
  ];
  return (
    <>
      <PageHeader
        title="Suppliers"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search name, code, KRA PIN"
        onNew={can(Permissions.SUPPLIERS_MANAGE) ? () => setEditing('new') : undefined}
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 170 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(SupplierStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => setSelected(row.id)} disableRowSelectionOnClick />
      </Paper>
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
        {selected && <SupplierDetails id={selected} onClose={() => setSelected(null)} onEdit={(s) => setEditing(s)} />}
      </Drawer>
      {editing && <SupplierDialog supplier={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

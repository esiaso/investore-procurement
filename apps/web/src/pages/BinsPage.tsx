import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Chip, MenuItem, Paper, TextField } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { BinInput, binSchema, Permissions } from '@sil/shared';
import { useAll, useApiMutation, usePaged } from '../api/hooks';
import type { Bin, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { RHFSelect, RHFSwitch, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { useDebounced } from '../lib/useDebounced';

function BinDialog({ bin, stores, defaultStoreId, onClose }: { bin: Bin | 'new'; stores: Store[]; defaultStoreId: string; onClose(): void }) {
  const isNew = bin === 'new';
  const { control, handleSubmit } = useForm<BinInput>({
    resolver: zodResolver(binSchema),
    defaultValues: isNew
      ? { storeId: defaultStoreId, code: '', name: '', zone: '', isActive: true }
      : { storeId: bin.storeId, code: bin.code, name: bin.name, zone: bin.zone ?? '', isActive: bin.isActive },
  });
  const save = useApiMutation<BinInput>(
    ({ storeId, ...rest }) =>
      isNew ? ['/bins', { method: 'POST', body: { storeId, ...rest } }] : [`/bins/${bin.id}`, { method: 'PATCH', body: rest }],
    { invalidate: ['/bins'], success: 'Bin saved' },
  );
  const remove = useApiMutation<void>(() => [`/bins/${(bin as Bin).id}`, { method: 'DELETE' }], {
    invalidate: ['/bins'],
    success: 'Bin deleted',
  });

  return (
    <FormDialog
      open
      title={isNew ? 'New bin' : `Edit bin ${bin.code}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => save.mutate(values, { onSuccess: onClose }))}
    >
      <RHFSelect
        control={control}
        name="storeId"
        label="Store"
        disabled={!isNew}
        options={stores.map((s) => ({ value: s.id, label: s.name }))}
      />
      <RHFText control={control} name="code" label="Code" autoFocus />
      <RHFText control={control} name="name" label="Name" />
      <RHFText control={control} name="zone" label="Zone" />
      <RHFSwitch control={control} name="isActive" label="Active" />
      {!isNew && (
        <Button color="error" onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
          Delete bin
        </Button>
      )}
    </FormDialog>
  );
}

export function BinsPage() {
  const { can } = useAuth();
  const stores = useAll<Store>('/stores');
  const [storeId, setStoreId] = useState('');
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 50 });
  const [editing, setEditing] = useState<Bin | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Bin>('/bins', { ...pagination, search: q, storeId });
  const canManage = can(Permissions.BINS_MANAGE);

  const columns: GridColDef<Bin>[] = [
    { field: 'store', headerName: 'Store', width: 180, valueGetter: (_v, row) => row.store?.name ?? '' },
    { field: 'code', headerName: 'Code', width: 130 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 180 },
    { field: 'zone', headerName: 'Zone', width: 120 },
    {
      field: 'isActive',
      headerName: 'Status',
      width: 100,
      renderCell: ({ value }) => <Chip size="small" label={value ? 'Active' : 'Inactive'} color={value ? 'success' : 'default'} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Bins & locations"
        search={search}
        onSearch={setSearch}
        onNew={canManage && (stores.data?.length ?? 0) > 0 ? () => setEditing('new') : undefined}
        actions={
          <TextField
            select
            label="Store"
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setPagination((p) => ({ ...p, page: 0 }));
            }}
            sx={{ width: { xs: '100%', sm: 220 } }}
          >
            <MenuItem value="">All accessible stores</MenuItem>
            {(stores.data ?? []).map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </TextField>
        }
      />
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
          onRowClick={({ row }) => canManage && setEditing(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      {editing && (
        <BinDialog
          bin={editing}
          stores={stores.data ?? []}
          defaultStoreId={storeId || stores.data?.[0]?.id || ''}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

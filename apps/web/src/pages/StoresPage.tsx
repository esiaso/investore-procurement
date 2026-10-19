import { zodResolver } from '@hookform/resolvers/zod';
import { Chip, Paper } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Permissions, ServicePoint, StoreInput, storeSchema, StoreType } from '@sil/shared';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { Facility, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { enumOptions, RHFSelect, RHFSwitch, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';

function StoreDialog({ store, onClose }: { store: Store | 'new'; onClose(): void }) {
  const isNew = store === 'new';
  const facilities = useList<Facility>('/facilities');
  const stores = useAll<Store>('/stores');
  const { control, handleSubmit } = useForm<StoreInput>({
    resolver: zodResolver(storeSchema),
    defaultValues: isNew
      ? { facilityId: '', code: '', name: '', type: StoreType.SATELLITE_PHARMACY, servicePoint: null, parentStoreId: null, isActive: true }
      : {
          facilityId: store.facilityId,
          code: store.code,
          name: store.name,
          type: store.type,
          servicePoint: store.servicePoint,
          parentStoreId: store.parentStoreId,
          isActive: store.isActive,
        },
  });
  const save = useApiMutation<StoreInput>(
    (body) => (isNew ? ['/stores', { method: 'POST', body }] : [`/stores/${store.id}`, { method: 'PATCH', body }]),
    { invalidate: ['/stores'], success: 'Store saved' },
  );

  return (
    <FormDialog
      open
      title={isNew ? 'New store' : `Edit ${store.name}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => save.mutate(values, { onSuccess: onClose }))}
    >
      <RHFSelect
        control={control}
        name="facilityId"
        label="Facility"
        options={(facilities.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
      />
      <RHFText control={control} name="code" label="Code" autoFocus />
      <RHFText control={control} name="name" label="Name" />
      <RHFSelect control={control} name="type" label="Type" options={enumOptions(StoreType, humanise)} />
      <RHFSelect
        control={control}
        name="servicePoint"
        label="Service point"
        allowEmpty="None"
        options={enumOptions(ServicePoint, humanise)}
      />
      <RHFSelect
        control={control}
        name="parentStoreId"
        label="Replenished from"
        allowEmpty="None"
        options={(stores.data ?? []).filter((s) => isNew || s.id !== store.id).map((s) => ({ value: s.id, label: s.name }))}
      />
      <RHFSwitch control={control} name="isActive" label="Active" />
    </FormDialog>
  );
}

export function StoresPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [editing, setEditing] = useState<Store | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Store>('/stores', { ...pagination, search: q });
  const canManage = can(Permissions.ORG_MANAGE);

  const columns: GridColDef<Store>[] = [
    { field: 'code', headerName: 'Code', width: 120 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 180 },
    { field: 'type', headerName: 'Type', width: 170, valueFormatter: (v: string) => humanise(v) },
    { field: 'servicePoint', headerName: 'Service point', width: 130, valueFormatter: (v: string | null) => (v ? humanise(v) : '') },
    { field: 'parentStore', headerName: 'Replenished from', width: 170, valueGetter: (_v, row) => row.parentStore?.name ?? '' },
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
        title="Stores & pharmacies"
        search={search}
        onSearch={(v) => {
          setSearch(v);
          setPagination((p) => ({ ...p, page: 0 }));
        }}
        onNew={canManage ? () => setEditing('new') : undefined}
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
      {editing && <StoreDialog store={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

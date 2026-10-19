import { zodResolver } from '@hookform/resolvers/zod';
import { Chip, Paper } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { DepartmentInput, departmentSchema, Permissions } from '@sil/shared';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { Department, Facility } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { RHFSelect, RHFSwitch, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { useDebounced } from '../lib/useDebounced';

function DepartmentDialog({ dept, onClose }: { dept: Department | 'new'; onClose(): void }) {
  const isNew = dept === 'new';
  const facilities = useList<Facility>('/facilities');
  const { control, handleSubmit } = useForm<DepartmentInput>({
    resolver: zodResolver(departmentSchema),
    defaultValues: isNew
      ? { facilityId: facilities.data?.[0]?.id ?? '', code: '', name: '', costCentreCode: '', isActive: true }
      : { facilityId: dept.facilityId, code: dept.code, name: dept.name, costCentreCode: dept.costCentreCode, isActive: dept.isActive },
  });
  const save = useApiMutation<DepartmentInput>(
    (body) => (isNew ? ['/departments', { method: 'POST', body }] : [`/departments/${dept.id}`, { method: 'PATCH', body }]),
    { invalidate: ['/departments'], success: 'Department saved' },
  );

  return (
    <FormDialog
      open
      title={isNew ? 'New department / cost centre' : `Edit ${dept.name}`}
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
      <RHFText control={control} name="costCentreCode" label="Cost centre code" />
      <RHFSwitch control={control} name="isActive" label="Active" />
    </FormDialog>
  );
}

export function DepartmentsPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Department>('/departments', { ...pagination, search: q });
  const canManage = can(Permissions.ORG_MANAGE);

  const columns: GridColDef<Department>[] = [
    { field: 'code', headerName: 'Code', width: 130 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 200 },
    { field: 'costCentreCode', headerName: 'Cost centre', width: 140 },
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
        title="Departments & cost centres"
        search={search}
        onSearch={setSearch}
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
      {editing && <DepartmentDialog dept={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

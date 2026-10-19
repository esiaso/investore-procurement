import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Box, Button, Chip, Paper, Stack, TextField } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { passwordSchema, Permissions, userBaseSchema } from '@sil/shared';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { Department, Role, Store, User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { RHFMultiSelect, RHFSelect, RHFSwitch, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { emptyToNull, formatDate } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';

type UserForm = z.infer<typeof userBaseSchema> & { password?: string };

function UserDialog({ user, onClose }: { user: User | 'new'; onClose(): void }) {
  const isNew = user === 'new';
  const { passwordPolicy } = useSettings();
  const roles = useList<Role>('/roles');
  const stores = useAll<Store>('/stores');
  const departments = useAll<Department>('/departments');
  const [resetPassword, setResetPassword] = useState('');

  const schema = useMemo(
    () =>
      isNew
        ? userBaseSchema.extend({ password: passwordSchema(passwordPolicy) })
        : userBaseSchema.extend({ password: z.string().optional() }),
    [isNew, passwordPolicy],
  );
  const { control, handleSubmit } = useForm<UserForm>({
    resolver: zodResolver(schema),
    defaultValues: isNew
      ? { username: '', fullName: '', email: '', phone: '', password: '', isActive: true, roleIds: [], storeIds: [], departmentId: null }
      : {
          username: user.username,
          fullName: user.fullName,
          email: user.email ?? '',
          phone: user.phone ?? '',
          isActive: user.isActive,
          roleIds: (user.roles ?? []).map((r) => r.id),
          storeIds: (user.stores ?? []).map((s) => s.id),
          departmentId: user.departmentId,
        },
  });

  const save = useApiMutation<UserForm>(
    ({ username, password, ...rest }) =>
      isNew
        ? ['/users', { method: 'POST', body: emptyToNull({ username, password, ...rest }) }]
        : [`/users/${user.id}`, { method: 'PATCH', body: emptyToNull(rest) }],
    { invalidate: ['/users'], success: 'User saved' },
  );
  const reset = useApiMutation<string>((password) => [`/users/${(user as User).id}/reset-password`, { method: 'POST', body: { password } }], {
    success: 'Password reset; the user must change it at next login',
  });
  const reset2fa = useApiMutation<void>(() => [`/users/${(user as User).id}/reset-2fa`, { method: 'POST' }], {
    invalidate: ['/users'],
    success: 'Two-factor authentication cleared',
  });

  return (
    <FormDialog
      open
      maxWidth="md"
      title={isNew ? 'New user' : `Edit ${user.username}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => save.mutate(values, { onSuccess: onClose }))}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="username" label="Username" disabled={!isNew} autoFocus={isNew} />
        <RHFText control={control} name="fullName" label="Full name" autoFocus={!isNew} />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="email" label="Email" type="email" />
        <RHFText control={control} name="phone" label="Phone" />
      </Stack>
      {isNew && (
        <RHFText
          control={control}
          name="password"
          label="Initial password"
          type="password"
          autoComplete="new-password"
          helperText="The user must change it at first login"
        />
      )}
      <RHFMultiSelect control={control} name="roleIds" label="Roles" options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
      <RHFMultiSelect
        control={control}
        name="storeIds"
        label="Stores (data scope)"
        options={(stores.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
      />
      <RHFSelect
        control={control}
        name="departmentId"
        label="Department"
        allowEmpty="None"
        options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
      />
      <RHFSwitch control={control} name="isActive" label="Active" />
      {!isNew && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <TextField
              label="New temporary password"
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
            <Button disabled={!resetPassword || reset.isPending} onClick={() => reset.mutate(resetPassword, { onSuccess: () => setResetPassword('') })}>
              Reset password
            </Button>
            {user.totpEnabled && (
              <Button color="warning" onClick={() => reset2fa.mutate()}>
                Clear 2FA
              </Button>
            )}
          </Stack>
          {user.lockedUntil && new Date(user.lockedUntil) > new Date() && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              Account locked after failed logins; resetting the password unlocks it.
            </Alert>
          )}
        </Box>
      )}
    </FormDialog>
  );
}

export function UsersPage() {
  const { can } = useAuth();
  const { dateFormat, timezone } = useSettings();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<User>('/users', { ...pagination, search: q });
  const canManage = can(Permissions.USERS_MANAGE);

  const columns: GridColDef<User>[] = [
    { field: 'username', headerName: 'Username', width: 150 },
    { field: 'fullName', headerName: 'Name', flex: 1, minWidth: 160 },
    {
      field: 'roles',
      headerName: 'Roles',
      flex: 1,
      minWidth: 200,
      sortable: false,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} sx={{ overflow: 'hidden', alignItems: 'center', height: '100%' }}>
          {(row.roles ?? []).map((r) => (
            <Chip key={r.id} size="small" label={r.name} />
          ))}
        </Stack>
      ),
    },
    {
      field: 'stores',
      headerName: 'Stores',
      width: 160,
      sortable: false,
      valueGetter: (_v, row) => (row.stores ?? []).map((s) => s.code).join(', '),
    },
    { field: 'totpEnabled', headerName: '2FA', width: 70, type: 'boolean' },
    {
      field: 'lastLoginAt',
      headerName: 'Last login',
      width: 150,
      valueFormatter: (v: string | null) => formatDate(v, dateFormat, timezone, true),
    },
    {
      field: 'isActive',
      headerName: 'Status',
      width: 100,
      renderCell: ({ value }) => <Chip size="small" label={value ? 'Active' : 'Inactive'} color={value ? 'success' : 'default'} />,
    },
  ];

  return (
    <>
      <PageHeader title="Users" search={search} onSearch={setSearch} onNew={canManage ? () => setEditing('new') : undefined} />
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
      {editing && <UserDialog user={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Permissions, RoleInput, roleSchema } from '@sil/shared';
import { useApiMutation, useList } from '../api/hooks';
import type { Permission, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';

function groupPermissions(perms: Permission[]): [string, Permission[]][] {
  const groups = new Map<string, Permission[]>();
  for (const p of perms) {
    const g = p.code.split('.')[0];
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  return [...groups.entries()];
}

function RoleDialog({ role, permissions, onClose }: { role: Role | 'new'; permissions: Permission[]; onClose(): void }) {
  const isNew = role === 'new';
  const { control, handleSubmit } = useForm<RoleInput>({
    resolver: zodResolver(roleSchema),
    defaultValues: isNew
      ? { code: '', name: '', description: '', permissionCodes: [] }
      : {
          code: role.code,
          name: role.name,
          description: role.description ?? '',
          permissionCodes: (role.permissions ?? []).map((p) => p.code),
        },
  });
  const save = useApiMutation<RoleInput>(
    ({ code, ...rest }) =>
      isNew ? ['/roles', { method: 'POST', body: { code, ...rest } }] : [`/roles/${role.id}`, { method: 'PATCH', body: rest }],
    { invalidate: ['/roles'], success: 'Role saved' },
  );

  return (
    <FormDialog
      open
      maxWidth="md"
      title={isNew ? 'New role' : `Edit role: ${role.name}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => save.mutate(values, { onSuccess: onClose }))}
    >
      <RHFText control={control} name="code" label="Code" disabled={!isNew} autoFocus={isNew} />
      <RHFText control={control} name="name" label="Name" />
      <RHFText control={control} name="description" label="Description" multiline minRows={2} />
      <Controller
        control={control}
        name="permissionCodes"
        render={({ field }) => {
          const selected = new Set(field.value ?? []);
          const toggle = (code: string) => {
            const next = new Set(selected);
            if (next.has(code)) next.delete(code);
            else next.add(code);
            field.onChange([...next]);
          };
          return (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              {groupPermissions(permissions).map(([group, perms]) => (
                <Box key={group}>
                  <FormLabel component="legend" sx={{ textTransform: 'capitalize', fontWeight: 600 }}>
                    {group}
                  </FormLabel>
                  <FormGroup>
                    {perms.map((p) => (
                      <FormControlLabel
                        key={p.code}
                        control={<Checkbox size="small" checked={selected.has(p.code)} onChange={() => toggle(p.code)} />}
                        label={
                          <Typography variant="body2">
                            {p.description} <Typography component="span" variant="caption" color="text.secondary">({p.code})</Typography>
                          </Typography>
                        }
                      />
                    ))}
                  </FormGroup>
                </Box>
              ))}
            </Box>
          );
        }}
      />
    </FormDialog>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const roles = useList<Role>('/roles');
  const permissions = useList<Permission>('/permissions');
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const canManage = can(Permissions.ROLES_MANAGE);

  const columns: GridColDef<Role>[] = [
    { field: 'name', headerName: 'Role', flex: 1, minWidth: 200 },
    { field: 'code', headerName: 'Code', width: 200 },
    { field: 'permissions', headerName: 'Permissions', width: 130, valueGetter: (_v, row) => row.permissions?.length ?? 0 },
    {
      field: 'isSystem',
      headerName: 'Type',
      width: 110,
      renderCell: ({ value }) => <Chip size="small" label={value ? 'Built-in' : 'Custom'} variant="outlined" />,
    },
  ];

  return (
    <>
      <PageHeader title="Roles & permissions" onNew={canManage ? () => setEditing('new') : undefined} />
      <Paper>
        <DataGrid
          autoHeight
          rows={roles.data ?? []}
          columns={columns}
          loading={roles.isFetching}
          onRowClick={({ row }) => canManage && setEditing(row)}
          disableRowSelectionOnClick
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
          pageSizeOptions={[25, 50]}
        />
      </Paper>
      {editing && permissions.data && (
        <RoleDialog role={editing} permissions={permissions.data} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

import { Box, Chip, LinearProgress, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useState } from 'react';
import { BudgetEnforcement, Permissions } from '@sil/shared';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { BudgetPosition } from '../api/purchasing-types';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { useMoney } from './common';

function BudgetDialog({ budget, onClose }: { budget: BudgetPosition | 'new'; onClose(): void }) {
  const isNew = budget === 'new';
  const departments = useAll<Department>('/departments');
  const [form, setForm] = useState({
    departmentId: isNew ? '' : budget.departmentId,
    voteHead: isNew ? '' : budget.voteHead,
    description: isNew ? '' : (budget.description ?? ''),
    amount: isNew ? '' : String(budget.amount),
    enforcement: isNew ? BudgetEnforcement.WARN : budget.enforcement,
  });
  const save = useApiMutation<void>(
    () =>
      isNew
        ? ['/budgets', { method: 'POST', body: { ...form, amount: Number(form.amount) } }]
        : [`/budgets/${budget.id}`, { method: 'PATCH', body: { description: form.description, amount: Number(form.amount), enforcement: form.enforcement } }],
    { invalidate: ['/budgets'], success: 'Budget saved' },
  );
  return (
    <FormDialog open title={isNew ? 'New budget' : `Edit ${budget.voteHead}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Department" value={form.departmentId} disabled={!isNew} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
        {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
      </TextField>
      <TextField label="Vote head" value={form.voteHead} disabled={!isNew} onChange={(e) => setForm({ ...form, voteHead: e.target.value.toUpperCase() })} />
      <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <TextField label="Amount" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
      <TextField select label="When exceeded" value={form.enforcement} onChange={(e) => setForm({ ...form, enforcement: e.target.value as BudgetEnforcement })}>
        <MenuItem value={BudgetEnforcement.WARN}>Warn</MenuItem>
        <MenuItem value={BudgetEnforcement.BLOCK}>Block approval</MenuItem>
      </TextField>
    </FormDialog>
  );
}

export function BudgetsPage() {
  const { can } = useAuth();
  const money = useMoney();
  const { data, isFetching } = useList<BudgetPosition>('/budgets');
  const [editing, setEditing] = useState<BudgetPosition | 'new' | null>(null);
  const columns: GridColDef<BudgetPosition>[] = [
    { field: 'departmentName', headerName: 'Department', width: 180 },
    { field: 'voteHead', headerName: 'Vote head', width: 150 },
    { field: 'financialYear', headerName: 'FY', width: 80 },
    { field: 'amount', headerName: 'Budget', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'committed', headerName: 'Committed', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'actual', headerName: 'Actual', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'available', headerName: 'Available', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    {
      field: 'used',
      headerName: 'Used',
      width: 160,
      sortable: false,
      renderCell: ({ row }) => {
        const used = row.amount ? ((row.committed + row.actual) / row.amount) * 100 : 0;
        return (
          <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', height: '100%', gap: 1 }}>
            <LinearProgress variant="determinate" value={Math.min(100, used)} color={used > 100 ? 'error' : used > 85 ? 'warning' : 'primary'} sx={{ flexGrow: 1 }} aria-label={`${used.toFixed(0)}% used`} />
            <Typography variant="caption">{used.toFixed(0)}%</Typography>
          </Box>
        );
      },
    },
    { field: 'enforcement', headerName: 'If exceeded', width: 110, renderCell: ({ value }) => <Chip size="small" label={value === 'BLOCK' ? 'Block' : 'Warn'} color={value === 'BLOCK' ? 'error' : 'default'} /> },
  ];
  return (
    <>
      <PageHeader title="Budgets" onNew={can(Permissions.BUDGETS_MANAGE) ? () => setEditing('new') : undefined} />
      <Stack spacing={1} sx={{ mb: 1 }}>
        <Typography variant="body2" color="text.secondary">
          Commitments are made when a purchase order is approved and released when it is cancelled, closed or invoiced; approved invoices become actual spend.
        </Typography>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => can(Permissions.BUDGETS_MANAGE) && setEditing(row)} disableRowSelectionOnClick />
      </Paper>
      {editing && <BudgetDialog budget={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

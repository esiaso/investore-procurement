import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { Box, Button, Chip, IconButton, MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { useApiMutation, useList } from '../api/hooks';
import type { ApprovalInboxRow, Workflow } from '../api/purchasing-types';
import type { ItemCategory, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { DOC_LABELS, useDate, useMoney } from './common';

interface Delegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  startsOn: string;
  endsOn: string;
  reason: string | null;
  isActive: boolean;
}
type DirectoryUser = { id: string; username: string; fullName: string };

function Inbox() {
  const money = useMoney();
  const date = useDate();
  const navigate = useNavigate();
  const { data, isFetching } = useList<ApprovalInboxRow>('/approvals/inbox');
  const columns: GridColDef<ApprovalInboxRow>[] = [
    { field: 'documentType', headerName: 'Type', width: 140, valueFormatter: (v: string) => DOC_LABELS[v] ?? v },
    { field: 'documentNo', headerName: 'Document', width: 190 },
    { field: 'amount', headerName: 'Amount', width: 140, type: 'number', valueFormatter: (v: number) => money(v) },
    { field: 'stepName', headerName: 'Your step', width: 180 },
    { field: 'summary', headerName: 'Summary', flex: 1, minWidth: 200 },
    { field: 'requestedByName', headerName: 'Requested by', width: 170 },
    { field: 'createdAt', headerName: 'Submitted', width: 120, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <Paper>
      <DataGrid
        autoHeight
        density="compact"
        rows={data ?? []}
        columns={columns}
        loading={isFetching}
        onRowClick={({ row }) => row.link && navigate(row.link)}
        localeText={{ noRowsLabel: 'Nothing waiting for you' }}
        disableRowSelectionOnClick
      />
    </Paper>
  );
}

function Delegations() {
  const { user, can } = useAuth();
  const date = useDate();
  const users = useList<DirectoryUser>('/users/directory');
  const list = useList<Delegation>('/approvals/delegations');
  const [form, setForm] = useState({ toUserId: '', startsOn: '', endsOn: '', reason: '', fromUserId: '' });
  const name = (id: string) => users.data?.find((u) => u.id === id)?.fullName ?? id;
  const create = useApiMutation<void>(
    () => ['/approvals/delegations', { method: 'POST', body: { ...form, fromUserId: form.fromUserId || undefined, reason: form.reason || undefined } }],
    { invalidate: ['/approvals/delegations', '/approvals/inbox'], success: 'Delegation saved' },
  );
  const end = useApiMutation<string>((id) => [`/approvals/delegations/${id}/end`, { method: 'POST' }], { invalidate: ['/approvals/delegations'], success: 'Delegation ended' });
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>
          Delegate my approvals while I am away
        </Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          {can(Permissions.APPROVALS_MANAGE) && (
            <TextField select label="On behalf of" value={form.fromUserId} onChange={(e) => setForm({ ...form, fromUserId: e.target.value })} sx={{ minWidth: 200 }}>
              <MenuItem value="">Me</MenuItem>
              {(users.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.fullName}</MenuItem>)}
            </TextField>
          )}
          <TextField select label="Delegate to" value={form.toUserId} onChange={(e) => setForm({ ...form, toUserId: e.target.value })} sx={{ minWidth: 220 }}>
            {(users.data ?? []).filter((u) => u.id !== user?.id).map((u) => <MenuItem key={u.id} value={u.id}>{u.fullName} ({u.username})</MenuItem>)}
          </TextField>
          <TextField label="From" type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="To" type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <Button variant="contained" disabled={!form.toUserId || !form.startsOn || !form.endsOn} onClick={() => create.mutate()}>
            Delegate
          </Button>
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        {(list.data ?? []).length === 0 && <Typography color="text.secondary">No delegations.</Typography>}
        {(list.data ?? []).map((d) => (
          <Stack key={d.id} direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
            <Typography sx={{ flexGrow: 1 }}>
              {name(d.fromUserId)} → {name(d.toUserId)} · {date(d.startsOn)} – {date(d.endsOn)} {d.reason ? `· ${d.reason}` : ''}
            </Typography>
            <Chip size="small" label={d.isActive ? 'Active' : 'Ended'} color={d.isActive ? 'success' : 'default'} />
            {d.isActive && (
              <Button size="small" onClick={() => end.mutate(d.id)}>
                End
              </Button>
            )}
          </Stack>
        ))}
      </Paper>
    </Stack>
  );
}

const DOC_TYPES = [
  ['PR', 'Purchase requisition'],
  ['PO', 'Purchase order'],
  ['INV', 'Supplier invoice'],
] as const;

function WorkflowDialog({ workflow, onClose }: { workflow: Workflow | 'new'; onClose(): void }) {
  const roles = useList<Role>('/roles');
  const categories = useList<ItemCategory>('/item-categories');
  const isNew = workflow === 'new';
  const [form, setForm] = useState({
    code: isNew ? '' : workflow.code,
    name: isNew ? '' : workflow.name,
    documentType: isNew ? 'PO' : workflow.documentType,
    minAmount: isNew ? '' : String(workflow.minAmount ?? ''),
    maxAmount: isNew ? '' : String(workflow.maxAmount ?? ''),
    itemCategoryId: isNew ? '' : (workflow.itemCategoryId ?? ''),
    priority: isNew ? 0 : workflow.priority,
    isActive: isNew ? true : workflow.isActive,
    steps: isNew ? [{ name: 'Approval', roleId: '' }] : (workflow.steps ?? []).sort((a, b) => a.sequence - b.sequence).map((s) => ({ name: s.name, roleId: s.roleId ?? '' })),
  });
  const save = useApiMutation<void>(
    () => [
      isNew ? '/approvals/workflows' : `/approvals/workflows/${workflow.id}`,
      {
        method: isNew ? 'POST' : 'PUT',
        body: {
          ...form,
          minAmount: form.minAmount === '' ? null : Number(form.minAmount),
          maxAmount: form.maxAmount === '' ? null : Number(form.maxAmount),
          itemCategoryId: form.itemCategoryId || null,
          steps: form.steps.map((s) => ({ name: s.name, approverType: 'ROLE', roleId: s.roleId })),
        },
      },
    ],
    { invalidate: ['/approvals/workflows'], success: 'Workflow saved' },
  );
  return (
    <FormDialog open maxWidth="md" title={isNew ? 'New workflow' : `Edit ${workflow.code}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Code" value={form.code} disabled={!isNew} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField select label="Document" value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>
          {DOC_TYPES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </TextField>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="From amount (inclusive)" type="number" value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: e.target.value })} />
        <TextField label="Up to (exclusive, blank = no limit)" type="number" value={form.maxAmount} onChange={(e) => setForm({ ...form, maxAmount: e.target.value })} />
        <TextField select label="Only for item category" value={form.itemCategoryId} onChange={(e) => setForm({ ...form, itemCategoryId: e.target.value })}>
          <MenuItem value="">Any</MenuItem>
          {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
        </TextField>
      </Stack>
      <Typography variant="subtitle2">Steps (in order)</Typography>
      {form.steps.map((s, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <Typography sx={{ width: 24 }}>{i + 1}.</Typography>
          <TextField label="Step name" value={s.name} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <TextField select label="Approver role" value={s.roleId} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)) })} sx={{ minWidth: 240 }}>
            {(roles.data ?? []).map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
          </TextField>
          <IconButton aria-label={`Remove step ${i + 1}`} disabled={form.steps.length === 1} onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}>
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Box>
        <Button startIcon={<AddIcon />} onClick={() => setForm({ ...form, steps: [...form.steps, { name: `Step ${form.steps.length + 1}`, roleId: '' }] })}>
          Add step
        </Button>
      </Box>
    </FormDialog>
  );
}

function Workflows() {
  const money = useMoney();
  const { data, isFetching } = useList<Workflow>('/approvals/workflows');
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const columns: GridColDef<Workflow>[] = [
    { field: 'code', headerName: 'Code', width: 100 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 220 },
    { field: 'documentType', headerName: 'Document', width: 100 },
    { field: 'band', headerName: 'Amount band', width: 220, valueGetter: (_v, r) => `${money(r.minAmount ?? 0)} – ${r.maxAmount == null ? '∞' : money(r.maxAmount)}` },
    { field: 'steps', headerName: 'Steps', flex: 1, minWidth: 260, valueGetter: (_v, r) => (r.steps ?? []).sort((a, b) => a.sequence - b.sequence).map((s) => s.role?.name ?? s.name).join(' → ') },
    { field: 'isActive', headerName: 'Active', type: 'boolean', width: 80 },
  ];
  return (
    <>
      <Box sx={{ mb: 1 }}>
        <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setEditing('new')}>
          New workflow
        </Button>
      </Box>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => setEditing(row)} disableRowSelectionOnClick />
      </Paper>
      {editing && <WorkflowDialog workflow={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

export function ApprovalsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(0);
  return (
    <>
      <PageHeader title="Approvals" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="My inbox" />
        <Tab label="Delegations" />
        {can(Permissions.APPROVALS_MANAGE) && <Tab label="Workflows" />}
      </Tabs>
      {tab === 0 && <Inbox />}
      {tab === 1 && <Delegations />}
      {tab === 2 && <Workflows />}
    </>
  );
}

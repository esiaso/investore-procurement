import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { Box, Button, Chip, IconButton, MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { ApprovalInboxRow, Workflow } from '../api/purchasing-types';
import type { Department, ItemCategory, Role } from '../api/types';
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
    { field: 'stepName', headerName: 'Your step', width: 200, valueGetter: (_v, r) => `${r.stepName}${(r.minApprovals ?? 1) > 1 ? ` (${r.approvalsAtStep ?? 0} of ${r.minApprovals})` : ''}${r.escalated ? ' · escalated' : ''}` },
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
  ['REQ', 'Staff requisition'],
  ['PR', 'Purchase requisition'],
  ['PO', 'Purchase order'],
  ['INV', 'Supplier invoice'],
  ['SR', 'Internal requisition'],
] as const;

const blankStep = (name: string) => ({ name, roleId: '', approverType: 'ROLE', minApprovals: '1', remindAfterHours: '', escalateAfterHours: '', escalateToRoleId: '' });

function WorkflowDialog({ workflow, onClose }: { workflow: Workflow | 'new'; onClose(): void }) {
  const roles = useList<Role>('/roles');
  const categories = useList<ItemCategory>('/item-categories');
  const departments = useAll<Department>('/departments');
  const isNew = workflow === 'new';
  const [form, setForm] = useState({
    code: isNew ? '' : workflow.code,
    name: isNew ? '' : workflow.name,
    documentType: isNew ? 'PO' : workflow.documentType,
    minAmount: isNew ? '' : String(workflow.minAmount ?? ''),
    maxAmount: isNew ? '' : String(workflow.maxAmount ?? ''),
    itemCategoryId: isNew ? '' : (workflow.itemCategoryId ?? ''),
    departmentId: isNew ? '' : (workflow.departmentId ?? ''),
    currency: isNew ? '' : (workflow.currency ?? ''),
    priority: isNew ? 0 : workflow.priority,
    isActive: isNew ? true : workflow.isActive,
    steps: isNew
      ? [blankStep('Approval')]
      : (workflow.steps ?? [])
          .sort((a, b) => a.sequence - b.sequence)
          .map((s) => ({
            name: s.name,
            roleId: s.roleId ?? '',
            approverType: s.approverType === 'DEPARTMENT_ROLE' ? 'DEPARTMENT_ROLE' : 'ROLE',
            minApprovals: String(s.minApprovals ?? 1),
            remindAfterHours: String(s.remindAfterHours ?? ''),
            escalateAfterHours: String(s.escalateAfterHours ?? ''),
            escalateToRoleId: s.escalateToRoleId ?? '',
          })),
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
          departmentId: form.departmentId || null,
          currency: form.currency || null,
          steps: form.steps.map((s) => ({
            name: s.name,
            approverType: s.approverType,
            roleId: s.roleId,
            minApprovals: Number(s.minApprovals || 1),
            remindAfterHours: s.remindAfterHours ? Number(s.remindAfterHours) : null,
            escalateAfterHours: s.escalateAfterHours ? Number(s.escalateAfterHours) : null,
            escalateToRoleId: s.escalateToRoleId || null,
          })),
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
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Only for department" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} sx={{ minWidth: 220 }}>
          <MenuItem value="">Any</MenuItem>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <TextField label="Only for currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase().slice(0, 3) })} helperText="Blank = any; bands stay in the base currency" sx={{ width: 200 }} />
        <TextField label="Priority" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} sx={{ width: 120 }} />
      </Stack>
      <Typography variant="subtitle2">Steps (in order)</Typography>
      {form.steps.map((s, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <Typography sx={{ width: 24 }}>{i + 1}.</Typography>
          <TextField label="Step name" value={s.name} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <TextField select label="Approver role" value={s.roleId} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)) })} sx={{ minWidth: 240 }}>
            {(roles.data ?? []).map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
          </TextField>
          <TextField select label="Who" value={s.approverType} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, approverType: e.target.value } : x)) })} sx={{ minWidth: 220 }}>
            <MenuItem value="ROLE">Anyone with the role</MenuItem>
            <MenuItem value="DEPARTMENT_ROLE">Role holder in the document's department</MenuItem>
          </TextField>
          <TextField label="Approvals needed" type="number" value={s.minApprovals} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, minApprovals: e.target.value } : x)) })} sx={{ width: 110 }} helperText="N of the role" />
          <TextField label="Remind after h" type="number" value={s.remindAfterHours} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, remindAfterHours: e.target.value } : x)) })} sx={{ width: 110 }} />
          <TextField label="Escalate after h" type="number" value={s.escalateAfterHours} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, escalateAfterHours: e.target.value } : x)) })} sx={{ width: 110 }} />
          <TextField select label="Escalate to" value={s.escalateToRoleId} onChange={(e) => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? { ...x, escalateToRoleId: e.target.value } : x)) })} sx={{ minWidth: 160 }}>
            <MenuItem value="">—</MenuItem>
            {(roles.data ?? []).map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
          </TextField>
          <IconButton aria-label={`Remove step ${i + 1}`} disabled={form.steps.length === 1} onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}>
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Box>
        <Button startIcon={<AddIcon />} onClick={() => setForm({ ...form, steps: [...form.steps, blankStep(`Step ${form.steps.length + 1}`)] })}>
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
    { field: 'steps', headerName: 'Steps', flex: 1, minWidth: 260, valueGetter: (_v, r) => (r.steps ?? []).sort((a, b) => a.sequence - b.sequence).map((s) => `${s.role?.name ?? s.name}${s.approverType === 'DEPARTMENT_ROLE' ? ' (own department)' : ''}${(s.minApprovals ?? 1) > 1 ? ` ×${s.minApprovals}` : ''}`).join(' → ') },
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

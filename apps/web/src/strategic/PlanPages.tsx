import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { Alert, Box, Button, IconButton, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Permissions, PlanStatus } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import { methodLabel, Plan, PlanDetail, useSourcingMethods } from './api';

interface BudgetOption {
  id: string;
  departmentId: string;
  voteHead: string;
  financialYear: string;
  label: string;
}

interface LineForm {
  item: Item | null;
  description: string;
  quantity: number;
  estimatedUnitCost: number;
  voteHead: string;
  sourcingMethod: string;
  plannedQuarter: number;
  notes: string;
}

const EMPTY_LINE: LineForm = { item: null, description: '', quantity: 1, estimatedUnitCost: 0, voteHead: '', sourcingMethod: '', plannedQuarter: 1, notes: '' };

/** Plan line payload from the form (blank method = recommended for the line value). */
export function planLinesPayload(lines: LineForm[]) {
  return lines.map((l) => ({
    itemId: l.item?.id,
    description: l.item ? undefined : l.description,
    quantity: Number(l.quantity),
    estimatedUnitCost: Number(l.estimatedUnitCost),
    voteHead: l.voteHead,
    sourcingMethod: l.sourcingMethod || undefined,
    plannedQuarter: Number(l.plannedQuarter),
    notes: l.notes || undefined,
  }));
}

export function PlanFormPage({ mode }: { mode: 'new' | 'edit' | 'revise' }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const money = useMoney();
  const { user, can } = useAuth();
  const departments = useAll<Department>('/departments');
  const methods = useSourcingMethods();
  const existing = useQuery({ queryKey: ['/procurement-plans', id], queryFn: () => api<PlanDetail>(`/procurement-plans/${id}`), enabled: !!id });
  const [departmentId, setDepartmentId] = useState(user?.departmentId ?? '');
  const [financialYear, setFinancialYear] = useState('');
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<LineForm[]>([{ ...EMPTY_LINE }]);
  const budgets = useList<BudgetOption>('/budgets/options', { departmentId, financialYear: financialYear || undefined }, !!departmentId);
  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    setDepartmentId(p.departmentId ?? '');
    setFinancialYear(p.financialYear);
    setTitle(p.title);
    setLines((p.lines ?? []).map((l) => ({ item: (l.item as Item) ?? null, description: l.description, quantity: l.quantity, estimatedUnitCost: l.estimatedUnitCost, voteHead: l.voteHead, sourcingMethod: l.sourcingMethod, plannedQuarter: l.plannedQuarter, notes: l.notes ?? '' })));
  }, [existing.data]);
  useEffect(() => {
    if (!financialYear && budgets.data?.length) setFinancialYear(budgets.data[0].financialYear);
  }, [financialYear, budgets.data]);
  const save = useApiMutation<void, Plan>(
    () =>
      mode === 'new'
        ? ['/procurement-plans', { method: 'POST', body: { financialYear, departmentId, title, lines: planLinesPayload(lines) } }]
        : mode === 'edit'
          ? [`/procurement-plans/${id}`, { method: 'PUT', body: { title, lines: planLinesPayload(lines) } }]
          : [`/procurement-plans/${id}/revise`, { method: 'POST', body: { reason, lines: planLinesPayload(lines) } }],
    { invalidate: ['/procurement-plans'], success: mode === 'revise' ? 'Revision submitted for approval' : 'Plan saved' },
  );
  const set = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.estimatedUnitCost), 0);
  const voteHeads = [...new Set((budgets.data ?? []).filter((b) => b.financialYear === financialYear).map((b) => b.voteHead))];
  const canChooseDepartment = can(Permissions.PLANS_CONSOLIDATE);
  return (
    <>
      <PageHeader title={mode === 'new' ? 'New procurement plan' : mode === 'edit' ? `Edit ${existing.data?.number ?? 'plan'}` : `Revise ${existing.data?.number ?? 'plan'} (version ${(existing.data?.version ?? 0) + 1})`} />
      <Paper sx={{ p: 2 }}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, { onSuccess: (p) => navigate(`/procurement-plans/${p.id}`) });
          }}
        >
          <Stack spacing={2}>
            {mode === 'revise' && (
              <>
                <Alert severity="info">The approved version stays in force until the revision is approved; if it is rejected, the plan goes back to the approved version.</Alert>
                <TextField label="Reason for the revision" value={reason} onChange={(e) => setReason(e.target.value)} required multiline minRows={2} />
              </>
            )}
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <TextField select label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={mode !== 'new' || (!canChooseDepartment && !!user?.departmentId)} sx={{ minWidth: 240 }}>
                {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
              </TextField>
              <TextField label="Financial year" value={financialYear} onChange={(e) => setFinancialYear(e.target.value)} disabled={mode !== 'new'} helperText="e.g. 2026 or 2026/27" />
              <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={mode === 'revise'} sx={{ flex: 1 }} required />
            </Stack>
            {departmentId && !voteHeads.length && !budgets.isFetching && <Alert severity="warning">This department has no budget for {financialYear || 'the year'}; finance sets up the vote heads first.</Alert>}
            <Typography variant="subtitle2">Planned procurement (quantities in base units)</Typography>
            {lines.map((l, i) => (
              <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={1}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
                    <ItemPicker value={l.item} onChange={(item) => set(i, { item })} label="Catalogue item (or describe below)" />
                    {!l.item && <TextField label="Description (services, works, new items)" value={l.description} onChange={(e) => set(i, { description: e.target.value })} sx={{ flex: 1 }} />}
                    <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}><DeleteIcon /></IconButton>
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    <TextField label="Quantity" type="number" value={l.quantity} onChange={(e) => set(i, { quantity: Number(e.target.value) })} sx={{ width: { md: 120 } }} />
                    <TextField label="Est. unit cost" type="number" value={l.estimatedUnitCost} onChange={(e) => set(i, { estimatedUnitCost: Number(e.target.value) })} sx={{ width: { md: 140 } }} />
                    <TextField select label="Vote head" value={l.voteHead} onChange={(e) => set(i, { voteHead: e.target.value })} sx={{ width: { md: 180 } }}>
                      {voteHeads.map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select label="Sourcing method" value={l.sourcingMethod} onChange={(e) => set(i, { sourcingMethod: e.target.value })} sx={{ width: { md: 220 } }}>
                      <MenuItem value="">Recommended for the value</MenuItem>
                      {(methods.data ?? []).filter((m) => m.isActive).map((m) => <MenuItem key={m.code} value={m.code}>{m.label}</MenuItem>)}
                    </TextField>
                    <TextField select label="Quarter" value={l.plannedQuarter} onChange={(e) => set(i, { plannedQuarter: Number(e.target.value) })} sx={{ width: { md: 100 } }}>
                      {[1, 2, 3, 4].map((q) => <MenuItem key={q} value={q}>Q{q}</MenuItem>)}
                    </TextField>
                    <Typography sx={{ alignSelf: 'center', minWidth: 120 }} align="right">{money(Number(l.quantity) * Number(l.estimatedUnitCost))}</Typography>
                  </Stack>
                </Stack>
              </Paper>
            ))}
            <Stack direction="row" alignItems="center">
              <Button startIcon={<AddIcon />} onClick={() => setLines([...lines, { ...EMPTY_LINE, voteHead: voteHeads[0] ?? '' }])}>Add line</Button>
              <Box sx={{ flexGrow: 1 }} />
              <Typography>Total <b>{money(total)}</b></Typography>
            </Stack>
            <Box>
              <Button type="submit" variant="contained" disabled={save.isPending}>{mode === 'revise' ? 'Submit revision' : 'Save draft'}</Button>
            </Box>
          </Stack>
        </form>
      </Paper>
    </>
  );
}

function ConsolidateDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const [financialYear, setFy] = useState('');
  const run = useApiMutation<void, Plan>(() => ['/procurement-plans/consolidate', { method: 'POST', body: { financialYear } }], { invalidate: ['/procurement-plans'], success: 'Hospital plan consolidated' });
  return (
    <FormDialog open title="Consolidate the hospital plan" submitLabel="Consolidate" onClose={onClose} submitting={run.isPending} onSubmit={(e) => { e.preventDefault(); run.mutate(undefined, { onSuccess: (p) => navigate(`/procurement-plans/${p.id}`) }); }}>
      <Typography variant="body2">Approved departmental plans are added up by item and vote head; the sourcing method is re-recommended for the combined value. The departmental plans become Consolidated.</Typography>
      <TextField label="Financial year" value={financialYear} onChange={(e) => setFy(e.target.value)} required helperText="e.g. 2026 or 2026/27" />
    </FormDialog>
  );
}

export function PlansPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const departments = useAll<Department>('/departments');
  const [financialYear, setFy] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [consolidate, setConsolidate] = useState(false);
  const { data, isFetching } = useList<Plan>('/procurement-plans', { financialYear: /^\d{4}(\/\d{2})?$/.test(financialYear) ? financialYear : undefined, departmentId: departmentId || undefined, status: status || undefined });
  const columns: GridColDef<Plan>[] = [
    { field: 'number', headerName: 'Number', width: 150 },
    { field: 'financialYear', headerName: 'FY', width: 90 },
    { field: 'department', headerName: 'Department', width: 200, valueGetter: (_v, r) => r.department?.name ?? 'Hospital plan' },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
    { field: 'version', headerName: 'Ver.', type: 'number', width: 70 },
    { field: 'status', headerName: 'Status', width: 160, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'totalEstimate', headerName: 'Total', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'updatedAt', headerName: 'Updated', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Annual procurement plans"
        onNew={can(Permissions.PLANS_MANAGE) ? () => navigate('/procurement-plans/new') : undefined}
        newLabel="New plan"
        actions={can(Permissions.PLANS_CONSOLIDATE) ? <Button variant="outlined" onClick={() => setConsolidate(true)}>Consolidate hospital plan</Button> : undefined}
      />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField label="Financial year" value={financialYear} onChange={(e) => setFy(e.target.value)} sx={{ width: { xs: '100%', md: 160 } }} />
        <TextField select label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ width: { xs: '100%', md: 240 } }}>
          <MenuItem value="">All</MenuItem>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', md: 200 } }}>
          <MenuItem value="">All</MenuItem>
          {Object.values(PlanStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => navigate(`/procurement-plans/${row.id}`)} disableRowSelectionOnClick pageSizeOptions={[25, 50]} initialState={{ pagination: { paginationModel: { pageSize: 25 } } }} />
      </Paper>
      {consolidate && <ConsolidateDialog onClose={() => setConsolidate(false)} />}
    </>
  );
}

export function PlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const { user, can } = useAuth();
  const methods = useSourcingMethods();
  const { data: plan } = useQuery({ queryKey: ['/procurement-plans', id], queryFn: () => api<PlanDetail>(`/procurement-plans/${id}`) });
  const submit = useApiMutation<void>(() => [`/procurement-plans/${id}/submit`, { method: 'POST' }], { invalidate: ['/procurement-plans', '/approvals'], success: 'Submitted for approval' });
  if (!plan) return null;
  const mayEdit = can(Permissions.PLANS_MANAGE) && (can(Permissions.PLANS_CONSOLIDATE) || plan.departmentId === user?.departmentId);
  const editable = mayEdit && ['DRAFT', 'RETURNED'].includes(plan.status);
  const exec = new Map(plan.execution.lines.map((l) => [l.lineId, l]));
  return (
    <>
      <PageHeader title={`${plan.number} · ${plan.title}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={plan.status} />
                <Typography>{plan.department?.name ?? 'Hospital plan'} · FY {plan.financialYear} · version {plan.version}</Typography>
              </Stack>
              {plan.lastComment && ['RETURNED', 'REJECTED'].includes(plan.status) && <Alert severity="warning" sx={{ mb: 2 }}>{plan.lastComment}</Alert>}
              {plan.revisionReason && <Typography variant="body2" sx={{ mb: 1 }}>Revision: {plan.revisionReason}</Typography>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Planned">{money(plan.execution.planned)}</Field>
                <Field label="Procured (approved POs)">{money(plan.execution.procured)}</Field>
                <Field label="Spent (approved invoices)">{money(plan.execution.spent)}</Field>
                <Field label="Execution">{plan.execution.executionRate === null ? '—' : `${plan.execution.executionRate}%`}</Field>
              </Stack>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Plan lines">
                  <TableHead>
                    <TableRow>
                      <TableCell>#</TableCell><TableCell>Description</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Unit cost</TableCell><TableCell align="right">Total</TableCell>
                      <TableCell>Vote head</TableCell><TableCell>Method</TableCell><TableCell>Qtr</TableCell><TableCell align="right">Procured</TableCell><TableCell sx={{ minWidth: 120 }}>Execution</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(plan.lines ?? []).map((l) => {
                      const e = exec.get(l.id);
                      return (
                        <TableRow key={l.id}>
                          <TableCell>{l.lineNo}</TableCell>
                          <TableCell>{l.item?.name ?? l.description}{l.sourceDepartmentIds.length > 1 && <Typography variant="caption" display="block">{l.sourceDepartmentIds.length} departments</Typography>}</TableCell>
                          <TableCell align="right">{l.quantity}</TableCell>
                          <TableCell align="right">{money(l.estimatedUnitCost)}</TableCell>
                          <TableCell align="right">{money(l.estimatedTotal)}</TableCell>
                          <TableCell>{l.voteHead}</TableCell>
                          <TableCell>{methodLabel(methods.data, l.sourcingMethod)}</TableCell>
                          <TableCell>Q{l.plannedQuarter}</TableCell>
                          <TableCell align="right">{e ? `${e.procuredQty} · ${money(e.procuredValue)}` : ''}</TableCell>
                          <TableCell>{e?.executionRate != null && <LinearProgress variant="determinate" value={Math.min(100, e.executionRate)} aria-label={`Line ${l.lineNo} execution ${e.executionRate}%`} />}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                {editable && <Button onClick={() => navigate(`/procurement-plans/${plan.id}/edit`)}>Edit</Button>}
                {editable && <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
                {mayEdit && plan.status === 'APPROVED' && <Button variant="outlined" onClick={() => navigate(`/procurement-plans/${plan.id}/revise`)}>Mid-year revision</Button>}
              </Stack>
            </Paper>
            {plan.budgets.length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Against the budget</Typography>
                <Table size="small" aria-label="Plan against budget">
                  <TableHead><TableRow><TableCell>Vote head</TableCell><TableCell align="right">Planned</TableCell><TableCell align="right">Budget</TableCell><TableCell /></TableRow></TableHead>
                  <TableBody>
                    {plan.budgets.map((b) => (
                      <TableRow key={b.vote_head}>
                        <TableCell>{b.vote_head}</TableCell><TableCell align="right">{money(b.planned)}</TableCell><TableCell align="right">{b.budget === null ? '—' : money(b.budget)}</TableCell>
                        <TableCell>{b.budget !== null && b.planned > b.budget && <Typography color="error" variant="body2">Over budget</Typography>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            )}
          </>
        }
        side={
          <>
            <ApprovalPanel type="APP" id={plan.id} />
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Approved versions</Typography>
              {plan.versions.length === 0 && <Typography color="text.secondary">None yet.</Typography>}
              {plan.versions.map((v) => (
                <Typography key={v.version} variant="body2">Version {v.version} · {date(v.at)}{v.reason ? ` — ${v.reason}` : ''}</Typography>
              ))}
              {plan.approvalHistory.some((a) => a.action) && (
                <>
                  <Typography variant="subtitle2" sx={{ mt: 2 }}>Approval history</Typography>
                  {plan.approvalHistory.filter((a) => a.action).map((a, i) => (
                    <Typography key={i} variant="caption" display="block">
                      {a.document_no}: {humanise(a.action!)} by {a.by} ({a.step_name}) · {date(a.acted_at)}{a.comment ? ` — “${a.comment}”` : ''}
                    </Typography>
                  ))}
                </>
              )}
            </Paper>
            <DocumentChain type="APP" id={plan.id} />
          </>
        }
      />
    </>
  );
}

import { Alert, Box, Button, Chip, Link, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { ContractStatus, Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip, StoreSelect } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import type { Contract, ContractDetail } from './api';

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const daysTo = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86_400_000);

/** Call-off lines with a positive quantity that fit the remaining balance. */
export function callOffProblems(lines: ContractDetail['lines'], qty: Record<string, number>): string[] {
  return lines
    .filter((l) => (qty[l.id] ?? 0) > 0 && l.remainingQty !== null && qty[l.id] > l.remainingQty)
    .map((l) => `${l.item?.name ?? 'Line'}: only ${l.remainingQty} left`);
}

export function ContractsPage() {
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [status, setStatus] = useState('ACTIVE');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, isFetching } = useList<Contract>('/contracts', { status: status || undefined, type: type || undefined, search: q || undefined });
  const columns: GridColDef<Contract>[] = [
    { field: 'number', headerName: 'Number', width: 150 },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
    { field: 'supplier', headerName: 'Supplier', width: 200, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'type', headerName: 'Type', width: 110, valueFormatter: (v: string) => humanise(v) },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'value', headerName: 'Value', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    {
      field: 'endDate',
      headerName: 'Ends',
      width: 160,
      renderCell: ({ row }) => {
        const left = daysTo(row.endDate);
        return <span>{date(row.endDate)}{row.status === 'ACTIVE' && left <= 90 && <Chip size="small" color={left <= 30 ? 'error' : 'warning'} label={`${left} d`} sx={{ ml: 1 }} />}</span>;
      },
    },
  ];
  return (
    <>
      <PageHeader title="Contracts and framework agreements" search={search} onSearch={setSearch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', md: 180 } }}>
          <MenuItem value="">All</MenuItem>
          {Object.values(ContractStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value)} sx={{ width: { xs: '100%', md: 180 } }}>
          <MenuItem value="">All</MenuItem>
          <MenuItem value="FRAMEWORK">Framework</MenuItem>
          <MenuItem value="FIXED">Fixed</MenuItem>
        </TextField>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => navigate(`/contracts/${row.id}`)} disableRowSelectionOnClick pageSizeOptions={[25, 50]} initialState={{ pagination: { paginationModel: { pageSize: 25 } } }} />
      </Paper>
    </>
  );
}

function CallOffDialog({ c, onClose }: { c: ContractDetail; onClose(): void }) {
  const navigate = useNavigate();
  const departments = useAll<Department>('/departments');
  const [storeId, setStoreId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const problems = callOffProblems(c.lines, qty);
  const lines = c.lines.filter((l) => (qty[l.id] ?? 0) > 0).map((l) => ({ contractLineId: l.id, quantity: qty[l.id] }));
  const create = useApiMutation<void, { purchaseOrderId: string }>(() => [`/contracts/${c.id}/call-offs`, { method: 'POST', body: { storeId, departmentId, lines } }], {
    invalidate: ['/contracts', '/purchase-orders'],
    success: 'Call-off created as a draft purchase order',
  });
  return (
    <FormDialog open maxWidth="md" title={`Call-off against ${c.number}`} submitLabel="Create draft PO" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); if (!problems.length) create.mutate(undefined, { onSuccess: (r) => navigate(`/purchase-orders/${r.purchaseOrderId}`) }); }}>
      <Stack direction="row" spacing={2}>
        <StoreSelect value={storeId} onChange={setStoreId} label="Deliver to" sx={{ flex: 1 }} />
        <TextField select label="Department charged" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ flex: 1 }}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      </Stack>
      {c.lines.map((l) => (
        <Stack key={l.id} direction="row" spacing={2} alignItems="center">
          <Typography sx={{ flex: 1 }}>{l.item?.name} @ {l.unitPrice}</Typography>
          <Typography variant="body2" color="text.secondary">{l.remainingQty === null ? 'no quantity limit' : `${l.remainingQty} left`}</Typography>
          <TextField size="small" type="number" label={`Qty (${l.item?.baseUom?.code ?? 'base units'})`} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: Number(e.target.value) })} sx={{ width: 150 }} />
        </Stack>
      ))}
      {problems.map((p) => <Alert key={p} severity="warning">{p}</Alert>)}
      <Typography variant="caption">The draft PO uses the contract prices and goes through the normal PO approval.</Typography>
    </FormDialog>
  );
}

function VariationDialog({ c, onClose }: { c: ContractDetail; onClose(): void }) {
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [value, setValue] = useState<number | ''>('');
  const [lineChanges, setLineChanges] = useState<Record<string, { unitPrice?: number; quantity?: number }>>({});
  const save = useApiMutation<void>(
    () => [
      `/contracts/${c.id}/variations`,
      {
        method: 'POST',
        body: {
          reason,
          changes: {
            endDate: endDate || undefined,
            value: value === '' ? undefined : Number(value),
            lines: Object.entries(lineChanges).filter(([, v]) => v.unitPrice !== undefined || v.quantity !== undefined).map(([contractLineId, v]) => ({ contractLineId, ...v })),
          },
        },
      },
    ],
    { invalidate: ['/contracts', '/approvals'], success: 'Variation submitted for approval' },
  );
  const setLine = (id: string, patch: { unitPrice?: number; quantity?: number }) => setLineChanges({ ...lineChanges, [id]: { ...lineChanges[id], ...patch } });
  return (
    <FormDialog open maxWidth="md" title={`Vary ${c.number}`} submitLabel="Submit for approval" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required multiline minRows={2} />
      <Stack direction="row" spacing={2}>
        <TextField label={`New end date (now ${c.endDate})`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label={`New contract value (now ${c.value})`} type="number" value={value} onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))} />
      </Stack>
      {c.lines.map((l) => (
        <Stack key={l.id} direction="row" spacing={2} alignItems="center">
          <Typography sx={{ flex: 1 }}>{l.item?.name}</Typography>
          <TextField size="small" type="number" label={`Price (now ${l.unitPrice})`} value={lineChanges[l.id]?.unitPrice ?? ''} onChange={(e) => setLine(l.id, { unitPrice: e.target.value === '' ? undefined : Number(e.target.value) })} sx={{ width: 160 }} />
          <TextField size="small" type="number" label={`Quantity (now ${l.quantity ?? '—'})`} value={lineChanges[l.id]?.quantity ?? ''} onChange={(e) => setLine(l.id, { quantity: e.target.value === '' ? undefined : Number(e.target.value) })} sx={{ width: 170 }} />
        </Stack>
      ))}
      <Typography variant="caption">The contract changes only when the variation is approved.</Typography>
    </FormDialog>
  );
}

function SecurityDialog({ c, onClose }: { c: ContractDetail; onClose(): void }) {
  const [form, setForm] = useState({ securityType: 'BANK_GUARANTEE', reference: '', issuer: '', amount: 0, expiresOn: c.endDate });
  const save = useApiMutation<void>(() => [`/contracts/${c.id}/securities`, { method: 'POST', body: { ...form, amount: Number(form.amount) } }], { invalidate: ['/contracts'], success: 'Security recorded' });
  return (
    <FormDialog open title="Performance security" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Type" value={form.securityType} onChange={(e) => setForm({ ...form, securityType: e.target.value })}>
        <MenuItem value="BANK_GUARANTEE">Bank guarantee</MenuItem>
        <MenuItem value="INSURANCE_BOND">Insurance bond</MenuItem>
        <MenuItem value="CASH">Cash deposit</MenuItem>
      </TextField>
      <TextField label="Reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} required />
      <TextField label="Issuer" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} required />
      <Stack direction="row" spacing={2}>
        <TextField label="Amount" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
        <TextField label="Expires" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
    </FormDialog>
  );
}

function MilestoneDialog({ c, onClose }: { c: ContractDetail; onClose(): void }) {
  const [form, setForm] = useState({ description: '', dueDate: todayStr(), notes: '' });
  const save = useApiMutation<void>(() => [`/contracts/${c.id}/milestones`, { method: 'POST', body: { ...form, notes: form.notes || undefined } }], { invalidate: ['/contracts'], success: 'Milestone added' });
  return (
    <FormDialog open title="Milestone" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
      <TextField label="Due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
    </FormDialog>
  );
}

function TerminateDialog({ c, onClose }: { c: ContractDetail; onClose(): void }) {
  const [reason, setReason] = useState('');
  const save = useApiMutation<void>(() => [`/contracts/${c.id}/terminate`, { method: 'POST', body: { reason } }], { invalidate: ['/contracts'], success: 'Contract terminated' });
  return (
    <FormDialog open title={`Terminate ${c.number}`} submitLabel="Terminate" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required multiline minRows={2} />
    </FormDialog>
  );
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const { data: c } = useQuery({ queryKey: ['/contracts', id], queryFn: () => api<ContractDetail>(`/contracts/${id}`) });
  const [dialog, setDialog] = useState<null | 'calloff' | 'variation' | 'security' | 'milestone' | 'terminate' | 'sign'>(null);
  const [signatory, setSignatory] = useState('');
  const release = useApiMutation<string>((sid) => [`/contracts/${id}/securities/${sid}/release`, { method: 'POST' }], { invalidate: ['/contracts'], success: 'Security released' });
  const complete = useApiMutation<string>((mid) => [`/contracts/${id}/milestones/${mid}/complete`, { method: 'POST', body: {} }], { invalidate: ['/contracts'], success: 'Milestone completed' });
  const sign = useApiMutation<void>(() => [`/contracts/${id}/sign`, { method: 'POST', body: { supplierSignatory: signatory } }], { invalidate: ['/contracts'], success: 'Contract signed' });
  if (!c) return null;
  const manage = can(Permissions.CONTRACTS_MANAGE);
  const active = c.status === 'ACTIVE';
  const pendingVariation = c.variations.find((v) => v.status === 'PENDING_APPROVAL');
  const used = c.value ? Math.round((100 * c.calledOffValue) / c.value) : 0;
  return (
    <>
      <PageHeader title={`${c.number} · ${c.title}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={c.status} />
                <Typography>{humanise(c.type)} · {c.supplier?.name}</Typography>
                {c.tenderId && <Link component={RouterLink} to={`/tenders/${c.tenderId}`}>from tender</Link>}
              </Stack>
              {c.terminationReason && <Alert severity="error" sx={{ mb: 2 }}>{c.terminationReason}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Field label="Valid">{date(c.startDate)} – {date(c.endDate)}{active && ` (${daysTo(c.endDate)} days left)`}</Field>
                <Field label="Value">{money(c.value)}</Field>
                <Field label="Called off">{money(c.calledOffValue)} ({used}%)</Field>
                <Field label="Remaining">{money(c.remainingValue)}</Field>
                <Field label="Terms">{[c.paymentTermsDays != null ? `${c.paymentTermsDays} days credit` : '', c.leadTimeDays != null ? `${c.leadTimeDays} days lead time` : ''].filter(Boolean).join(' · ') || '—'}</Field>
              </Stack>
              {c.deliveryTerms && <Typography variant="body2" sx={{ mb: 2 }}>Delivery: {c.deliveryTerms}</Typography>}
              <Table size="small" aria-label="Contract lines">
                <TableHead><TableRow><TableCell>Item</TableCell><TableCell align="right">Unit price</TableCell><TableCell align="right">Contract qty</TableCell><TableCell align="right">Called off</TableCell><TableCell align="right">Remaining</TableCell></TableRow></TableHead>
                <TableBody>
                  {c.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.item?.name}{l.brand ? ` (${l.brand})` : ''}</TableCell>
                      <TableCell align="right">{money(l.unitPrice)}</TableCell>
                      <TableCell align="right">{l.quantity ?? 'price only'}</TableCell>
                      <TableCell align="right">{l.calledOffQty}</TableCell>
                      <TableCell align="right"><b>{l.remainingQty ?? '—'}</b></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                {manage && c.status === 'DRAFT' && (
                  <>
                    <TextField size="small" label="Supplier signatory" value={signatory} onChange={(e) => setSignatory(e.target.value)} />
                    <Button variant="contained" disabled={!signatory || sign.isPending} onClick={() => sign.mutate()}>Sign</Button>
                  </>
                )}
                {manage && can(Permissions.PURCHASING_PO) && active && <Button variant="contained" onClick={() => setDialog('calloff')}>New call-off order</Button>}
                {manage && active && !pendingVariation && <Button onClick={() => setDialog('variation')}>Request variation</Button>}
                {manage && active && <Button onClick={() => setDialog('security')}>Add security</Button>}
                {manage && active && <Button onClick={() => setDialog('milestone')}>Add milestone</Button>}
                {manage && active && <Button color="error" onClick={() => setDialog('terminate')}>Terminate</Button>}
              </Stack>
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Call-off orders</Typography>
              {c.callOffs.length === 0 && <Typography color="text.secondary">None yet.</Typography>}
              {c.callOffs.length > 0 && (
                <Table size="small" aria-label="Call-off orders">
                  <TableHead><TableRow><TableCell>PO</TableCell><TableCell>Date</TableCell><TableCell>Store</TableCell><TableCell>Status</TableCell><TableCell align="right">Total</TableCell></TableRow></TableHead>
                  <TableBody>
                    {c.callOffs.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell><Link component={RouterLink} to={`/purchase-orders/${p.id}`}>{p.number}</Link></TableCell>
                        <TableCell>{date(p.orderDate)}</TableCell><TableCell>{p.store}</TableCell><TableCell><StatusChip status={p.status} /></TableCell><TableCell align="right">{money(p.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Variations</Typography>
              {c.variations.length === 0 && <Typography color="text.secondary">None.</Typography>}
              {c.variations.map((v) => (
                <Box key={v.id} sx={{ mb: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center"><b>{v.number}</b><StatusChip status={v.status} /><Typography variant="caption">{date(v.createdAt)}</Typography></Stack>
                  <Typography variant="body2">{v.reason}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[v.changes.endDate ? `end date → ${date(v.changes.endDate)}` : '', v.changes.value !== undefined ? `value → ${money(v.changes.value)}` : '', v.changes.lines?.length ? `${v.changes.lines.length} line change(s)` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                  {v.lastComment && <Typography variant="caption" display="block" color="warning.main">{v.lastComment}</Typography>}
                </Box>
              ))}
            </Paper>
          </>
        }
        side={
          <>
            {pendingVariation && <ApprovalPanel type="CV" id={pendingVariation.id} />}
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Performance securities</Typography>
              {c.securities.length === 0 && <Typography color="text.secondary">None.</Typography>}
              {c.securities.map((s) => (
                <Stack key={s.id} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {humanise(s.securityType)} {s.reference} · {s.issuer} · {money(s.amount)} · expires {date(s.expiresOn)}
                    {!s.releasedOn && daysTo(s.expiresOn) <= 30 && <Chip size="small" color="warning" label="Expiring" sx={{ ml: 1 }} />}
                    {s.releasedOn && ` · released ${date(s.releasedOn)}`}
                  </Typography>
                  {manage && !s.releasedOn && <Button size="small" onClick={() => release.mutate(s.id)}>Release</Button>}
                </Stack>
              ))}
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Milestones</Typography>
              {c.milestones.length === 0 && <Typography color="text.secondary">None.</Typography>}
              {c.milestones.map((m) => (
                <Stack key={m.id} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>{m.description} · due {date(m.dueDate)}{m.completedOn && ` · done ${date(m.completedOn)}`}</Typography>
                  {manage && !m.completedOn && <Button size="small" onClick={() => complete.mutate(m.id)}>Complete</Button>}
                </Stack>
              ))}
            </Paper>
            <DocumentChain type="CTR" id={c.id} />
          </>
        }
      />
      {dialog === 'calloff' && <CallOffDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'variation' && <VariationDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'security' && <SecurityDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'milestone' && <MilestoneDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'terminate' && <TerminateDialog c={c} onClose={() => setDialog(null)} />}
    </>
  );
}

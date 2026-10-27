import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { Alert, Box, Button, Chip, FormControlLabel, IconButton, Link, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { API_BASE, api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { GlAccount } from '../api/nonstock-types';
import { PETTY_METHODS, type FloatStatement, type PettyFloat, type PettyMethod, type PettyRequest, type Replenishment } from '../api/petty-cash-types';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { formatMoney, humanise } from '../lib/format';
import { SyncChip } from '../accounting/SyncChip';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';

const P = Permissions;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

// ------------------------------------------------------------------ request form

export function PettyRequestDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const floats = useList<PettyFloat>('/petty-cash/floats');
  const gl = useAll<GlAccount>('/gl-accounts', { active: true });
  const departments = useAll<Department>('/departments');
  const [f, setF] = useState({
    floatId: '',
    kind: 'PAYMENT' as 'PAYMENT' | 'ADVANCE',
    payeeType: 'VENDOR' as 'STAFF' | 'VENDOR',
    payeeName: '',
    purpose: '',
    glAccountId: '',
    departmentId: user?.departmentId ?? '',
    amount: '',
    method: 'CASH' as PettyMethod,
    payeePhone: '',
    payeeShortcode: '',
    payeeAccountRef: '',
    duplicateJustification: '',
  });
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const chosen = (floats.data ?? []).find((x) => x.id === f.floatId);
  const advance = f.kind === 'ADVANCE';
  const save = useApiMutation<void, PettyRequest>(
    () => [
      '/petty-cash/requests',
      {
        method: 'POST',
        body: {
          floatId: f.floatId,
          kind: f.kind,
          payeeType: advance ? 'STAFF' : f.payeeType,
          payeeName: advance || f.payeeType === 'STAFF' ? undefined : f.payeeName,
          purpose: f.purpose,
          glAccountId: f.glAccountId || undefined,
          departmentId: f.departmentId || undefined,
          amount: Number(f.amount),
          method: f.method,
          ...(f.method === 'MPESA_B2C' ? { payeePhone: f.payeePhone } : {}),
          ...(f.method === 'MPESA_PAYBILL' || f.method === 'MPESA_TILL' ? { payeeShortcode: f.payeeShortcode } : {}),
          ...(f.method === 'MPESA_PAYBILL' ? { payeeAccountRef: f.payeeAccountRef } : {}),
          duplicateJustification: f.duplicateJustification || undefined,
          submit: true,
        },
      },
    ],
    { invalidate: ['/petty-cash'], success: 'Submitted for approval' },
  );
  return (
    <FormDialog
      open
      maxWidth="md"
      title="Petty cash request"
      submitLabel="Submit for approval"
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, {
          onSuccess: (r) => navigate(`/petty-cash/${r.id}`),
          onError: (err) => {
            const body = (err as { body?: { code?: string; duplicateOf?: string } }).body;
            if (body?.code === 'POSSIBLE_DUPLICATE') setDuplicate(body.duplicateOf ?? 'an earlier request');
          },
        });
      }}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Float" value={f.floatId} onChange={(e) => set({ floatId: e.target.value })} required sx={{ flex: 1 }}>
          {(floats.data ?? []).filter((x) => x.isActive).map((x) => <MenuItem key={x.id} value={x.id}>{x.name} (available {formatMoney(x.available ?? x.balance, 'KES')})</MenuItem>)}
        </TextField>
        <TextField select label="Type" value={f.kind} onChange={(e) => set({ kind: e.target.value as 'PAYMENT' | 'ADVANCE' })} sx={{ minWidth: 200 }}>
          <MenuItem value="PAYMENT">Payment</MenuItem>
          <MenuItem value="ADVANCE">Advance / imprest (to retire)</MenuItem>
        </TextField>
      </Stack>
      {chosen && <Typography variant="body2" color="text.secondary">Up to {formatMoney(chosen.perTransactionLimit, 'KES')} per request · custodian {chosen.custodianName}</Typography>}
      {advance && <Alert severity="info">An advance is paid to you and must be retired with receipts (and any balance returned). No new advance is given while one is open.</Alert>}
      {!advance && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select label="Payee" value={f.payeeType} onChange={(e) => set({ payeeType: e.target.value as 'STAFF' | 'VENDOR' })} sx={{ minWidth: 160 }}>
            <MenuItem value="VENDOR">Vendor / other</MenuItem>
            <MenuItem value="STAFF">Me (staff)</MenuItem>
          </TextField>
          {f.payeeType === 'VENDOR' && <TextField label="Payee name" value={f.payeeName} onChange={(e) => set({ payeeName: e.target.value })} required sx={{ flex: 1 }} />}
        </Stack>
      )}
      <TextField label="Purpose" value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} required multiline minRows={2} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Expense account" value={f.glAccountId} onChange={(e) => set({ glAccountId: e.target.value })} sx={{ flex: 1 }}>
          <MenuItem value="">—</MenuItem>
          {(gl.data ?? []).filter((g) => g.type === 'EXPENSE').map((g) => <MenuItem key={g.id} value={g.id}>{g.code} {g.name}</MenuItem>)}
        </TextField>
        <TextField select label="Cost centre" value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value })} sx={{ flex: 1 }} required>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Amount" type="number" value={f.amount} onChange={(e) => set({ amount: e.target.value })} required slotProps={{ htmlInput: { min: 1, step: '0.01', max: chosen?.perTransactionLimit } }} />
        <TextField select label="Pay by" value={f.method} onChange={(e) => set({ method: e.target.value as PettyMethod })} sx={{ minWidth: 180 }}>
          {PETTY_METHODS.filter((m) => m.value === 'CASH' || chosen?.mpesaEnabled).map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
        </TextField>
        {f.method === 'MPESA_B2C' && <TextField label="Phone" value={f.payeePhone} onChange={(e) => set({ payeePhone: e.target.value })} required />}
        {(f.method === 'MPESA_PAYBILL' || f.method === 'MPESA_TILL') && <TextField label={f.method === 'MPESA_TILL' ? 'Till' : 'PayBill'} value={f.payeeShortcode} onChange={(e) => set({ payeeShortcode: e.target.value })} required />}
        {f.method === 'MPESA_PAYBILL' && <TextField label="Account" value={f.payeeAccountRef} onChange={(e) => set({ payeeAccountRef: e.target.value })} required />}
      </Stack>
      {duplicate && (
        <>
          <Alert severity="warning">The same payee was paid this amount recently ({duplicate}). Explain why this is not a duplicate to continue.</Alert>
          <TextField label="Why this is not a duplicate" value={f.duplicateJustification} onChange={(e) => set({ duplicateJustification: e.target.value })} required slotProps={{ htmlInput: { minLength: 5 } }} />
        </>
      )}
    </FormDialog>
  );
}

// ------------------------------------------------------------------ lists

export function PettyCashPage() {
  const { can, canAny } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [scope, setScope] = useState<'mine' | 'custodian' | 'all' | 'review'>('mine');
  const [open, setOpen] = useState(false);
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<PettyRequest>('/petty-cash/requests', { ...pagination, ...(scope === 'review' ? { scope: 'all', review: true } : { scope }) });
  const columns: GridColDef<PettyRequest>[] = [
    { field: 'number', headerName: 'Voucher', width: 150 },
    { field: 'kind', headerName: 'Type', width: 100, valueFormatter: (v: string) => humanise(v) },
    { field: 'payeeName', headerName: 'Payee', width: 180 },
    { field: 'purpose', headerName: 'Purpose', flex: 1, minWidth: 200 },
    { field: 'amount', headerName: 'Amount', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
    { field: 'method', headerName: 'Pay by', width: 130, valueFormatter: (v: string) => PETTY_METHODS.find((m) => m.value === v)?.label ?? v },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Petty cash" onNew={can(P.PETTY_CASH_REQUEST) ? () => setOpen(true) : undefined} newLabel="New request" />
      <Tabs value={scope} onChange={(_, v) => setScope(v)} sx={{ mb: 2 }}>
        <Tab value="mine" label="Mine" />
        {can(P.PETTY_CASH_DISBURSE) && <Tab value="custodian" label="To pay (my floats)" />}
        {can(P.PETTY_CASH_MANAGE) && <Tab value="all" label="All" />}
        {canAny(P.PETTY_CASH_MANAGE, P.PAYMENTS_RECONCILE) && <Tab value="review" label="M-PESA review" />}
      </Tabs>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/petty-cash/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
      {open && <PettyRequestDialog onClose={() => setOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ request detail

function DisburseDialog({ r, onClose }: { r: PettyRequest; onClose(): void }) {
  const cash = r.method === 'CASH';
  const [receivedByName, setReceivedByName] = useState(r.payeeName);
  const [reference, setReference] = useState('');
  const pay = useApiMutation<void>(() => [`/petty-cash/requests/${r.id}/disburse`, { method: 'POST', body: cash ? { receivedByName, reference: reference || undefined } : {} }], {
    invalidate: ['/petty-cash'],
    success: cash ? 'Paid out' : 'Sent to M-PESA',
  });
  return (
    <FormDialog open title={cash ? 'Pay out cash' : 'Send via M-PESA'} submitLabel={cash ? 'Paid' : 'Send now'} onClose={onClose} submitting={pay.isPending} onSubmit={(e) => { e.preventDefault(); pay.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography>{formatMoney(r.amount, 'KES')} to {r.payeeName}{r.payeePhone ? ` (${r.payeePhone})` : r.payeeShortcode ? ` (${r.payeeShortcode}${r.payeeAccountRef ? ` / ${r.payeeAccountRef}` : ''})` : ''}</Typography>
      {cash ? (
        <Stack direction="row" spacing={2}>
          <TextField label="Collected by (as signed)" value={receivedByName} onChange={(e) => setReceivedByName(e.target.value)} required />
          <TextField label="Receipt / voucher ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Stack>
      ) : (
        <Alert severity="warning">This sends money now, once. If the result is late the system asks M-PESA before anything else.</Alert>
      )}
    </FormDialog>
  );
}

function RetirementDialog({ r, onClose }: { r: PettyRequest; onClose(): void }) {
  const [lines, setLines] = useState([{ description: '', amount: '', receiptRef: '' }]);
  const [notes, setNotes] = useState('');
  const spent = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const retire = useApiMutation<void>(() => [`/petty-cash/requests/${r.id}/retirement`, { method: 'POST', body: { lines: lines.filter((l) => l.description).map((l) => ({ description: l.description, amount: Number(l.amount), receiptRef: l.receiptRef || undefined })), notes: notes || undefined } }], {
    invalidate: ['/petty-cash'],
    success: 'Retirement sent to the custodian',
  });
  const balance = Math.round((r.amount - spent) * 100) / 100;
  return (
    <FormDialog open maxWidth="md" title="Retire the advance" submitLabel="Submit receipts" onClose={onClose} submitting={retire.isPending} onSubmit={(e) => { e.preventDefault(); retire.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2" color="text.secondary">List what you spent (attach the receipts on the request). Hand any balance back to the custodian.</Typography>
      {lines.map((l, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <TextField size="small" label="What" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} sx={{ flex: 1 }} />
          <TextField size="small" label="Amount" type="number" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} sx={{ width: 130 }} slotProps={{ htmlInput: { 'aria-label': `Amount ${i + 1}` } }} />
          <TextField size="small" label="Receipt no." value={l.receiptRef} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, receiptRef: e.target.value } : x)))} sx={{ width: 140 }} />
          <IconButton aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}><DeleteIcon /></IconButton>
        </Stack>
      ))}
      <Box><Button startIcon={<AddIcon />} onClick={() => setLines([...lines, { description: '', amount: '', receiptRef: '' }])}>Add receipt</Button></Box>
      <Typography>
        Spent {formatMoney(spent, 'KES')} of {formatMoney(r.amount, 'KES')}: {balance >= 0 ? <b>hand back {formatMoney(balance, 'KES')}</b> : <b>{formatMoney(-balance, 'KES')} more than the advance</b>}
      </Typography>
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
    </FormDialog>
  );
}

function ResolveDialog({ r, onClose }: { r: PettyRequest; onClose(): void }) {
  const [outcome, setOutcome] = useState<'PAID' | 'FAILED'>('PAID');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const resolve = useApiMutation<void>(() => [`/petty-cash/requests/${r.id}/resolve`, { method: 'POST', body: { outcome, reference: reference || undefined, note } }], { invalidate: ['/petty-cash'], success: 'Resolved' });
  return (
    <FormDialog open title="Resolve from the M-PESA statement" onClose={onClose} submitting={resolve.isPending} onSubmit={(e) => { e.preventDefault(); resolve.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as 'PAID' | 'FAILED')}>
        <MenuItem value="PAID">Paid (on the statement)</MenuItem>
        <MenuItem value="FAILED">Not paid</MenuItem>
      </TextField>
      {outcome === 'PAID' && <TextField label="M-PESA receipt" value={reference} onChange={(e) => setReference(e.target.value)} required />}
      <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} required slotProps={{ htmlInput: { minLength: 5 } }} />
    </FormDialog>
  );
}

export function PettyRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, canAny, user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [dialog, setDialog] = useState<'disburse' | 'retire' | 'resolve' | null>(null);
  const [comment, setComment] = useState('');
  const { data: r } = useQuery({ queryKey: ['/petty-cash/requests', id], queryFn: () => api<PettyRequest>(`/petty-cash/requests/${id}`), refetchInterval: (q) => (q.state.data?.status === 'PROCESSING' ? 5000 : false) });
  const act = (path: string, body?: object, success?: string) => useApiMutation<void>(() => [`/petty-cash/requests/${id}/${path}`, { method: 'POST', body }], { invalidate: ['/petty-cash', '/approvals'], success });
  const submit = act('submit', undefined, 'Submitted for approval');
  const ack = act('acknowledge', undefined, 'Receipt confirmed');
  const accept = act('retirement/verify', { accept: true, comment: comment || undefined }, 'Advance retired');
  const reject = act('retirement/verify', { accept: false, comment: comment || 'Please correct the receipts' }, 'Returned to the holder');
  const cancel = act('cancel', { reason: 'Cancelled by the requester' }, 'Cancelled');
  if (!r) return null;
  const s = r.status;
  const mine = r.requestedBy === user?.id;
  const custodian = r.float?.custodianId === user?.id;
  const payee = (r.payeeUserId ?? r.requestedBy) === user?.id;
  const mpesa = r.method !== 'CASH';
  const canPay = custodian && !mine && can(P.PETTY_CASH_DISBURSE) && (s === 'APPROVED' || (mpesa && s === 'FAILED'));
  return (
    <>
      <PageHeader
        title={`Petty cash ${r.kind === 'ADVANCE' ? 'advance' : 'voucher'} ${r.number}`}
        actions={<Button startIcon={<PictureAsPdfIcon />} href={`${API_BASE}/petty-cash/requests/${r.id}/pdf`} target="_blank" rel="noopener">PDF</Button>}
      />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={s} />
                {r.overdue && <Chip size="small" color="error" label={`Retirement overdue (due ${date(r.retirementDueOn)})`} />}
                {['DISBURSED', 'RETIREMENT_SUBMITTED', 'RETIRED'].includes(s) && <SyncChip id={r.id} />}
                <Typography>{r.payeeName} · {money(r.amount)} · {PETTY_METHODS.find((m) => m.value === r.method)?.label}</Typography>
              </Stack>
              {r.lastComment && <Alert severity="info" sx={{ mb: 2 }}>{r.lastComment}</Alert>}
              {r.duplicate && <Alert severity="warning" sx={{ mb: 2 }}>Possible duplicate of <Link component={RouterLink} to={`/petty-cash/${r.duplicate.id}`}>{r.duplicate.number}</Link>: {r.duplicateJustification}</Alert>}
              <Typography sx={{ mb: 2 }}>{r.purpose}</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} flexWrap="wrap" useFlexGap>
                <Field label="Float">{r.float?.name}</Field>
                <Field label="Requested by">{r.requestedByName}</Field>
                <Field label="Cost centre">{r.department?.name}</Field>
                <Field label="Account">{r.glAccount ? `${r.glAccount.code} ${r.glAccount.name}` : '—'}</Field>
                {r.disbursedOn && <Field label="Paid">{date(r.disbursedOn)} · {r.reference} · by {r.disbursedByName}</Field>}
                {r.receivedByName && <Field label="Collected by">{r.receivedByName}</Field>}
                {r.acknowledgedAt && <Field label="Receipt confirmed">{date(r.acknowledgedAt)}</Field>}
                {r.retirementDueOn && <Field label="Retire by">{date(r.retirementDueOn)}</Field>}
              </Stack>
            </Paper>
            {(r.retirementLines ?? []).length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Retirement</Typography>
                <Table size="small" aria-label="Retirement receipts">
                  <TableHead><TableRow><TableCell>Receipt</TableCell><TableCell>What</TableCell><TableCell align="right">Amount</TableCell></TableRow></TableHead>
                  <TableBody>{r.retirementLines!.map((l) => <TableRow key={l.id}><TableCell>{l.receiptRef ?? '—'}</TableCell><TableCell>{l.description}</TableCell><TableCell align="right">{money(l.amount)}</TableCell></TableRow>)}</TableBody>
                </Table>
                <Typography sx={{ mt: 1 }}>Spent {money(r.spentAmount)} · {(r.refundAmount ?? 0) >= 0 ? `to hand back ${money(r.refundAmount)}` : `overspent ${money(-(r.refundAmount ?? 0))}`}{r.retiredByName ? ` · checked by ${r.retiredByName}` : ''}</Typography>
              </Paper>
            )}
            {(r.attempts ?? []).length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>M-PESA</Typography>
                {r.attempts!.map((a) => <Typography key={a.id} variant="body2">#{a.attempt} <StatusChip status={a.status} /> {a.receiptNo ?? ''} {a.recipientName ?? ''} {a.resultDesc ?? ''}</Typography>)}
              </Paper>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {mine && ['DRAFT', 'RETURNED'].includes(s) && <Button variant="contained" onClick={() => submit.mutate()}>Submit for approval</Button>}
              {canPay && <Button variant="contained" onClick={() => setDialog('disburse')}>{mpesa ? 'Send via M-PESA' : 'Pay out cash'}</Button>}
              {payee && ['DISBURSED', 'RETIREMENT_SUBMITTED', 'RETIRED'].includes(s) && !r.acknowledgedAt && <Button variant="outlined" onClick={() => ack.mutate()}>I received it</Button>}
              {mine && r.kind === 'ADVANCE' && s === 'DISBURSED' && <Button variant="contained" onClick={() => setDialog('retire')}>Retire with receipts</Button>}
              {canAny(P.PETTY_CASH_MANAGE, P.PAYMENTS_RECONCILE) && ['REVIEW', 'FAILED'].includes(s) && <Button onClick={() => setDialog('resolve')}>Resolve</Button>}
              {mine && ['DRAFT', 'RETURNED', 'PENDING_APPROVAL', 'APPROVED'].includes(s) && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
            </Stack>
            {custodian && !mine && s === 'RETIREMENT_SUBMITTED' && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Check the retirement</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField size="small" label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ flex: 1 }} />
                  <Button variant="contained" onClick={() => accept.mutate()}>{(r.refundAmount ?? 0) > 0 ? `Accept · ${money(r.refundAmount)} received back` : 'Accept'}</Button>
                  <Button color="warning" onClick={() => reject.mutate()}>Return</Button>
                </Stack>
              </Paper>
            )}
          </>
        }
        side={
          <>
            <ApprovalPanel type="PCV" id={r.id} />
            <DocumentChain type="PCV" id={r.id} />
          </>
        }
      />
      {dialog === 'disburse' && <DisburseDialog r={r} onClose={() => setDialog(null)} />}
      {dialog === 'retire' && <RetirementDialog r={r} onClose={() => setDialog(null)} />}
      {dialog === 'resolve' && <ResolveDialog r={r} onClose={() => setDialog(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ floats

function FloatDialog({ f, onClose }: { f?: PettyFloat; onClose(): void }) {
  const users = useQuery({ queryKey: ['/users/directory'], queryFn: () => api<{ id: string; fullName: string; username: string }[]>('/users/directory') });
  const departments = useAll<Department>('/departments');
  const gl = useAll<GlAccount>('/gl-accounts', { active: true });
  const [v, setV] = useState({
    code: f?.code ?? '',
    name: f?.name ?? '',
    departmentId: f?.departmentId ?? '',
    location: f?.location ?? '',
    custodianId: f?.custodianId ?? '',
    floatLimit: String(f?.floatLimit ?? ''),
    perTransactionLimit: String(f?.perTransactionLimit ?? ''),
    replenishThreshold: String(f?.replenishThreshold ?? ''),
    glAccountId: f?.glAccountId ?? '',
    mpesaEnabled: f?.mpesaEnabled ?? false,
    openingBalance: '',
  });
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });
  const save = useApiMutation<void>(
    () => [
      f ? `/petty-cash/floats/${f.id}` : '/petty-cash/floats',
      {
        method: f ? 'PUT' : 'POST',
        body: {
          code: v.code,
          name: v.name,
          departmentId: v.departmentId || undefined,
          location: v.location || undefined,
          custodianId: v.custodianId,
          floatLimit: Number(v.floatLimit),
          perTransactionLimit: Number(v.perTransactionLimit),
          replenishThreshold: Number(v.replenishThreshold),
          glAccountId: v.glAccountId || undefined,
          mpesaEnabled: v.mpesaEnabled,
          ...(f ? {} : { openingBalance: v.openingBalance ? Number(v.openingBalance) : undefined }),
        },
      },
    ],
    { invalidate: ['/petty-cash'], success: 'Float saved' },
  );
  return (
    <FormDialog open maxWidth="md" title={f ? `Float ${f.code}` : 'New petty cash float'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code" value={v.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} required />
        <TextField label="Name" value={v.name} onChange={(e) => set({ name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <Stack direction="row" spacing={2}>
        <TextField select label="Department / branch" value={v.departmentId} onChange={(e) => set({ departmentId: e.target.value })} sx={{ flex: 1 }}>
          <MenuItem value="">—</MenuItem>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <TextField label="Location" value={v.location} onChange={(e) => set({ location: e.target.value })} sx={{ flex: 1 }} />
      </Stack>
      <TextField select label="Custodian" value={v.custodianId} onChange={(e) => set({ custodianId: e.target.value })} required>
        {(users.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.fullName} ({u.username})</MenuItem>)}
      </TextField>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Float limit" type="number" value={v.floatLimit} onChange={(e) => set({ floatLimit: e.target.value })} required />
        <TextField label="Per-transaction limit" type="number" value={v.perTransactionLimit} onChange={(e) => set({ perTransactionLimit: e.target.value })} required />
        <TextField label="Replenish below" type="number" value={v.replenishThreshold} onChange={(e) => set({ replenishThreshold: e.target.value })} required />
      </Stack>
      <Stack direction="row" spacing={2} alignItems="center">
        <TextField select label="Cash account" value={v.glAccountId} onChange={(e) => set({ glAccountId: e.target.value })} sx={{ flex: 1 }}>
          <MenuItem value="">—</MenuItem>
          {(gl.data ?? []).filter((g) => g.type === 'BANK' || g.type === 'ASSET').map((g) => <MenuItem key={g.id} value={g.id}>{g.code} {g.name}</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch checked={v.mpesaEnabled} onChange={(e) => set({ mpesaEnabled: e.target.checked })} />} label="Pays by M-PESA" />
      </Stack>
      {!f && <TextField label="Opening cash" type="number" value={v.openingBalance} onChange={(e) => set({ openingBalance: e.target.value })} helperText="Cash handed to the custodian now (cash book opening)" />}
    </FormDialog>
  );
}

function CountDialog({ f, onClose }: { f: PettyFloat; onClose(): void }) {
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const save = useApiMutation<void, { variance: number }>(() => [`/petty-cash/floats/${f.id}/counts`, { method: 'POST', body: { counted: Number(counted), notes: notes || undefined } }], { invalidate: ['/petty-cash'], success: 'Count recorded' });
  const variance = counted === '' ? null : Math.round((Number(counted) - f.balance) * 100) / 100;
  return (
    <FormDialog open title={`Count ${f.name}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography>The cash book says {formatMoney(f.balance, 'KES')}.</Typography>
      <TextField label="Cash counted" type="number" value={counted} onChange={(e) => setCounted(e.target.value)} required />
      {variance !== null && variance !== 0 && <Alert severity="warning">Variance {variance > 0 ? '+' : ''}{formatMoney(variance, 'KES')}: the petty cash managers will be told.</Alert>}
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
    </FormDialog>
  );
}

export function FloatsPage() {
  const { can, user } = useAuth();
  const money = useMoney();
  const navigate = useNavigate();
  const { data } = useList<PettyFloat>('/petty-cash/floats');
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'count'; f?: PettyFloat } | null>(null);
  const replenish = useApiMutation<string, Replenishment>((floatId) => ['/petty-cash/replenishments', { method: 'POST', body: { floatId } }], { invalidate: ['/petty-cash'], success: 'Replenishment sent for approval' });
  return (
    <>
      <PageHeader title="Petty cash floats" onNew={can(P.PETTY_CASH_MANAGE) ? () => setDialog({ kind: 'edit' }) : undefined} newLabel="New float" />
      <Paper sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="Floats">
          <TableHead><TableRow><TableCell>Float</TableCell><TableCell>Custodian</TableCell><TableCell align="right">Balance</TableCell><TableCell align="right">Available</TableCell><TableCell align="right">Limit</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {(data ?? []).map((f) => {
              const mine = f.custodianId === user?.id;
              return (
                <TableRow key={f.id} hover>
                  <TableCell>
                    <Link component={RouterLink} to={`/petty-cash/floats/${f.id}`}>{f.code}</Link> {f.name}
                    {f.belowThreshold && <Chip size="small" color="warning" label="Low" sx={{ ml: 1 }} />}
                    {!f.isActive && <Chip size="small" label="Inactive" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>{f.custodianName}</TableCell>
                  <TableCell align="right">{money(f.balance)}</TableCell>
                  <TableCell align="right">{money(f.available)}</TableCell>
                  <TableCell align="right">{money(f.floatLimit)}</TableCell>
                  <TableCell align="right">
                    {(mine || can(P.PETTY_CASH_MANAGE)) && <Button size="small" onClick={() => setDialog({ kind: 'count', f })}>Count</Button>}
                    {(mine || can(P.PETTY_CASH_MANAGE)) && f.balance < f.floatLimit && <Button size="small" onClick={() => replenish.mutate(f.id, { onSuccess: (rp) => navigate(`/petty-cash/replenishments/${rp.id}`) })}>Replenish</Button>}
                    {can(P.PETTY_CASH_MANAGE) && <Button size="small" onClick={() => setDialog({ kind: 'edit', f })}>Edit</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Paper>
      {dialog?.kind === 'edit' && <FloatDialog f={dialog.f} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'count' && dialog.f && <CountDialog f={dialog.f} onClose={() => setDialog(null)} />}
    </>
  );
}

/** Cash book of a float: opening + movements = closing, with counts and replenishments. */
export function FloatStatementPage() {
  const { id } = useParams<{ id: string }>();
  const money = useMoney();
  const date = useDate();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data: s } = useQuery({ queryKey: ['/petty-cash/floats', id, 'statement', range], queryFn: () => api<FloatStatement>(`/petty-cash/floats/${id}/statement`, { query: range }) });
  const reps = useList<Replenishment>('/petty-cash/replenishments', { floatId: id! });
  if (!s) return null;
  const link = (t: FloatStatement['transactions'][number]) => (t.refType === 'PCV' ? `/petty-cash/${t.refId}` : t.refType === 'PCRP' ? `/petty-cash/replenishments/${t.refId}` : null);
  return (
    <>
      <PageHeader title={`Cash book · ${s.float.name}`} />
      <Stack spacing={2}>
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <TextField label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          <Stack direction="row" spacing={3} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap aria-label="Summary">
            <Field label="Opening">{money(s.opening)}</Field>
            <Field label="Replenishments">{money(s.totals.REPLENISHMENT + s.totals.OPENING)}</Field>
            <Field label="Refunds">{money(s.totals.REFUND)}</Field>
            <Field label="Disbursements">{money(-(s.totals.DISBURSEMENT + s.totals.TOP_UP))}</Field>
            {!!s.totals.REVERSAL && <Field label="Reversals">{money(s.totals.REVERSAL)}</Field>}
            <Field label="Closing">{money(s.closing)}</Field>
          </Stack>
        </Paper>
        <Paper sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Cash book">
            <TableHead><TableRow><TableCell>Date</TableCell><TableCell>Type</TableCell><TableCell>Document</TableCell><TableCell>Details</TableCell><TableCell align="right">In</TableCell><TableCell align="right">Out</TableCell><TableCell align="right">Balance</TableCell></TableRow></TableHead>
            <TableBody>
              {s.transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{date(t.txnDate)}</TableCell>
                  <TableCell>{humanise(t.type)}</TableCell>
                  <TableCell>{link(t) ? <Link component={RouterLink} to={link(t)!}>{t.refNo}</Link> : (t.refNo ?? '—')}</TableCell>
                  <TableCell>{t.note}</TableCell>
                  <TableCell align="right">{t.amount > 0 ? money(t.amount) : ''}</TableCell>
                  <TableCell align="right">{t.amount < 0 ? money(-t.amount) : ''}</TableCell>
                  <TableCell align="right">{money(t.balanceAfter)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
        {s.counts.length > 0 && (
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>Cash counts</Typography>
            {s.counts.map((c) => (
              <Typography key={c.id} variant="body2" color={c.variance ? 'warning.main' : undefined}>
                {date(c.countedAt)} · {c.countedBy}: counted {money(c.counted)} vs {money(c.expected)} — variance {money(c.variance)}{c.notes ? ` (${c.notes})` : ''}
              </Typography>
            ))}
          </Paper>
        )}
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Replenishments</Typography>
          {(reps.data ?? []).map((rp) => (
            <Typography key={rp.id} variant="body2">
              <Link component={RouterLink} to={`/petty-cash/replenishments/${rp.id}`}>{rp.number}</Link> · {date(rp.createdAt)} · {money(rp.amount)} · <StatusChip status={rp.status} />
            </Typography>
          ))}
        </Paper>
      </Stack>
    </>
  );
}

export function ReplenishmentPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [reference, setReference] = useState('');
  const { data: rp } = useQuery({ queryKey: ['/petty-cash/replenishments', id], queryFn: () => api<Replenishment>(`/petty-cash/replenishments/${id}`) });
  const receive = useApiMutation<void>(() => [`/petty-cash/replenishments/${id}/receive`, { method: 'POST', body: { reference } }], { invalidate: ['/petty-cash'], success: 'Cash received into the float' });
  const cancel = useApiMutation<void>(() => [`/petty-cash/replenishments/${id}/cancel`, { method: 'POST' }], { invalidate: ['/petty-cash', '/approvals'], success: 'Cancelled' });
  if (!rp) return null;
  const custodian = rp.float?.custodianId === user?.id;
  return (
    <>
      <PageHeader title={`Replenishment ${rp.number}`} />
      <DetailLayout
        main={
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <StatusChip status={rp.status} />
              <Typography>
                <Link component={RouterLink} to={`/petty-cash/floats/${rp.floatId}`}>{rp.float?.name}</Link>
              </Typography>
            </Stack>
            {rp.lastComment && <Alert severity="info" sx={{ mb: 2 }}>{rp.lastComment}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
              <Field label="Amount">{money(rp.amount)}</Field>
              <Field label="Balance when requested">{money(rp.balanceAtRequest)}</Field>
              <Field label="Requested">{date(rp.createdAt)}</Field>
              {rp.receivedAt && <Field label="Received">{date(rp.receivedAt)} · {rp.reference}</Field>}
            </Stack>
            {rp.reason && <Typography variant="body2" sx={{ mt: 2 }}>{rp.reason}</Typography>}
            {custodian && rp.status === 'APPROVED' && (
              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                <TextField size="small" label="Cheque / transfer ref" value={reference} onChange={(e) => setReference(e.target.value)} />
                <Button variant="contained" disabled={reference.length < 2 || receive.isPending} onClick={() => receive.mutate()}>Cash received</Button>
              </Stack>
            )}
            {['PENDING_APPROVAL', 'APPROVED', 'RETURNED'].includes(rp.status) && (
              <Box sx={{ mt: 2 }}><Button color="error" onClick={() => cancel.mutate()}>Cancel</Button></Box>
            )}
          </Paper>
        }
        side={
          <>
            <ApprovalPanel type="PCRP" id={rp.id} />
            <DocumentChain type="PCRP" id={rp.id} />
          </>
        }
      />
    </>
  );
}

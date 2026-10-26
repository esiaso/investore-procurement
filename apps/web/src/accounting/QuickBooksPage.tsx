import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { AccountingBatch, AccountingConnection, AccountMappingKind, BatchDetail, MappingsResponse, OutstandingInvoice, Posting, QboLists, Reconciliation, SettlementRow } from '../api/accounting-types';
import type { Payer } from '../api/pharmacy-types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { useDate, useMoney } from '../purchasing/common';

const P = Permissions;
const POSTING_COLOURS: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = { READY: 'info', BLOCKED: 'warning', PENDING: 'warning', POSTED: 'success', FAILED: 'error' };
export function PostingChip({ status }: { status: string }) {
  return <Chip size="small" color={POSTING_COLOURS[status] ?? 'default'} label={humanise(status)} />;
}

const MAPPING_KINDS: { kind: AccountMappingKind; label: string; list: keyof QboLists; help: string }[] = [
  { kind: 'SYSTEM', label: 'Control accounts', list: 'accounts', help: 'Payables, receivables, GRNI clearing, VAT, stock in transit, write-offs, adjustments, opening balances, default bank' },
  { kind: 'CATEGORY_INVENTORY', label: 'Inventory', list: 'accounts', help: 'Stock asset account per item category (a sub-category uses its parent’s when not mapped)' },
  { kind: 'CATEGORY_COGS', label: 'Cost of sales', list: 'accounts', help: 'Cost of goods dispensed / sold, per category' },
  { kind: 'CATEGORY_INCOME', label: 'Sales income', list: 'accounts', help: 'Income account per category (QuickBooks products are created per category)' },
  { kind: 'CATEGORY_CONSUMPTION', label: 'Consumption', list: 'accounts', help: 'Expense for stock issued to departments, per category' },
  { kind: 'PAYMENT_ACCOUNT', label: 'Payment modes', list: 'accounts', help: 'Bank / clearing account per payment mode (sales) and per supplier payment method' },
  { kind: 'TAX_CODE', label: 'Tax codes', list: 'taxCodes', help: 'QuickBooks tax code per tax category' },
  { kind: 'STORE_CLASS', label: 'Store classes', list: 'classes', help: 'QuickBooks class per store / outlet (optional)' },
  { kind: 'DEPARTMENT_CLASS', label: 'Department classes', list: 'classes', help: 'QuickBooks class per department for consumption (optional)' },
];
const OPTIONAL_KINDS: AccountMappingKind[] = ['STORE_CLASS', 'DEPARTMENT_CLASS'];

/** QuickBooks Online: connection, mappings, batch posting with preview, errors, settlements, reconciliation. */
export function QuickBooksPage() {
  const [tab, setTab] = useState(0);
  const [params, setParams] = useSearchParams();
  const connected = params.get('connected');
  const error = params.get('error');
  return (
    <>
      <PageHeader title="QuickBooks" />
      {connected && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setParams({})}>QuickBooks is connected.</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setParams({})}>{error}</Alert>}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="Post" />
        <Tab label="Postings & errors" />
        <Tab label="Mappings" />
        <Tab label="Settlements" />
        <Tab label="Reconciliation" />
        <Tab label="Connection" />
      </Tabs>
      {tab === 0 && <BatchesTab />}
      {tab === 1 && <PostingsTab />}
      {tab === 2 && <MappingsTab />}
      {tab === 3 && <SettlementsTab />}
      {tab === 4 && <ReconciliationTab />}
      {tab === 5 && <ConnectionTab />}
    </>
  );
}

function useConnection() {
  return useQuery({ queryKey: ['/accounting/connection'], queryFn: () => api<AccountingConnection | null>('/accounting/connection') });
}

function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - 1, 1)).toISOString().slice(0, 10);
}
function monthEnd() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ batches

function BatchesTab() {
  const { can } = useAuth();
  const conn = useConnection();
  const date = useDate();
  const [f, setF] = useState({ from: monthStart(), to: monthEnd(), PURCHASES: true, SALES: true, INVENTORY: true });
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['/accounting/batches'], queryFn: () => api<AccountingBatch[]>('/accounting/batches') });
  const preview = useApiMutation<void, BatchDetail>(
    () => ['/accounting/batches', { method: 'POST', body: { from: f.from, to: f.to, kinds: (['PURCHASES', 'SALES', 'INVENTORY'] as const).filter((k) => f[k]) } }],
    { invalidate: ['/accounting'] },
  );
  const c = conn.data;
  return (
    <Stack spacing={2}>
      {c && !c.connected && <Alert severity="warning">QuickBooks is not connected — documents can be previewed but not posted. See Connection.</Alert>}
      {c?.closingDate && <Alert severity="info">The books are closed up to {date(c.closingDate)}: earlier documents are blocked.</Alert>}
      {can(P.ACCOUNTING_POST) && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Preview a batch</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
            <TextField type="date" label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} InputLabelProps={{ shrink: true }} />
            <TextField type="date" label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} InputLabelProps={{ shrink: true }} />
            {(['PURCHASES', 'SALES', 'INVENTORY'] as const).map((k) => (
              <FormControlLabel key={k} control={<Checkbox checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />} label={k === 'INVENTORY' ? 'Inventory journals' : humanise(k)} />
            ))}
            <Button variant="contained" disabled={preview.isPending || !f.from || !f.to} onClick={() => preview.mutate(undefined, { onSuccess: (b) => setOpen(b.id) })}>
              Preview
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Bills, bill payments and supplier credits; sales receipts / invoices, payments, refunds and settlements; inventory journals for whole periods already ended. Documents already in QuickBooks are left out.
          </Typography>
        </Paper>
      )}
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Batch</TableCell><TableCell>Period</TableCell><TableCell>Kinds</TableCell><TableCell>Status</TableCell><TableCell>Posted</TableCell></TableRow></TableHead>
          <TableBody>
            {(list.data ?? []).map((b) => (
              <TableRow key={b.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(b.id)}>
                <TableCell>{b.number}</TableCell>
                <TableCell>{date(b.fromDate)} – {date(b.toDate)}</TableCell>
                <TableCell>{humanise(b.kinds)}</TableCell>
                <TableCell><Chip size="small" label={humanise(b.status)} color={b.status === 'POSTED' ? 'success' : 'default'} /></TableCell>
                <TableCell>{b.postedAt ? date(b.postedAt) : '—'}</TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={5}>No batches yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      {open && <BatchDialog id={open} onClose={() => setOpen(null)} canPost={can(P.ACCOUNTING_POST) && !!c?.connected} />}
    </Stack>
  );
}

function BatchDialog({ id, onClose, canPost }: { id: string; onClose(): void; canPost: boolean }) {
  const money = useMoney();
  const date = useDate();
  const [detail, setDetail] = useState<Posting | null>(null);
  const b = useQuery({ queryKey: ['/accounting/batches', id], queryFn: () => api<BatchDetail>(`/accounting/batches/${id}`) });
  const post = useApiMutation<void, BatchDetail>(() => [`/accounting/batches/${id}/post`, { method: 'POST' }], { invalidate: ['/accounting'] });
  const d = post.data ?? b.data;
  const ready = d?.items.filter((i) => i.status === 'READY').length ?? 0;
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Batch {d?.number} · {d && `${date(d.fromDate)} – ${date(d.toDate)}`}</DialogTitle>
      <DialogContent dividers>
        {d && (
          <Stack spacing={2}>
            {post.data?.totals && (
              <Alert severity={post.data.totals.failed ? 'error' : post.data.totals.retry ? 'warning' : 'success'}>
                Posted {post.data.totals.posted}; {post.data.totals.retry} waiting to retry; {post.data.totals.failed} failed.
              </Alert>
            )}
            <Table size="small">
              <TableHead><TableRow><TableCell>QuickBooks document</TableCell><TableCell align="right">Count</TableCell><TableCell align="right">Amount</TableCell><TableCell align="right">Ready</TableCell><TableCell align="right">Blocked</TableCell><TableCell align="right">Posted</TableCell></TableRow></TableHead>
              <TableBody>
                {d.summary.map((s) => (
                  <TableRow key={s.docType}>
                    <TableCell>{humanise(s.docType)}</TableCell><TableCell align="right">{s.count}</TableCell><TableCell align="right">{money(s.amount)}</TableCell>
                    <TableCell align="right">{s.ready}</TableCell><TableCell align="right">{s.blocked || ''}</TableCell><TableCell align="right">{s.posted || ''}</TableCell>
                  </TableRow>
                ))}
                {d.summary.length === 0 && <TableRow><TableCell colSpan={6}>Nothing to post for this period.</TableCell></TableRow>}
              </TableBody>
            </Table>
            <PostingTable rows={d.items} onOpen={setDetail} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {canPost && <Button variant="contained" disabled={!ready || post.isPending} onClick={() => post.mutate()}>Post {ready} to QuickBooks</Button>}
      </DialogActions>
      {detail && <PostingDialog posting={detail} onClose={() => setDetail(null)} />}
    </Dialog>
  );
}

function PostingTable({ rows, onOpen }: { rows: Posting[]; onOpen(p: Posting): void }) {
  const money = useMoney();
  const date = useDate();
  return (
    <Table size="small">
      <TableHead><TableRow><TableCell>Date</TableCell><TableCell>Document</TableCell><TableCell>QuickBooks</TableCell><TableCell align="right">Amount</TableCell><TableCell>Status</TableCell><TableCell>Detail</TableCell></TableRow></TableHead>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpen(p)}>
            <TableCell>{date(p.txnDate)}</TableCell>
            <TableCell>{p.localDocNo ?? p.localDocId}<Typography variant="caption" display="block" color="text.secondary">{humanise(p.localDocType)}</Typography></TableCell>
            <TableCell>{humanise(p.docType)}{p.externalId && <Typography variant="caption" display="block" color="text.secondary">#{p.externalId}</Typography>}</TableCell>
            <TableCell align="right">{money(p.amount)}</TableCell>
            <TableCell><PostingChip status={p.status} /></TableCell>
            <TableCell sx={{ maxWidth: 360 }}><Typography variant="body2" color={p.error ? 'error' : 'text.secondary'} noWrap title={p.error ?? ''}>{p.error ?? ''}</Typography></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One document: the local double entry, the QuickBooks request, and reprocessing. */
function PostingDialog({ posting, onClose }: { posting: Posting; onClose(): void }) {
  const { can } = useAuth();
  const money = useMoney();
  const lists = useQuery({ queryKey: ['/accounting/lists'], queryFn: () => api<QboLists>('/accounting/lists'), retry: false });
  const name = (id: string) => lists.data?.accounts.find((a) => a.id === id)?.name ?? (id || '(not mapped)');
  const reprocess = useApiMutation<void, Posting>(() => [`/accounting/postings/${posting.id}/reprocess`, { method: 'POST' }], { invalidate: ['/accounting'], success: 'Rebuilt and sent again' });
  const p = reprocess.data ?? posting;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{humanise(p.docType)} · {p.localDocNo ?? p.localDocId} <PostingChip status={p.status} /></DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {p.error && <Alert severity={p.status === 'BLOCKED' ? 'warning' : 'error'}>{p.error}</Alert>}
          {p.externalId && <Alert severity="success">In QuickBooks as #{p.externalId}.</Alert>}
          <Table size="small">
            <TableHead><TableRow><TableCell>Account</TableCell><TableCell align="right">Debit</TableCell><TableCell align="right">Credit</TableCell><TableCell>Class</TableCell></TableRow></TableHead>
            <TableBody>
              {p.entries.map((e, i) => (
                <TableRow key={i}>
                  <TableCell>{name(e.account)}</TableCell>
                  <TableCell align="right">{e.amount > 0 ? money(e.amount) : ''}</TableCell>
                  <TableCell align="right">{e.amount < 0 ? money(-e.amount) : ''}</TableCell>
                  <TableCell>{e.classId ? (lists.data?.classes.find((c) => c.id === e.classId)?.name ?? e.classId) : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(p.payload, null, 2)}</Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {can(P.ACCOUNTING_POST) && ['BLOCKED', 'FAILED', 'PENDING'].includes(p.status) && (
          <Button variant="contained" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>Rebuild and send</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ------------------------------------------------------------------ postings and errors

function PostingsTab() {
  const money = useMoney();
  const date = useDate();
  const [status, setStatus] = useState('FAILED');
  const [search, setSearch] = useState('');
  const [model, setModel] = useState({ page: 0, pageSize: 25 });
  const [open, setOpen] = useState<Posting | null>(null);
  const { data, isFetching } = usePaged<Posting>('/accounting/postings', { ...model, status: status || undefined, search: search || undefined });
  const cols: GridColDef<Posting>[] = [
    { field: 'txnDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'localDocNo', headerName: 'Document', flex: 1, minWidth: 180 },
    { field: 'docType', headerName: 'QuickBooks', width: 140, valueFormatter: (v: string) => humanise(v) },
    { field: 'amount', headerName: 'Amount', width: 120, align: 'right', headerAlign: 'right', valueFormatter: (v: number) => money(v) },
    { field: 'status', headerName: 'Status', width: 110, renderCell: (p) => <PostingChip status={p.value} /> },
    { field: 'attempts', headerName: 'Tries', width: 70 },
    { field: 'error', headerName: 'Error', flex: 2, minWidth: 240 },
  ];
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: 200 }}>
          <MenuItem value="">All</MenuItem>
          {['FAILED', 'PENDING', 'BLOCKED', 'READY', 'POSTED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        <TextField label="Document, QuickBooks id or error" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} />
      </Stack>
      <Paper>
        <DataGrid autoHeight rows={data?.items ?? []} columns={cols} rowCount={data?.total ?? 0} loading={isFetching} paginationMode="server" paginationModel={model} onPaginationModelChange={setModel} pageSizeOptions={[25, 50, 100]} onRowClick={(p) => setOpen(p.row)} disableRowSelectionOnClick />
      </Paper>
      <Typography variant="caption" color="text.secondary">Waiting documents (QuickBooks unreachable, 5xx) are retried with back-off by the accounting.dispatch job; failed ones need a fix (usually a mapping) and Rebuild and send.</Typography>
      {open && <PostingDialog posting={open} onClose={() => setOpen(null)} />}
    </Stack>
  );
}

// ------------------------------------------------------------------ mappings

function MappingsTab() {
  const { can } = useAuth();
  const conn = useConnection();
  const [kind, setKind] = useState<AccountMappingKind>('SYSTEM');
  const m = useQuery({ queryKey: ['/accounting/mappings'], queryFn: () => api<MappingsResponse>('/accounting/mappings') });
  const lists = useQuery({ queryKey: ['/accounting/lists'], queryFn: () => api<QboLists>('/accounting/lists'), enabled: !!conn.data?.connected, retry: false });
  const save = useApiMutation<{ localKey: string; externalId: string; externalName?: string }>((v) => ['/accounting/mappings', { method: 'PUT', body: { kind, ...v } }], { invalidate: ['/accounting/mappings'], success: 'Mapping saved' });
  const del = useApiMutation<string>((id) => [`/accounting/mappings/${id}`, { method: 'DELETE' }], { invalidate: ['/accounting/mappings'] });
  const def = MAPPING_KINDS.find((k) => k.kind === kind)!;
  const options = lists.data?.[def.list] ?? [];
  const editable = can(P.ACCOUNTING_MANAGE) && !!lists.data;
  const rows = useMemo(() => {
    const keys = m.data?.keys[kind] ?? [];
    const mapped = (m.data?.mappings ?? []).filter((x) => x.kind === kind);
    const extra = mapped.filter((x) => !keys.some((k) => k.code === x.localKey)).map((x) => ({ code: x.localKey, name: '(no longer in use)' }));
    return [...keys, ...extra].map((k) => ({ ...k, mapping: mapped.find((x) => x.localKey === k.code) ?? null }));
  }, [m.data, kind]);
  const gaps = (k: AccountMappingKind) => (OPTIONAL_KINDS.includes(k) ? 0 : (m.data?.keys[k] ?? []).filter((x) => !(m.data?.mappings ?? []).some((y) => y.kind === k && y.localKey === x.code)).length);
  return (
    <Stack spacing={2}>
      {!conn.data?.connected && <Alert severity="info">Connect QuickBooks to pick its accounts, classes and tax codes.</Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {MAPPING_KINDS.map((k) => (
          <Chip key={k.kind} label={`${k.label}${gaps(k.kind) ? ` (${gaps(k.kind)} to map)` : ''}`} color={kind === k.kind ? 'primary' : gaps(k.kind) ? 'warning' : 'default'} variant={kind === k.kind ? 'filled' : 'outlined'} onClick={() => setKind(k.kind)} />
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary">{def.help}</Typography>
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Here</TableCell><TableCell>QuickBooks</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell>{r.code}<Typography variant="caption" display="block" color="text.secondary">{r.name}</Typography></TableCell>
                <TableCell sx={{ width: '50%' }}>
                  {editable ? (
                    <TextField
                      select
                      size="small"
                      fullWidth
                      value={r.mapping?.externalId ?? ''}
                      onChange={(e) => save.mutate({ localKey: r.code, externalId: e.target.value, externalName: options.find((o) => o.id === e.target.value)?.name })}
                      SelectProps={{ displayEmpty: true }}
                    >
                      <MenuItem value="" disabled><em>Not mapped</em></MenuItem>
                      {options.map((o) => <MenuItem key={o.id} value={o.id}>{o.name}</MenuItem>)}
                    </TextField>
                  ) : (
                    r.mapping ? `${r.mapping.externalName ?? r.mapping.externalId}` : <Typography variant="body2" color="warning.main">Not mapped</Typography>
                  )}
                </TableCell>
                <TableCell padding="checkbox">
                  {r.mapping && can(P.ACCOUNTING_MANAGE) && (
                    <Tooltip title="Remove mapping"><IconButton size="small" onClick={() => del.mutate(r.mapping!.id)}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}

// ------------------------------------------------------------------ payer settlements

function SettlementsTab() {
  const { can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['/accounting/settlements'], queryFn: () => api<SettlementRow[]>('/accounting/settlements') });
  return (
    <Stack spacing={2}>
      {can(P.ACCOUNTING_POST) && <Box><Button variant="contained" onClick={() => setOpen(true)}>Record a settlement</Button></Box>}
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Number</TableCell><TableCell>Received</TableCell><TableCell>Payer</TableCell><TableCell>Mode</TableCell><TableCell>Reference</TableCell><TableCell align="right">Invoices</TableCell><TableCell align="right">Amount</TableCell></TableRow></TableHead>
          <TableBody>
            {(list.data ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.number}</TableCell><TableCell>{date(s.receivedOn)}</TableCell><TableCell>{s.payer}</TableCell><TableCell>{s.modeCode}</TableCell><TableCell>{s.reference}</TableCell>
                <TableCell align="right">{s.invoices}</TableCell><TableCell align="right">{money(s.amount)}</TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={7}>No settlements recorded.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="caption" color="text.secondary">Money from insurers and corporates against their invoices; posted to QuickBooks as payments applied to those invoices.</Typography>
      {open && <SettlementDialog onClose={() => setOpen(false)} />}
    </Stack>
  );
}

function SettlementDialog({ onClose }: { onClose(): void }) {
  const money = useMoney();
  const date = useDate();
  const payers = useQuery({ queryKey: ['/billing/payers'], queryFn: () => api<Payer[]>('/billing/payers') });
  const [f, setF] = useState({ payerId: '', receivedOn: new Date().toISOString().slice(0, 10), modeCode: 'BANK', reference: '', notes: '' });
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const owed = useQuery({ queryKey: ['/accounting/settlements/outstanding', f.payerId], queryFn: () => api<OutstandingInvoice[]>(`/accounting/settlements/outstanding/${f.payerId}`), enabled: !!f.payerId });
  useEffect(() => setAlloc({}), [f.payerId]);
  const total = Math.round(Object.values(alloc).reduce((s, v) => s + (v || 0), 0) * 100) / 100;
  const save = useApiMutation<void>(
    () => ['/accounting/settlements', { method: 'POST', body: { ...f, notes: f.notes || undefined, amount: total, allocations: Object.entries(alloc).filter(([, v]) => v > 0).map(([invoiceId, amount]) => ({ invoiceId, amount })) } }],
    { invalidate: ['/accounting'], success: 'Settlement recorded' },
  );
  return (
    <FormDialog open title="Payer settlement" maxWidth="md" onClose={onClose} submitting={save.isPending} submitLabel={`Record ${money(total)}`} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField select required label="Payer" value={f.payerId} onChange={(e) => setF({ ...f, payerId: e.target.value })}>
          {(payers.data ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
        </TextField>
        <Stack direction="row" spacing={2}>
          <TextField type="date" required label="Received on" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} InputLabelProps={{ shrink: true }} />
          <TextField required label="Mode" value={f.modeCode} onChange={(e) => setF({ ...f, modeCode: e.target.value.toUpperCase() })} helperText="Mapped to a bank account" sx={{ width: 140 }} />
          <TextField required label="Remittance / EFT reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} sx={{ flex: 1 }} />
        </Stack>
        {owed.data && (
          <Table size="small">
            <TableHead><TableRow><TableCell>Invoice</TableCell><TableCell>Date</TableCell><TableCell>Patient</TableCell><TableCell align="right">Still owed</TableCell><TableCell align="right" sx={{ width: 160 }}>Paid now</TableCell></TableRow></TableHead>
            <TableBody>
              {owed.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.number}</TableCell><TableCell>{date(i.date)}</TableCell><TableCell>{i.patient ?? ''}</TableCell><TableCell align="right">{money(i.owed)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Checkbox size="small" checked={alloc[i.id] === i.owed} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.checked ? i.owed : 0 })} inputProps={{ 'aria-label': `Pay ${i.number} in full` }} />
                      <TextField size="small" type="number" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: Math.min(Number(e.target.value), i.owed) })} inputProps={{ min: 0, step: '0.01', 'aria-label': `Amount for ${i.number}` }} />
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {owed.data.length === 0 && <TableRow><TableCell colSpan={5}>Nothing owed by this payer.</TableCell></TableRow>}
            </TableBody>
          </Table>
        )}
        <TextField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Stack>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ reconciliation

function ReconciliationTab() {
  const money = useMoney();
  const date = useDate();
  const [period, setPeriod] = useState({ from: monthStart(), to: monthEnd() });
  const [run, setRun] = useState<typeof period | null>(null);
  const r = useQuery({ queryKey: ['/accounting/reconciliation', run], queryFn: () => api<Reconciliation>('/accounting/reconciliation', { query: run! }), enabled: !!run, retry: false });
  const d = r.data;
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <TextField type="date" label="From" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} InputLabelProps={{ shrink: true }} />
        <TextField type="date" label="To" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} InputLabelProps={{ shrink: true }} />
        <Button variant="contained" onClick={() => setRun({ ...period })} disabled={r.isFetching}>Reconcile</Button>
      </Stack>
      {r.error && <Alert severity="error">{(r.error as Error).message}</Alert>}
      {d && (
        <>
          <Alert severity={d.balanced ? 'success' : 'warning'}>
            {d.balanced ? 'What was posted agrees with QuickBooks for every account.' : 'Some accounts differ from QuickBooks (something was entered or changed there).'}
            {d.unposted.count > 0 && ` ${d.unposted.count} document(s) for the period are not yet in QuickBooks (${d.unposted.byType.map((t) => `${t.count} ${humanise(t.docType).toLowerCase()}`).join(', ')}).`}
          </Alert>
          <Paper>
            <Table size="small">
              <TableHead><TableRow><TableCell>Account</TableCell><TableCell align="right">Here (all documents)</TableCell><TableCell align="right">Posted</TableCell><TableCell align="right">QuickBooks movement</TableCell><TableCell align="right">Difference</TableCell><TableCell align="right">Still to post</TableCell></TableRow></TableHead>
              <TableBody>
                {d.accounts.map((a) => (
                  <TableRow key={a.account}>
                    <TableCell>{a.name}</TableCell>
                    <TableCell align="right">{money(a.local)}</TableCell><TableCell align="right">{money(a.posted)}</TableCell><TableCell align="right">{money(a.quickbooks)}</TableCell>
                    <TableCell align="right" sx={{ color: a.difference ? 'error.main' : undefined }}>{a.difference ? money(a.difference) : '—'}</TableCell>
                    <TableCell align="right">{a.toPost ? money(a.toPost) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2">Stock valuation at {date(d.to)}{d.inventory.since ? ` (movements since ${date(d.inventory.since)})` : ''}</Typography>
            <Typography variant="body2">
              Here {money(d.inventory.local)} · QuickBooks inventory accounts {money(d.inventory.quickbooks)} · difference{' '}
              <Box component="span" sx={{ color: Math.abs(d.inventory.difference) >= 0.01 ? 'warning.main' : undefined }}>{money(d.inventory.difference)}</Box>
              {Math.abs(d.inventory.difference) >= 0.01 && ' — post the inventory journals for the open periods.'}
            </Typography>
          </Paper>
        </>
      )}
    </Stack>
  );
}

// ------------------------------------------------------------------ connection

function ConnectionTab() {
  const { can } = useAuth();
  const date = useDate();
  const { data: c, isFetched } = useConnection();
  const [f, setF] = useState({ provider: 'QBO', environment: 'SANDBOX', clientId: '', clientSecret: '', redirectUri: `${window.location.origin}/api/v1/callbacks/quickbooks`, journalsFrom: '', isActive: true });
  useEffect(() => {
    if (c) setF((x) => ({ ...x, provider: c.provider, environment: c.environment, clientId: c.clientId ?? '', clientSecret: '', redirectUri: c.redirectUri ?? x.redirectUri, journalsFrom: c.journalsFrom ?? '', isActive: c.isActive }));
  }, [c]);
  const save = useApiMutation<void>(
    () => ['/accounting/connection', { method: 'PUT', body: { ...f, clientId: f.clientId || undefined, clientSecret: f.clientSecret || undefined, journalsFrom: f.journalsFrom || undefined } }],
    { invalidate: ['/accounting'], success: 'Saved' },
  );
  const authorize = useApiMutation<void, { url: string }>(() => ['/accounting/connection/authorize', { method: 'POST' }], {});
  const disconnect = useApiMutation<void>(() => ['/accounting/connection/disconnect', { method: 'POST' }], { invalidate: ['/accounting'], success: 'Disconnected' });
  const refresh = useApiMutation<void>(() => ['/accounting/connection/refresh', { method: 'POST' }], { invalidate: ['/accounting'], success: 'Read from QuickBooks' });
  if (!isFetched) return null;
  const editable = can(P.ACCOUNTING_MANAGE);
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 680 }}>
        {c?.connected ? (
          <Alert severity="success" action={editable && (
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => refresh.mutate()}>Refresh</Button>
              <Button size="small" color="error" onClick={() => disconnect.mutate()}>Disconnect</Button>
            </Stack>
          )}>
            Connected to {c.companyName ?? 'QuickBooks'} (company {c.realmId}){c.provider === 'MOCK' && ' — mock company, nothing reaches Intuit'} since {date(c.connectedAt)}.
            {c.closingDate && ` Books closed up to ${date(c.closingDate)}.`}
          </Alert>
        ) : (
          <Alert severity="info">Not connected. Save the Intuit app details, then Connect to QuickBooks and approve access to the company.</Alert>
        )}
        {c?.lastError && <Alert severity="warning">Last refresh failed: {c.lastError}</Alert>}
        <TextField select label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} disabled={!editable}>
          <MenuItem value="QBO">QuickBooks Online</MenuItem>
          <MenuItem value="MOCK">Mock company (training / tests)</MenuItem>
        </TextField>
        {f.provider === 'QBO' && (
          <>
            <TextField select label="Environment" value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })} disabled={!editable}>
              <MenuItem value="SANDBOX">Sandbox</MenuItem><MenuItem value="PRODUCTION">Production</MenuItem>
            </TextField>
            <TextField label="Client ID" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} disabled={!editable} />
            <TextField label={c?.hasClientSecret ? 'Client secret (stored — leave empty to keep)' : 'Client secret'} type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} disabled={!editable} />
            <TextField label="Redirect URI" value={f.redirectUri} onChange={(e) => setF({ ...f, redirectUri: e.target.value })} disabled={!editable} helperText="Register exactly this URI in the Intuit developer app (Keys & credentials)" />
          </>
        )}
        <TextField type="date" label="Inventory journals from (go-live)" value={f.journalsFrom} onChange={(e) => setF({ ...f, journalsFrom: e.target.value })} InputLabelProps={{ shrink: true }} disabled={!editable} helperText="Documents and stock movements before this date are not posted" />
        <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} disabled={!editable} />} label="Active" />
        {editable && (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
            <Button variant="contained" disabled={!c || authorize.isPending} onClick={() => authorize.mutate(undefined, { onSuccess: (r) => window.location.assign(r.url) })}>
              {c?.connected ? 'Reconnect' : 'Connect to QuickBooks'}
            </Button>
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary">
          The token is refreshed hourly (accounting.refresh job), which also reads the books closing date. Waiting documents are retried every 5 minutes (accounting.dispatch).
        </Typography>
      </Stack>
    </Paper>
  );
}

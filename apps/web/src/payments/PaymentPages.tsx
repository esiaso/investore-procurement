import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { Alert, Box, Button, Chip, Link, MenuItem, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { API_BASE, api } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import { isMpesa, PAYMENT_METHODS, type Payable, type PaymentMethodCode, type PaymentVoucher, type Reconciliation } from '../api/payment-types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { formatMoney, humanise } from '../lib/format';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate } from '../purchasing/common';

const P = Permissions;
const methodLabel = (m: string) => PAYMENT_METHODS.find((x) => x.value === m)?.label ?? humanise(m);
const today = () => new Date().toISOString().slice(0, 10);

/** Prepares one voucher for the selected invoices of one supplier. */
export function VoucherDialog({ invoices, onClose }: { invoices: Payable[]; onClose(): void }) {
  const navigate = useNavigate();
  const [method, setMethod] = useState<PaymentMethodCode>('EFT');
  const [amounts, setAmounts] = useState<Record<string, string>>(Object.fromEntries(invoices.map((i) => [i.id, String(i.available)])));
  const [payee, setPayee] = useState({ payeePhone: '', payeeShortcode: '', payeeAccountRef: '' });
  const [dueDate, setDueDate] = useState('');
  const [narrative, setNarrative] = useState('');
  const currency = invoices[0]?.currency ?? 'KES';
  const gross = invoices.reduce((s, i) => s + Number(amounts[i.id] || 0), 0);
  const wht = invoices.reduce((s, i) => s + (i.total > 0 ? (i.whtTotal * Number(amounts[i.id] || 0)) / i.total : 0), 0);
  const save = useApiMutation<void, PaymentVoucher>(
    () => [
      '/payment-vouchers',
      {
        method: 'POST',
        body: {
          supplierId: invoices[0].supplierId,
          method,
          invoices: invoices.map((i) => ({ invoiceId: i.id, amount: Number(amounts[i.id]) })),
          ...(method === 'MPESA_B2C' ? { payeePhone: payee.payeePhone } : {}),
          ...(method === 'MPESA_PAYBILL' || method === 'MPESA_TILL' ? { payeeShortcode: payee.payeeShortcode } : {}),
          ...(method === 'MPESA_PAYBILL' ? { payeeAccountRef: payee.payeeAccountRef } : {}),
          dueDate: dueDate || undefined,
          narrative: narrative || undefined,
        },
      },
    ],
    { invalidate: ['/payments', '/payment-vouchers', '/invoices'], success: 'Voucher prepared: submit it for approval' },
  );
  return (
    <FormDialog open maxWidth="md" title={`Pay ${invoices[0]?.supplier}`} submitLabel="Prepare voucher" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (v) => navigate(`/payment-vouchers/${v.id}`) }); }}>
      {invoices.map((i) => (
        <Stack key={i.id} direction="row" spacing={2} alignItems="center">
          <Typography sx={{ flex: 1 }}>{i.number} · {i.supplierInvoiceNo} (still to pay {formatMoney(i.available, currency)})</Typography>
          <TextField size="small" type="number" label="Pay" value={amounts[i.id]} onChange={(e) => setAmounts({ ...amounts, [i.id]: e.target.value })} sx={{ width: 160 }} slotProps={{ htmlInput: { step: '0.01', min: 0.01, max: i.available, 'aria-label': `Amount for ${i.number}` } }} />
        </Stack>
      ))}
      <Typography variant="body2">
        Settled {formatMoney(gross, currency)} · withholding tax {formatMoney(Math.round(wht * 100) / 100, currency)} · <b>paid to the supplier {formatMoney(Math.round((gross - wht) * 100) / 100, currency)}</b>
      </Typography>
      <TextField select label="Pay by" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodCode)}>
        {PAYMENT_METHODS.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
      </TextField>
      {method === 'MPESA_B2C' && <TextField label="Payee phone" value={payee.payeePhone} onChange={(e) => setPayee({ ...payee, payeePhone: e.target.value })} required helperText="07…, 01… or 2547…" />}
      {(method === 'MPESA_PAYBILL' || method === 'MPESA_TILL') && (
        <Stack direction="row" spacing={2}>
          <TextField label={method === 'MPESA_TILL' ? 'Till number' : 'PayBill number'} value={payee.payeeShortcode} onChange={(e) => setPayee({ ...payee, payeeShortcode: e.target.value })} required />
          {method === 'MPESA_PAYBILL' && <TextField label="Account number" value={payee.payeeAccountRef} onChange={(e) => setPayee({ ...payee, payeeAccountRef: e.target.value })} required />}
        </Stack>
      )}
      {isMpesa(method) && <Alert severity="info">M-PESA pays whole shillings, from the paying shortcode configured on the server.</Alert>}
      <Stack direction="row" spacing={2}>
        <TextField label="Pay on" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Narrative" value={narrative} onChange={(e) => setNarrative(e.target.value)} sx={{ flex: 1 }} />
      </Stack>
    </FormDialog>
  );
}

/** Approved invoices still to pay, with ageing; select a supplier's invoices to prepare a voucher. */
export function PayablesPage() {
  const { can } = useAuth();
  const date = useDate();
  const [params] = useSearchParams();
  const supplierId = params.get('supplierId') ?? undefined;
  const { data, isFetching } = useList<Payable>('/payments/payables', supplierId ? { supplierId } : undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const rows = data ?? [];
  const chosen = rows.filter((r) => selected.includes(r.id));
  const oneSupplier = new Set(chosen.map((r) => r.supplierId)).size === 1 && new Set(chosen.map((r) => r.currency)).size === 1;
  const buckets = useMemo(() => {
    const b: Record<string, number> = {};
    for (const r of rows) b[r.bucket] = (b[r.bucket] ?? 0) + r.outstanding;
    return b;
  }, [rows]);
  const columns: GridColDef<Payable>[] = [
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 180 },
    { field: 'number', headerName: 'Invoice', width: 160, renderCell: ({ row }) => <Link component={RouterLink} to={`/invoices/${row.id}`}>{row.number}</Link> },
    { field: 'supplierInvoiceNo', headerName: 'Supplier no.', width: 130 },
    { field: 'dueDate', headerName: 'Due', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'bucket', headerName: 'Age', width: 100, renderCell: ({ value, row }) => <Chip size="small" color={row.daysOverdue > 30 ? 'error' : row.daysOverdue > 0 ? 'warning' : 'default'} label={value === 'CURRENT' ? 'Current' : `${value} days`} /> },
    { field: 'outstanding', headerName: 'Outstanding', type: 'number', width: 140, valueFormatter: (v: number, r) => formatMoney(v, r.currency) },
    { field: 'available', headerName: 'Not yet on a voucher', type: 'number', width: 170, valueFormatter: (v: number, r) => formatMoney(v, r.currency) },
  ];
  return (
    <>
      <PageHeader
        title="Payables"
        actions={can(P.PAYMENTS_PREPARE) ? <Button variant="contained" disabled={!chosen.length || !oneSupplier} onClick={() => setOpen(true)}>Prepare voucher</Button> : undefined}
      />
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap aria-label="Ageing">
        {['CURRENT', '1-30', '31-60', '61-90', '90+'].map((b) => (
          <Chip key={b} variant="outlined" label={`${b === 'CURRENT' ? 'Current' : `${b} days`}: ${formatMoney(buckets[b] ?? 0, rows[0]?.currency ?? 'KES')}`} />
        ))}
      </Stack>
      {chosen.length > 0 && !oneSupplier && <Alert severity="warning" sx={{ mb: 1 }}>A voucher pays one supplier in one currency.</Alert>}
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={rows}
          columns={columns}
          loading={isFetching}
          checkboxSelection
          isRowSelectable={({ row }) => row.available > 0}
          rowSelectionModel={selected}
          onRowSelectionModelChange={(m) => setSelected(m as string[])}
          pageSizeOptions={[25, 50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
        />
      </Paper>
      {open && <VoucherDialog invoices={chosen.filter((r) => r.available > 0)} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PaymentVouchersPage() {
  const navigate = useNavigate();
  const date = useDate();
  const [tab, setTab] = useState<'all' | 'review'>('all');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<PaymentVoucher>('/payment-vouchers', { ...pagination, ...(tab === 'review' ? { review: true } : {}) });
  const columns: GridColDef<PaymentVoucher>[] = [
    { field: 'number', headerName: 'Voucher', width: 160 },
    { field: 'supplier', headerName: 'Payee', flex: 1, minWidth: 180, valueGetter: (_v, r) => r.payeeName ?? r.supplier?.name ?? '' },
    { field: 'method', headerName: 'Method', width: 180, valueFormatter: (v: string) => methodLabel(v) },
    { field: 'amount', headerName: 'Amount', type: 'number', width: 140, valueFormatter: (v: number, r) => formatMoney(v, r.currency) },
    { field: 'dueDate', headerName: 'Pay on', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'status', headerName: 'Status', width: 150, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Payment vouchers" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="all" label="All" />
        <Tab value="review" label="Review queue" />
      </Tabs>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/payment-vouchers/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

function ReleaseDialog({ v, onClose }: { v: PaymentVoucher; onClose(): void }) {
  const mpesa = isMpesa(v.method);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const release = useApiMutation<void>(() => [`/payment-vouchers/${v.id}/release`, { method: 'POST', body: mpesa ? {} : { paymentReference: reference, paidOn } }], {
    invalidate: ['/payment-vouchers', '/payments', '/invoices'],
    success: mpesa ? 'Sent to M-PESA: waiting for the result' : 'Payment recorded',
  });
  const payee = v.payeePhone ?? (v.payeeShortcode ? `${v.payeeShortcode}${v.payeeAccountRef ? ` / ${v.payeeAccountRef}` : ''}` : null);
  return (
    <FormDialog open title={mpesa ? 'Send via M-PESA' : 'Record the payment'} submitLabel={mpesa ? 'Send now' : 'Mark paid'} onClose={onClose} submitting={release.isPending} onSubmit={(e) => { e.preventDefault(); release.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography>
        {formatMoney(v.amount, v.currency)} to {v.payeeName}
        {payee ? ` (${payee})` : ''} by {methodLabel(v.method)}.
      </Typography>
      {mpesa ? (
        <Alert severity="warning">This sends money now. It is sent once: if the result is late, the system asks M-PESA before anything else.</Alert>
      ) : (
        <Stack direction="row" spacing={2}>
          <TextField label={v.method === 'CHEQUE' ? 'Cheque number' : 'Bank reference'} value={reference} onChange={(e) => setReference(e.target.value)} required />
          <TextField label="Paid on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        </Stack>
      )}
    </FormDialog>
  );
}

function ResolveDialog({ v, onClose }: { v: PaymentVoucher; onClose(): void }) {
  const [outcome, setOutcome] = useState<'PAID' | 'FAILED'>('PAID');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const resolve = useApiMutation<void>(() => [`/payment-vouchers/${v.id}/resolve`, { method: 'POST', body: { outcome, reference: reference || undefined, note } }], { invalidate: ['/payment-vouchers', '/invoices'], success: 'Resolved' });
  return (
    <FormDialog open title="Resolve from the statement" submitLabel="Resolve" onClose={onClose} submitting={resolve.isPending} onSubmit={(e) => { e.preventDefault(); resolve.mutate(undefined, { onSuccess: onClose }); }}>
      <Alert severity="info">Check the M-PESA statement (or the bank) first. “Not paid” lets the voucher be released again as a new M-PESA request.</Alert>
      <TextField select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as 'PAID' | 'FAILED')}>
        <MenuItem value="PAID">Paid (found on the statement)</MenuItem>
        <MenuItem value="FAILED">Not paid</MenuItem>
      </TextField>
      {outcome === 'PAID' && <TextField label="M-PESA receipt / reference" value={reference} onChange={(e) => setReference(e.target.value)} required />}
      <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} required multiline minRows={2} slotProps={{ htmlInput: { minLength: 5 } }} />
    </FormDialog>
  );
}

function ReasonDialog({ title, action, v, onClose }: { title: string; action: 'cancel' | 'reverse'; v: PaymentVoucher; onClose(): void }) {
  const [reason, setReason] = useState('');
  const run = useApiMutation<void>(() => [`/payment-vouchers/${v.id}/${action}`, { method: 'POST', body: { reason } }], { invalidate: ['/payment-vouchers', '/invoices'], success: action === 'reverse' ? 'Reversal requested from M-PESA' : 'Cancelled' });
  return (
    <FormDialog open title={title} onClose={onClose} submitting={run.isPending} onSubmit={(e) => { e.preventDefault(); run.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required multiline minRows={2} slotProps={{ htmlInput: { minLength: 5 } }} />
    </FormDialog>
  );
}

export function PaymentVoucherDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const date = useDate();
  const [dialog, setDialog] = useState<'release' | 'resolve' | 'cancel' | 'reverse' | null>(null);
  const { data: v } = useQuery({ queryKey: ['/payment-vouchers', id], queryFn: () => api<PaymentVoucher>(`/payment-vouchers/${id}`), refetchInterval: (q) => (q.state.data?.status === 'PROCESSING' ? 5000 : false) });
  const submit = useApiMutation<void>(() => [`/payment-vouchers/${id}/submit`, { method: 'POST' }], { invalidate: ['/payment-vouchers', '/approvals'], success: 'Submitted for approval' });
  if (!v) return null;
  const cur = (n: number | null | undefined) => formatMoney(n ?? 0, v.currency);
  const s = v.status;
  const mpesa = isMpesa(v.method);
  const mine = v.preparedBy === user?.id;
  const live = (v.attempts ?? []).some((a) => ['PENDING', 'UNKNOWN', 'SUCCESS'].includes(a.status));
  const canRelease = can(P.PAYMENTS_RELEASE) && !mine && (s === 'APPROVED' || (s === 'FAILED' && mpesa && !live));
  return (
    <>
      <PageHeader
        title={`Payment voucher ${v.number}`}
        actions={<Button startIcon={<PictureAsPdfIcon />} href={`${API_BASE}/payment-vouchers/${v.id}/pdf`} target="_blank" rel="noopener">PDF</Button>}
      />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={s} />
                <Typography>{v.payeeName ?? v.supplier?.name} · {methodLabel(v.method)}</Typography>
              </Stack>
              {v.lastComment && <Alert severity={['FAILED', 'REVIEW', 'REJECTED', 'RETURNED'].includes(s) ? 'warning' : 'info'} sx={{ mb: 2 }}>{v.lastComment}</Alert>}
              {s === 'PROCESSING' && <Alert severity="info" sx={{ mb: 2 }}>Sent to M-PESA; waiting for the result.</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Field label="Settled">{cur(v.grossAmount)}</Field>
                <Field label="Withholding tax">{cur(v.whtAmount)}</Field>
                <Field label="Paid to the supplier">{cur(v.amount)}</Field>
                {v.payeePhone && <Field label="Phone">{v.payeePhone}</Field>}
                {v.payeeShortcode && <Field label={v.method === 'MPESA_TILL' ? 'Till' : 'PayBill'}>{v.payeeShortcode}{v.payeeAccountRef ? ` / ${v.payeeAccountRef}` : ''}</Field>}
                <Field label="Pay on">{date(v.dueDate) || '—'}</Field>
                {v.paidOn && <Field label="Paid">{date(v.paidOn)} · {v.paymentReference}</Field>}
                <Field label="Prepared by">{v.preparedByName ?? '—'}</Field>
                {v.releasedByName && <Field label="Released by">{v.releasedByName}</Field>}
              </Stack>
              <Table size="small" aria-label="Invoices paid">
                <TableHead><TableRow><TableCell>Invoice</TableCell><TableCell align="right">Settled</TableCell><TableCell align="right">WHT</TableCell><TableCell align="right">Paid</TableCell></TableRow></TableHead>
                <TableBody>
                  {(v.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell><Link component={RouterLink} to={`/invoices/${l.invoiceId}`}>{l.invoice?.number}</Link> · {l.invoice?.supplierInvoiceNo}</TableCell>
                      <TableCell align="right">{cur(l.amount)}</TableCell>
                      <TableCell align="right">{cur(l.whtAmount)}</TableCell>
                      <TableCell align="right">{cur(l.netAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            {(v.attempts ?? []).length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>M-PESA</Typography>
                <Table size="small" aria-label="M-PESA attempts">
                  <TableHead><TableRow><TableCell>#</TableCell><TableCell>Status</TableCell><TableCell>Receipt</TableCell><TableCell>Recipient</TableCell><TableCell align="right">Charges</TableCell><TableCell>Result</TableCell></TableRow></TableHead>
                  <TableBody>
                    {(v.attempts ?? []).map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.attempt}</TableCell>
                        <TableCell><StatusChip status={a.status} /></TableCell>
                        <TableCell>{a.receiptNo ?? '—'}</TableCell>
                        <TableCell>{a.recipientName ?? '—'}</TableCell>
                        <TableCell align="right">{a.charges != null ? cur(a.charges) : '—'}</TableCell>
                        <TableCell>{a.resultDesc ?? (a.status === 'PENDING' ? 'Waiting for M-PESA' : '')}{a.statusChecks ? ` (${a.statusChecks} status check(s))` : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {can(P.PAYMENTS_PREPARE) && ['DRAFT', 'RETURNED'].includes(s) && <Button variant="contained" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
              {canRelease && <Button variant="contained" onClick={() => setDialog('release')}>{mpesa ? (s === 'FAILED' ? 'Send again via M-PESA' : 'Send via M-PESA') : 'Record payment'}</Button>}
              {mine && s === 'APPROVED' && <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>You prepared this payment: someone else releases it.</Typography>}
              {can(P.PAYMENTS_RECONCILE) && ['REVIEW', 'FAILED'].includes(s) && <Button onClick={() => setDialog('resolve')}>Resolve</Button>}
              {can(P.PAYMENTS_RELEASE) && s === 'PAID' && mpesa && <Button color="warning" onClick={() => setDialog('reverse')}>Reverse on M-PESA</Button>}
              {can(P.PAYMENTS_PREPARE) && ['DRAFT', 'RETURNED', 'PENDING_APPROVAL', 'APPROVED', 'FAILED'].includes(s) && !live && <Button color="error" onClick={() => setDialog('cancel')}>Cancel</Button>}
            </Stack>
          </>
        }
        side={
          <>
            <ApprovalPanel type="PV" id={v.id} />
            <DocumentChain type="PV" id={v.id} />
          </>
        }
      />
      {dialog === 'release' && <ReleaseDialog v={v} onClose={() => setDialog(null)} />}
      {dialog === 'resolve' && <ResolveDialog v={v} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <ReasonDialog title="Cancel voucher" action="cancel" v={v} onClose={() => setDialog(null)} />}
      {dialog === 'reverse' && <ReasonDialog title="Reverse the M-PESA payment" action="reverse" v={v} onClose={() => setDialog(null)} />}
    </>
  );
}

/** Statement import, reconciliation runs and their exceptions. */
export function ReconciliationPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const date = useDate();
  const runs = useList<Reconciliation>('/payments/reconciliations');
  const current = useQuery({ queryKey: ['/payments/reconciliations', id], queryFn: () => api<Reconciliation>(`/payments/reconciliations/${id}`), enabled: !!id });
  const [csv, setCsv] = useState('');
  const [range, setRange] = useState({ from: today(), to: today() });
  const imp = useApiMutation<void, { imported: number; skipped: number }>(() => ['/payments/mpesa/statements', { method: 'POST', body: { csv } }], { invalidate: ['/payments'], success: 'Statement imported' });
  const run = useApiMutation<void, Reconciliation>(() => ['/payments/reconciliations', { method: 'POST', body: range }], { invalidate: ['/payments/reconciliations'], success: 'Reconciled' });
  const followUp = useApiMutation<void, { queried: number; resolved: number; retried: number; review: number }>(() => ['/payments/mpesa/follow-up', { method: 'POST' }], { invalidate: ['/payment-vouchers'], success: 'Pending M-PESA payments checked' });
  const r = current.data;
  return (
    <>
      <PageHeader title="M-PESA reconciliation" actions={<Button onClick={() => followUp.mutate()}>Check pending payments now</Button>} />
      <Stack spacing={2}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>1. Import the M-PESA statement</Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>The CSV export of the organisation statement (Receipt No., Completion Time, Details, Paid In, Withdrawn).</Typography>
          <Stack spacing={1}>
            <Button component="label" variant="outlined" sx={{ alignSelf: 'flex-start' }}>
              Choose CSV file
              <input hidden type="file" accept=".csv,text/csv" onChange={async (e) => setCsv((await e.target.files?.[0]?.text()) ?? '')} />
            </Button>
            <TextField label="…or paste it" value={csv} onChange={(e) => setCsv(e.target.value)} multiline minRows={3} maxRows={8} />
            <Box>
              <Button variant="contained" disabled={!csv || imp.isPending} onClick={() => imp.mutate(undefined, { onSuccess: () => setCsv('') })}>Import</Button>
              {imp.data && <Typography component="span" sx={{ ml: 2 }}>{imp.data.imported} line(s) imported, {imp.data.skipped} skipped</Typography>}
            </Box>
          </Stack>
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>2. Reconcile</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <TextField label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <Button variant="contained" disabled={run.isPending} onClick={() => run.mutate(undefined, { onSuccess: (x) => navigate(`/payments/reconciliation/${x.id}`) })}>Reconcile</Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Runs every morning for the previous day (job payments.mpesaReconcile).</Typography>
        </Paper>
        {r && (
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <StatusChip status={r.status} />
              <Typography>{date(r.dateFrom)}{r.dateTo !== r.dateFrom ? ` – ${date(r.dateTo)}` : ''}: {r.matched} matched · system {formatMoney(r.systemTotal, 'KES')} · statement {formatMoney(r.statementTotal, 'KES')}{r.accountBalance != null ? ` · balance ${formatMoney(r.accountBalance, 'KES')}` : ''}</Typography>
            </Stack>
            <Table size="small" aria-label="Reconciliation exceptions">
              <TableHead><TableRow><TableCell>Exception</TableCell><TableCell>Receipt</TableCell><TableCell>Voucher</TableCell><TableCell align="right">System</TableCell><TableCell align="right">Statement</TableCell><TableCell>Note</TableCell></TableRow></TableHead>
              <TableBody>
                {r.exceptions.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell>{humanise(e.kind)}</TableCell>
                    <TableCell>{e.receiptNo ?? '—'}</TableCell>
                    <TableCell>{e.voucherNo ?? '—'}</TableCell>
                    <TableCell align="right">{e.system != null ? formatMoney(e.system, 'KES') : ''}</TableCell>
                    <TableCell align="right">{e.statement != null ? formatMoney(e.statement, 'KES') : ''}</TableCell>
                    <TableCell>{e.note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Earlier runs</Typography>
          {(runs.data ?? []).map((x) => (
            <Typography key={x.id} variant="body2">
              <Link component={RouterLink} to={`/payments/reconciliation/${x.id}`}>{date(x.dateFrom)}{x.dateTo !== x.dateFrom ? ` – ${date(x.dateTo)}` : ''}</Link> · {humanise(x.status)} · {x.matched} matched, {x.exceptions.filter((e) => e.kind !== 'CHARGES').length} exception(s)
            </Typography>
          ))}
        </Paper>
      </Stack>
    </>
  );
}

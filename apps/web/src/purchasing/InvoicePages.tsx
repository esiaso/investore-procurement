import { Alert, Box, Button, Chip, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceStatus, Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { Invoice, MatchView, PurchaseOrder } from '../api/purchasing-types';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from './common';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function InvoiceFormPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const money = useMoney();
  const poId = params.get('poId')!;
  const { data: po } = useQuery({ queryKey: ['/purchase-orders', poId], queryFn: () => api<PurchaseOrder>(`/purchase-orders/${poId}`) });
  const [header, setHeader] = useState({ supplierInvoiceNo: '', invoiceDate: today(), dueDate: '', etimsInvoiceNo: '' });
  const [edits, setEdits] = useState<Record<string, { quantity?: string; unitPrice?: string }>>({});
  const lines = useMemo(
    () =>
      (po?.lines ?? []).map((l) => {
        const received = Math.round((l.receivedBaseQty / l.conversionFactor) * 10_000) / 10_000;
        return { id: l.id, label: `${l.lineNo}. ${l.item?.name}`, uom: l.uom?.code, poPrice: l.unitPrice, received, quantity: edits[l.id]?.quantity ?? String(received), unitPrice: edits[l.id]?.unitPrice ?? String(l.unitPrice), rate: l.taxRatePercent };
      }),
    [po, edits],
  );
  const total = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0) * (1 + l.rate / 100), 0);
  const save = useApiMutation<void, Invoice>(
    () => [
      '/invoices',
      {
        method: 'POST',
        body: {
          purchaseOrderId: poId,
          ...header,
          dueDate: header.dueDate || null,
          etimsInvoiceNo: header.etimsInvoiceNo || undefined,
          lines: lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ poLineId: l.id, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
        },
      },
    ],
    { invalidate: ['/invoices', '/documents'], success: 'Invoice captured and matched' },
  );
  if (!po) return null;
  return (
    <>
      <PageHeader title={`Capture supplier invoice: ${po.number}`} />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography color="text.secondary">{po.supplier?.name}</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField label="Supplier invoice no." value={header.supplierInvoiceNo} onChange={(e) => setHeader({ ...header, supplierInvoiceNo: e.target.value })} required autoFocus />
            <TextField label="Invoice date" type="date" value={header.invoiceDate} onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="Due date" type="date" value={header.dueDate} onChange={(e) => setHeader({ ...header, dueDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="eTIMS invoice no. (optional)" value={header.etimsInvoiceNo} onChange={(e) => setHeader({ ...header, etimsInvoiceNo: e.target.value })} />
          </Stack>
          <Table size="small" aria-label="Invoice lines">
            <TableHead>
              <TableRow><TableCell>PO line</TableCell><TableCell>Unit</TableCell><TableCell align="right">Received</TableCell><TableCell align="right">PO price</TableCell><TableCell>Invoiced qty</TableCell><TableCell>Invoice price</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.label}</TableCell>
                  <TableCell>{l.uom}</TableCell>
                  <TableCell align="right">{l.received}</TableCell>
                  <TableCell align="right">{money(l.poPrice)}</TableCell>
                  <TableCell><TextField type="number" value={l.quantity} onChange={(e) => setEdits({ ...edits, [l.id]: { ...edits[l.id], quantity: e.target.value } })} sx={{ width: 110 }} slotProps={{ htmlInput: { 'aria-label': `Invoiced quantity ${l.label}` } }} /></TableCell>
                  <TableCell><TextField type="number" value={l.unitPrice} onChange={(e) => setEdits({ ...edits, [l.id]: { ...edits[l.id], unitPrice: e.target.value } })} sx={{ width: 130 }} slotProps={{ htmlInput: { 'aria-label': `Invoice price ${l.label}`, step: 'any' } }} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography>Invoice total (incl. VAT): <b>{money(total)}</b></Typography>
          <Box>
            <Button variant="contained" disabled={!header.supplierInvoiceNo || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (inv) => navigate(`/invoices/${inv.id}`) })}>
              Capture and match
            </Button>
          </Box>
        </Stack>
      </Paper>
    </>
  );
}

/** PO vs received vs invoiced, line by line. */
export function ThreeWayMatch({ view }: { view: MatchView }) {
  const money = useMoney();
  return (
    <Paper sx={{ p: 2, overflowX: 'auto' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" fontWeight={600}>Three-way match</Typography>
        <Chip size="small" color={view.invoice.matchStatus === 'MATCHED' ? 'success' : 'warning'} label={humanise(view.invoice.matchStatus)} />
      </Stack>
      <Table size="small" aria-label="Three-way match">
        <TableHead>
          <TableRow>
            <TableCell>Line</TableCell><TableCell align="right">Ordered</TableCell><TableCell align="right">Received</TableCell>
            <TableCell align="right">Invoiced (all)</TableCell><TableCell align="right">This invoice</TableCell>
            <TableCell align="right">PO price</TableCell><TableCell align="right">Invoice price</TableCell><TableCell>Variance</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {view.lines.map((l) => (
            <TableRow key={l.poLineId} sx={{ bgcolor: l.variances.length ? 'rgba(237, 108, 2, 0.08)' : undefined }}>
              <TableCell>{l.lineNo}. {l.item} ({l.uom})</TableCell>
              <TableCell align="right">{l.orderedQty}</TableCell>
              <TableCell align="right">{l.receivedQty}</TableCell>
              <TableCell align="right">{l.invoicedToDate}</TableCell>
              <TableCell align="right">{l.thisInvoiceQty}</TableCell>
              <TableCell align="right">{money(l.poUnitPrice)}</TableCell>
              <TableCell align="right">{l.thisInvoicePrice === null ? '—' : money(l.thisInvoicePrice)}</TableCell>
              <TableCell>{l.variances.map((v) => <Chip key={v.code} size="small" color="warning" label={humanise(v.code)} sx={{ mr: 0.5 }} />)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {view.invoice.variances.map((v, i) => (
        <Typography key={i} variant="body2" color="warning.main">{v.message}</Typography>
      ))}
    </Paper>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [payment, setPayment] = useState({ paidOn: today(), paymentReference: '', method: 'EFT' });
  const { data: view } = useQuery({ queryKey: ['/invoices', id, 'match'], queryFn: () => api<MatchView>(`/invoices/${id}/match`) });
  const act = (path: string, body?: object) => [`/invoices/${id}/${path}`, { method: 'POST' as const, body }] as [string, { method: 'POST'; body?: object }];
  const submit = useApiMutation<void>(() => act('submit'), { invalidate: ['/invoices', '/approvals'], success: 'Submitted for approval' });
  const rematch = useApiMutation<void>(() => act('rematch'), { invalidate: ['/invoices'], success: 'Re-matched' });
  const cancel = useApiMutation<void>(() => act('cancel'), { invalidate: ['/invoices', '/approvals'], success: 'Cancelled' });
  const pay = useApiMutation<void>(() => act('pay', payment), { invalidate: ['/invoices', '/documents'], success: 'Payment recorded' });
  if (!view) return null;
  const inv = view.invoice;
  const editable = [InvoiceStatus.CAPTURED, InvoiceStatus.RETURNED].includes(inv.status as InvoiceStatus);
  return (
    <>
      <PageHeader title={`Invoice ${inv.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={inv.status} />
                <Chip size="small" variant="outlined" label={`eTIMS: ${humanise(inv.etimsStatus)}`} />
                <Typography>{inv.supplier?.name} · invoice {inv.supplierInvoiceNo} · PO {inv.purchaseOrder?.number}</Typography>
              </Stack>
              {inv.lastComment && <Alert severity="warning" sx={{ mb: 2 }}>{inv.lastComment}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
                <Field label="Invoice date">{date(inv.invoiceDate)}</Field>
                <Field label="Due">{date(inv.dueDate) || '—'}</Field>
                <Field label="Subtotal">{money(inv.subtotal)}</Field>
                <Field label="VAT">{money(inv.taxTotal)}</Field>
                <Field label="Total">{money(inv.total)}</Field>
              </Stack>
            </Paper>
            <ThreeWayMatch view={view} />
            {can(Permissions.PURCHASING_INVOICE) && editable && (
              <Stack direction="row" spacing={1}>
                <Button variant="contained" onClick={() => submit.mutate()}>Submit for approval</Button>
                <Button onClick={() => rematch.mutate()}>Re-run match</Button>
                <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>
              </Stack>
            )}
            {can(Permissions.PURCHASING_PAYMENT) && inv.status === InvoiceStatus.APPROVED && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Record payment</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField label="Paid on" type="date" value={payment.paidOn} onChange={(e) => setPayment({ ...payment, paidOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
                  <TextField select label="Method" value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })} sx={{ minWidth: 140 }}>
                    {['EFT', 'RTGS', 'CHEQUE', 'MPESA'].map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                  </TextField>
                  <TextField label="Reference" value={payment.paymentReference} onChange={(e) => setPayment({ ...payment, paymentReference: e.target.value })} />
                  <Button variant="contained" disabled={!payment.paymentReference} onClick={() => pay.mutate()}>Record payment</Button>
                </Stack>
              </Paper>
            )}
          </>
        }
        side={
          <>
            <ApprovalPanel type="INV" id={inv.id} />
            <DocumentChain type="INV" id={inv.id} />
          </>
        }
      />
    </>
  );
}

export function InvoicesPage() {
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<Invoice>('/invoices', { ...pagination, status });
  const columns: GridColDef<Invoice>[] = [
    { field: 'number', headerName: 'Number', width: 160 },
    { field: 'supplierInvoiceNo', headerName: 'Supplier invoice', width: 150 },
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 200, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'total', headerName: 'Total', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
    { field: 'matchStatus', headerName: 'Match', width: 120, renderCell: ({ value }) => <Chip size="small" color={value === 'MATCHED' ? 'success' : 'warning'} label={humanise(value)} /> },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'invoiceDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Supplier invoices"
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 180 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(InvoiceStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Capture invoices from the purchase order page.</Typography>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/invoices/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

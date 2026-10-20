import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PrintIcon from '@mui/icons-material/Print';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Link,
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
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { Payer, PaymentMode, PriceList, SalesInvoice } from '../api/pharmacy-types';
import type { Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StoreSelect, useStores } from '../inventory/components';
import { formatDate, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { EtimsChip } from '../pharmacy/ui';
import { DetailLayout, Field, useMoney } from '../purchasing/common';
import { useSettings } from '../settings/SettingsContext';

const P = Permissions;

function useToday() {
  const { timezone } = useSettings();
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

// ------------------------------------------------------------------ invoices list

export function SalesInvoicesPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const money = useMoney();
  const { dateFormat, timezone } = useSettings();
  const [storeId, setStoreId] = useState('');
  const [docType, setDocType] = useState('');
  const [etimsStatus, setEtimsStatus] = useState('');
  const [search, setSearch] = useState('');
  const [paging, setPaging] = useState({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<SalesInvoice>('/billing/invoices', { ...paging, storeId: storeId || undefined, docType: docType || undefined, etimsStatus: etimsStatus || undefined, search: q || undefined });
  const columns: GridColDef<SalesInvoice>[] = [
    { field: 'number', headerName: 'Number', width: 190 },
    { field: 'docType', headerName: 'Type', width: 120, valueFormatter: (v) => humanise(v as string) },
    { field: 'issuedAt', headerName: 'Issued', width: 160, valueFormatter: (v) => formatDate(v as string, dateFormat, timezone, true) },
    { field: 'store', headerName: 'Outlet', width: 160, valueGetter: (_, r) => r.store?.name },
    { field: 'source', headerName: 'Source', width: 110, valueFormatter: (v) => humanise(v as string) },
    { field: 'customerName', headerName: 'Customer', flex: 1, minWidth: 150, valueGetter: (_, r) => r.customerName ?? r.payer?.name ?? 'Walk-in' },
    { field: 'totalAmount', headerName: 'Total', width: 130, align: 'right', headerAlign: 'right', valueFormatter: (v) => money(v as number) },
    { field: 'etimsStatus', headerName: 'eTIMS', width: 150, renderCell: ({ value }) => <EtimsChip status={value} /> },
    { field: 'cuInvoiceNo', headerName: 'CU invoice no.', width: 190 },
  ];
  return (
    <>
      <PageHeader title="Sales invoices" search={search} onSearch={setSearch} searchPlaceholder="Number, customer or CU no." onNew={can(P.BILLING_INVOICE) ? () => navigate('/sales/new') : undefined} newLabel="New sale" />
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <StoreSelect value={storeId} onChange={setStoreId} label="Outlet" allowAll="All outlets" sx={{ minWidth: 200 }} />
        <TextField select label="Type" value={docType} onChange={(e) => setDocType(e.target.value)} sx={{ minWidth: 160 }}>
          <MenuItem value="">All</MenuItem>
          <MenuItem value="INVOICE">Invoices</MenuItem>
          <MenuItem value="CREDIT_NOTE">Credit notes</MenuItem>
        </TextField>
        <TextField select label="eTIMS" value={etimsStatus} onChange={(e) => setEtimsStatus(e.target.value)} sx={{ minWidth: 160 }}>
          <MenuItem value="">All</MenuItem>
          {['ACCEPTED', 'PENDING', 'FAILED', 'NOT_REQUIRED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
      </Stack>
      <DataGrid
        autoHeight
        rows={data?.items ?? []}
        columns={columns}
        loading={isFetching}
        rowCount={data?.total ?? 0}
        paginationMode="server"
        paginationModel={paging}
        onPaginationModelChange={setPaging}
        pageSizeOptions={[25, 50, 100]}
        onRowClick={(p) => navigate(`/sales/${p.id}`)}
        disableRowSelectionOnClick
      />
    </>
  );
}

// ------------------------------------------------------------------ point of sale

export function SaleFormPage() {
  const navigate = useNavigate();
  const money = useMoney();
  const stores = useStores();
  const modes = useList<PaymentMode>('/billing/payment-modes');
  const payers = useList<Payer>('/billing/payers');
  const [storeId, setStoreId] = useState('');
  const [source, setSource] = useState<'OTC' | 'CONSUMABLE'>('OTC');
  const [lines, setLines] = useState<{ item: Item | null; quantity: number }[]>([{ item: null, quantity: 1 }]);
  const [customer, setCustomer] = useState({ name: '', kraPin: '', phone: '', payerId: '' });
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState<number | ''>('');
  const [reference, setReference] = useState('');
  useEffect(() => {
    const pharmacy = stores.data?.find((s) => s.type.includes('PHARMACY'));
    if (!storeId && pharmacy) setStoreId(pharmacy.id);
  }, [storeId, stores.data]);
  const selectedMode = (modes.data ?? []).find((m) => m.code === mode);
  const sell = useApiMutation<void, SalesInvoice>(
    () => [
      '/billing/invoices',
      {
        method: 'POST',
        body: {
          storeId,
          source,
          customer: customer.name || customer.kraPin || customer.phone || customer.payerId ? { name: customer.name || undefined, kraPin: customer.kraPin || undefined, phone: customer.phone || undefined, payerId: customer.payerId || undefined } : undefined,
          lines: lines.filter((l) => l.item && l.quantity > 0).map((l) => ({ itemId: l.item!.id, quantity: l.quantity })),
          payments: amount ? [{ modeCode: mode, amount: Number(amount), reference: reference || undefined }] : undefined,
        },
      },
    ],
    { invalidate: ['/billing', '/inventory'], success: 'Sale recorded' },
  );
  const set = (i: number, patch: Partial<{ item: Item | null; quantity: number }>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <>
      <PageHeader title="New sale" />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            <StoreSelect value={storeId} onChange={setStoreId} label="Outlet" sx={{ minWidth: 220 }} />
            <TextField select label="Sale type" value={source} onChange={(e) => setSource(e.target.value as 'OTC')} sx={{ minWidth: 220 }}>
              <MenuItem value="OTC">Over the counter</MenuItem>
              <MenuItem value="CONSUMABLE">Patient-chargeable consumables</MenuItem>
            </TextField>
          </Stack>
          {lines.map((l, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="center">
              <ItemPicker value={l.item} onChange={(item) => set(i, { item })} autoFocus={i === lines.length - 1} />
              <TextField label="Quantity" type="number" value={l.quantity || ''} onChange={(e) => set(i, { quantity: Number(e.target.value) })} sx={{ width: 120 }} />
              <IconButton aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}><DeleteIcon /></IconButton>
            </Stack>
          ))}
          <Box><Button startIcon={<AddIcon />} onClick={() => setLines((ls) => [...ls, { item: null, quantity: 1 }])}>Add item</Button></Box>
          <Typography variant="subtitle2">Customer (optional — B2C sales need none; a buyer KRA PIN makes it a B2B invoice)</Typography>
          <Stack direction="row" spacing={1}>
            <TextField label="Name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
            <TextField label="KRA PIN" value={customer.kraPin} onChange={(e) => setCustomer({ ...customer, kraPin: e.target.value.toUpperCase() })} helperText="e.g. P051234567X" />
            <TextField label="Phone" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
            <TextField select label="Payer" value={customer.payerId} onChange={(e) => setCustomer({ ...customer, payerId: e.target.value })} sx={{ minWidth: 200 }}>
              <MenuItem value="">None (cash)</MenuItem>
              {(payers.data ?? []).filter((p) => p.isActive).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField select label="Payment" value={mode} onChange={(e) => setMode(e.target.value)} sx={{ minWidth: 180 }}>
              {(modes.data ?? []).filter((m) => m.isActive).map((m) => <MenuItem key={m.code} value={m.code}>{m.name}</MenuItem>)}
            </TextField>
            <TextField label="Amount tendered" type="number" value={amount} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} />
            {selectedMode?.requiresReference && <TextField label="Reference (M-Pesa code)" value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} required />}
          </Stack>
          <Box>
            <Button
              variant="contained"
              disabled={!storeId || !lines.some((l) => l.item) || sell.isPending}
              onClick={() => sell.mutate(undefined, { onSuccess: (inv) => navigate(`/sales/${inv.id}${inv.change ? `?change=${inv.change}` : ''}`) })}
            >
              Complete sale
            </Button>
            {sell.data?.change ? <Typography>Change: {money(sell.data.change)}</Typography> : null}
          </Box>
        </Stack>
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ invoice detail

export function SalesInvoiceDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const money = useMoney();
  const { dateFormat, timezone } = useSettings();
  const change = new URLSearchParams(window.location.search).get('change');
  const { data: inv } = useQuery({ queryKey: ['/billing/invoices', id], queryFn: () => api<SalesInvoice>(`/billing/invoices/${id}`), refetchInterval: (q) => (q.state.data?.etimsStatus === 'PENDING' ? 10_000 : false) });
  const [crediting, setCrediting] = useState(false);
  if (!inv) return null;
  const receipt = (layout: string, copy = false) => buildUrl(`/billing/invoices/${inv.id}/receipt`, { layout, copy: copy || undefined });
  const accepted = inv.etimsStatus === 'ACCEPTED';
  const main = (
    <Stack spacing={2}>
      {change && <Alert severity="success">Change due: {money(Number(change))}</Alert>}
      {inv.etimsStatus === 'PENDING' && <Alert severity="warning">eTIMS pending: the receipt prints as “not an official receipt” until KRA accepts it; it is sent automatically and the signed receipt can then be reprinted.</Alert>}
      {inv.etimsStatus === 'FAILED' && <Alert severity="error">eTIMS refused this document: {inv.etimsError}. Finance can correct the mapping and reprocess it under eTIMS → Outbox.</Alert>}
      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Item</TableCell>
              <TableCell align="right">Qty</TableCell>
              <TableCell align="right">Price</TableCell>
              <TableCell align="right">Discount</TableCell>
              <TableCell>Tax</TableCell>
              <TableCell align="right">VAT</TableCell>
              <TableCell align="right">Amount</TableCell>
              {inv.payerAmount > 0 && <TableCell align="right">Payer</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {(inv.lines ?? []).map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.description}</TableCell>
                <TableCell align="right">{l.quantity}</TableCell>
                <TableCell align="right">{money(l.unitPrice)}</TableCell>
                <TableCell align="right">{l.discountAmount ? money(l.discountAmount) : ''}</TableCell>
                <TableCell>{l.taxTypeCode} ({l.taxRatePercent}%)</TableCell>
                <TableCell align="right">{money(l.taxAmount)}</TableCell>
                <TableCell align="right">{money(l.grossAmount)}</TableCell>
                {inv.payerAmount > 0 && <TableCell align="right">{money(l.payerShare)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Stack direction="row" spacing={4} sx={{ mt: 2 }}>
          <Field label="Excl. VAT">{money(inv.totalNet)}</Field>
          <Field label="VAT">{money(inv.totalTax)}</Field>
          <Field label="Total">{money(inv.totalAmount)}</Field>
          {inv.payerAmount > 0 && <Field label="Payer / patient">{money(inv.payerAmount)} / {money(inv.patientAmount)}</Field>}
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>Tax by eTIMS type</Typography>
        <Table size="small">
          <TableBody>
            {Object.entries(inv.taxSummary).filter(([, b]) => b.taxable).map(([t, b]) => (
              <TableRow key={t}>
                <TableCell>{t}</TableCell>
                <TableCell align="right">{money(b.taxable)}</TableCell>
                <TableCell align="right">{b.rate}%</TableCell>
                <TableCell align="right">{money(b.tax)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="subtitle2" sx={{ mt: 2 }}>Payments</Typography>
        {(inv.payments ?? []).map((p) => (
          <Typography key={p.id} variant="body2">{p.modeCode}: {money(p.amount)}{p.reference ? ` (${p.reference})` : ''}</Typography>
        ))}
      </Paper>
    </Stack>
  );
  const side = (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6">{inv.number}</Typography>
          <Box><EtimsChip status={inv.etimsStatus} /></Box>
          <Field label="Type">{humanise(inv.docType)}{inv.originalInvoice && <> for <Link component={RouterLink} to={`/sales/${inv.originalInvoice.id}`}>{inv.originalInvoice.number}</Link></>}</Field>
          <Field label="Issued">{formatDate(inv.issuedAt, dateFormat, timezone, true)}</Field>
          <Field label="Outlet">{inv.store?.name}</Field>
          <Field label="Customer">{inv.customerName ?? 'Walk-in'}{inv.customerPin ? ` · PIN ${inv.customerPin}` : ''}</Field>
          {inv.payer && <Field label="Payer">{inv.payer.name}</Field>}
          <Field label="CU invoice no.">{inv.cuInvoiceNo ?? '—'}</Field>
          {inv.notes && <Field label="Notes">{inv.notes}</Field>}
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Button startIcon={<PrintIcon />} href={receipt('THERMAL')} target="_blank">Receipt (80 mm)</Button>
          <Button startIcon={<PrintIcon />} href={receipt('A4')} target="_blank">Invoice (A4)</Button>
          {accepted && <Button startIcon={<PrintIcon />} href={receipt('THERMAL', true)} target="_blank">Reprint (COPY)</Button>}
          {inv.docType === 'INVOICE' && can(P.BILLING_MANAGE) && <Button color="warning" onClick={() => setCrediting(true)}>Credit note</Button>}
        </Stack>
      </Paper>
      {(inv.creditNotes ?? []).length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>Credit notes</Typography>
          {inv.creditNotes!.map((c) => (
            <Stack key={c.id} direction="row" spacing={1} alignItems="center">
              <Link component={RouterLink} to={`/sales/${c.id}`}>{c.number}</Link>
              <span>{money(c.totalAmount)}</span>
              <EtimsChip status={c.etimsStatus} />
            </Stack>
          ))}
        </Paper>
      )}
    </Stack>
  );
  return (
    <>
      <PageHeader title={`${inv.docType === 'CREDIT_NOTE' ? 'Credit note' : 'Invoice'} ${inv.number}`} />
      <DetailLayout main={main} side={side} />
      {crediting && <CreditNoteDialog inv={inv} onClose={() => setCrediting(false)} />}
    </>
  );
}

function CreditNoteDialog({ inv, onClose }: { inv: SalesInvoice; onClose(): void }) {
  const navigate = useNavigate();
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries((inv.lines ?? []).map((l) => [l.id, l.quantity])));
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState('06');
  const [restock, setRestock] = useState(true);
  const save = useApiMutation<void, SalesInvoice>(
    () => [`/billing/invoices/${inv.id}/credit-notes`, { method: 'POST', body: { reason, reasonCode, restock, lines: Object.entries(qty).filter(([, q]) => q > 0).map(([invoiceLineId, quantity]) => ({ invoiceLineId, quantity })) } }],
    { invalidate: ['/billing', '/inventory'], success: 'Credit note issued' },
  );
  return (
    <FormDialog open title={`Credit note for ${inv.number}`} submitLabel="Issue credit note" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (cn) => { onClose(); navigate(`/sales/${cn.id}`); } }); }}>
      {(inv.lines ?? []).map((l) => (
        <TextField key={l.id} type="number" label={`${l.description} (of ${l.quantity})`} value={qty[l.id] ?? 0} onChange={(e) => setQty({ ...qty, [l.id]: Math.min(l.quantity, Number(e.target.value)) })} />
      ))}
      <TextField select label="eTIMS reason" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
        {[['01', 'Missing quantity'], ['02', 'Missing data'], ['03', 'Damaged'], ['04', 'Wasted'], ['05', 'Raw material shortage'], ['06', 'Refund']].map(([c, n]) => <MenuItem key={c} value={c}>{c} {n}</MenuItem>)}
      </TextField>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <FormControlLabel control={<Switch checked={restock} onChange={(e) => setRestock(e.target.checked)} />} label="Return the goods to stock (same batches)" />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ setup

export function BillingSetupPage() {
  const { can } = useAuth();
  const manage = can(P.BILLING_MANAGE);
  const lists = useList<PriceList>('/billing/price-lists');
  const payers = useList<Payer>('/billing/payers');
  const modes = useList<PaymentMode>('/billing/payment-modes');
  const [tab, setTab] = useState(0);
  const [list, setList] = useState<PriceList | null | 'new'>(null);
  const [payer, setPayer] = useState<Payer | null | 'new'>(null);
  const [mode, setMode] = useState<PaymentMode | null>(null);
  return (
    <>
      <PageHeader title="Billing setup" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Price lists" />
        <Tab label="Payers" />
        <Tab label="Payment modes" />
      </Tabs>
      {tab === 0 && (
        <Paper sx={{ p: 2 }}>
          {manage && <Button startIcon={<AddIcon />} onClick={() => setList('new')}>New price list</Button>}
          <Table size="small">
            <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Type</TableCell><TableCell align="right">Adjustment</TableCell><TableCell>Default</TableCell><TableCell>Active</TableCell></TableRow></TableHead>
            <TableBody>
              {(lists.data ?? []).map((l) => (
                <TableRow key={l.id} hover onClick={() => manage && setList(l)} sx={{ cursor: manage ? 'pointer' : undefined }}>
                  <TableCell>{l.code}</TableCell><TableCell>{l.name}</TableCell><TableCell>{humanise(l.type)}</TableCell><TableCell align="right">{l.adjustPercent}%</TableCell><TableCell>{l.isDefault ? 'Yes' : ''}</TableCell><TableCell>{l.isActive ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="body2" sx={{ mt: 1 }}>Prices are VAT inclusive: the item’s VAT-exclusive price ± the list adjustment, plus VAT; explicit prices per item override it.</Typography>
        </Paper>
      )}
      {tab === 1 && (
        <Paper sx={{ p: 2 }}>
          {manage && <Button startIcon={<AddIcon />} onClick={() => setPayer('new')}>New payer</Button>}
          <Table size="small">
            <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Type</TableCell><TableCell align="right">Patient co-pay</TableCell><TableCell>KRA PIN</TableCell><TableCell>Active</TableCell></TableRow></TableHead>
            <TableBody>
              {(payers.data ?? []).map((p) => (
                <TableRow key={p.id} hover onClick={() => manage && setPayer(p)} sx={{ cursor: manage ? 'pointer' : undefined }}>
                  <TableCell>{p.code}</TableCell><TableCell>{p.name}</TableCell><TableCell>{humanise(p.type)}</TableCell><TableCell align="right">{p.coPayPercent}%</TableCell><TableCell>{p.kraPin}</TableCell><TableCell>{p.isActive ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {tab === 2 && (
        <Paper sx={{ p: 2 }}>
          <Table size="small">
            <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>eTIMS payment type</TableCell><TableCell>Needs reference</TableCell><TableCell>Credit</TableCell></TableRow></TableHead>
            <TableBody>
              {(modes.data ?? []).map((m) => (
                <TableRow key={m.id} hover onClick={() => manage && setMode(m)} sx={{ cursor: manage ? 'pointer' : undefined }}>
                  <TableCell>{m.code}</TableCell><TableCell>{m.name}</TableCell><TableCell>{m.etimsPaymentTypeCode}</TableCell><TableCell>{m.requiresReference ? 'Yes' : ''}</TableCell><TableCell>{m.isCredit ? 'Yes' : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {list && <PriceListDialog row={list === 'new' ? undefined : list} onClose={() => setList(null)} />}
      {payer && <PayerDialog row={payer === 'new' ? undefined : payer} lists={lists.data ?? []} onClose={() => setPayer(null)} />}
      {mode && <PaymentModeDialog row={mode} onClose={() => setMode(null)} />}
    </>
  );
}

function PriceListDialog({ row, onClose }: { row?: PriceList; onClose(): void }) {
  const [f, setF] = useState({ code: row?.code ?? '', name: row?.name ?? '', type: row?.type ?? 'RETAIL', adjustPercent: row?.adjustPercent ?? 0, isActive: row?.isActive ?? true });
  const save = useApiMutation<void>(() => [row ? `/billing/price-lists/${row.id}` : '/billing/price-lists', { method: row ? 'PUT' : 'POST', body: f }], { invalidate: ['/billing/price-lists'], success: 'Price list saved' });
  return (
    <FormDialog open title={row ? 'Edit price list' : 'New price list'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required />
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <TextField select label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as PriceList['type'] })}>
        {['RETAIL', 'STAFF', 'CORPORATE', 'INSURANCE'].map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
      </TextField>
      <TextField label="Adjustment % (e.g. -10 for staff)" type="number" value={f.adjustPercent} onChange={(e) => setF({ ...f, adjustPercent: Number(e.target.value) })} />
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function PayerDialog({ row, lists, onClose }: { row?: Payer; lists: PriceList[]; onClose(): void }) {
  const [f, setF] = useState({ code: row?.code ?? '', name: row?.name ?? '', type: row?.type ?? 'INSURANCE', kraPin: row?.kraPin ?? '', priceListId: row?.priceListId ?? '', coPayPercent: row?.coPayPercent ?? 0, etimsInsuranceCode: row?.etimsInsuranceCode ?? '', isActive: row?.isActive ?? true });
  const body = { ...f, kraPin: f.kraPin || undefined, priceListId: f.priceListId || undefined, etimsInsuranceCode: f.etimsInsuranceCode || undefined };
  const save = useApiMutation<void>(() => [row ? `/billing/payers/${row.id}` : '/billing/payers', { method: row ? 'PUT' : 'POST', body }], { invalidate: ['/billing/payers'], success: 'Payer saved' });
  return (
    <FormDialog open title={row ? 'Edit payer' : 'New payer'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required />
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <TextField select label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Payer['type'] })}>
        <MenuItem value="INSURANCE">Insurance</MenuItem>
        <MenuItem value="CORPORATE">Corporate</MenuItem>
      </TextField>
      <TextField select label="Price list" value={f.priceListId} onChange={(e) => setF({ ...f, priceListId: e.target.value })}>
        <MenuItem value="">Default</MenuItem>
        {lists.map((l) => <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>)}
      </TextField>
      <TextField label="Patient co-pay %" type="number" value={f.coPayPercent} onChange={(e) => setF({ ...f, coPayPercent: Number(e.target.value) })} />
      <TextField label="KRA PIN" value={f.kraPin} onChange={(e) => setF({ ...f, kraPin: e.target.value.toUpperCase() })} />
      <TextField label="eTIMS insurance code" value={f.etimsInsuranceCode} onChange={(e) => setF({ ...f, etimsInsuranceCode: e.target.value })} />
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function PaymentModeDialog({ row, onClose }: { row: PaymentMode; onClose(): void }) {
  const [code, setCode] = useState(row.etimsPaymentTypeCode);
  const save = useApiMutation<void>(() => [`/billing/payment-modes/${row.code}`, { method: 'PUT', body: { etimsPaymentTypeCode: code } }], { invalidate: ['/billing/payment-modes'], success: 'Saved' });
  return (
    <FormDialog open title={`${row.name}: eTIMS payment type`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="eTIMS payment type (code class 07)" value={code} onChange={(e) => setCode(e.target.value)}>
        {[['01', 'Cash'], ['02', 'Credit'], ['03', 'Cash/credit'], ['04', 'Bank cheque'], ['05', 'Debit & credit card'], ['06', 'Mobile money'], ['07', 'Other']].map(([c, n]) => <MenuItem key={c} value={c}>{c} {n}</MenuItem>)}
      </TextField>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ reports

type Row = Record<string, string | number | null>;

function RowsTable({ rows, money = [] }: { rows: Row[]; money?: string[] }) {
  const fmt = useMoney();
  if (!rows.length) return <Typography variant="body2">Nothing for this period.</Typography>;
  const keys = Object.keys(rows[0]);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <TableHead><TableRow>{keys.map((k) => <TableCell key={k}>{humanise(k)}</TableCell>)}</TableRow></TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>{keys.map((k) => <TableCell key={k} align={typeof r[k] === 'number' ? 'right' : 'left'}>{money.includes(k) ? fmt(r[k] as number) : String(r[k] ?? '')}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export function BillingReportsPage() {
  const today = useToday();
  const [tab, setTab] = useState(0);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState('');
  const query = { from, to, storeId: storeId || undefined };
  const paths = ['/billing/reports/vat-output', '/billing/reports/purchases-by-tax', '/billing/reports/credit-notes', '/billing/reports/reconciliation', '/billing/reports/etims-status'];
  // The sync status is a point-in-time view (no period).
  const q = tab === 4 ? { storeId: storeId || undefined } : query;
  const { data } = useQuery({ queryKey: [paths[tab], q], queryFn: () => api<unknown>(paths[tab], { query: q }) });
  const csv = tab < 3 ? buildUrl(paths[tab], { ...query, format: 'csv' }) : null;
  const rec = tab === 3 ? (data as { matched: boolean; summary: Row[]; exceptions: Row[]; receiptGaps: Row[] } | undefined) : undefined;
  const st = tab === 4 ? (data as { byStatus: Row[]; invoices: Row[]; overdue: Row[]; stock: Row[]; alertAfterMinutes: number } | undefined) : undefined;
  return (
    <>
      <PageHeader title="Tax and eTIMS reports" />
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <StoreSelect value={storeId} onChange={setStoreId} label="Outlet" allowAll="All" sx={{ minWidth: 200 }} />
        {csv && <Button href={csv}>CSV</Button>}
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="VAT output" />
        <Tab label="Purchases by tax" />
        <Tab label="Credit notes" />
        <Tab label="Reconciliation" />
        <Tab label="eTIMS sync" />
      </Tabs>
      <Paper sx={{ p: 2 }}>
        {tab === 0 && <RowsTable rows={(data as Row[]) ?? []} money={['taxable_incl_vat', 'net', 'vat']} />}
        {tab === 1 && (
          <>
            <Typography variant="body2" sx={{ mb: 1 }}>Supplier invoices by tax category; VERIFIED = found among the supplier’s sales on eTIMS.</Typography>
            <RowsTable rows={(data as Row[]) ?? []} money={['net', 'vat', 'gross']} />
          </>
        )}
        {tab === 2 && <RowsTable rows={(data as Row[]) ?? []} money={['amount', 'vat']} />}
        {rec && (
          <Stack spacing={2}>
            <Alert severity={rec.matched ? 'success' : 'warning'}>{rec.matched ? 'Local documents and eTIMS agree for this period.' : 'Differences found — see below.'}</Alert>
            <RowsTable rows={rec.summary} money={['local_total', 'etims_total']} />
            {rec.exceptions.length > 0 && <><Typography variant="subtitle2">Exceptions</Typography><RowsTable rows={rec.exceptions} money={['local_total', 'transmitted_total']} /></>}
            {rec.receiptGaps.length > 0 && <><Typography variant="subtitle2">Gaps in the CU receipt counter</Typography><RowsTable rows={rec.receiptGaps} /></>}
          </Stack>
        )}
        {st && (
          <Stack spacing={2}>
            <Typography variant="subtitle2">Outbox by outlet, kind and status</Typography>
            <RowsTable rows={st.byStatus} />
            <Typography variant="subtitle2">Sales documents</Typography>
            <RowsTable rows={st.invoices} money={['amount']} />
            <Typography variant="subtitle2">Not accepted after {st.alertAfterMinutes} minutes</Typography>
            <RowsTable rows={st.overdue} />
            <Typography variant="subtitle2">Stock movement reporting</Typography>
            <RowsTable rows={st.stock} />
            <Box><Button component={RouterLink} to="/etims">Open the eTIMS console</Button></Box>
          </Stack>
        )}
      </Paper>
    </>
  );
}

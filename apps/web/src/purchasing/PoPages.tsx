import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Permissions, PurchaseLineType, PurchaseOrderStatus } from '@sil/shared';
import { API_BASE, api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { PurchaseOrder } from '../api/purchasing-types';
import type { Department, Item, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { useNotify } from '../components/Notify';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip } from '../inventory/components';
import { formatMoney, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from './common';
import { useSupplierOptions } from './RequisitionsPages';

function AmendDialog({ po, onClose }: { po: PurchaseOrder; onClose(): void }) {
  const [reason, setReason] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState(po.expectedDelivery ?? '');
  const [lines, setLines] = useState((po.lines ?? []).map((l) => ({ lineId: l.id, name: l.item?.name ?? l.description, uom: l.uom?.code, quantity: String(l.quantity), unitPrice: String(l.unitPrice) })));
  const amend = useApiMutation<void>(
    () => [
      `/purchase-orders/${po.id}/amend`,
      { method: 'POST', body: { reason, expectedDelivery: expectedDelivery || null, lines: lines.map((l) => ({ lineId: l.lineId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) } },
    ],
    { invalidate: ['/purchase-orders', '/approvals'], success: 'Amendment submitted for approval' },
  );
  return (
    <FormDialog open maxWidth="md" title={`Amend ${po.number} (creates version ${po.version + 1})`} submitLabel="Submit amendment" onClose={onClose} submitting={amend.isPending} onSubmit={(e) => { e.preventDefault(); amend.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Reason for the amendment" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <TextField label="Expected delivery" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      {lines.map((l, i) => (
        <Stack key={l.lineId} direction="row" spacing={1} alignItems="center">
          <Typography sx={{ flexGrow: 1 }}>{l.name} ({l.uom})</Typography>
          <TextField label="Qty" type="number" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} sx={{ width: 110 }} />
          <TextField label="Unit price" type="number" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} sx={{ width: 130 }} />
        </Stack>
      ))}
    </FormDialog>
  );
}

function ReasonDialog({ title, action, po, onClose }: { title: string; action: 'cancel' | 'close'; po: PurchaseOrder; onClose(): void }) {
  const [reason, setReason] = useState('');
  const m = useApiMutation<void>(() => [`/purchase-orders/${po.id}/${action}`, { method: 'POST', body: { reason } }], { invalidate: ['/purchase-orders', '/budgets', '/approvals'], success: 'Done' });
  return (
    <FormDialog open title={title} submitLabel="Confirm" onClose={onClose} submitting={m.isPending} onSubmit={(e) => { e.preventDefault(); m.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2" color="text.secondary">The open budget commitment of this order will be released.</Typography>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
    </FormDialog>
  );
}

interface Version {
  id: string;
  version: number;
  changeReason: string | null;
  createdAt: string;
  snapshot: { total: number; status: string; lines: { lineNo: number; quantity: number; unitPrice: number }[] };
}

/** LPO / LSO for non-stock orders (services only → LSO), else purchase order. */
export function orderKind(po: PurchaseOrder): string {
  const types = (po.lines ?? []).map((l) => l.lineType ?? PurchaseLineType.STOCK);
  if (!types.length || types.includes(PurchaseLineType.STOCK)) return 'Purchase order';
  return types.every((t) => t === PurchaseLineType.SERVICE) ? 'Local service order' : 'Local purchase order';
}

export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const notify = useNotify();
  const money = useMoney();
  const date = useDate();
  const [dialog, setDialog] = useState<'amend' | 'cancel' | 'close' | null>(null);
  const { data: po } = useQuery({ queryKey: ['/purchase-orders', id], queryFn: () => api<PurchaseOrder>(`/purchase-orders/${id}`) });
  const versions = useList<Version>(`/purchase-orders/${id}/versions`);
  const emails = useList<{ id: string; toAddress: string; status: string; createdAt: string; lastError: string | null }>(`/purchase-orders/${id}/emails`);
  const submit = useApiMutation<void, PurchaseOrder>(() => [`/purchase-orders/${id}/submit`, { method: 'POST' }], { invalidate: ['/purchase-orders', '/approvals'], success: 'Submitted for approval' });
  const send = useApiMutation<void>(() => [`/purchase-orders/${id}/send`, { method: 'POST' }], { invalidate: ['/purchase-orders'], success: 'Email to the supplier queued' });
  if (!po) return null;
  const manage = can(Permissions.PURCHASING_PO);
  const s = po.status as PurchaseOrderStatus;
  const open = [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED].includes(s);
  const stock = (po.lines ?? []).some((l) => (l.lineType ?? PurchaseLineType.STOCK) === PurchaseLineType.STOCK);
  const foreign = !!po.exchangeRate && po.exchangeRate !== 1;
  // Order lines are in the order currency.
  const cur = (v: number | null | undefined) => (foreign ? formatMoney(v ?? 0, po.currency) : money(v));
  return (
    <>
      <PageHeader
        title={`${orderKind(po)} ${po.number}`}
        actions={
          <Button startIcon={<PictureAsPdfIcon />} href={`${API_BASE}/purchase-orders/${po.id}/pdf`} target="_blank" rel="noopener">
            PDF
          </Button>
        }
      />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={po.status} />
                {po.version > 1 && <Chip size="small" variant="outlined" label={`Version ${po.version}`} />}
                <Typography>{po.supplier?.name}</Typography>
                <Typography color="text.secondary">→ {po.store?.name} · {po.department?.name} · {humanise(po.source)}</Typography>
              </Stack>
              {po.lastComment && <Alert severity="warning" sx={{ mb: 2 }}>{po.lastComment}</Alert>}
              {po.cancellationReason && <Alert severity="info" sx={{ mb: 2 }}>{humanise(po.status)}: {po.cancellationReason}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Order date">{date(po.orderDate)}</Field>
                <Field label="Expected delivery">{date(po.expectedDelivery) || '—'}</Field>
                <Field label="Total (incl. VAT)">{cur(po.total)}</Field>
                {foreign && <Field label={`Base value (rate ${po.exchangeRate})`}>{money(po.baseTotal)}</Field>}
                {!!po.whtTotal && <Field label="Withholding tax">{cur(po.whtTotal)}</Field>}
                {!!po.whtTotal && <Field label="Net payable">{cur(po.total - po.whtTotal)}</Field>}
                {po.expiresOn && <Field label="Valid until">{date(po.expiresOn)}</Field>}
                <Field label="Committed">{money(po.committedTotal)}</Field>
              </Stack>
              {po.deliveryAddress && <Typography variant="body2" sx={{ mb: 1 }}>Deliver to: {po.deliveryAddress}</Typography>}
              <Table size="small" aria-label="Order lines">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell><TableCell>Item</TableCell><TableCell align="right">Qty</TableCell><TableCell>Unit</TableCell>
                    <TableCell align="right">Price</TableCell><TableCell align="right">VAT</TableCell><TableCell align="right">Total</TableCell>{stock && <TableCell align="right">Received (base)</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(po.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.lineNo}</TableCell>
                      <TableCell>
                        {l.item?.name ?? l.description}
                        {l.lineType && l.lineType !== PurchaseLineType.STOCK && <Chip size="small" variant="outlined" label={humanise(l.lineType)} sx={{ ml: 1 }} />}
                        {!!l.whtAmount && <Box sx={{ fontSize: 11, color: 'text.secondary' }}>WHT {l.whtRatePercent}%: {cur(l.whtAmount)}</Box>}
                      </TableCell>
                      <TableCell align="right">{l.quantity}</TableCell>
                      <TableCell>{l.uom?.code}{l.conversionFactor !== 1 ? ` (×${l.conversionFactor})` : ''}</TableCell>
                      <TableCell align="right">{cur(l.unitPrice)}</TableCell>
                      <TableCell align="right">{l.taxRatePercent}%</TableCell>
                      <TableCell align="right">{cur(l.lineTotal)}</TableCell>
                      {stock && <TableCell align="right">{l.itemId ? `${l.receivedBaseQty} / ${l.quantity * l.conversionFactor}` : '—'}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {po.terms && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="subtitle2">Terms</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }} color="text.secondary">{po.terms}</Typography>
                </Box>
              )}
            </Paper>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {manage && [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.RETURNED].includes(s) && (
                <Button variant="contained" onClick={() => submit.mutate(undefined, { onSuccess: (r) => r.budgetWarning && notify.info(r.budgetWarning) })}>Submit for approval</Button>
              )}
              {manage && [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.SENT].includes(s) && <Button variant="contained" onClick={() => send.mutate()}>{s === 'SENT' ? 'Resend to supplier' : 'Send to supplier'}</Button>}
              {open && stock && can(Permissions.PURCHASING_RECEIVE) && <Button variant="outlined" onClick={() => navigate(`/grns/new?poId=${po.id}`)}>Receive goods</Button>}
              {can(Permissions.PURCHASING_INVOICE) && ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(s) && <Button variant="outlined" onClick={() => navigate(`/invoices/new?poId=${po.id}`)}>Capture invoice</Button>}
              {manage && open && <Button onClick={() => setDialog('amend')}>Amend</Button>}
              {manage && [...(open ? [s] : []), PurchaseOrderStatus.RECEIVED].includes(s) && <Button onClick={() => setDialog('close')}>Close</Button>}
              {manage && !['CANCELLED', 'CLOSED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(s) && <Button color="error" onClick={() => setDialog('cancel')}>Cancel</Button>}
            </Stack>
            {(versions.data ?? []).length > 1 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Version history</Typography>
                {(versions.data ?? []).map((v) => (
                  <Typography key={v.id} variant="body2">
                    v{v.version} · {date(v.createdAt)} · {money(v.snapshot.total)} · {v.snapshot.lines.length} line(s){v.changeReason ? ` — ${v.changeReason}` : ''}
                  </Typography>
                ))}
              </Paper>
            )}
            {(emails.data ?? []).length > 0 && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>Emails</Typography>
                {(emails.data ?? []).map((e) => (
                  <Typography key={e.id} variant="body2">{date(e.createdAt)} → {e.toAddress} · {humanise(e.status)}{e.lastError ? ` (${e.lastError})` : ''}</Typography>
                ))}
              </Paper>
            )}
          </>
        }
        side={
          <>
            <ApprovalPanel type="PO" id={po.id} />
            <DocumentChain type="PO" id={po.id} />
          </>
        }
      />
      {dialog === 'amend' && <AmendDialog po={po} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <ReasonDialog title="Cancel purchase order" action="cancel" po={po} onClose={() => setDialog(null)} />}
      {dialog === 'close' && <ReasonDialog title="Close purchase order" action="close" po={po} onClose={() => setDialog(null)} />}
    </>
  );
}

/** Contract-price order without a requisition. */
function ContractPoDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const suppliers = useSupplierOptions();
  const stores = useList<Store>('/stores/directory');
  const departments = useAll<Department>('/departments');
  const [form, setForm] = useState({ supplierId: '', storeId: '', departmentId: '', budgetId: '' });
  const budgets = useList<{ id: string; label: string }>('/budgets/options', { departmentId: form.departmentId }, !!form.departmentId);
  const [lines, setLines] = useState<{ item: Item | null; quantity: string }[]>([{ item: null, quantity: '' }]);
  const create = useApiMutation<void, PurchaseOrder>(
    () => [
      '/purchase-orders',
      { method: 'POST', body: { ...form, budgetId: form.budgetId || null, lines: lines.filter((l) => l.item).map((l) => ({ itemId: l.item!.id, quantity: Number(l.quantity) })) } },
    ],
    { invalidate: ['/purchase-orders'], success: 'Draft PO created from contract prices' },
  );
  return (
    <FormDialog open maxWidth="md" title="Order from contract price list" submitLabel="Create draft PO" onClose={onClose} submitting={create.isPending} onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (po) => navigate(`/purchase-orders/${po.id}`) }); }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Supplier" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
          {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
        <TextField select label="Deliver to" value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })}>
          {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Department" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <TextField select label="Budget" value={form.budgetId} onChange={(e) => setForm({ ...form, budgetId: e.target.value })}>
          <MenuItem value="">No budget</MenuItem>
          {(budgets.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>)}
        </TextField>
      </Stack>
      {lines.map((l, i) => (
        <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <ItemPicker value={l.item} onChange={(item) => setLines(lines.map((x, j) => (j === i ? { ...x, item } : x)))} />
          <TextField label="Qty (base units)" type="number" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} sx={{ width: 160 }} />
        </Stack>
      ))}
      <Box><Button onClick={() => setLines([...lines, { item: null, quantity: '' }])}>Add item</Button></Box>
    </FormDialog>
  );
}

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<PurchaseOrder>('/purchase-orders', { ...pagination, search: q, status });
  const columns: GridColDef<PurchaseOrder>[] = [
    { field: 'number', headerName: 'Number', width: 170 },
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 220, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'store', headerName: 'Deliver to', width: 150, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'total', headerName: 'Total', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'status', headerName: 'Status', width: 180, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'orderDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Purchase orders"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search number or supplier"
        onNew={can(Permissions.PURCHASING_PO) ? () => setOpen(true) : undefined}
        newLabel="Contract order"
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 190 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(PurchaseOrderStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/purchase-orders/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
      {open && <ContractPoDialog onClose={() => setOpen(false)} />}
    </>
  );
}

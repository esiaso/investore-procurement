import {
  Alert,
  Box,
  Button,
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
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DepartmentReturnStatus, Paginated, Permissions, ReturnCondition, SupplierReturnStatus } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { StockRow } from '../api/inventory-types';
import type { DepartmentReturn, ReturnableLine, ReturnReason, SupplierReturn } from '../api/stores-types';
import type { Supplier } from '../api/purchasing-types';
import type { Bin, Department, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ExpiryChip, StatusChip, StoreSelect, WitnessFields, WitnessValue } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';

// ------------------------------------------------------------------ department returns

interface ReturnDraft {
  quantity: number;
  reasonCode: string;
  condition: ReturnCondition;
  binId: string;
}

export function DepartmentReturnFormPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const departments = useAll<Department>('/departments');
  const stores = useList<Store>('/stores/directory');
  const reasons = useList<ReturnReason>('/return-reasons', { for: 'DEPARTMENT' });
  const ownOnly = user?.storeIds !== null && !!user?.departmentId;
  const [departmentId, setDepartmentId] = useState(user?.departmentId ?? '');
  const [storeId, setStoreId] = useState('');
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ReturnDraft>>({});
  const returnable = useList<ReturnableLine>('/department-returns/returnable', { departmentId, storeId }, !!departmentId && !!storeId);
  const storeUser = can(Permissions.INVENTORY_DEPT_RETURN) && (user?.storeIds === null || !!user?.storeIds?.includes(storeId));
  const bins = useAll<Bin>('/bins', { storeId }, !!storeId && storeUser);
  const chosen = (returnable.data ?? []).filter((l) => (drafts[l.issueVoucherLineId]?.quantity ?? 0) > 0);
  const invalid = chosen.some((l) => drafts[l.issueVoucherLineId].quantity > l.returnableQty || !drafts[l.issueVoucherLineId].reasonCode);
  const save = useApiMutation<void, DepartmentReturn>(
    () => [
      '/department-returns',
      {
        method: 'POST',
        body: {
          departmentId,
          storeId,
          notes: notes || undefined,
          lines: chosen.map((l) => {
            const d = drafts[l.issueVoucherLineId];
            return {
              itemId: l.itemId,
              batchId: l.batchId,
              issueVoucherLineId: l.issueVoucherLineId,
              quantity: d.quantity,
              reasonCode: d.reasonCode,
              condition: d.condition,
              binId: d.condition === ReturnCondition.RESALEABLE && d.binId ? d.binId : undefined,
              patientRef: l.patientRef ?? undefined,
            };
          }),
        },
      },
    ],
    { invalidate: ['/department-returns'], success: 'Return raised' },
  );
  const blank: ReturnDraft = { quantity: 0, reasonCode: '', condition: ReturnCondition.RESALEABLE, binId: '' };
  const set = (key: string, patch: Partial<ReturnDraft>) => setDrafts((d) => ({ ...d, [key]: { ...blank, ...d[key], ...patch } }));
  return (
    <>
      <PageHeader title="Return stock to the store" />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField select label="Department / ward" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ minWidth: 220, width: 'auto' }}>
              {(departments.data ?? []).filter((d) => !ownOnly || d.id === user?.departmentId).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
            </TextField>
            <TextField select label="Return to" value={storeId} onChange={(e) => setStoreId(e.target.value)} sx={{ minWidth: 220, width: 'auto' }}>
              {(stores.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
            </TextField>
          </Stack>
          {departmentId && storeId && (returnable.data ?? []).length === 0 && !returnable.isFetching && (
            <Alert severity="info">Nothing issued from this store to this department can still be returned.</Alert>
          )}
          {(returnable.data ?? []).length > 0 && (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Returnable stock">
                <TableHead>
                  <TableRow>
                    <TableCell>Issued</TableCell>
                    <TableCell>Item</TableCell>
                    <TableCell>Batch</TableCell>
                    <TableCell align="right">Returnable</TableCell>
                    <TableCell align="right">Return</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell>Condition</TableCell>
                    {storeUser && <TableCell>Bin</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {returnable.data!.map((l) => {
                    const d = drafts[l.issueVoucherLineId];
                    return (
                      <TableRow key={l.issueVoucherLineId}>
                        <TableCell>{l.voucherNo}</TableCell>
                        <TableCell>{l.itemName}{l.patientRef && <Typography variant="caption" display="block">Patient {l.patientRef}</Typography>}</TableCell>
                        <TableCell>{l.batchNo} <ExpiryChip date={l.expiryDate} /></TableCell>
                        <TableCell align="right">{l.returnableQty} {l.uom}</TableCell>
                        <TableCell align="right">
                          <TextField size="small" type="number" value={d?.quantity ?? 0} error={(d?.quantity ?? 0) > l.returnableQty} onChange={(e) => set(l.issueVoucherLineId, { quantity: Math.max(0, Number(e.target.value) || 0) })} slotProps={{ htmlInput: { min: 0, 'aria-label': `Return quantity of ${l.itemName} ${l.batchNo}` } }} sx={{ width: 90 }} />
                        </TableCell>
                        <TableCell>
                          <TextField select size="small" value={d?.reasonCode ?? ''} onChange={(e) => set(l.issueVoucherLineId, { reasonCode: e.target.value })} sx={{ minWidth: 180, width: 'auto' }} slotProps={{ htmlInput: { 'aria-label': 'Reason' } }}>
                            {(reasons.data ?? []).map((r) => <MenuItem key={r.code} value={r.code}>{r.name}</MenuItem>)}
                          </TextField>
                        </TableCell>
                        <TableCell>
                          <TextField select size="small" value={d?.condition ?? ReturnCondition.RESALEABLE} onChange={(e) => set(l.issueVoucherLineId, { condition: e.target.value as ReturnCondition })} sx={{ minWidth: 140, width: 'auto' }} slotProps={{ htmlInput: { 'aria-label': 'Condition' } }}>
                            {Object.values(ReturnCondition).map((c) => <MenuItem key={c} value={c}>{humanise(c)}</MenuItem>)}
                          </TextField>
                        </TableCell>
                        {storeUser && (
                          <TableCell>
                            <TextField select size="small" value={d?.binId ?? ''} disabled={(d?.condition ?? ReturnCondition.RESALEABLE) !== ReturnCondition.RESALEABLE} onChange={(e) => set(l.issueVoucherLineId, { binId: e.target.value })} sx={{ minWidth: 120, width: 'auto' }} slotProps={{ htmlInput: { 'aria-label': 'Bin' } }}>
                              <MenuItem value="">No bin</MenuItem>
                              {(bins.data ?? []).filter((b) => b.isActive && !b.isQuarantine).map((b) => <MenuItem key={b.id} value={b.id}>{b.code}</MenuItem>)}
                            </TextField>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}
          <Alert severity="info" variant="outlined">Resaleable stock goes back on the same batch; damaged or expired stock goes to the store's quarantine bin. The department is credited at the cost it was charged.</Alert>
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
          <Box>
            <Button variant="contained" disabled={!chosen.length || invalid || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r) => navigate(`/department-returns/${r.id}`) })}>
              Raise return
            </Button>
          </Box>
        </Stack>
      </Paper>
    </>
  );
}

export function DepartmentReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [witness, setWitness] = useState<WitnessValue>({ username: '', password: '' });
  const { data: r } = useQuery({ queryKey: ['/department-returns', id], queryFn: () => api<DepartmentReturn>(`/department-returns/${id}`) });
  const inv = ['/department-returns', '/inventory', '/issues', '/documents', '/consumption'];
  const post = useApiMutation<void>(() => [`/department-returns/${id}/post`, { method: 'POST', body: { witness: controlled ? witness : undefined } }], { invalidate: inv, success: 'Return posted' });
  const cancel = useApiMutation<void>(() => [`/department-returns/${id}/cancel`, { method: 'POST' }], { invalidate: inv, success: 'Return cancelled' });
  if (!r) return null;
  const controlled = (r.lines ?? []).some((l) => l.item?.isControlled);
  const store = can(Permissions.INVENTORY_DEPT_RETURN) && (user?.storeIds === null || !!user?.storeIds?.includes(r.storeId));
  const draft = r.status === DepartmentReturnStatus.DRAFT;
  return (
    <>
      <PageHeader title={`Department return ${r.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
                <StatusChip status={r.status} />
                <Field label="From">{r.department?.name}</Field>
                <Field label="To">{r.store?.name}</Field>
                <Field label="Date">{date(r.returnDate ?? r.createdAt)}</Field>
                {!draft && <Field label="Credited">{money(r.totalValue)}</Field>}
              </Stack>
              {r.notes && <Typography variant="body2" sx={{ mb: 2 }}>{r.notes}</Typography>}
              <Table size="small" aria-label="Returned stock">
                <TableHead>
                  <TableRow><TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell align="right">Qty</TableCell><TableCell>Reason</TableCell><TableCell>Condition</TableCell>{!draft && <TableCell align="right">Value</TableCell>}</TableRow>
                </TableHead>
                <TableBody>
                  {(r.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.item?.name}</TableCell>
                      <TableCell>{l.batch?.batchNo}</TableCell>
                      <TableCell align="right">{l.quantity} {l.item?.baseUom?.code}</TableCell>
                      <TableCell>{l.reasonCode}</TableCell>
                      <TableCell>{humanise(l.condition)}</TableCell>
                      {!draft && <TableCell align="right">{money(l.value)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            {draft && store && controlled && <Paper sx={{ p: 2 }}><WitnessFields value={witness} onChange={setWitness} /></Paper>}
            {draft && (
              <Stack direction="row" spacing={1}>
                {store && <Button variant="contained" disabled={post.isPending} onClick={() => post.mutate()}>Receive and post</Button>}
                {(store || r.requestedBy === user?.id) && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
              </Stack>
            )}
          </>
        }
        side={<DocumentChain type="DRT" id={r.id} />}
      />
    </>
  );
}

export function DepartmentReturnsPage() {
  const { canAny } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<DepartmentReturn>('/department-returns', { ...pagination, status });
  const columns: GridColDef<DepartmentReturn>[] = [
    { field: 'number', headerName: 'Number', width: 180 },
    { field: 'department', headerName: 'Department', width: 170, valueGetter: (_v, r) => r.department?.name ?? '' },
    { field: 'store', headerName: 'To', flex: 1, minWidth: 150, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'totalValue', headerName: 'Credited', type: 'number', width: 130, valueFormatter: (v: number) => (v ? money(v) : '') },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Department returns"
        onNew={canAny(Permissions.INVENTORY_REQUISITION, Permissions.INVENTORY_DEPT_RETURN) ? () => navigate('/department-returns/new') : undefined}
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 160 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(DepartmentReturnStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/department-returns/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ returns to supplier

export function SupplierReturnFormPage() {
  const navigate = useNavigate();
  const suppliers = useAll<Supplier>('/suppliers');
  const reasons = useList<ReturnReason>('/return-reasons', { for: 'SUPPLIER' });
  const [params] = useSearchParams();
  const [supplierId, setSupplierId] = useState('');
  const [storeId, setStoreId] = useState(params.get('storeId') ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const q = useDebounced(search);
  const stock = useQuery({
    queryKey: ['/inventory/stock', 'rts', storeId, q],
    queryFn: () => api<Paginated<StockRow>>('/inventory/stock', { query: { storeId, search: q, groupBy: 'batch', pageSize: 100 } }),
    enabled: !!storeId,
  });
  const rows = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const chosen = Object.entries(qty).filter(([, v]) => v > 0);
  const save = useApiMutation<void, SupplierReturn>(
    () => [
      '/supplier-returns',
      {
        method: 'POST',
        body: {
          supplierId,
          storeId,
          reasonCode,
          notes: notes || undefined,
          lines: chosen.map(([rowId, quantity]) => {
            const r = rows.find((x) => x.id === rowId)!;
            return { batchId: r.batchId, binId: r.binId ?? null, quantity };
          }),
        },
      },
    ],
    { invalidate: ['/supplier-returns'], success: 'Return drafted' },
  );
  return (
    <>
      <PageHeader title="Return stock to a supplier" />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} sx={{ minWidth: 240, width: 'auto' }}>
              {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
            </TextField>
            <StoreSelect value={storeId} onChange={(v) => { setStoreId(v); setQty({}); }} label="From store" sx={{ minWidth: 220 }} />
            <TextField select label="Reason" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} sx={{ minWidth: 220, width: 'auto' }}>
              {(reasons.data ?? []).map((r) => <MenuItem key={r.code} value={r.code}>{r.name}</MenuItem>)}
            </TextField>
          </Stack>
          {storeId && <TextField label="Find item or batch" value={search} onChange={(e) => setSearch(e.target.value)} />}
          {rows.length > 0 && (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Stock to return">
                <TableHead>
                  <TableRow><TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell>Expiry</TableCell><TableCell>Bin</TableCell><TableCell align="right">On hand</TableCell><TableCell align="right">Reserved</TableCell><TableCell align="right">Return</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.itemName}</TableCell>
                      <TableCell>{r.batchNo} {r.holdStatus && r.holdStatus !== 'NONE' ? `(${humanise(r.holdStatus)})` : ''}</TableCell>
                      <TableCell><ExpiryChip date={r.expiryDate} /></TableCell>
                      <TableCell>{r.binCode ?? '—'}{r.inQuarantine ? ' (quarantine)' : ''}</TableCell>
                      <TableCell align="right">{r.onHand}</TableCell>
                      <TableCell align="right">{r.reserved || ''}</TableCell>
                      <TableCell align="right">
                        <TextField size="small" type="number" value={qty[r.id!] ?? 0} error={(qty[r.id!] ?? 0) > r.onHand - r.reserved} onChange={(e) => setQty({ ...qty, [r.id!]: Math.max(0, Number(e.target.value) || 0) })} slotProps={{ htmlInput: { min: 0, 'aria-label': `Return quantity of ${r.itemName} ${r.batchNo}` } }} sx={{ width: 90 }} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
          <Alert severity="info" variant="outlined">Expired, held and quarantined stock can be returned; stock reserved for requisitions cannot. Stock leaves the store when the return is dispatched.</Alert>
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
          <Box>
            <Button variant="contained" disabled={!supplierId || !storeId || !reasonCode || !chosen.length || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r) => navigate(`/supplier-returns/${r.id}`) })}>
              Save draft
            </Button>
          </Box>
        </Stack>
      </Paper>
    </>
  );
}

function CreditNoteDialog({ rts, onClose }: { rts: SupplierReturn; onClose(): void }) {
  const [form, setForm] = useState({ creditNoteNo: '', creditNoteDate: '', amount: String(rts.totalValue) });
  const save = useApiMutation<void>(() => [`/supplier-returns/${rts.id}/credit-note`, { method: 'POST', body: { ...form, amount: Number(form.amount) } }], {
    invalidate: ['/supplier-returns', '/documents'],
    success: 'Credit note recorded',
  });
  return (
    <FormDialog open title="Record supplier credit note" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Credit note number" value={form.creditNoteNo} onChange={(e) => setForm({ ...form, creditNoteNo: e.target.value })} required />
      <TextField label="Date" type="date" value={form.creditNoteDate} onChange={(e) => setForm({ ...form, creditNoteDate: e.target.value })} required slotProps={{ inputLabel: { shrink: true } }} />
      <TextField label="Amount" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
    </FormDialog>
  );
}

export function SupplierReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, can, canAny } = useAuth();
  const money = useMoney();
  const date = useDate();
  const [credit, setCredit] = useState(false);
  const [witness, setWitness] = useState<WitnessValue>({ username: '', password: '' });
  const { data: r } = useQuery({ queryKey: ['/supplier-returns', id], queryFn: () => api<SupplierReturn>(`/supplier-returns/${id}`) });
  const inv = ['/supplier-returns', '/inventory', '/documents'];
  const dispatch = useApiMutation<void>(() => [`/supplier-returns/${id}/dispatch`, { method: 'POST', body: { witness: controlled ? witness : undefined } }], { invalidate: inv, success: 'Dispatched to supplier' });
  const cancel = useApiMutation<void>(() => [`/supplier-returns/${id}/cancel`, { method: 'POST' }], { invalidate: inv, success: 'Cancelled' });
  if (!r) return null;
  const controlled = (r.lines ?? []).some((l) => l.item?.isControlled);
  const store = can(Permissions.INVENTORY_SUPPLIER_RETURN) && (user?.storeIds === null || !!user?.storeIds?.includes(r.storeId));
  const draft = r.status === SupplierReturnStatus.DRAFT;
  return (
    <>
      <PageHeader title={`Return to supplier ${r.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
                <StatusChip status={r.status} />
                <Field label="Supplier">{r.supplier?.name}</Field>
                <Field label="From">{r.store?.name}</Field>
                <Field label="Source">{r.source === 'GRN_REJECT' ? 'Rejected at inspection' : 'From stock'}</Field>
                <Field label="Reason">{r.reasonCode}</Field>
                <Field label="Debit note value">{money(r.totalValue)}</Field>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="GRN">{r.grn?.number ?? '—'}</Field>
                <Field label="PO">{r.purchaseOrder?.number ?? '—'}</Field>
                <Field label="Returned">{date(r.returnDate) || '—'}</Field>
                {r.creditNoteNo && <Field label="Credit note">{r.creditNoteNo} · {date(r.creditNoteDate)} · {money(r.creditNoteAmount)}</Field>}
              </Stack>
              {r.creditVariance ? <Alert severity="warning" sx={{ mb: 2 }}>Credit note differs from the return value by {money(r.creditVariance)}.</Alert> : null}
              {r.notes && <Typography variant="body2" sx={{ mb: 2 }}>{r.notes}</Typography>}
              <Table size="small" aria-label="Returned goods">
                <TableHead>
                  <TableRow><TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Unit cost</TableCell><TableCell align="right">Value</TableCell><TableCell>Note</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {(r.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.item?.name}</TableCell>
                      <TableCell>{l.batchNo ?? '—'}</TableCell>
                      <TableCell align="right">{l.quantity} {l.item?.baseUom?.code}</TableCell>
                      <TableCell align="right">{money(l.unitCost)}</TableCell>
                      <TableCell align="right">{money(l.value)}</TableCell>
                      <TableCell>{l.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            {draft && store && controlled && <Paper sx={{ p: 2 }}><WitnessFields value={witness} onChange={setWitness} /></Paper>}
            <Stack direction="row" spacing={1}>
              {draft && store && <Button variant="contained" disabled={dispatch.isPending} onClick={() => dispatch.mutate()}>Dispatch (post out of stock)</Button>}
              {draft && store && <Button color="error" onClick={() => cancel.mutate()}>Cancel</Button>}
              {r.status === 'DISPATCHED' && canAny(Permissions.PURCHASING_INVOICE, Permissions.INVENTORY_SUPPLIER_RETURN) && <Button variant="outlined" onClick={() => setCredit(true)}>Record credit note</Button>}
            </Stack>
          </>
        }
        side={r.grnId ? <DocumentChain type="RTS" id={r.id} /> : undefined}
      />
      {credit && <CreditNoteDialog rts={r} onClose={() => setCredit(false)} />}
    </>
  );
}

export function SupplierReturnsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<SupplierReturn>('/supplier-returns', { ...pagination, search: q, status });
  const columns: GridColDef<SupplierReturn>[] = [
    { field: 'number', headerName: 'Number', width: 170 },
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 180, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'source', headerName: 'Source', width: 140, valueFormatter: (v: string) => (v === 'GRN_REJECT' ? 'Inspection reject' : 'Stock') },
    { field: 'grn', headerName: 'GRN', width: 170, valueGetter: (_v, r) => r.grn?.number ?? '' },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'totalValue', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number) => money(v) },
    { field: 'creditNoteNo', headerName: 'Credit note', width: 130 },
    { field: 'createdAt', headerName: 'Raised', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Returns to supplier"
        search={search}
        onSearch={setSearch}
        onNew={can(Permissions.INVENTORY_SUPPLIER_RETURN) ? () => navigate('/supplier-returns/new') : undefined}
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 160 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(SupplierReturnStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/supplier-returns/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

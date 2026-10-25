import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import {
  Alert,
  Box,
  Button,
  InputAdornment,
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
import { KeyboardEvent, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { GrnStatus, Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, usePaged } from '../api/hooks';
import type { Grn, PurchaseOrder } from '../api/purchasing-types';
import type { Bin, Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useNotify } from '../components/Notify';
import { PageHeader } from '../components/PageHeader';
import { ExpiryChip, ItemPicker, StatusChip, StoreSelect, WitnessFields } from '../inventory/components';
import { humanise } from '../lib/format';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { DetailLayout, DocumentChain, Field, useDate, useMoney } from './common';
import { useSupplierOptions } from './RequisitionsPages';

interface LineDraft {
  key: string;
  poLineId?: string;
  item?: Item | null;
  label: string;
  unit: string;
  remaining?: number;
  quantity: string;
  batchNo: string;
  expiryDate: string;
  unitPrice: string;
  binId: string;
  batchTracked: boolean;
}

/** GRN entry. Scanning a GTIN/barcode jumps to the matching PO line's quantity. */
export function GrnFormPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const poId = params.get('poId');
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [deliveryNoteNo, setDeliveryNoteNo] = useState('');
  const [receiptTemp, setReceiptTemp] = useState<number | ''>('');
  const [shipmentId, setShipmentId] = useState('');
  const [emergencyReason, setEmergencyReason] = useState('');
  const [scan, setScan] = useState('');
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const { data: po } = useQuery({ queryKey: ['/purchase-orders', poId], queryFn: () => api<PurchaseOrder>(`/purchase-orders/${poId}`), enabled: !!poId });
  const effectiveStore = po?.storeId ?? storeId;
  const shipments = useQuery({ queryKey: ['/shipments', 'po', poId], queryFn: () => api<{ id: string; number: string; status: string; expectedOn: string }[]>('/shipments', { query: { purchaseOrderId: poId! } }), enabled: !!poId });
  const openShipments = (shipments.data ?? []).filter((s) => !['RECEIVED', 'CANCELLED'].includes(s.status));
  const coldChain = (po?.lines ?? []).some((l) => l.item?.isColdChain);
  const bins = useAll<Bin>('/bins', { storeId: effectiveStore }, !!effectiveStore);
  const initial = useMemo<LineDraft[]>(
    () =>
      (po?.lines ?? [])
        .map((l) => ({
          key: l.id,
          poLineId: l.id,
          item: l.item as Item,
          label: `${l.lineNo}. ${l.item?.name}`,
          unit: `${l.uom?.code}${l.conversionFactor !== 1 ? ` of ${l.conversionFactor}` : ''}`,
          remaining: Math.round(((l.quantity * l.conversionFactor - l.receivedBaseQty) / l.conversionFactor) * 10_000) / 10_000,
          quantity: '',
          batchNo: '',
          expiryDate: '',
          unitPrice: '',
          binId: '',
          batchTracked: !!l.item?.isBatchTracked,
        }))
        .filter((l) => (l.remaining ?? 0) > 0),
    [po],
  );
  const [edits, setEdits] = useState<Record<string, Partial<LineDraft>>>({});
  const [extra, setExtra] = useState<LineDraft[]>([]);
  const lines: LineDraft[] = [...initial, ...extra].map((l) => ({ ...l, ...(edits[l.key] ?? {}) }));
  const set = (key: string, patch: Partial<LineDraft>) => setEdits({ ...edits, [key]: { ...edits[key], ...patch } });

  const onScan = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !scan.trim()) return;
    e.preventDefault();
    const code = scan.trim();
    const hit = lines.find((l) => l.item && (l.item.gtin === code || l.item.barcode === code || l.item.code.toLowerCase() === code.toLowerCase()));
    if (hit) {
      qtyRefs.current[hit.key]?.focus();
      setScan('');
    } else notify.error(`${code} is not on this order`);
  };

  const save = useApiMutation<void, Grn>(
    () => [
      '/grns',
      {
        method: 'POST',
        body: {
          purchaseOrderId: poId ?? undefined,
          supplierId: poId ? undefined : supplierId,
          storeId: poId ? undefined : storeId,
          deliveryNoteNo: deliveryNoteNo || undefined,
          receiptTemperatureC: receiptTemp === '' ? undefined : Number(receiptTemp),
          shipmentId: shipmentId || undefined,
          emergencyReason: poId ? undefined : emergencyReason,
          lines: lines
            .filter((l) => Number(l.quantity) > 0)
            .map((l) => ({
              poLineId: l.poLineId,
              itemId: l.poLineId ? undefined : l.item?.id,
              quantity: Number(l.quantity),
              batchNo: l.batchNo || undefined,
              expiryDate: l.expiryDate || null,
              unitPrice: l.unitPrice ? Number(l.unitPrice) : undefined,
              binId: l.binId || null,
            })),
        },
      },
    ],
    { invalidate: ['/grns', '/purchase-orders'], success: 'GRN saved' },
  );

  return (
    <>
      <PageHeader title={poId ? `Receive goods: ${po?.number ?? ''}` : 'Emergency receipt (no purchase order)'} />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          {!poId && (
            <>
              <Alert severity="warning">Goods received without a PO are flagged for regularisation: a PO must be raised and linked afterwards.</Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
                </TextField>
                <StoreSelect value={storeId} onChange={setStoreId} sx={{ width: '100%' }} />
              </Stack>
              <TextField label="Why there is no PO" value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} required />
            </>
          )}
          {po && <Typography color="text.secondary">{po.supplier?.name} → {po.store?.name}</Typography>}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Supplier delivery note no." value={deliveryNoteNo} onChange={(e) => setDeliveryNoteNo(e.target.value)} />
            {openShipments.length > 0 && (
              <TextField select label="Shipment" value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} sx={{ minWidth: 200 }}>
                <MenuItem value="">Not on a notified shipment</MenuItem>
                {openShipments.map((s) => <MenuItem key={s.id} value={s.id}>{s.number} (expected {s.expectedOn})</MenuItem>)}
              </TextField>
            )}
            {(coldChain || !poId) && (
              <TextField label="Temperature on arrival (°C)" type="number" value={receiptTemp} onChange={(e) => setReceiptTemp(e.target.value === '' ? '' : Number(e.target.value))} helperText="Out of range holds the cold-chain batches" sx={{ width: 220 }} />
            )}
            {poId && (
              <TextField
                label="Scan barcode"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={onScan}
                autoFocus
                slotProps={{ input: { startAdornment: <InputAdornment position="start"><QrCodeScannerIcon /></InputAdornment> } }}
                helperText="Scan or type a GTIN and press Enter to jump to its line"
              />
            )}
          </Stack>
          <Table size="small" aria-label="Received lines">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell><TableCell>Unit</TableCell><TableCell align="right">Outstanding</TableCell>
                <TableCell>Received</TableCell><TableCell>Batch</TableCell><TableCell>Expiry</TableCell>
                {!poId && <TableCell>Unit price</TableCell>}<TableCell>Bin</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.key}>
                  <TableCell sx={{ minWidth: 220 }}>
                    {l.poLineId ? l.label : <ItemPicker value={l.item ?? null} onChange={(item) => set(l.key, { item, batchTracked: !!item?.isBatchTracked, unit: item?.baseUom?.code ?? '' })} />}
                  </TableCell>
                  <TableCell>{l.unit}</TableCell>
                  <TableCell align="right">{l.remaining ?? ''}</TableCell>
                  <TableCell>
                    <TextField type="number" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} inputRef={(el) => (qtyRefs.current[l.key] = el)} sx={{ width: 100 }} slotProps={{ htmlInput: { 'aria-label': `Received quantity ${l.label}` } }} />
                  </TableCell>
                  <TableCell><TextField value={l.batchNo} onChange={(e) => set(l.key, { batchNo: e.target.value })} required={l.batchTracked} sx={{ width: 120 }} slotProps={{ htmlInput: { 'aria-label': 'Batch number' } }} /></TableCell>
                  <TableCell><TextField type="date" value={l.expiryDate} onChange={(e) => set(l.key, { expiryDate: e.target.value })} required={l.batchTracked} sx={{ width: 160 }} slotProps={{ htmlInput: { 'aria-label': 'Expiry date' } }} /></TableCell>
                  {!poId && <TableCell><TextField type="number" value={l.unitPrice} onChange={(e) => set(l.key, { unitPrice: e.target.value })} sx={{ width: 110 }} /></TableCell>}
                  <TableCell>
                    <TextField select value={l.binId} onChange={(e) => set(l.key, { binId: e.target.value })} sx={{ width: 120 }} slotProps={{ htmlInput: { 'aria-label': 'Bin' } }}>
                      <MenuItem value="">—</MenuItem>
                      {(bins.data ?? []).map((b) => <MenuItem key={b.id} value={b.id}>{b.code}</MenuItem>)}
                    </TextField>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!poId && (
            <Box>
              <Button onClick={() => setExtra([...extra, { key: `x${extra.length}`, label: '', unit: '', quantity: '', batchNo: '', expiryDate: '', unitPrice: '', binId: '', batchTracked: false, item: null }])}>
                Add item
              </Button>
            </Box>
          )}
          <Box>
            <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (g) => navigate(`/grns/${g.id}`) })}>
              Save GRN
            </Button>
          </Box>
        </Stack>
      </Paper>
    </>
  );
}

export function GrnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const money = useMoney();
  const date = useDate();
  const { data: grn } = useQuery({ queryKey: ['/grns', id], queryFn: () => api<Grn>(`/grns/${id}`) });
  const [inspection, setInspection] = useState<Record<string, { accepted: string; rejected: string; reason: string }>>({});
  const [notes, setNotes] = useState('');
  const [witness, setWitness] = useState({ username: '', password: '' });
  const [poToLink, setPoToLink] = useState('');
  const pos = usePaged<PurchaseOrder>('/purchase-orders', { page: 0, pageSize: 50, supplierId: grn?.supplierId, status: 'SENT' }, !!grn?.isEmergency);
  const submit = useApiMutation<void>(() => [`/grns/${id}/submit`, { method: 'POST' }], { invalidate: ['/grns'], success: 'Sent for inspection' });
  const inspect = useApiMutation<boolean>(
    (withLines) => [
      `/grns/${id}/inspect`,
      {
        method: 'POST',
        body: {
          notes: notes || undefined,
          lines: withLines
            ? (grn?.lines ?? []).map((l) => {
                const r = inspection[l.id];
                const accepted = r?.accepted !== undefined && r.accepted !== '' ? Number(r.accepted) : l.receivedBaseQty - Number(r?.rejected || 0);
                return { lineId: l.id, acceptedQty: accepted, rejectedQty: Number(r?.rejected || 0), rejectionReason: r?.reason || undefined };
              })
            : undefined,
        },
      },
    ],
    { invalidate: ['/grns'], success: 'Inspection recorded' },
  );
  const post = useApiMutation<void>(() => [`/grns/${id}/post`, { method: 'POST', body: { witness: witness.username ? witness : undefined } }], {
    invalidate: ['/grns', '/purchase-orders', '/inventory', '/documents'],
    success: 'Posted to stock',
  });
  const regularise = useApiMutation<void>(() => [`/grns/${id}/regularise`, { method: 'POST', body: { purchaseOrderId: poToLink } }], { invalidate: ['/grns', '/purchase-orders', '/documents'], success: 'Linked to the PO' });
  if (!grn) return null;
  const inInspection = grn.status === GrnStatus.INSPECTION;
  const canInspect = can(Permissions.PURCHASING_INSPECT) && inInspection && grn.receivedBy !== user?.id;
  const controlled = (grn.lines ?? []).some((l) => l.item?.isControlled);
  return (
    <>
      <PageHeader title={`GRN ${grn.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={grn.status} />
                {grn.isEmergency && <StatusChip status={grn.regularisationStatus === 'PENDING' ? 'PENDING' : 'REGULARISED'} />}
                <Typography>{grn.supplier?.name} → {grn.store?.name}</Typography>
              </Stack>
              {grn.isEmergency && <Alert severity="warning" sx={{ mb: 2 }}>Emergency receipt: {grn.emergencyReason}</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Received">{date(grn.receivedDate)}</Field>
                <Field label="Delivery note">{grn.deliveryNoteNo ?? '—'}</Field>
                {grn.receiptTemperatureC != null && <Field label="Arrival temperature">{grn.receiptTemperatureC} °C</Field>}
                <Field label="PO">{grn.purchaseOrder?.number ?? '—'}</Field>
                <Field label="Inspection sign-offs">{grn.inspectedBy.length}</Field>
              </Stack>
              <Table size="small" aria-label="GRN lines">
                <TableHead>
                  <TableRow>
                    <TableCell>Item</TableCell><TableCell>Batch</TableCell><TableCell>Expiry</TableCell>
                    <TableCell align="right">Received (base)</TableCell><TableCell align="right">Accepted</TableCell><TableCell align="right">Rejected</TableCell><TableCell align="right">Price</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(grn.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{l.item?.name}</TableCell>
                      <TableCell>{l.batchNo}</TableCell>
                      <TableCell><ExpiryChip date={l.expiryDate} /></TableCell>
                      <TableCell align="right">{l.receivedBaseQty}</TableCell>
                      <TableCell align="right">
                        {canInspect ? (
                          <TextField type="number" defaultValue={l.acceptedBaseQty || l.receivedBaseQty} onChange={(e) => setInspection({ ...inspection, [l.id]: { ...(inspection[l.id] ?? { rejected: '0', reason: '' }), accepted: e.target.value } })} sx={{ width: 100 }} slotProps={{ htmlInput: { 'aria-label': `Accepted ${l.item?.name}` } }} />
                        ) : (
                          l.acceptedBaseQty
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {canInspect ? (
                          <Stack spacing={0.5}>
                            <TextField type="number" defaultValue={l.rejectedBaseQty} onChange={(e) => setInspection({ ...inspection, [l.id]: { ...(inspection[l.id] ?? { accepted: '', reason: '' }), rejected: e.target.value } })} sx={{ width: 100 }} slotProps={{ htmlInput: { 'aria-label': `Rejected ${l.item?.name}` } }} />
                            {Number(inspection[l.id]?.rejected || 0) > 0 && (
                              <TextField placeholder="Reason" value={inspection[l.id]?.reason ?? ''} onChange={(e) => setInspection({ ...inspection, [l.id]: { ...inspection[l.id], reason: e.target.value } })} />
                            )}
                          </Stack>
                        ) : (
                          <>
                            {l.rejectedBaseQty}
                            {l.rejectionReason && <Typography variant="caption" display="block">{l.rejectionReason}</Typography>}
                          </>
                        )}
                      </TableCell>
                      <TableCell align="right">{money(l.unitPrice)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
            <Stack spacing={1}>
              {grn.status === GrnStatus.DRAFT && grn.receivedBy === user?.id && (
                <Box><Button variant="contained" onClick={() => submit.mutate()}>Send for inspection</Button></Box>
              )}
              {canInspect && (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField label="Inspection notes" value={notes} onChange={(e) => setNotes(e.target.value)} sx={{ flexGrow: 1 }} />
                  <Button variant="contained" onClick={() => inspect.mutate(true)}>Record results</Button>
                  {grn.inspectedBy.length > 0 && !grn.inspectedBy.includes(user?.id ?? '') && <Button onClick={() => inspect.mutate(false)}>Confirm as committee member</Button>}
                </Stack>
              )}
              {inInspection && can(Permissions.PURCHASING_RECEIVE) && (
                <>
                  {controlled && <WitnessFields value={witness} onChange={setWitness} />}
                  <Box><Button variant="contained" color="success" onClick={() => post.mutate()}>Post accepted goods to stock</Button></Box>
                </>
              )}
              {grn.isEmergency && grn.status === 'POSTED' && grn.regularisationStatus === 'PENDING' && can(Permissions.PURCHASING_PO) && (
                <Stack direction="row" spacing={1}>
                  <TextField select label="Regularise with PO" value={poToLink} onChange={(e) => setPoToLink(e.target.value)} sx={{ minWidth: 260 }}>
                    {(pos.data?.items ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.number} · {money(p.total)}</MenuItem>)}
                  </TextField>
                  <Button disabled={!poToLink} onClick={() => regularise.mutate()}>Link</Button>
                </Stack>
              )}
            </Stack>
            {(grn.returns ?? []).map((r) => (
              <Paper key={r.id} sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>Return to supplier {r.number}</Typography>
                {r.lines.map((l, i) => (
                  <Typography key={i} variant="body2">{l.itemName} · batch {l.batchNo ?? '—'} · {l.quantity} · {l.reason}</Typography>
                ))}
              </Paper>
            ))}
          </>
        }
        side={
          <>
            <AttachmentsPanel ownerType="GRN" ownerId={grn.id} categories={['DELIVERY_NOTE', 'INVOICE_COPY', 'CERTIFICATE_OF_ANALYSIS', 'PHOTO']} />
            <DocumentChain type="GRN" id={grn.id} />
          </>
        }
      />
    </>
  );
}

export function GrnsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const date = useDate();
  const [status, setStatus] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<Grn>('/grns', { ...pagination, status });
  const columns: GridColDef<Grn>[] = [
    { field: 'number', headerName: 'Number', width: 190 },
    { field: 'supplier', headerName: 'Supplier', flex: 1, minWidth: 200, valueGetter: (_v, r) => r.supplier?.name ?? '' },
    { field: 'store', headerName: 'Store', width: 150, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'purchaseOrder', headerName: 'PO', width: 160, valueGetter: (_v, r) => r.purchaseOrder?.number ?? (r.isEmergency ? `emergency (${humanise(r.regularisationStatus)})` : '') },
    { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'receivedDate', headerName: 'Received', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader
        title="Goods received notes"
        onNew={can(Permissions.PURCHASING_EMERGENCY_RECEIPT) ? () => navigate('/grns/new') : undefined}
        newLabel="Emergency receipt"
        actions={
          <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: { xs: '100%', sm: 170 } }}>
            <MenuItem value="">Any</MenuItem>
            {Object.values(GrnStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
          </TextField>
        }
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Receive against a purchase order from the PO page.</Typography>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/grns/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

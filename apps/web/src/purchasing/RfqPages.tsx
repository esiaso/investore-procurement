import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
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
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Permissions, RfqStatus } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { Comparison, Rfq, Supplier } from '../api/purchasing-types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { DetailLayout, DocumentChain, useDate, useMoney } from './common';

function QuotationDialog({ rfq, suppliers, onClose }: { rfq: Rfq; suppliers: Supplier[]; onClose(): void }) {
  const [supplierId, setSupplierId] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [compliant, setCompliant] = useState(true);
  const [notes, setNotes] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const save = useApiMutation<void>(
    () => [
      `/rfqs/${rfq.id}/quotations`,
      {
        method: 'POST',
        body: {
          supplierId,
          deliveryDays: deliveryDays ? Number(deliveryDays) : undefined,
          compliant,
          complianceNotes: notes || undefined,
          lines: Object.entries(prices).filter(([, v]) => v !== '').map(([rfqLineId, v]) => ({ rfqLineId, unitPrice: Number(v) })),
        },
      },
    ],
    { invalidate: ['/rfqs'], success: 'Quotation recorded' },
  );
  return (
    <FormDialog open maxWidth="md" title="Record a quotation" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          {suppliers.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
        <TextField label="Delivery (days)" type="number" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} />
      </Stack>
      <FormControlLabel control={<Checkbox checked={compliant} onChange={(e) => setCompliant(e.target.checked)} />} label="Compliant (documents, registration, specifications)" />
      {!compliant && <TextField label="Why not compliant" value={notes} onChange={(e) => setNotes(e.target.value)} />}
      <Typography variant="subtitle2">Unit prices per base unit, excl. VAT (leave blank if not quoted)</Typography>
      {(rfq.lines ?? []).map((l) => (
        <Stack key={l.id} direction="row" spacing={1} alignItems="center">
          <Typography sx={{ flexGrow: 1 }}>{l.item?.name} × {l.quantity}</Typography>
          <TextField label="Unit price" type="number" value={prices[l.id] ?? ''} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} sx={{ width: 160 }} slotProps={{ htmlInput: { step: 'any' } }} />
        </Stack>
      ))}
    </FormDialog>
  );
}

/** Comparative analysis sheet with award selection. */
export function ComparativeSheet({ rfq, comparison, canAward }: { rfq: Rfq; comparison: Comparison; canAward: boolean }) {
  const money = useMoney();
  const navigate = useNavigate();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  useEffect(() => {
    // Default: lowest compliant quote per line.
    setChoice(Object.fromEntries(comparison.lines.map((l) => [l.rfqLineId, l.quotes.find((q) => q.lowestCompliant)?.quotationLineId ?? ''])));
  }, [comparison]);
  const deviates = comparison.lines.some((l) => choice[l.rfqLineId] && !l.quotes.find((q) => q.quotationLineId === choice[l.rfqLineId])?.lowestCompliant);
  const award = useApiMutation<void, { purchaseOrderIds: string[] }>(
    () => [
      `/rfqs/${rfq.id}/award`,
      {
        method: 'POST',
        body: {
          awards: Object.entries(choice).filter(([, v]) => v).map(([rfqLineId, quotationLineId]) => ({ rfqLineId, quotationLineId })),
          justification: justification || undefined,
          expectedDelivery: expectedDelivery || null,
        },
      },
    ],
    { invalidate: ['/rfqs', '/purchase-orders', '/requisitions', '/documents'], success: 'Awarded: draft purchase order(s) created' },
  );
  const suppliers = comparison.suppliers;
  const awarding = rfq.status === RfqStatus.EVALUATION && canAward;
  return (
    <Paper sx={{ p: 2, overflowX: 'auto' }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Comparative analysis
      </Typography>
      <Table size="small" aria-label="Comparative analysis">
        <TableHead>
          <TableRow>
            <TableCell>Item</TableCell>
            <TableCell align="right">Qty</TableCell>
            {suppliers.map((s) => (
              <TableCell key={s.supplierId} align="right">
                <Box fontWeight={600}>{s.supplierName}</Box>
                <Box sx={{ fontSize: 11, color: 'text.secondary' }}>
                  {s.deliveryDays != null ? `${s.deliveryDays} days` : '—'} · {s.compliant ? 'compliant' : 'not compliant'}
                </Box>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {comparison.lines.map((l) => (
            <TableRow key={l.rfqLineId}>
              <TableCell>{l.itemName}</TableCell>
              <TableCell align="right">{l.quantity}</TableCell>
              {suppliers.map((s) => {
                const q = l.quotes.find((x) => x.supplierId === s.supplierId);
                if (!q) return <TableCell key={s.supplierId} align="right">—</TableCell>;
                const awarded = l.awardedQuotationLineId === q.quotationLineId;
                return (
                  <TableCell key={s.supplierId} align="right" sx={{ bgcolor: q.lowestCompliant ? 'rgba(46, 125, 50, 0.08)' : undefined, opacity: q.compliant ? 1 : 0.6 }}>
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                      {awarding && (
                        <Radio size="small" checked={choice[l.rfqLineId] === q.quotationLineId} onChange={() => setChoice({ ...choice, [l.rfqLineId]: q.quotationLineId })} inputProps={{ 'aria-label': `Award ${l.itemName} to ${s.supplierName}` }} />
                      )}
                      <Box>
                        <Box>{money(q.unitPrice)}</Box>
                        <Box sx={{ fontSize: 11 }}>{money(q.lineTotal)}</Box>
                      </Box>
                      {q.lowestCompliant && <Chip size="small" color="success" label="Lowest" />}
                      {awarded && <Chip size="small" color="primary" label="Awarded" />}
                    </Stack>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={2}><b>Total</b></TableCell>
            {suppliers.map((s) => (
              <TableCell key={s.supplierId} align="right">
                <b>{money(s.total)}</b>
                <Box sx={{ fontSize: 11 }}>lowest on {s.lowestOnLines} line(s)</Box>
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
      {suppliers.filter((s) => !s.compliant && s.complianceNotes).map((s) => (
        <Typography key={s.supplierId} variant="body2" color="text.secondary">{s.supplierName}: {s.complianceNotes}</Typography>
      ))}
      {awarding && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          {deviates && <Alert severity="warning">At least one line is not awarded to the lowest compliant quote: a justification is required.</Alert>}
          <TextField label="Award justification" value={justification} onChange={(e) => setJustification(e.target.value)} multiline minRows={2} required={deviates} />
          <TextField label="Expected delivery" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 220 }} />
          <Box>
            <Button variant="contained" disabled={award.isPending || (deviates && !justification)} onClick={() => award.mutate(undefined, { onSuccess: (r) => r.purchaseOrderIds[0] && navigate(`/purchase-orders/${r.purchaseOrderIds[0]}`) })}>
              Award and create purchase orders
            </Button>
          </Box>
        </Stack>
      )}
      {rfq.awardJustification && <Alert severity="info" sx={{ mt: 2 }}>Award justification: {rfq.awardJustification}</Alert>}
    </Paper>
  );
}

export function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const date = useDate();
  const [quoting, setQuoting] = useState(false);
  const { data: rfq } = useQuery({ queryKey: ['/rfqs', id], queryFn: () => api<Rfq>(`/rfqs/${id}`) });
  const comparison = useQuery({ queryKey: ['/rfqs', id, 'comparison'], queryFn: () => api<Comparison>(`/rfqs/${id}/comparison`), enabled: !!rfq });
  const supplierList = useQuery({
    queryKey: ['/suppliers', 'byIds', rfq?.supplierIds],
    queryFn: async () => Promise.all(rfq!.supplierIds.map((s) => api<Supplier>(`/suppliers/${s}`))),
    enabled: !!rfq,
  });
  const send = useApiMutation<void>(() => [`/rfqs/${id}/send`, { method: 'POST' }], { invalidate: ['/rfqs'], success: 'Invitations queued by email' });
  const cancel = useApiMutation<void>(() => [`/rfqs/${id}/cancel`, { method: 'POST' }], { invalidate: ['/rfqs'], success: 'RFQ cancelled' });
  if (!rfq) return null;
  const manage = can(Permissions.PURCHASING_RFQ);
  return (
    <>
      <PageHeader title={`RFQ ${rfq.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <StatusChip status={rfq.status} />
                <Typography>{rfq.title} · closes {date(rfq.closingDate)}</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">Invited: {(supplierList.data ?? []).map((s) => s.name).join(', ')}</Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                {manage && rfq.status === RfqStatus.DRAFT && <Button variant="contained" onClick={() => send.mutate()}>Send invitations</Button>}
                {manage && [RfqStatus.SENT, RfqStatus.EVALUATION].includes(rfq.status as RfqStatus) && <Button variant="outlined" onClick={() => setQuoting(true)}>Record quotation</Button>}
                {manage && rfq.status !== RfqStatus.AWARDED && rfq.status !== RfqStatus.CANCELLED && <Button color="error" onClick={() => cancel.mutate()}>Cancel RFQ</Button>}
              </Stack>
            </Paper>
            {comparison.data && comparison.data.suppliers.length > 0 ? (
              <ComparativeSheet rfq={rfq} comparison={comparison.data} canAward={manage} />
            ) : (
              <Paper sx={{ p: 2 }}><Typography color="text.secondary">No quotations recorded yet.</Typography></Paper>
            )}
          </>
        }
        side={<DocumentChain type="RFQ" id={rfq.id} />}
      />
      {quoting && <QuotationDialog rfq={rfq} suppliers={supplierList.data ?? []} onClose={() => setQuoting(false)} />}
    </>
  );
}

export function RfqsPage() {
  const navigate = useNavigate();
  const date = useDate();
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<Rfq>('/rfqs', { ...pagination });
  const columns: GridColDef<Rfq>[] = [
    { field: 'number', headerName: 'Number', width: 170 },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
    { field: 'supplierIds', headerName: 'Invited', width: 90, valueGetter: (_v, r) => r.supplierIds.length },
    { field: 'closingDate', headerName: 'Closes', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'status', headerName: 'Status', width: 140, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Requests for quotation" />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>RFQs are raised from an approved requisition.</Typography>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/rfqs/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}


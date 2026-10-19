import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import {
  Alert,
  Box,
  Button,
  Chip,
  InputAdornment,
  Link,
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
import { KeyboardEvent, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { IssuePlan, IssueVoucher, StoreRequisition } from '../api/stores-types';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { ExpiryChip, WitnessFields, WitnessValue } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import { allConfirmed, applyScan, initialState, issueBody, LineState, lineTotal, overridesFefo } from './issue-logic';

/** Issue screen: FEFO suggestions, manual picks (override), scan-to-confirm, witness for controlled drugs. */
export function IssueFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const sr = useQuery({ queryKey: ['/store-requisitions', id], queryFn: () => api<StoreRequisition>(`/store-requisitions/${id}`) });
  const plan = useQuery({ queryKey: ['/store-requisitions', id, 'plan'], queryFn: () => api<IssuePlan>(`/store-requisitions/${id}/issue-plan`), gcTime: 0 });
  const [state, setState] = useState<LineState[]>([]);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [collectedBy, setCollectedBy] = useState('');
  const [witness, setWitness] = useState<WitnessValue>({ username: '', password: '' });
  useEffect(() => {
    if (plan.data) setState(initialState(plan.data.lines));
  }, [plan.data]);

  const post = useApiMutation<void, IssueVoucher>(
    () => [
      `/store-requisitions/${id}/issues`,
      {
        method: 'POST',
        body: {
          lines: issueBody(state),
          fefoOverrideReason: overridden ? reason : undefined,
          collectedBy: collectedBy || undefined,
          witness: controlled ? witness : undefined,
        },
      },
    ],
    { invalidate: ['/store-requisitions', '/issues', '/inventory', '/documents'], success: 'Stock issued' },
  );

  if (!sr.data || !plan.data) return null;
  const overridden = overridesFefo(state);
  const picking = state.filter((s) => lineTotal(s) > 0);
  const controlled = picking.some((s) => s.line.isControlled);
  const required = plan.data.scanConfirm === 'REQUIRED';
  const confirmed = allConfirmed(state);
  const pickCount = state.reduce((n, s) => n + s.rows.filter((r) => r.quantity > 0).length, 0);
  const scannedCount = state.reduce((n, s) => n + s.rows.filter((r) => r.quantity > 0 && r.scannedCode).length, 0);
  const tooMuch = state.some((s) => lineTotal(s) > s.line.outstandingQty || s.rows.some((r) => r.quantity > r.available));
  const blocked =
    !picking.length || tooMuch || (overridden && (!can(Permissions.INVENTORY_OVERRIDE_FEFO) || !reason.trim())) || (required && !confirmed) || (controlled && (!witness.username || !witness.password));

  const onScan = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const res = applyScan(state, scan);
    setState(res.state);
    setScanMsg(res.matched ? { ok: true, text: `Confirmed line ${res.matched.lineNo}, batch ${res.matched.batchNo}` } : { ok: false, text: `${scan} does not match any open pick` });
    setScan('');
  };
  const setQty = (li: number, key: string, value: string) => {
    const q = Math.max(0, Number(value) || 0);
    setState((st) => st.map((s, i) => (i !== li ? s : { ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, quantity: q, scannedCode: undefined } : r)) })));
  };

  return (
    <>
      <PageHeader title={`Issue against ${sr.data.number}`} />
      <Stack spacing={2}>
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
            <Field label="Department">{sr.data.department?.name}</Field>
            <Field label="From">{sr.data.store?.name}</Field>
            <Field label="Priority">{humanise(sr.data.priority)}</Field>
            <Field label="Picks confirmed by scan">{scannedCount} / {pickCount}{required ? ' (required)' : ''}</Field>
          </Stack>
          <TextField
            label="Scan item barcode or batch number"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={onScan}
            autoFocus
            fullWidth
            sx={{ mt: 2 }}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><QrCodeScannerIcon /></InputAdornment> } }}
          />
          {scanMsg && <Alert severity={scanMsg.ok ? 'success' : 'warning'} sx={{ mt: 1 }}>{scanMsg.text}</Alert>}
        </Paper>

        {state.length === 0 && <Alert severity="info">Nothing is outstanding on this requisition.</Alert>}
        {state.map((s, li) => (
          <Paper key={s.line.requisitionLineId} sx={{ p: 2 }} aria-label={`Line ${s.line.lineNo}`}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <Typography fontWeight={600}>{s.line.lineNo}. {s.line.itemName}</Typography>
              <Typography variant="body2" color="text.secondary">{s.line.itemCode}</Typography>
              {s.line.isControlled && <Chip size="small" color="error" label="Controlled" />}
              {s.line.isColdChain && <Chip size="small" color="info" label="2–8°C" />}
              {s.line.patientRef && <Chip size="small" variant="outlined" label={`Patient ${s.line.patientRef}`} />}
              <Box sx={{ flexGrow: 1 }} />
              <Typography variant="body2">
                Picking <b>{lineTotal(s)}</b> of {s.line.outstandingQty} {s.line.uom} outstanding
              </Typography>
            </Stack>
            {s.line.shortfall > 0 && (
              <Alert severity="warning" sx={{ mb: 1 }}>
                Only {s.line.outstandingQty - s.line.shortfall} usable: {s.line.shortfall} {s.line.uom} will stay on back-order.
              </Alert>
            )}
            {s.rows.length === 0 ? (
              <Typography color="text.secondary">No usable stock (expired, held and quarantined stock is never issued).</Typography>
            ) : (
              <Table size="small" aria-label={`Batches for line ${s.line.lineNo}`}>
                <TableHead>
                  <TableRow>
                    <TableCell>Batch</TableCell>
                    <TableCell>Expiry</TableCell>
                    <TableCell>Bin</TableCell>
                    <TableCell align="right">Available</TableCell>
                    <TableCell align="right">FEFO</TableCell>
                    <TableCell align="right">Issue</TableCell>
                    <TableCell>Scan</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {s.rows.map((r) => (
                    <TableRow key={r.key} selected={r.quantity > 0}>
                      <TableCell>{r.batchNo}</TableCell>
                      <TableCell><ExpiryChip date={r.expiryDate} /></TableCell>
                      <TableCell>{r.binCode ?? '—'}</TableCell>
                      <TableCell align="right">{r.available}</TableCell>
                      <TableCell align="right">{r.suggested || ''}</TableCell>
                      <TableCell align="right">
                        <TextField
                          size="small"
                          type="number"
                          value={r.quantity}
                          onChange={(e) => setQty(li, r.key, e.target.value)}
                          error={r.quantity > r.available}
                          slotProps={{ htmlInput: { min: 0, 'aria-label': `Issue quantity of batch ${r.batchNo}` } }}
                          sx={{ width: 100 }}
                        />
                      </TableCell>
                      <TableCell>{r.quantity > 0 && (r.scannedCode ? <CheckCircleIcon color="success" titleAccess="Scanned" /> : <Typography variant="caption" color="text.secondary">not scanned</Typography>)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        ))}

        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            {overridden && (
              <>
                <Alert severity={can(Permissions.INVENTORY_OVERRIDE_FEFO) ? 'warning' : 'error'}>
                  {can(Permissions.INVENTORY_OVERRIDE_FEFO)
                    ? 'These picks differ from FEFO (first expiry, first out). Give a reason; it is recorded on the ledger.'
                    : 'These picks differ from FEFO and you do not have permission to override it. Restore the FEFO quantities.'}
                </Alert>
                {can(Permissions.INVENTORY_OVERRIDE_FEFO) && <TextField label="FEFO override reason" value={reason} onChange={(e) => setReason(e.target.value)} required />}
              </>
            )}
            {tooMuch && <Alert severity="error">A line picks more than is outstanding or available.</Alert>}
            {required && !confirmed && <Alert severity="info">Every pick must be confirmed by scanning before posting.</Alert>}
            {controlled && <WitnessFields value={witness} onChange={setWitness} />}
            <TextField label="Collected by" value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)} helperText="Name of the person collecting for the department" />
            <Box>
              <Button variant="contained" disabled={blocked || post.isPending} onClick={() => post.mutate(undefined, { onSuccess: (v) => navigate(`/issues/${v.id}`) })}>
                Post issue voucher
              </Button>
            </Box>
          </Stack>
        </Paper>
      </Stack>
    </>
  );
}

export function IssueVoucherDetailPage() {
  const { id } = useParams<{ id: string }>();
  const money = useMoney();
  const date = useDate();
  const { data: v } = useQuery({ queryKey: ['/issues', id], queryFn: () => api<IssueVoucher>(`/issues/${id}`) });
  if (!v) return null;
  return (
    <>
      <PageHeader title={`Issue voucher ${v.number}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Requisition">
                  <Link component={RouterLink} to={`/store-requisitions/${v.requisitionId}`}>{v.requisition?.number}</Link>
                </Field>
                <Field label="To">{v.department?.name}</Field>
                <Field label="From">{v.store?.name}</Field>
                <Field label="Date">{date(v.issueDate)}</Field>
                <Field label="Value">{money(v.totalValue)}</Field>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Issued by">{v.issuedByName}</Field>
                {v.witnessName && <Field label="Witness">{v.witnessName}</Field>}
                <Field label="Collected by">{v.collectedBy ?? '—'}</Field>
              </Stack>
              {v.fefoOverrideReason && <Alert severity="warning" sx={{ mb: 2 }}>FEFO overridden: {v.fefoOverrideReason}</Alert>}
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Issued batches">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell>Batch</TableCell>
                      <TableCell>Expiry</TableCell>
                      <TableCell>Bin</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Unit cost</TableCell>
                      <TableCell align="right">Value</TableCell>
                      <TableCell align="right">Returned</TableCell>
                      <TableCell>Patient</TableCell>
                      <TableCell>Scan</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(v.lines ?? []).map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{l.item?.name}</TableCell>
                        <TableCell><Link component={RouterLink} to={`/batches/${l.batchId}/trace`}>{l.batch?.batchNo}</Link></TableCell>
                        <TableCell>{date(l.batch?.expiryDate)}</TableCell>
                        <TableCell>{l.binCode ?? '—'}</TableCell>
                        <TableCell align="right">{l.quantity} {l.item?.baseUom?.code}</TableCell>
                        <TableCell align="right">{money(l.unitCost)}</TableCell>
                        <TableCell align="right">{money(l.value)}</TableCell>
                        <TableCell align="right">{l.returnedQty || ''}</TableCell>
                        <TableCell>{l.patientRef}</TableCell>
                        <TableCell>{l.scanConfirmed ? <CheckCircleIcon fontSize="small" color="success" titleAccess="Scanned" /> : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Paper>
            <Box>
              <Button startIcon={<PictureAsPdfIcon />} variant="outlined" href={buildUrl(`/issues/${v.id}/pdf`)} target="_blank" rel="noopener">
                Print issue voucher
              </Button>
            </Box>
          </>
        }
        side={<DocumentChain type="ISS" id={v.id} />}
      />
    </>
  );
}

export function IssueVouchersPage() {
  const navigate = useNavigate();
  const money = useMoney();
  const date = useDate();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<IssueVoucher>('/issues', { ...pagination, search: q });
  const columns: GridColDef<IssueVoucher>[] = [
    { field: 'number', headerName: 'Number', width: 180 },
    { field: 'requisition', headerName: 'Requisition', width: 180, valueGetter: (_v, r) => r.requisition?.number ?? '' },
    { field: 'department', headerName: 'Department', width: 170, valueGetter: (_v, r) => r.department?.name ?? '' },
    { field: 'store', headerName: 'From', flex: 1, minWidth: 150, valueGetter: (_v, r) => r.store?.name ?? '' },
    { field: 'totalValue', headerName: 'Value', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
    { field: 'issueDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <>
      <PageHeader title="Issue vouchers" search={search} onSearch={setSearch} />
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/issues/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

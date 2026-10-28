import DownloadIcon from '@mui/icons-material/Download';
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
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { api, buildUrl } from '../api/client';
import { useAll } from '../api/hooks';
import type { BatchTrace, ConsumptionReport, ConsumptionRow, MovementRow } from '../api/stores-types';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { ExpiryChip, HoldChip, StoreSelect } from '../inventory/components';
import { humanise } from '../lib/format';
import { DOC_ROUTES, Field, useDate, useMoney } from '../purchasing/common';
import type { BatchHoldStatus } from '@sil/shared';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthStart = () => `${today().slice(0, 8)}01`;

type GroupBy = ConsumptionReport['groupBy'];

/** Query string for the consumption API (shared by the table and the CSV link). */
export function consumptionQuery(f: { from: string; to: string; groupBy: GroupBy; departmentId: string; storeId: string; patientRef: string }) {
  return {
    from: f.from,
    to: f.to,
    groupBy: f.groupBy,
    departmentId: f.departmentId || undefined,
    storeId: f.storeId || undefined,
    patientRef: f.patientRef.trim() || undefined,
  };
}

export function ConsumptionPage() {
  const money = useMoney();
  const { user } = useAuth();
  const departments = useAll<Department>('/departments');
  const [f, setF] = useState({ from: monthStart(), to: today(), groupBy: 'department' as GroupBy, departmentId: '', storeId: '', patientRef: '' });
  const query = consumptionQuery(f);
  const { data, isFetching, error } = useQuery({
    queryKey: ['/consumption', query],
    queryFn: () => api<ConsumptionReport>('/consumption', { query }),
    enabled: !!f.from && !!f.to,
  });
  const withQty = f.groupBy === 'item';
  const columns: GridColDef<ConsumptionRow>[] = [
    ...(f.groupBy === 'period' ? [{ field: 'period', headerName: 'Month', width: 100 } as GridColDef<ConsumptionRow>] : []),
    ...(f.groupBy === 'patient' ? [{ field: 'label', headerName: 'Patient reference', width: 200 } as GridColDef<ConsumptionRow>] : []),
    ...(f.groupBy === 'item'
      ? ([
          { field: 'itemCode', headerName: 'Code', width: 110 },
          { field: 'label', headerName: 'Item', flex: 1, minWidth: 220 },
          { field: 'issuedQty', headerName: 'Issued', type: 'number', width: 100 },
          { field: 'returnedQty', headerName: 'Returned', type: 'number', width: 100 },
          { field: 'netQty', headerName: 'Net qty', type: 'number', width: 100 },
          { field: 'uom', headerName: 'Unit', width: 70 },
        ] as GridColDef<ConsumptionRow>[])
      : ([
          { field: 'department', headerName: 'Department', flex: 1, minWidth: 180 },
          { field: 'costCentre', headerName: 'Cost centre', width: 120 },
        ] as GridColDef<ConsumptionRow>[])),
    { field: 'issuedValue', headerName: 'Issued value', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'returnedValue', headerName: 'Returns credited', type: 'number', width: 150, valueFormatter: (v: number) => money(v) },
    { field: 'netValue', headerName: 'Net cost', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'movements', headerName: 'Movements', type: 'number', width: 110 },
  ];
  const deptOptions = (departments.data ?? []).filter((d) => user?.storeIds === null || !user?.departmentId || d.id === user.departmentId);
  return (
    <>
      <PageHeader title="Departmental consumption" />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} flexWrap="wrap" useFlexGap>
          <TextField label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField select label="Group by" value={f.groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value as GroupBy })} sx={{ minWidth: 170, width: 'auto' }}>
            <MenuItem value="department">Department</MenuItem>
            <MenuItem value="period">Month × department</MenuItem>
            <MenuItem value="item">Item</MenuItem>
            <MenuItem value="patient">Patient reference</MenuItem>
          </TextField>
          <TextField select label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
            <MenuItem value="">All</MenuItem>
            {deptOptions.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
          <StoreSelect value={f.storeId} onChange={(v) => setF({ ...f, storeId: v })} label="Issuing store" allowAll="All" sx={{ minWidth: 200 }} />
          <TextField label="Patient reference" value={f.patientRef} onChange={(e) => setF({ ...f, patientRef: e.target.value })} />
          <Button startIcon={<DownloadIcon />} variant="outlined" href={buildUrl('/consumption', { ...query, format: 'csv' })} sx={{ alignSelf: 'center' }}>
            Export CSV
          </Button>
        </Stack>
      </Paper>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{(error as Error).message}</Alert>}
      {data && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
          <Field label="Issued">{money(data.totals.issuedValue)}</Field>
          <Field label="Returns credited">{money(data.totals.returnedValue)}</Field>
          <Field label="Net cost">{money(data.totals.netValue)}</Field>
        </Stack>
      )}
      <Paper>
        <DataGrid autoHeight density="compact" getRowId={(r) => r.key} rows={data?.rows ?? []} columns={columns} loading={isFetching} pageSizeOptions={[50, 100]} initialState={{ pagination: { paginationModel: { pageSize: 50 } } }} disableRowSelectionOnClick />
      </Paper>
      {!withQty && <Typography variant="caption" color="text.secondary">Group by item to see quantities.</Typography>}
    </>
  );
}

function DocLink({ m }: { m: MovementRow }) {
  const route = m.sourceDocId ? DOC_ROUTES[m.sourceDocType] : undefined;
  if (!m.sourceDocNo) return <>{m.sourceDocType}</>;
  return route ? <RouterLink to={route(m.sourceDocId!)}>{m.sourceDocNo}</RouterLink> : <>{m.sourceDocNo}</>;
}

export function BatchTracePage() {
  const { id } = useParams<{ id: string }>();
  const date = useDate();
  const { data } = useQuery({ queryKey: ['/inventory/batches', id, 'trace'], queryFn: () => api<BatchTrace>(`/inventory/batches/${id}/trace`) });
  if (!data) return null;
  const { batch } = data;
  return (
    <>
      <PageHeader title={`Batch trace · ${batch.batchNo}`} />
      <Stack spacing={2}>
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ md: 'center' }}>
            <Field label="Item">{batch.itemCode} · {batch.itemName}</Field>
            <Field label="Expiry"><ExpiryChip date={batch.expiryDate} /></Field>
            <Field label="Status">{batch.holdStatus === 'NONE' ? 'Usable' : <HoldChip status={batch.holdStatus as BatchHoldStatus} />}</Field>
            {batch.holdReason && <Field label="Hold reason">{batch.holdReason}</Field>}
            {batch.isControlled && <Chip size="small" color="error" label="Controlled" />}
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ mt: 2 }}>
            <Field label="Received">{data.totals.received} {batch.uom}</Field>
            <Field label="Issued to departments">{data.totals.issued}</Field>
            <Field label="Returned by departments">{data.totals.returnedFromDepartments}</Field>
            <Field label="Returned to supplier">{data.totals.returnedToSupplier}</Field>
            <Field label="Adjusted / counted">{data.totals.adjusted}</Field>
          </Stack>
          {data.patients.length > 0 && <Typography variant="body2" sx={{ mt: 2 }}>Patients: {data.patients.join(', ')}</Typography>}
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Where it is now</Typography>
          {data.locations.length === 0 ? (
            <Typography color="text.secondary">None left in the stores you can see.</Typography>
          ) : (
            <Table size="small" aria-label="Current locations">
              <TableHead><TableRow><TableCell>Store</TableCell><TableCell>Bin</TableCell><TableCell align="right">On hand</TableCell><TableCell align="right">Reserved</TableCell><TableCell align="right">In transit</TableCell></TableRow></TableHead>
              <TableBody>
                {data.locations.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>{l.storeName}</TableCell>
                    <TableCell>{l.binCode ?? '—'}{l.inQuarantine && <Chip size="small" color="warning" label="Quarantine" sx={{ ml: 1 }} />}</TableCell>
                    <TableCell align="right">{l.onHand}</TableCell>
                    <TableCell align="right">{l.reserved || ''}</TableCell>
                    <TableCell align="right">{l.inTransit || ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Movements</Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Batch movements">
              <TableHead>
                <TableRow><TableCell>When</TableCell><TableCell>What</TableCell><TableCell>Document</TableCell><TableCell>From</TableCell><TableCell>To</TableCell><TableCell align="right">Qty</TableCell><TableCell>Who</TableCell><TableCell>Detail</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {data.movements.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{date(m.postedAt)}</TableCell>
                    <TableCell>{humanise(m.txnType)}</TableCell>
                    <TableCell><DocLink m={m} /></TableCell>
                    <TableCell>{m.from}</TableCell>
                    <TableCell>{m.to}</TableCell>
                    <TableCell align="right">{m.quantity || m.inTransitDelta}</TableCell>
                    <TableCell>{m.user}{m.secondSigner ? ` + ${m.secondSigner}` : ''}</TableCell>
                    <TableCell>{[m.patientRef && `patient ${m.patientRef}`, m.reasonCode, m.fefoOverrideReason && `FEFO override: ${m.fefoOverrideReason}`].filter(Boolean).join(' · ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Paper>
      </Stack>
    </>
  );
}

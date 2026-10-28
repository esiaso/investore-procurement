import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  FormControlLabel,
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
import { FormEvent, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { BrandOption, ClinicalAlert, Dispense, Patient, Payer, PaymentMode, Prescription, WorklistRow } from '../api/pharmacy-types';
import type { Generic } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip, StoreSelect, useStores } from '../inventory/components';
import { formatDate, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { DetailLayout, Field, useMoney } from '../purchasing/common';
import { useSettings } from '../settings/SettingsContext';
import { AlertLine, ageText, EtimsChip, GenericPicker, PatientPicker, SeverityChip } from './ui';
import { HmisPatientImportDialog, HmisStatusChip } from '../hmis/HmisPages';

const P = Permissions;
const OPEN = 'RECEIVED,VERIFIED,PARTIALLY_DISPENSED';

function useDateTime() {
  const { dateFormat, timezone } = useSettings();
  return (v: string | null | undefined) => (v ? formatDate(v, dateFormat, timezone, true) : '—');
}

// ------------------------------------------------------------------ worklist

export function PharmacyWorklistPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  // Default: every outlet the user works in (store scope applies server-side).
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState(OPEN);
  const [search, setSearch] = useState('');
  const [paging, setPaging] = useState({ page: 0, pageSize: 25 });
  const q = useDebounced(search);
  const { data, isFetching } = useQuery({
    queryKey: ['/pharmacy/prescriptions', storeId, status, q, paging],
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(paging.page + 1), pageSize: String(paging.pageSize) });
      for (const s of status.split(',')) qs.append('status', s);
      if (storeId) qs.set('storeId', storeId);
      if (q) qs.set('search', q);
      return api<{ items: WorklistRow[]; total: number }>(`/pharmacy/prescriptions?${qs}`);
    },
    refetchInterval: 30_000,
  });
  const dt = useDateTime();
  const columns: GridColDef<WorklistRow>[] = [
    { field: 'number', headerName: 'Rx', width: 170 },
    { field: 'patient', headerName: 'Patient', flex: 1, minWidth: 200, valueGetter: (_, r) => `${r.patient?.hospitalNo ?? ''} · ${r.patient?.name ?? ''}` },
    {
      field: 'encounter',
      headerName: 'Visit',
      width: 170,
      sortable: false,
      renderCell: ({ row }) =>
        row.encounter ? (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
            <Chip size="small" variant="outlined" label={row.encounter.class} />
            <span>{[row.encounter.department?.name, row.encounter.bed].filter(Boolean).join(' · ')}</span>
          </Stack>
        ) : (
          'Walk-in'
        ),
    },
    { field: 'prescriber', headerName: 'Prescriber', width: 160 },
    { field: 'receivedAt', headerName: 'Received', width: 160, valueFormatter: (v) => dt(v as string) },
    { field: 'waitingMinutes', headerName: 'Waiting', width: 90, valueFormatter: (v) => `${v} min` },
    {
      field: 'alerts',
      headerName: 'Alerts',
      width: 170,
      sortable: false,
      renderCell: ({ row }) =>
        row.alerts ? (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
            <SeverityChip severity={row.alerts.highest} />
            {row.alerts.openBlocking > 0 && <Chip size="small" color="error" variant="outlined" label={`${row.alerts.openBlocking} to override`} />}
          </Stack>
        ) : (
          ''
        ),
    },
    { field: 'status', headerName: 'Status', width: 170, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Pharmacy worklist" search={search} onSearch={setSearch} searchPlaceholder="Rx, patient or hospital no." onNew={can(P.PHARMACY_PRESCRIPTION) ? () => navigate('/pharmacy/new') : undefined} newLabel="New prescription" />
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <StoreSelect value={storeId} onChange={setStoreId} label="Outlet" allowAll="All my outlets" sx={{ minWidth: 220 }} />
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 220, width: 'auto' }}>
          <MenuItem value={OPEN}>Open (to verify / dispense)</MenuItem>
          {['RECEIVED', 'VERIFIED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'CANCELLED'].map((s) => (
            <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>
          ))}
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
        onRowClick={(p) => navigate(`/pharmacy/prescriptions/${p.id}`)}
        disableRowSelectionOnClick
      />
    </>
  );
}

// ------------------------------------------------------------------ new prescription

interface DraftLine {
  generic: Generic | null;
  dose: string;
  frequency: string;
  duration: string;
  route: string;
  quantity: number;
}
const blankLine = (): DraftLine => ({ generic: null, dose: '', frequency: '', duration: '', route: '', quantity: 0 });

export function PrescriptionFormPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const stores = useStores();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [storeId, setStoreId] = useState('');
  const [prescriber, setPrescriber] = useState('');
  const [regNo, setRegNo] = useState('');
  const [encounter, setEncounter] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [newPatient, setNewPatient] = useState(false);
  useEffect(() => {
    const pharmacy = stores.data?.find((s) => s.type.includes('PHARMACY'));
    if (!storeId && pharmacy) setStoreId(pharmacy.id);
  }, [storeId, stores.data]);
  const save = useApiMutation<void, Prescription>(
    () => [
      '/pharmacy/prescriptions',
      {
        method: 'POST',
        body: {
          patientId: patient?.id,
          storeId,
          prescriber,
          prescriberRegNo: regNo || undefined,
          encounterRef: encounter || undefined,
          lines: lines.filter((l) => l.generic).map((l) => ({ genericId: l.generic!.id, dose: l.dose, frequency: l.frequency, duration: l.duration || undefined, route: l.route || undefined, quantity: l.quantity })),
        },
      },
    ],
    { invalidate: ['/pharmacy'], success: 'Prescription received; checks done' },
  );
  const set = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = patient && storeId && prescriber && lines.some((l) => l.generic && l.dose && l.frequency && l.quantity > 0);
  return (
    <>
      <PageHeader title="New prescription" />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center">
            <PatientPicker value={patient} onChange={setPatient} />
            {can(P.PATIENTS_MANAGE) && <Button onClick={() => setNewPatient(true)}>New patient</Button>}
            <StoreSelect value={storeId} onChange={setStoreId} label="Dispensing outlet" sx={{ minWidth: 220 }} />
          </Stack>
          {patient && <PatientBanner patient={patient} />}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField label="Prescriber" value={prescriber} onChange={(e) => setPrescriber(e.target.value)} required />
            <TextField label="Registration no." value={regNo} onChange={(e) => setRegNo(e.target.value)} />
            <TextField label="Encounter / visit" value={encounter} onChange={(e) => setEncounter(e.target.value)} />
          </Stack>
          <Typography variant="subtitle1">Medicines (generic level — the brand is chosen at dispensing)</Typography>
          {lines.map((l, i) => (
            <Stack key={i} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center">
              <GenericPicker value={l.generic} onChange={(g) => set(i, { generic: g })} />
              <TextField label="Dose" value={l.dose} onChange={(e) => set(i, { dose: e.target.value })} sx={{ width: 110 }} />
              <TextField label="Frequency" value={l.frequency} onChange={(e) => set(i, { frequency: e.target.value })} sx={{ width: 110 }} />
              <TextField label="Duration" value={l.duration} onChange={(e) => set(i, { duration: e.target.value })} sx={{ width: 110 }} />
              <TextField label="Route" value={l.route} onChange={(e) => set(i, { route: e.target.value })} sx={{ width: 90 }} />
              <TextField label="Qty (base units)" type="number" value={l.quantity || ''} onChange={(e) => set(i, { quantity: Number(e.target.value) })} sx={{ width: 130 }} />
              <IconButton aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                <DeleteIcon />
              </IconButton>
            </Stack>
          ))}
          <Box>
            <Button startIcon={<AddIcon />} onClick={() => setLines((ls) => [...ls, blankLine()])}>Add medicine</Button>
          </Box>
          <Box>
            <Button variant="contained" disabled={!valid || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (rx) => navigate(`/pharmacy/prescriptions/${rx.id}`) })}>
              Receive prescription
            </Button>
          </Box>
        </Stack>
      </Paper>
      {newPatient && <PatientDialog onClose={() => setNewPatient(false)} onSaved={setPatient} />}
    </>
  );
}

function PatientBanner({ patient }: { patient: Patient }) {
  return (
    <Alert severity={patient.allergies.length || patient.isPregnant ? 'warning' : 'info'} icon={false}>
      <strong>{patient.name}</strong> · {patient.hospitalNo} · {humanise(patient.sex ?? 'unknown')} · {ageText(patient.dateOfBirth)}
      {patient.weightKg ? ` · ${patient.weightKg} kg` : ''}
      {patient.isPregnant && ' · PREGNANT'}
      {' · Allergies: '}
      {patient.allergies.length ? patient.allergies.join(', ') : 'none recorded'}
      {patient.payer && ` · ${patient.payer.name}${patient.memberNo ? ` (${patient.memberNo})` : ''}`}
      {patient.externalId && <Chip size="small" variant="outlined" label="HMIS patient" sx={{ ml: 1 }} />}
    </Alert>
  );
}

// ------------------------------------------------------------------ prescription detail

export function PrescriptionDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const dt = useDateTime();
  const money = useMoney();
  const { data: rx } = useQuery({ queryKey: ['/pharmacy/prescriptions', id], queryFn: () => api<Prescription>(`/pharmacy/prescriptions/${id}`) });
  const [override, setOverride] = useState<ClinicalAlert | null>(null);
  const [dispensing, setDispensing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState<Dispense | null>(null);
  const verify = useApiMutation<void>(() => [`/pharmacy/prescriptions/${id}/verify`, { method: 'POST' }], { invalidate: ['/pharmacy'], success: 'Verified' });
  const recheck = useApiMutation<void>(() => [`/pharmacy/prescriptions/${id}/check`, { method: 'POST' }], { invalidate: ['/pharmacy'], success: 'Checks re-run' });
  if (!rx) return null;
  const open = ['RECEIVED', 'VERIFIED', 'PARTIALLY_DISPENSED'].includes(rx.status);
  const unresolved = (rx.alerts ?? []).filter((a) => a.blocking && !a.override);
  const remaining = (rx.lines ?? []).some((l) => l.quantity - l.dispensedQty - l.cancelledQty > 0);
  const main = (
    <Stack spacing={2}>
      {rx.patient && <PatientBanner patient={rx.patient} />}
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Clinical checks</Typography>
        {(rx.alerts ?? []).length === 0 && <Alert severity="success">No interactions, allergies, duplicate therapy, age or pregnancy alerts.</Alert>}
        <Stack spacing={1}>
          {(rx.alerts ?? []).map((a) => (
            <AlertLine
              key={a.id}
              alert={a}
              action={a.blocking && !a.override && can(P.PHARMACY_VERIFY) && open ? <Button color="inherit" size="small" onClick={() => setOverride(a)}>Override</Button> : undefined}
            />
          ))}
        </Stack>
        {unresolved.length > 0 && <Typography variant="body2" color="error" sx={{ mt: 1 }}>{unresolved.length} blocking alert(s): a pharmacist must override with a reason before verification or dispensing.</Typography>}
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Medicines</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>#</TableCell>
              <TableCell>Generic</TableCell>
              <TableCell>Dose · frequency · duration · route</TableCell>
              <TableCell align="right">Prescribed</TableCell>
              <TableCell align="right">Dispensed</TableCell>
              <TableCell align="right">Cancelled</TableCell>
              <TableCell align="right">To dispense</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(rx.lines ?? []).map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.lineNo}</TableCell>
                <TableCell>{l.generic ? `${l.generic.innName} ${l.generic.strength} ${l.generic.dosageForm}` : l.genericId}</TableCell>
                <TableCell>{[l.dose, l.frequency, l.duration, l.route].filter(Boolean).join(' · ')}</TableCell>
                <TableCell align="right">{l.quantity}</TableCell>
                <TableCell align="right">{l.dispensedQty}</TableCell>
                <TableCell align="right">{l.cancelledQty}</TableCell>
                <TableCell align="right">{l.quantity - l.dispensedQty - l.cancelledQty}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {(rx.dispenses ?? []).map((d) => (
        <Paper key={d.id} sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
              {d.number} · {dt(d.dispensedAt)}
            </Typography>
            {can(P.PHARMACY_DISPENSE) && <Button size="small" onClick={() => setReturning(d)}>Return medicines</Button>}
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Item given</TableCell>
                <TableCell>Batch</TableCell>
                <TableCell>Expiry</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell align="right">Returned</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {d.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.item?.name} {l.substituted && <Chip size="small" variant="outlined" label="Substituted" />}
                  </TableCell>
                  <TableCell>{l.batch?.batchNo}</TableCell>
                  <TableCell>{l.batch?.expiryDate ?? ''}</TableCell>
                  <TableCell align="right">{l.quantity}</TableCell>
                  <TableCell align="right">{l.returnedQty}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {d.fefoOverrideReason && <Typography variant="body2" sx={{ mt: 1 }}>FEFO override: {d.fefoOverrideReason}</Typography>}
        </Paper>
      ))}
    </Stack>
  );
  const side = (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6">{rx.number}</Typography>
          <Box><StatusChip status={rx.status} /></Box>
          <Field label="Outlet">{rx.store?.name}</Field>
          <Field label="Prescriber">{rx.prescriber}{rx.prescriberRegNo ? ` (${rx.prescriberRegNo})` : ''}</Field>
          {rx.encounter ? (
            <Field label="Encounter">
              <Link component={RouterLink} to={`/encounters/${rx.encounter.id}`}>{rx.encounter.externalId}</Link> · {rx.encounter.class}
              {rx.encounter.department ? ` · ${rx.encounter.department.name}` : ''}{rx.encounter.bed ? ` · bed ${rx.encounter.bed}` : ''}
            </Field>
          ) : (
            rx.encounterRef && <Field label="Encounter">{rx.encounterRef}</Field>
          )}
          {rx.supplyMode && rx.supplyMode !== 'STANDARD' && <Field label="Supply">{humanise(rx.supplyMode)} (ward supply)</Field>}
          {rx.billingMode === 'HMIS' && <Field label="Billing">Charged to the HMIS bill</Field>}
          <Field label="Received">{dt(rx.receivedAt)}</Field>
          <Field label="Verified">{dt(rx.verifiedAt)}</Field>
          <Field label="First dispensed">{dt(rx.firstDispensedAt)}</Field>
          <Field label="Completed">{dt(rx.completedAt)}</Field>
          {rx.notes && <Field label="Notes">{rx.notes}</Field>}
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          {rx.status === 'RECEIVED' && can(P.PHARMACY_VERIFY) && (
            <Button variant="contained" disabled={unresolved.length > 0 || verify.isPending} onClick={() => verify.mutate()}>Verify</Button>
          )}
          {['VERIFIED', 'PARTIALLY_DISPENSED'].includes(rx.status) && remaining && can(P.PHARMACY_DISPENSE) && (
            <Button variant="contained" onClick={() => setDispensing(true)}>Dispense</Button>
          )}
          {open && <Button onClick={() => recheck.mutate()}>Re-run checks</Button>}
          {open && remaining && can(P.PHARMACY_DISPENSE) && <Button color="warning" onClick={() => setCancelling(true)}>Cancel undispensed balance</Button>}
        </Stack>
      </Paper>
      {((rx.charges ?? []).length > 0 || (rx.hmisMessages ?? []).length > 0) && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>Charges and HMIS records</Typography>
          <Stack spacing={1}>
            {(rx.charges ?? []).map((c) => (
              <Stack key={c.id} direction="row" spacing={1} alignItems="center">
                <span>{c.quantity} × {c.description}</span>
                <span>{money(c.amount)}</span>
                <HmisStatusChip status={c.status} />
              </Stack>
            ))}
            {(rx.hmisMessages ?? []).map((m) => (
              <Stack key={m.id} direction="row" spacing={1} alignItems="center">
                <span>{humanise(m.type)} {m.localDocNo}</span>
                <HmisStatusChip status={m.status} />
                {m.error && m.status !== 'SENT' && <Typography variant="caption">{m.error}</Typography>}
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}
      {(rx.invoices ?? []).length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>Invoices</Typography>
          <Stack spacing={1}>
            {rx.invoices!.map((i) => (
              <Stack key={i.id} direction="row" spacing={1} alignItems="center">
                <Link component={RouterLink} to={`/sales/${i.id}`}>{i.number}</Link>
                <span>{money(i.totalAmount)}</span>
                <EtimsChip status={i.etimsStatus} />
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
  return (
    <>
      <PageHeader title={`Prescription ${rx.number}`} />
      <DetailLayout main={main} side={side} />
      {override && <OverrideDialog alert={override} onClose={() => setOverride(null)} />}
      {dispensing && <DispenseDialog rx={rx} onClose={() => setDispensing(false)} />}
      {cancelling && <CancelDialog rx={rx} onClose={() => setCancelling(false)} />}
      {returning && <ReturnDialog rx={rx} dispense={returning} onClose={() => setReturning(null)} />}
    </>
  );
}

function OverrideDialog({ alert, onClose }: { alert: ClinicalAlert; onClose(): void }) {
  const [reason, setReason] = useState('');
  const save = useApiMutation<void>(() => [`/pharmacy/alerts/${alert.id}/override`, { method: 'POST', body: { reason } }], { invalidate: ['/pharmacy'], success: 'Override recorded' });
  return (
    <FormDialog open title="Override clinical alert" submitLabel="Record override" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <AlertLine alert={alert} />
      <TextField label="Clinical reason (logged and reported)" value={reason} onChange={(e) => setReason(e.target.value)} multiline minRows={3} required inputProps={{ minLength: 5 }} />
    </FormDialog>
  );
}

function DispenseDialog({ rx, onClose }: { rx: Prescription; onClose(): void }) {
  const money = useMoney();
  const options = useQuery({ queryKey: ['/pharmacy/prescriptions', rx.id, 'options'], queryFn: () => api<BrandOption[]>(`/pharmacy/prescriptions/${rx.id}/options`) });
  const modes = useList<PaymentMode>('/billing/payment-modes');
  const [choice, setChoice] = useState<Record<string, { itemId: string; quantity: number }>>({});
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState<number | ''>('');
  const [reference, setReference] = useState('');
  useEffect(() => {
    if (!options.data) return;
    setChoice(
      Object.fromEntries(
        options.data
          .filter((o) => o.remaining > 0)
          .map((o) => {
            const best = o.brands.find((b) => b.preferred && b.available > 0) ?? [...o.brands].sort((a, b) => b.available - a.available)[0];
            return [o.prescriptionLineId, { itemId: best?.itemId ?? '', quantity: best ? Math.min(o.remaining, best.available) : 0 }];
          }),
      ),
    );
  }, [options.data]);
  const lines = Object.entries(choice).filter(([, c]) => c.itemId && c.quantity > 0).map(([prescriptionLineId, c]) => ({ prescriptionLineId, ...c }));
  const selectedMode = (modes.data ?? []).find((m) => m.code === mode);
  const dispense = useApiMutation<void, Prescription & { change: number }>(
    () => [
      `/pharmacy/prescriptions/${rx.id}/dispense`,
      { method: 'POST', body: { lines, payments: amount && rx.billingMode !== 'HMIS' ? [{ modeCode: mode, amount: Number(amount), reference: reference || undefined }] : undefined } },
    ],
    { invalidate: ['/pharmacy', '/billing', '/inventory', '/hmis'], success: rx.billingMode === 'HMIS' ? 'Dispensed and charged to the HMIS bill' : 'Dispensed and invoiced' },
  );
  const hmisBilled = rx.billingMode === 'HMIS';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    dispense.mutate(undefined, { onSuccess: (r) => { if (r.change) alert(`Change due: ${money(r.change)}`); onClose(); } });
  };
  return (
    <FormDialog open title="Dispense" submitLabel={hmisBilled ? 'Dispense and charge' : 'Dispense and invoice'} maxWidth="md" onClose={onClose} submitting={dispense.isPending} onSubmit={submit}>
      {(options.data ?? []).filter((o) => o.remaining > 0).map((o) => {
        const line = rx.lines?.find((l) => l.id === o.prescriptionLineId);
        const c = choice[o.prescriptionLineId] ?? { itemId: '', quantity: 0 };
        const brand = o.brands.find((b) => b.itemId === c.itemId);
        const substituted = !!o.preferredItemId && c.itemId !== o.preferredItemId;
        return (
          <Stack key={o.prescriptionLineId} spacing={1}>
            <Typography variant="subtitle2">
              {line?.generic ? `${line.generic.innName} ${line.generic.strength} ${line.generic.dosageForm}` : `Line ${line?.lineNo}`} — {o.remaining} to dispense
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField select label="Brand" value={c.itemId} onChange={(e) => setChoice({ ...choice, [o.prescriptionLineId]: { ...c, itemId: e.target.value } })} sx={{ flex: 1 }}>
                {o.brands.map((b) => (
                  <MenuItem key={b.itemId} value={b.itemId} disabled={b.available <= 0}>
                    {b.name} — {b.available} available{b.earliestExpiry ? `, earliest expiry ${b.earliestExpiry}` : ''}{b.preferred ? ' (prescribed)' : ''}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="Quantity" type="number" value={c.quantity || ''} onChange={(e) => setChoice({ ...choice, [o.prescriptionLineId]: { ...c, quantity: Number(e.target.value) } })} sx={{ width: 130 }} />
            </Stack>
            {substituted && <Alert severity="info">Equivalent brand of the same generic (substitution is recorded).</Alert>}
            {brand && c.quantity > brand.available && <Alert severity="warning">Only {brand.available} usable in stock.</Alert>}
            {c.quantity > 0 && c.quantity < o.remaining && <Typography variant="caption">Partial supply: {o.remaining - c.quantity} stays on the prescription.</Typography>}
          </Stack>
        );
      })}
      {hmisBilled ? (
        <Alert severity="info">Batches are taken first-expiry-first-out. This visit is billed in the HMIS: the charge goes to the patient’s HMIS bill (payments are taken there).</Alert>
      ) : (
      <>
      <Typography variant="body2">Batches are taken first-expiry-first-out. The patient’s payer and co-pay come from the {rx.encounter ? 'visit' : 'patient record'}.</Typography>
      <Stack direction="row" spacing={1}>
        <TextField select label="Payment" value={mode} onChange={(e) => setMode(e.target.value)} sx={{ minWidth: 180, width: 'auto' }}>
          {(modes.data ?? []).filter((m) => m.isActive).map((m) => <MenuItem key={m.code} value={m.code}>{m.name}</MenuItem>)}
        </TextField>
        <TextField label="Amount tendered" type="number" value={amount} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} helperText="Leave empty to put it on account" />
        {selectedMode?.requiresReference && <TextField label="Reference (e.g. M-Pesa code)" value={reference} onChange={(e) => setReference(e.target.value)} required />}
      </Stack>
      </>
      )}
    </FormDialog>
  );
}

function CancelDialog({ rx, onClose }: { rx: Prescription; onClose(): void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const save = useApiMutation<void>(() => [`/pharmacy/prescriptions/${rx.id}/cancel-lines`, { method: 'POST', body: { lineIds: ids, reason } }], { invalidate: ['/pharmacy'], success: 'Balance cancelled' });
  return (
    <FormDialog open title="Cancel undispensed balance" submitLabel="Cancel balance" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {(rx.lines ?? []).filter((l) => l.quantity - l.dispensedQty - l.cancelledQty > 0).map((l) => (
        <FormControlLabel
          key={l.id}
          control={<Switch checked={ids.includes(l.id)} onChange={(e) => setIds(e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id))} />}
          label={`${l.generic?.innName ?? `Line ${l.lineNo}`}: ${l.quantity - l.dispensedQty - l.cancelledQty} not dispensed`}
        />
      ))}
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
    </FormDialog>
  );
}

function ReturnDialog({ rx, dispense, onClose }: { rx: Prescription; dispense: Dispense; onClose(): void }) {
  const byLine = new Map<string, number>();
  for (const l of dispense.lines) byLine.set(l.prescriptionLineId, (byLine.get(l.prescriptionLineId) ?? 0) + l.quantity - l.returnedQty);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([prescriptionLineId, quantity]) => ({ prescriptionLineId, quantity }));
  const save = useApiMutation<void>(() => [`/pharmacy/dispenses/${dispense.id}/returns`, { method: 'POST', body: { lines, reason, restock } }], { invalidate: ['/pharmacy', '/billing', '/inventory', '/hmis'], success: 'Return credited' });
  return (
    <FormDialog open title={`Return medicines from ${dispense.number}`} submitLabel="Credit and return" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {[...byLine.entries()].filter(([, left]) => left > 0).map(([lineId, left]) => {
        const l = rx.lines?.find((x) => x.id === lineId);
        return <TextField key={lineId} type="number" label={`${l?.generic?.innName ?? 'Line'} (up to ${left})`} value={qty[lineId] ?? ''} onChange={(e) => setQty({ ...qty, [lineId]: Math.min(left, Number(e.target.value)) })} />;
      })}
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <FormControlLabel control={<Switch checked={restock} onChange={(e) => setRestock(e.target.checked)} />} label="Back into sellable stock (same batch)" />
      <Typography variant="body2">
        {dispense.billingMode === 'HMIS' ? 'A credit is posted to the patient’s HMIS bill against the original charge.' : 'A credit note is issued against the dispense invoice and sent to eTIMS.'}
        {rx.encounter ? ' The dispense record in the HMIS is updated.' : ''}
      </Typography>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ patients

function PatientDialog({ patient, onClose, onSaved }: { patient?: Patient; onClose(): void; onSaved?(p: Patient): void }) {
  const payers = useList<Payer>('/billing/payers');
  const [f, setF] = useState({
    hospitalNo: patient?.hospitalNo ?? '',
    name: patient?.name ?? '',
    dateOfBirth: patient?.dateOfBirth ?? '',
    sex: patient?.sex ?? '',
    weightKg: patient?.weightKg ?? '',
    isPregnant: patient?.isPregnant ?? false,
    payerId: patient?.payerId ?? '',
    memberNo: patient?.memberNo ?? '',
    allergies: (patient?.allergies ?? []).join(', '),
    phone: patient?.phone ?? '',
    kraPin: patient?.kraPin ?? '',
  });
  const body = {
    hospitalNo: f.hospitalNo,
    name: f.name,
    dateOfBirth: f.dateOfBirth || undefined,
    sex: f.sex || undefined,
    weightKg: f.weightKg === '' ? undefined : Number(f.weightKg),
    isPregnant: f.isPregnant,
    payerId: f.payerId || undefined,
    memberNo: f.memberNo || undefined,
    allergies: f.allergies.split(',').map((a) => a.trim()).filter(Boolean),
    phone: f.phone || undefined,
    kraPin: f.kraPin || undefined,
  };
  const save = useApiMutation<void, Patient>(() => [patient ? `/patients/${patient.id}` : '/patients', { method: patient ? 'PUT' : 'POST', body }], { invalidate: ['/patients', '/pharmacy'], success: 'Patient saved' });
  return (
    <FormDialog open title={patient ? 'Edit patient' : 'New patient'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (p) => { onSaved?.(p); onClose(); } }); }}>
      <TextField label="Hospital no." value={f.hospitalNo} onChange={(e) => setF({ ...f, hospitalNo: e.target.value })} required />
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <Stack direction="row" spacing={1}>
        <TextField label="Date of birth" type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField select label="Sex" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as Patient['sex'] & string })} sx={{ minWidth: 110, width: 'auto' }}>
          <MenuItem value="F">Female</MenuItem>
          <MenuItem value="M">Male</MenuItem>
          <MenuItem value="OTHER">Other</MenuItem>
        </TextField>
        <TextField label="Weight (kg)" type="number" value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })} sx={{ width: 120 }} />
      </Stack>
      {f.sex === 'F' && <FormControlLabel control={<Switch checked={f.isPregnant} onChange={(e) => setF({ ...f, isPregnant: e.target.checked })} />} label="Pregnant" />}
      <TextField label="Allergies (comma separated substances or classes)" value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })} helperText="e.g. penicillins, sulfonamides, ibuprofen" />
      <Stack direction="row" spacing={1}>
        <TextField select label="Payer / scheme" value={f.payerId} onChange={(e) => setF({ ...f, payerId: e.target.value })} sx={{ flex: 1 }}>
          <MenuItem value="">Self (cash)</MenuItem>
          {(payers.data ?? []).filter((p) => p.isActive).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
        </TextField>
        <TextField sx={{ flex: 1 }} label="Member no." value={f.memberNo} onChange={(e) => setF({ ...f, memberNo: e.target.value })} />
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <TextField label="KRA PIN (optional)" value={f.kraPin} onChange={(e) => setF({ ...f, kraPin: e.target.value.toUpperCase() })} />
      </Stack>
    </FormDialog>
  );
}

export function PatientsPage() {
  const { can, canAny } = useAuth();
  const [search, setSearch] = useState('');
  const [paging, setPaging] = useState({ page: 0, pageSize: 25 });
  const [edit, setEdit] = useState<Patient | null | 'new'>(null);
  const [fromHmis, setFromHmis] = useState(false);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Patient>('/patients', { ...paging, search: q || undefined });
  const columns: GridColDef<Patient>[] = [
    { field: 'hospitalNo', headerName: 'Hospital no.', width: 130 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 180 },
    { field: 'dateOfBirth', headerName: 'Age', width: 110, valueFormatter: (v) => ageText(v as string | null) },
    { field: 'sex', headerName: 'Sex', width: 80 },
    { field: 'allergies', headerName: 'Allergies', flex: 1, minWidth: 160, valueFormatter: (v: string[]) => v.join(', ') },
    { field: 'isPregnant', headerName: 'Pregnant', width: 100, valueFormatter: (v) => (v ? 'Yes' : '') },
    { field: 'payer', headerName: 'Payer', width: 200, valueGetter: (_, r) => r.payer?.name ?? 'Self' },
    { field: 'externalId', headerName: 'Source', width: 110, valueFormatter: (v) => (v ? 'HMIS' : 'Local') },
  ];
  return (
    <>
      <PageHeader title="Patients" search={search} onSearch={setSearch} searchPlaceholder="Hospital no. or name" onNew={can(P.PATIENTS_MANAGE) ? () => setEdit('new') : undefined} />
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ flexGrow: 1 }}>Minimal cached patient details used for dispensing checks and invoicing (the HMIS remains the patient register).</Typography>
        {canAny(P.PATIENTS_MANAGE, P.HMIS_MANAGE) && can(P.HMIS_READ) && <Button onClick={() => setFromHmis(true)}>Find in HMIS</Button>}
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
        onRowClick={(p) => can(P.PATIENTS_MANAGE) && setEdit(p.row)}
        disableRowSelectionOnClick
      />
      {edit && <PatientDialog patient={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {fromHmis && <HmisPatientImportDialog onClose={() => setFromHmis(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ interactions

interface InteractionRow {
  id: string;
  innA: string;
  innB: string;
  severity: ClinicalAlert['severity'];
  mechanism: string;
  management: string;
  source: string;
  isActive: boolean;
}

export function InteractionsPage() {
  const { can } = useAuth();
  const dt = useDateTime();
  const [search, setSearch] = useState('');
  const [paging, setPaging] = useState({ page: 0, pageSize: 25 });
  const [edit, setEdit] = useState<InteractionRow | null | 'new'>(null);
  const [importing, setImporting] = useState(false);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: useSettings().timezone }).format(new Date());
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<InteractionRow>('/pharmacy/interactions', { ...paging, search: q || undefined });
  const report = useQuery({
    queryKey: ['/pharmacy/reports/alerts', from, to],
    queryFn: () => api<{ summary: { type: string; severity: ClinicalAlert['severity']; raised: number; overridden: number; blocking: number }[]; overrides: Record<string, string>[] }>('/pharmacy/reports/alerts', { query: { from, to } }),
  });
  const columns: GridColDef<InteractionRow>[] = [
    { field: 'innA', headerName: 'Substance / class A', width: 200 },
    { field: 'innB', headerName: 'Substance / class B', width: 200 },
    { field: 'severity', headerName: 'Severity', width: 150, renderCell: ({ value }) => <SeverityChip severity={value} /> },
    { field: 'mechanism', headerName: 'Mechanism', flex: 1, minWidth: 200 },
    { field: 'management', headerName: 'Advice', flex: 1, minWidth: 200 },
    { field: 'source', headerName: 'Source', width: 110, renderCell: ({ value }) => (value === 'DEMO' ? <Chip size="small" color="warning" label="DEMO" /> : value) },
  ];
  return (
    <>
      <PageHeader
        title="Drug interactions"
        search={search}
        onSearch={setSearch}
        onNew={can(P.PHARMACY_INTERACTIONS) ? () => setEdit('new') : undefined}
        actions={can(P.PHARMACY_INTERACTIONS) ? <Button onClick={() => setImporting(true)}>Import CSV</Button> : undefined}
      />
      <Alert severity="warning" sx={{ mb: 2 }}>
        Rows marked DEMO are an illustrative starter set, not a clinical reference. Replace or extend them from a licensed source (CSV import) before go-live.
      </Alert>
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
        onRowClick={(p) => can(P.PHARMACY_INTERACTIONS) && setEdit(p.row)}
        disableRowSelectionOnClick
      />
      <Paper sx={{ p: 2, mt: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Alerts raised vs overridden</Typography>
          <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <Button href={`/api/v1/pharmacy/reports/alerts?from=${from}&to=${to}&format=csv`}>Override log CSV</Button>
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Type</TableCell>
              <TableCell>Severity</TableCell>
              <TableCell align="right">Raised</TableCell>
              <TableCell align="right">Blocking</TableCell>
              <TableCell align="right">Overridden</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(report.data?.summary ?? []).map((r) => (
              <TableRow key={`${r.type}-${r.severity}`}>
                <TableCell>{humanise(r.type)}</TableCell>
                <TableCell><SeverityChip severity={r.severity} /></TableCell>
                <TableCell align="right">{r.raised}</TableCell>
                <TableCell align="right">{r.blocking}</TableCell>
                <TableCell align="right">{r.overridden}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="subtitle2" sx={{ mt: 2 }}>Overrides</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>Prescription</TableCell>
              <TableCell>Patient</TableCell>
              <TableCell>Alert</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Pharmacist</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(report.data?.overrides ?? []).map((o, i) => (
              <TableRow key={i}>
                <TableCell>{dt(o.at)}</TableCell>
                <TableCell>{o.prescription}</TableCell>
                <TableCell>{o.hospital_no} {o.patient}</TableCell>
                <TableCell>{humanise(o.severity)}: {o.message}</TableCell>
                <TableCell>{o.reason}</TableCell>
                <TableCell>{o.pharmacist}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {edit && <InteractionDialog row={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {importing && <InteractionImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}

function InteractionDialog({ row, onClose }: { row?: InteractionRow; onClose(): void }) {
  const [f, setF] = useState({ innA: row?.innA ?? '', innB: row?.innB ?? '', severity: row?.severity ?? 'MODERATE', mechanism: row?.mechanism ?? '', management: row?.management ?? '', isActive: row?.isActive ?? true });
  const save = useApiMutation<void>(() => [row ? `/pharmacy/interactions/${row.id}` : '/pharmacy/interactions', { method: row ? 'PUT' : 'POST', body: f }], { invalidate: ['/pharmacy/interactions'], success: 'Interaction saved' });
  return (
    <FormDialog open title={row ? 'Edit interaction' : 'New interaction'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Substance or class A" value={f.innA} onChange={(e) => setF({ ...f, innA: e.target.value })} helperText='INN (e.g. "ciprofloxacin") or "class:nsaid"' required />
      <TextField label="Substance or class B" value={f.innB} onChange={(e) => setF({ ...f, innB: e.target.value })} required />
      <TextField select label="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as InteractionRow['severity'] })}>
        {['CONTRAINDICATED', 'MAJOR', 'MODERATE', 'MINOR'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
      </TextField>
      <TextField label="Mechanism / effect" value={f.mechanism} onChange={(e) => setF({ ...f, mechanism: e.target.value })} multiline required />
      <TextField label="Advice" value={f.management} onChange={(e) => setF({ ...f, management: e.target.value })} multiline required />
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function InteractionImportDialog({ onClose }: { onClose(): void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ imported: number; updated: number; errors: string[]; valid: number } | null>(null);
  const run = useApiMutation<boolean, { imported: number; updated: number; errors: string[]; valid: number }>((dryRun) => ['/pharmacy/interactions/import', { method: 'POST', body: { csv, dryRun } }], { invalidate: ['/pharmacy/interactions'] });
  return (
    <FormDialog open title="Import interactions (CSV)" submitLabel="Import" maxWidth="md" onClose={onClose} submitting={run.isPending} onSubmit={(e) => { e.preventDefault(); run.mutate(false, { onSuccess: setResult }); }}>
      <Typography variant="body2">Columns: inn_a, inn_b, severity (CONTRAINDICATED/MAJOR/MODERATE/MINOR), mechanism, management[, source]. Existing pairs are updated.</Typography>
      <Button component="label" variant="outlined">
        Choose file
        <input hidden type="file" accept=".csv,text/csv" onChange={async (e) => setCsv((await e.target.files?.[0]?.text()) ?? '')} />
      </Button>
      <TextField label="CSV" value={csv} onChange={(e) => setCsv(e.target.value)} multiline minRows={6} />
      <Box>
        <Button onClick={() => run.mutate(true, { onSuccess: setResult })} disabled={!csv}>Check only</Button>
      </Box>
      {result && (
        <Alert severity={result.errors.length ? 'warning' : 'success'}>
          {result.valid} valid row(s); {result.imported} added, {result.updated} updated.
          {result.errors.map((e) => <div key={e}>{e}</div>)}
        </Alert>
      )}
    </FormDialog>
  );
}

import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  List,
  ListItem,
  ListItemText,
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
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Permissions, type Paginated } from '@sil/shared';
import { api } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { Encounter, EncounterDetail, HmisConnection, HmisDashboard, HmisMapping, HmisMappingKind, HmisMessage, HmisPatientHit, PatientCharge, WardSupplyLine, WardSupplyList } from '../api/hmis-types';
import type { BrandOption, Payer } from '../api/pharmacy-types';
import type { Department, Generic, Item, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip, StoreSelect } from '../inventory/components';
import { formatDate, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { DetailLayout, Field, useMoney } from '../purchasing/common';
import { useSettings } from '../settings/SettingsContext';
import { GenericPicker } from '../pharmacy/ui';

const P = Permissions;
const MAPPING_KINDS: { kind: HmisMappingKind; label: string; help: string }[] = [
  { kind: 'DRUG', label: 'Drugs', help: 'HMIS drug code → generic (or a brand item, when the HMIS orders a brand)' },
  { kind: 'LOCATION', label: 'Dispensing locations', help: 'HMIS dispensing location → pharmacy outlet whose worklist receives the order' },
  { kind: 'WARD', label: 'Wards', help: 'HMIS ward → department (ward supply list, consumables charged by the ward)' },
  { kind: 'PAYER', label: 'Payers', help: 'HMIS payer / scheme code → payer (price list and co-pay); unmapped = cash' },
];

function useDt() {
  const { dateFormat, timezone } = useSettings();
  return (v: string | null | undefined) => (v ? formatDate(v, dateFormat, timezone, true) : '—');
}

const MSG_COLOURS: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = { PROCESSED: 'success', SENT: 'success', POSTED: 'success', INVOICED: 'info', PENDING: 'warning', FAILED: 'error', IGNORED: 'default' };
export function HmisStatusChip({ status }: { status: string }) {
  return <Chip size="small" color={MSG_COLOURS[status] ?? 'default'} label={humanise(status)} />;
}

// ------------------------------------------------------------------ console

/** HMIS integration: health and error dashboard, message log, code mapping, connection, specification notes. */
export function HmisConsolePage() {
  const [tab, setTab] = useState(0);
  const [mapCode, setMapCode] = useState<{ code: string; display: string | null } | null>(null);
  return (
    <>
      <PageHeader title="HMIS integration" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="Dashboard" />
        <Tab label="Messages" />
        <Tab label="Code mapping" />
        <Tab label="Connection" />
        <Tab label="Specification notes" />
      </Tabs>
      {tab === 0 && <DashboardTab onMap={(c) => { setMapCode(c); setTab(2); }} />}
      {tab === 1 && <MessagesTab />}
      {tab === 2 && <MappingTab prefill={mapCode} onPrefillUsed={() => setMapCode(null)} />}
      {tab === 3 && <ConnectionTab />}
      {tab === 4 && <AssumptionsTab />}
    </>
  );
}

function DashboardTab({ onMap }: { onMap(c: { code: string; display: string | null }): void }) {
  const { can } = useAuth();
  const dt = useDt();
  const dash = useQuery({ queryKey: ['/hmis/dashboard'], queryFn: () => api<HmisDashboard>('/hmis/dashboard'), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const test = useApiMutation<void, { ok: boolean; detail: string; ms: number }>(() => ['/hmis/connection/test', { method: 'POST' }], {});
  const sync = useApiMutation<void>(() => ['/hmis/sync', { method: 'POST' }], { invalidate: ['/hmis', '/pharmacy'], success: 'Polled the HMIS and sent what was queued' });
  const reprocess = useApiMutation<string>((id) => [`/hmis/messages/${id}/reprocess`, { method: 'POST' }], { invalidate: ['/hmis', '/pharmacy'], success: 'Reprocessed' });
  const d = dash.data;
  if (!d) return null;
  if (!d.connection) return <Alert severity="info">No HMIS is linked yet. Configure it under Connection.</Alert>;
  const count = (dir: string, st: string) => d.counts.find((c) => c.direction === dir && c.status === st)?.n ?? 0;
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="subtitle1">
              {d.connection.name} · {d.connection.adapter}
              {d.connection.adapter === 'MOCK' && <Chip size="small" color="warning" label="Mock — not a real HMIS" sx={{ ml: 1 }} />}
              {!d.connection.isActive && <Chip size="small" label="Inactive" sx={{ ml: 1 }} />}
            </Typography>
            <Typography variant="body2">
              Billing: {d.connection.billingMode === 'HMIS' ? 'charges posted to the HMIS bill' : 'invoiced here (eTIMS)'} · Orders: {d.connection.pollOrders ? `polled (last ${dt(d.connection.lastPolledAt)})` : 'pushed by the HMIS'}
            </Typography>
            {d.connection.lastPollError && <Alert severity="warning" sx={{ mt: 1 }}>Last poll failed: {d.connection.lastPollError}</Alert>}
            {test.data && <Alert severity={test.data.ok ? 'success' : 'error'} sx={{ mt: 1 }}>{test.data.detail} ({test.data.ms} ms)</Alert>}
          </Box>
          {can(P.HMIS_MANAGE) && (
            <Stack direction="row" spacing={1}>
              <Button onClick={() => test.mutate()} disabled={test.isPending}>Test connection</Button>
              <Button variant="contained" onClick={() => sync.mutate()} disabled={sync.isPending}>Sync now</Button>
            </Stack>
          )}
        </Stack>
      </Paper>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        {[
          ['Received and processed', count('IN', 'PROCESSED')],
          ['Inbound failed', count('IN', 'FAILED')],
          ['Sent to the HMIS', count('OUT', 'SENT')],
          ['Waiting / retrying', d.pending.count],
          ['Outbound failed', count('OUT', 'FAILED')],
        ].map(([label, n]) => (
          <Paper key={label as string} sx={{ p: 2, flex: 1 }}>
            <Typography variant="h5">{n}</Typography>
            <Typography variant="body2">{label}</Typography>
          </Paper>
        ))}
      </Stack>
      {d.pending.count > 0 && <Alert severity="info">Oldest message waiting since {dt(d.pending.oldestAt)}; retries back off up to an hour.</Alert>}
      {d.unmappedDrugs.length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" gutterBottom>Unmapped drug codes</Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>Orders with these codes did not reach a worklist. Map the code, then reprocess the failed messages.</Typography>
          <Table size="small">
            <TableHead><TableRow><TableCell>HMIS code</TableCell><TableCell>Name in the HMIS</TableCell><TableCell align="right">Messages</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {d.unmappedDrugs.map((u) => (
                <TableRow key={u.code}>
                  <TableCell>{u.code}</TableCell><TableCell>{u.display}</TableCell><TableCell align="right">{u.messages}</TableCell>
                  <TableCell>{can(P.HMIS_MANAGE) && <Button size="small" onClick={() => onMap(u)}>Map</Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Failed messages</Typography>
        {d.failed.length === 0 ? <Alert severity="success">Nothing failed.</Alert> : (
          <Table size="small">
            <TableHead><TableRow><TableCell>When</TableCell><TableCell>Direction</TableCell><TableCell>Type</TableCell><TableCell>Document</TableCell><TableCell>Error</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {d.failed.map((f) => (
                <TableRow key={f.id} hover onClick={() => setOpen(f.id)} sx={{ cursor: 'pointer' }}>
                  <TableCell>{dt(f.createdAt)}</TableCell><TableCell>{f.direction}</TableCell><TableCell>{humanise(f.type)}</TableCell>
                  <TableCell>{f.localDocNo ?? f.externalId ?? '—'}</TableCell><TableCell sx={{ maxWidth: 420 }}>{f.error}</TableCell>
                  <TableCell>{can(P.HMIS_MANAGE) && <Button size="small" onClick={(e) => { e.stopPropagation(); reprocess.mutate(f.id); }}>Reprocess</Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Last 24 hours</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {d.last24h.map((r) => <Chip key={`${r.direction}${r.type}`} label={`${r.direction} ${humanise(r.type)}: ${r.n}${r.duplicates ? ` (+${r.duplicates} repeats ignored)` : ''}`} />)}
          {d.last24h.length === 0 && <Typography variant="body2">No traffic.</Typography>}
        </Stack>
      </Paper>
      {open && <MessageDialog id={open} onClose={() => setOpen(null)} />}
    </Stack>
  );
}

function MessagesTab() {
  const dt = useDt();
  const [paging, setPaging] = useState({ page: 0, pageSize: 50 });
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [open, setOpen] = useState<string | null>(null);
  const { data, isFetching } = usePaged<HmisMessage>('/hmis/messages', { ...paging, direction: direction || undefined, status: status || undefined, type: type || undefined, search: q || undefined });
  const columns: GridColDef<HmisMessage>[] = [
    { field: 'createdAt', headerName: 'When', width: 160, valueFormatter: (v) => dt(v as string) },
    { field: 'direction', headerName: 'Dir.', width: 70 },
    { field: 'type', headerName: 'Type', width: 170, valueFormatter: (v) => humanise(v as string) },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <HmisStatusChip status={value} /> },
    { field: 'externalId', headerName: 'HMIS id', width: 140 },
    { field: 'localDocNo', headerName: 'Document', width: 190 },
    { field: 'via', headerName: 'Via', width: 90 },
    { field: 'attempts', headerName: 'Tries', width: 70 },
    { field: 'error', headerName: 'Error / note', flex: 1, minWidth: 200 },
  ];
  return (
    <>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)} sx={{ minWidth: 130 }}>
          <MenuItem value="">All</MenuItem><MenuItem value="IN">In</MenuItem><MenuItem value="OUT">Out</MenuItem>
        </TextField>
        <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">All</MenuItem>
          {['PATIENT', 'ENCOUNTER', 'ALLERGY', 'MEDICATION_REQUEST', 'MEDICATION_DISPENSE', 'CHARGE'].map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
        </TextField>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 150 }}>
          <MenuItem value="">All</MenuItem>
          {['PENDING', 'PROCESSED', 'SENT', 'FAILED', 'IGNORED'].map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
        </TextField>
        <TextField label="Search (HMIS id, document, error)" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} />
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
        pageSizeOptions={[50, 100, 200]}
        onRowClick={(p) => setOpen(String(p.id))}
        disableRowSelectionOnClick
      />
      {open && <MessageDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, maxHeight: 280, overflow: 'auto' }}>
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

function MessageDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth();
  const dt = useDt();
  const { data: m } = useQuery({ queryKey: ['/hmis/messages', id], queryFn: () => api<HmisMessage>(`/hmis/messages/${id}`) });
  const reprocess = useApiMutation<void>(() => [`/hmis/messages/${id}/reprocess`, { method: 'POST' }], { invalidate: ['/hmis', '/pharmacy'], success: 'Reprocessed' });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{m ? `${m.direction} ${humanise(m.type)}` : 'Message'}</DialogTitle>
      <DialogContent dividers>
        {m && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center"><HmisStatusChip status={m.status} /><Typography variant="body2">{m.idempotencyKey}</Typography></Stack>
            <Typography variant="body2">
              Created {dt(m.createdAt)} · processed {dt(m.processedAt)} · tries {m.attempts}{m.status === 'PENDING' ? ` · next ${dt(m.nextAttemptAt)}` : ''}{m.httpStatus ? ` · HTTP ${m.httpStatus}` : ''}{m.duplicates ? ` · ${m.duplicates} repeat(s) ignored` : ''}
            </Typography>
            {m.localDocNo && <Typography variant="body2">Document: {m.localDocType} {m.localDocNo}{m.localDocType === 'PRESCRIPTION' && m.localDocId && <> · <Link component={RouterLink} to={`/pharmacy/prescriptions/${m.localDocId}`}>open</Link></>}</Typography>}
            {m.error && <Alert severity={m.status === 'FAILED' ? 'error' : 'info'}>{m.error}</Alert>}
            <Typography variant="subtitle2">{m.direction === 'IN' ? 'As received' : 'Payload'}</Typography>
            <Json value={m.payload} />
            {m.request && <><Typography variant="subtitle2">Request sent</Typography><Json value={m.request} /></>}
            {m.response && <><Typography variant="subtitle2">Response</Typography><Json value={m.response} /></>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {m && can(P.HMIS_MANAGE) && ['FAILED', 'PENDING', 'IGNORED'].includes(m.status) && <Button onClick={() => reprocess.mutate()}>Reprocess</Button>}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function MappingTab({ prefill, onPrefillUsed }: { prefill: { code: string; display: string | null } | null; onPrefillUsed(): void }) {
  const { can } = useAuth();
  const [kind, setKind] = useState<HmisMappingKind>('DRUG');
  const maps = useList<HmisMapping>('/hmis/mappings', { kind });
  const [edit, setEdit] = useState<Partial<HmisMapping> | null>(null);
  const del = useApiMutation<string>((id) => [`/hmis/mappings/${id}`, { method: 'DELETE' }], { invalidate: ['/hmis'], success: 'Mapping removed' });
  useEffect(() => {
    if (prefill) {
      setKind('DRUG');
      setEdit({ kind: 'DRUG', externalCode: prefill.code, externalDisplay: prefill.display });
      onPrefillUsed();
    }
  }, [prefill, onPrefillUsed]);
  const info = MAPPING_KINDS.find((k) => k.kind === kind)!;
  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
        <TextField select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as HmisMappingKind)} sx={{ minWidth: 220 }}>
          {MAPPING_KINDS.map((k) => <MenuItem key={k.kind} value={k.kind}>{k.label}</MenuItem>)}
        </TextField>
        <Typography variant="body2" sx={{ flexGrow: 1 }}>{info.help}</Typography>
        {can(P.HMIS_MANAGE) && <Button variant="contained" onClick={() => setEdit({ kind })}>Add mapping</Button>}
      </Stack>
      <Table size="small">
        <TableHead><TableRow><TableCell>HMIS code</TableCell><TableCell>HMIS name</TableCell><TableCell>Maps to</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(maps.data ?? []).map((m) => (
            <TableRow key={m.id}>
              <TableCell>{m.externalCode}</TableCell>
              <TableCell>{m.externalDisplay}</TableCell>
              <TableCell>{m.localCode ? `${m.localCode} · ` : ''}{m.localName ?? m.localId}{m.isItem && <Chip size="small" label="Brand" sx={{ ml: 1 }} />}</TableCell>
              <TableCell align="right">
                {can(P.HMIS_MANAGE) && <><Button size="small" onClick={() => setEdit(m)}>Edit</Button><Button size="small" color="error" onClick={() => del.mutate(m.id)}>Remove</Button></>}
              </TableCell>
            </TableRow>
          ))}
          {(maps.data ?? []).length === 0 && <TableRow><TableCell colSpan={4}>No mappings yet.</TableCell></TableRow>}
        </TableBody>
      </Table>
      {edit && <MappingDialog value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function MappingDialog({ value, onClose }: { value: Partial<HmisMapping>; onClose(): void }) {
  const kind = value.kind ?? 'DRUG';
  const [code, setCode] = useState(value.externalCode ?? '');
  const [display, setDisplay] = useState(value.externalDisplay ?? '');
  const [isItem, setIsItem] = useState(value.isItem ?? false);
  const [localId, setLocalId] = useState(value.localId ?? '');
  const [generic, setGeneric] = useState<Generic | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const departments = useAll<Department>('/departments', undefined, kind === 'WARD');
  const payers = useList<Payer>('/billing/payers', undefined, kind === 'PAYER');
  const target = kind === 'DRUG' ? (isItem ? item?.id : generic?.id) ?? localId : localId;
  const save = useApiMutation<void>(() => ['/hmis/mappings', { method: 'PUT', body: { kind, externalCode: code, externalDisplay: display || undefined, localId: target, isItem: kind === 'DRUG' ? isItem : undefined } }], { invalidate: ['/hmis'], success: 'Mapping saved' });
  return (
    <FormDialog open title={`${value.id ? 'Edit' : 'Add'} ${MAPPING_KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} mapping`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="HMIS code" value={code} onChange={(e) => setCode(e.target.value)} required disabled={!!value.id} />
      <TextField label="HMIS name (optional)" value={display} onChange={(e) => setDisplay(e.target.value)} />
      {kind === 'DRUG' && (
        <>
          <FormControlLabel control={<Switch checked={isItem} onChange={(e) => setIsItem(e.target.checked)} />} label="The HMIS code is a specific brand" />
          {isItem ? <ItemPicker value={item} onChange={setItem} label="Brand item" /> : <GenericPicker value={generic} onChange={setGeneric} />}
          {value.localName && !generic && !item && <Typography variant="body2">Currently: {value.localName}</Typography>}
        </>
      )}
      {kind === 'LOCATION' && <StoreSelect value={localId} onChange={setLocalId} label="Pharmacy outlet" />}
      {kind === 'WARD' && (
        <TextField select label="Department / ward" value={localId} onChange={(e) => setLocalId(e.target.value)}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      )}
      {kind === 'PAYER' && (
        <TextField select label="Payer" value={localId} onChange={(e) => setLocalId(e.target.value)}>
          {(payers.data ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
        </TextField>
      )}
    </FormDialog>
  );
}

function ConnectionTab() {
  const { can } = useAuth();
  const { data: c, isFetched } = useQuery({ queryKey: ['/hmis/connection'], queryFn: () => api<HmisConnection | null>('/hmis/connection') });
  const [f, setF] = useState({ name: 'HMIS', adapter: 'FHIR', baseUrl: '', authToken: '', authHeader: 'Authorization', hospitalNoSystem: 'urn:sil:hospital-no', billingMode: 'LOCAL', sendDispenses: true, pollOrders: true, isActive: true });
  useEffect(() => {
    if (c) setF({ name: c.name, adapter: c.adapter, baseUrl: c.baseUrl ?? '', authToken: '', authHeader: c.authHeader, hospitalNoSystem: c.hospitalNoSystem, billingMode: c.billingMode, sendDispenses: c.sendDispenses, pollOrders: c.pollOrders, isActive: c.isActive });
  }, [c]);
  const save = useApiMutation<void>(
    () => ['/hmis/connection', { method: 'PUT', body: { ...f, baseUrl: f.baseUrl || undefined, authToken: f.authToken || undefined } }],
    { invalidate: ['/hmis'], success: 'Connection saved' },
  );
  if (!isFetched) return null;
  const editable = can(P.HMIS_MANAGE);
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 640 }}>
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!editable} />
        <TextField select label="Protocol" value={f.adapter} onChange={(e) => setF({ ...f, adapter: e.target.value })} disabled={!editable} helperText="FHIR R4 REST; generic REST (JSON contract in the specification notes); HL7 v2 over MLLP (the HMIS pushes ADT / RDE); MOCK = built-in test HMIS">
          <MenuItem value="FHIR">FHIR R4</MenuItem><MenuItem value="REST">Generic REST</MenuItem><MenuItem value="HL7">HL7 v2 (MLLP)</MenuItem><MenuItem value="MOCK">Mock (not a real HMIS)</MenuItem>
        </TextField>
        <TextField label="Base URL" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} disabled={!editable} helperText={f.adapter === 'MOCK' ? 'Empty: in-process mock; or the mock-hmis service, e.g. http://mock-hmis:8090/fhir' : f.adapter === 'HL7' ? 'Where RDS / DFT messages go: mllp://host:port (mllp://mock-hmis:2575 for the mock; mllp://mock in-process). Inbound ADT / RDE: MLLP on HL7_MLLP_PORT or POST /integration/hmis/hl7' : 'e.g. https://hmis.example/fhir'} />
        <Stack direction="row" spacing={2}>
          <TextField label="Auth header" value={f.authHeader} onChange={(e) => setF({ ...f, authHeader: e.target.value })} disabled={!editable} sx={{ width: 200 }} />
          <TextField label={c?.hasToken ? 'Token (stored — leave empty to keep)' : 'Token / API key'} type="password" value={f.authToken} onChange={(e) => setF({ ...f, authToken: e.target.value })} disabled={!editable} sx={{ flex: 1 }} />
        </Stack>
        <TextField label="Hospital number identifier system" value={f.hospitalNoSystem} onChange={(e) => setF({ ...f, hospitalNoSystem: e.target.value })} disabled={!editable} />
        <TextField select label="Who bills patient charges" value={f.billingMode} onChange={(e) => setF({ ...f, billingMode: e.target.value })} disabled={!editable}>
          <MenuItem value="LOCAL">This system (sales invoice + eTIMS; nothing posted to the HMIS bill)</MenuItem>
          <MenuItem value="HMIS">The HMIS (charges posted to the patient&apos;s HMIS bill; no local invoice)</MenuItem>
        </TextField>
        <FormControlLabel control={<Switch checked={f.sendDispenses} onChange={(e) => setF({ ...f, sendDispenses: e.target.checked })} disabled={!editable} />} label="Send dispense records (MedicationDispense) to the HMIS" />
        <FormControlLabel control={<Switch checked={f.pollOrders && f.adapter !== 'HL7'} onChange={(e) => setF({ ...f, pollOrders: e.target.checked })} disabled={!editable || f.adapter === 'HL7'} />} label="Poll the HMIS for orders (off when the HMIS pushes to /integration/hmis)" />
        <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} disabled={!editable} />} label="Active" />
        {editable && <Box><Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending}>Save connection</Button></Box>}
        <Alert severity="info">
          An HMIS that pushes data posts FHIR resources or Bundles to <code>/api/v1/integration/hmis/fhir</code> (or REST events to <code>/integration/hmis/events</code>) with an API key that has the <code>hmis</code> scope (created under eTIMS → API clients).
        </Alert>
      </Stack>
    </Paper>
  );
}

function AssumptionsTab() {
  const { data } = useQuery({ queryKey: ['/hmis/assumptions'], queryFn: () => api<{ topic: string; choice: string }[]>('/hmis/assumptions') });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>Choices made where FHIR R4 or a typical HMIS leaves room. Review them with the HMIS vendor before go-live.</Typography>
      <List dense>
        {(data ?? []).map((a) => (
          <ListItem key={a.topic}><ListItemText primary={a.topic} secondary={a.choice} /></ListItem>
        ))}
      </List>
    </Paper>
  );
}

// ------------------------------------------------------------------ patients from the HMIS

/** Search the HMIS and bring a patient into the cache (or refresh one). */
export function HmisPatientImportDialog({ onClose, onImported }: { onClose(): void; onImported?(patientId: string): void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<HmisPatientHit[] | null>(null);
  const search = useApiMutation<void, HmisPatientHit[]>(() => ['/hmis/patients/search', { method: 'GET', query: { q } }], {});
  const imp = useApiMutation<string, { id: string; name: string }>((externalId) => ['/hmis/patients/import', { method: 'POST', body: { externalId } }], { invalidate: ['/patients', '/hmis'], success: 'Patient brought in from the HMIS' });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Find a patient in the HMIS</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); search.mutate(undefined, { onSuccess: setHits }); }}>
            <TextField label="Hospital number or name" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1 }} autoFocus />
            <Button type="submit" variant="contained" disabled={q.trim().length < 2 || search.isPending}>Search</Button>
          </Stack>
          {hits && hits.length === 0 && <Alert severity="info">No patient found in the HMIS.</Alert>}
          {hits && hits.length > 0 && (
            <Table size="small">
              <TableHead><TableRow><TableCell>Hospital no.</TableCell><TableCell>Name</TableCell><TableCell>Born</TableCell><TableCell>Sex</TableCell><TableCell /></TableRow></TableHead>
              <TableBody>
                {hits.map((h) => (
                  <TableRow key={h.externalId}>
                    <TableCell>{h.hospitalNo}</TableCell><TableCell>{h.name}{h.isPregnant && <Chip size="small" label="Pregnant" sx={{ ml: 1 }} />}</TableCell>
                    <TableCell>{h.dateOfBirth ?? '—'}</TableCell><TableCell>{h.sex ?? '—'}</TableCell>
                    <TableCell align="right">
                      <Button size="small" variant={h.patientId ? 'text' : 'contained'} disabled={imp.isPending} onClick={() => imp.mutate(h.externalId, { onSuccess: (p) => { onImported?.(p.id); onClose(); } })}>
                        {h.patientId ? 'Refresh' : 'Bring in'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

/** Active visit / admission picker (ward staff choose the patient a consumable is for). */
export function EncounterPicker({ value, onChange, departmentId, label = 'Patient (admission / visit)' }: { value: Encounter | null; onChange(e: Encounter | null): void; departmentId?: string; label?: string }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 250);
  const { data, isFetching } = useQuery({
    queryKey: ['/hmis/encounters', 'picker', q, departmentId],
    queryFn: () => api<Paginated<Encounter>>('/hmis/encounters', { query: { status: 'ACTIVE', search: q || undefined, departmentId, pageSize: 20 } }),
  });
  return (
    <Autocomplete
      value={value}
      options={data?.items ?? (value ? [value] : [])}
      loading={isFetching}
      getOptionLabel={(e) => `${e.patient?.hospitalNo ?? ''} · ${e.patient?.name ?? ''} · ${e.class}${e.bed ? ` bed ${e.bed}` : ''}`}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterOptions={(x) => x}
      inputValue={input}
      onInputChange={(_, v, reason) => reason !== 'reset' && setInput(v)}
      onChange={(_, v) => onChange(v)}
      sx={{ minWidth: 260, flex: 1 }}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

// ------------------------------------------------------------------ encounters

export function EncountersPage() {
  const navigate = useNavigate();
  const dt = useDt();
  const [paging, setPaging] = useState({ page: 0, pageSize: 25 });
  const [status, setStatus] = useState('ACTIVE');
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const departments = useAll<Department>('/departments');
  const { data, isFetching } = usePaged<Encounter>('/hmis/encounters', { ...paging, status: status || undefined, departmentId: departmentId || undefined, search: q || undefined });
  const columns: GridColDef<Encounter>[] = [
    { field: 'patient', headerName: 'Patient', flex: 1, minWidth: 220, valueGetter: (_, r) => `${r.patient?.hospitalNo ?? ''} · ${r.patient?.name ?? ''}` },
    { field: 'class', headerName: 'Visit', width: 110 },
    { field: 'department', headerName: 'Ward', width: 160, valueGetter: (_, r) => r.department?.name ?? r.wardCode ?? '' },
    { field: 'bed', headerName: 'Bed', width: 80 },
    { field: 'payer', headerName: 'Payer', width: 180, valueGetter: (_, r) => r.payer?.name ?? 'Cash' },
    { field: 'startedAt', headerName: 'Started', width: 160, valueFormatter: (v) => dt(v as string) },
    { field: 'externalId', headerName: 'HMIS id', width: 130 },
    { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Encounters" search={search} onSearch={setSearch} searchPlaceholder="Patient, hospital no., bed or HMIS id" />
      <Typography variant="body2" sx={{ mb: 1 }}>Visits and admissions cached from the HMIS (the HMIS is the register), with what has been dispensed and charged to each.</Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 160 }}>
          <MenuItem value="">All</MenuItem>{['ACTIVE', 'FINISHED', 'CANCELLED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        <TextField select label="Ward" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ minWidth: 220 }}>
          <MenuItem value="">All</MenuItem>{(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
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
        onRowClick={(p) => navigate(`/encounters/${p.id}`)}
        disableRowSelectionOnClick
      />
    </>
  );
}

export function EncounterDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const dt = useDt();
  const money = useMoney();
  const { data: e } = useQuery({ queryKey: ['/hmis/encounters', id], queryFn: () => api<EncounterDetail>(`/hmis/encounters/${id}`) });
  const [charging, setCharging] = useState(false);
  const [reversing, setReversing] = useState<PatientCharge | null>(null);
  if (!e) return null;
  const reversedQty = (c: PatientCharge) => -e.charges.filter((x) => x.reversesId === c.id).reduce((s, x) => s + x.quantity, 0);
  const main = (
    <Stack spacing={2}>
      {e.patient && (
        <Alert severity={e.patient.allergies.length || e.patient.isPregnant ? 'warning' : 'info'} icon={false}>
          <strong>{e.patient.name}</strong> · {e.patient.hospitalNo}{e.patient.isPregnant ? ' · PREGNANT' : ''} · Allergies: {e.patient.allergies.length ? e.patient.allergies.join(', ') : 'none recorded'}
        </Alert>
      )}
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Prescriptions</Typography>
        {e.prescriptions.length === 0 && <Typography variant="body2">None.</Typography>}
        <Stack spacing={0.5}>
          {e.prescriptions.map((rx) => (
            <Stack key={rx.id} direction="row" spacing={1} alignItems="center">
              <Link component={RouterLink} to={`/pharmacy/prescriptions/${rx.id}`}>{rx.number}</Link>
              <StatusChip status={rx.status} />
              {rx.supplyMode !== 'STANDARD' && <Chip size="small" variant="outlined" label={humanise(rx.supplyMode)} />}
              <Typography variant="body2">{rx.store} · {dt(rx.receivedAt)}</Typography>
            </Stack>
          ))}
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>Charges</Typography>
          {can(P.PATIENTS_CHARGE) && e.status === 'ACTIVE' && <Button variant="contained" size="small" onClick={() => setCharging(true)}>Charge ward consumables</Button>}
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>When</TableCell><TableCell>Source</TableCell><TableCell>Item</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Amount</TableCell><TableCell>Status</TableCell><TableCell>HMIS / invoice</TableCell><TableCell /></TableRow>
          </TableHead>
          <TableBody>
            {e.charges.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{dt(c.createdAt)}</TableCell>
                <TableCell>{humanise(c.source)}{c.sourceNo ? ` ${c.sourceNo}` : ''}{c.reversesId && <Chip size="small" label="Reversal" sx={{ ml: 1 }} />}</TableCell>
                <TableCell>{c.description}{c.note ? ` — ${c.note}` : ''}</TableCell>
                <TableCell align="right">{c.quantity}</TableCell>
                <TableCell align="right">{money(c.amount)}</TableCell>
                <TableCell><HmisStatusChip status={c.status} /></TableCell>
                <TableCell>{c.externalId ?? (c.invoiceId ? <Link component={RouterLink} to={`/sales/${c.invoiceId}`}>invoice</Link> : '—')}</TableCell>
                <TableCell>
                  {can(P.PATIENTS_CHARGE) && !c.reversesId && c.status !== 'INVOICED' && c.quantity - reversedQty(c) > 0 && <Button size="small" onClick={() => setReversing(c)}>Reverse</Button>}
                </TableCell>
              </TableRow>
            ))}
            {e.charges.length === 0 && <TableRow><TableCell colSpan={8}>No charges yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
        <Typography variant="body2" sx={{ mt: 1 }}>Total charged {money(e.totals.charged)}{e.totals.pendingToHmis ? ` · ${e.totals.pendingToHmis} waiting to reach the HMIS` : ''}</Typography>
      </Paper>
    </Stack>
  );
  const side = (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="h6">{humanise(e.class)} visit</Typography>
        <Box><StatusChip status={e.status} /></Box>
        <Field label="HMIS id">{e.externalId}</Field>
        <Field label="Ward / bed">{e.department?.name ?? e.wardCode ?? '—'}{e.bed ? ` · ${e.bed}` : ''}</Field>
        <Field label="Payer">{e.payer?.name ?? 'Cash'}{e.memberNo ? ` (${e.memberNo})` : ''}</Field>
        <Field label="Attending">{e.attending ?? '—'}</Field>
        <Field label="Started">{dt(e.startedAt)}</Field>
        {e.endedAt && <Field label="Ended">{dt(e.endedAt)}</Field>}
        <Field label="Synchronised">{dt(e.syncedAt)}</Field>
      </Stack>
    </Paper>
  );
  return (
    <>
      <PageHeader title={`Encounter ${e.externalId}`} />
      <DetailLayout main={main} side={side} />
      {charging && <WardConsumptionDialog encounter={e} onClose={() => setCharging(false)} />}
      {reversing && <ReverseChargeDialog charge={reversing} left={reversing.quantity - reversedQty(reversing)} onClose={() => setReversing(null)} />}
    </>
  );
}

function WardConsumptionDialog({ encounter, onClose }: { encounter: EncounterDetail; onClose(): void }) {
  const { user } = useAuth();
  const departments = useAll<Department>('/departments');
  const [departmentId, setDepartmentId] = useState(encounter.departmentId ?? user?.departmentId ?? '');
  const [storeId, setStoreId] = useState('');
  const stores = useList<Store>('/stores/directory');
  const [lines, setLines] = useState<{ item: Item | null; quantity: number }[]>([{ item: null, quantity: 1 }]);
  const [note, setNote] = useState('');
  const save = useApiMutation<void>(
    () => ['/patient-charges/ward-consumption', { method: 'POST', body: { encounterId: encounter.id, departmentId, storeId, note: note || undefined, lines: lines.filter((l) => l.item && l.quantity > 0).map((l) => ({ itemId: l.item!.id, quantity: l.quantity })) } }],
    { invalidate: ['/hmis', '/patient-charges'], success: 'Charged to the patient' },
  );
  return (
    <FormDialog open title="Charge ward consumables" submitLabel="Charge patient" maxWidth="md" onClose={onClose} submitting={save.isPending} onSubmit={(ev) => { ev.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">Stock already issued to the ward and used on this patient. Nothing moves in stock; the patient is charged at their payer&apos;s prices.</Typography>
      <Stack direction="row" spacing={2}>
        <TextField select label="Ward / department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ flex: 1 }}>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <StoreSelect value={storeId} onChange={setStoreId} label="Store that issued it" stores={stores.data ?? []} sx={{ flex: 1 }} />
      </Stack>
      {lines.map((l, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <ItemPicker value={l.item} onChange={(item) => setLines(lines.map((x, j) => (j === i ? { ...x, item } : x)))} />
          <TextField label="Qty" type="number" value={l.quantity || ''} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} sx={{ width: 110 }} />
        </Stack>
      ))}
      <Box><Button onClick={() => setLines([...lines, { item: null, quantity: 1 }])}>Add item</Button></Box>
      <TextField label="Note (e.g. procedure)" value={note} onChange={(e) => setNote(e.target.value)} />
    </FormDialog>
  );
}

function ReverseChargeDialog({ charge, left, onClose }: { charge: PatientCharge; left: number; onClose(): void }) {
  const [quantity, setQuantity] = useState(left);
  const [reason, setReason] = useState('');
  const save = useApiMutation<void>(() => [`/patient-charges/${charge.id}/reverse`, { method: 'POST', body: { quantity, reason } }], { invalidate: ['/hmis', '/patient-charges', '/pharmacy'], success: 'Charge reversed' });
  return (
    <FormDialog open title={`Reverse ${charge.description}`} submitLabel="Reverse" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">A credit is posted to the HMIS bill against the original charge.</Typography>
      <TextField label={`Quantity (up to ${left})`} type="number" value={quantity} onChange={(e) => setQuantity(Math.min(left, Number(e.target.value)))} />
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ ward supply

/** Inpatient pharmacy ward round: daily / unit-dose lines due today, dispensed together. */
export function WardSupplyPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const departments = useAll<Department>('/departments');
  const list = useQuery({
    queryKey: ['/pharmacy/ward-supply', storeId, departmentId],
    queryFn: () => api<WardSupplyList>('/pharmacy/ward-supply', { query: { storeId, departmentId: departmentId || undefined } }),
    enabled: !!storeId,
  });
  const lines = useMemo(() => (list.data?.patients ?? []).flatMap((p) => p.lines), [list.data]);
  const rxIds = useMemo(() => [...new Set(lines.filter((l) => !l.needsVerification && l.due > 0).map((l) => l.prescriptionId))], [lines]);
  const options = useQueries({ queries: rxIds.map((id) => ({ queryKey: ['/pharmacy/prescriptions', id, 'options'], queryFn: () => api<BrandOption[]>(`/pharmacy/prescriptions/${id}/options`) })) });
  const brandsOf = (lineId: string) => options.flatMap((o) => o.data ?? []).find((o) => o.prescriptionLineId === lineId)?.brands ?? [];
  const [pick, setPick] = useState<Record<string, { include: boolean; itemId: string; quantity: number }>>({});
  useEffect(() => {
    const next: typeof pick = {};
    for (const l of lines) {
      if (l.needsVerification || l.due <= 0) continue;
      const brands = brandsOf(l.prescriptionLineId);
      const best = [...brands].sort((a, b) => b.available - a.available)[0];
      next[l.prescriptionLineId] = pick[l.prescriptionLineId] ?? { include: !!best && best.available >= l.due, itemId: best?.itemId ?? '', quantity: l.due };
      if (!next[l.prescriptionLineId].itemId && best) next[l.prescriptionLineId] = { ...next[l.prescriptionLineId], itemId: best.itemId, include: best.available >= l.due };
    }
    setPick(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, options.map((o) => o.dataUpdatedAt).join()]);
  const [result, setResult] = useState<{ dispensed: number; failed: number; results: { prescriptionId: string; ok: boolean; error?: string }[] } | null>(null);
  const chosen = Object.entries(pick).filter(([, v]) => v.include && v.itemId && v.quantity > 0).map(([prescriptionLineId, v]) => ({ prescriptionLineId, itemId: v.itemId, quantity: v.quantity }));
  const round = useApiMutation<void, NonNullable<typeof result>>(() => ['/pharmacy/ward-supply', { method: 'POST', body: { storeId, lines: chosen } }], { invalidate: ['/pharmacy', '/hmis', '/inventory'], success: 'Ward round dispensed' });
  const lineRow = (l: WardSupplyLine) => {
    const p = pick[l.prescriptionLineId];
    return (
      <TableRow key={l.prescriptionLineId}>
        <TableCell padding="checkbox">
          <Checkbox checked={!!p?.include} disabled={!p || l.needsVerification} onChange={(e) => setPick({ ...pick, [l.prescriptionLineId]: { ...p!, include: e.target.checked } })} inputProps={{ 'aria-label': `Include ${l.generic}` }} />
        </TableCell>
        <TableCell>
          {l.generic} <Typography variant="caption" component="div">{[l.dose, l.frequency, l.route].filter(Boolean).join(' · ')} · <Link component={RouterLink} to={`/pharmacy/prescriptions/${l.prescriptionId}`}>{l.prescriptionNo}</Link></Typography>
        </TableCell>
        <TableCell align="right">{l.dailyQuantity}</TableCell>
        <TableCell align="right">{l.givenToday}</TableCell>
        <TableCell align="right">{l.remaining}</TableCell>
        <TableCell align="right"><strong>{l.due}</strong></TableCell>
        <TableCell>
          {l.needsVerification ? (
            <Button size="small" onClick={() => navigate(`/pharmacy/prescriptions/${l.prescriptionId}`)}>Verify first</Button>
          ) : l.due > 0 && p ? (
            <Stack direction="row" spacing={1}>
              <TextField select size="small" label="Brand" value={p.itemId} onChange={(e) => setPick({ ...pick, [l.prescriptionLineId]: { ...p, itemId: e.target.value } })} sx={{ minWidth: 200 }}>
                {brandsOf(l.prescriptionLineId).map((b) => <MenuItem key={b.itemId} value={b.itemId} disabled={b.available <= 0}>{b.name} ({b.available})</MenuItem>)}
              </TextField>
              <TextField size="small" label="Qty" type="number" value={p.quantity} onChange={(e) => setPick({ ...pick, [l.prescriptionLineId]: { ...p, quantity: Number(e.target.value) } })} sx={{ width: 90 }} />
            </Stack>
          ) : (
            'Nothing due'
          )}
        </TableCell>
      </TableRow>
    );
  };
  return (
    <>
      <PageHeader title="Ward supply" />
      <Typography variant="body2" sx={{ mb: 1 }}>Daily and unit-dose supply for admitted patients: what each line still needs today (daily quantity less what was given today). Batches are taken first-expiry-first-out; charges follow the HMIS billing setting.</Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <StoreSelect value={storeId} onChange={setStoreId} label="Inpatient pharmacy" sx={{ minWidth: 240 }} />
        <TextField select label="Ward" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} sx={{ minWidth: 220 }}>
          <MenuItem value="">All wards</MenuItem>{(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        {can(P.PHARMACY_DISPENSE) && <Button variant="contained" disabled={!chosen.length || round.isPending} onClick={() => round.mutate(undefined, { onSuccess: setResult })}>Dispense {chosen.length} line(s)</Button>}
      </Stack>
      {!storeId && <Alert severity="info">Choose the inpatient pharmacy.</Alert>}
      {result && (
        <Alert severity={result.failed ? 'warning' : 'success'} sx={{ mb: 2 }} onClose={() => setResult(null)}>
          {result.dispensed} prescription(s) dispensed{result.failed ? `, ${result.failed} not: ` : ''}
          {result.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}
        </Alert>
      )}
      {list.data && list.data.patients.length === 0 && <Alert severity="success">No daily or unit-dose supply is due.</Alert>}
      <Stack spacing={2}>
        {(list.data?.patients ?? []).map((pt) => (
          <Paper key={pt.patientId} sx={{ p: 2 }}>
            <Typography variant="subtitle1">{pt.patient} · {pt.hospitalNo} · {pt.ward ?? 'Ward not mapped'}{pt.bed ? ` · bed ${pt.bed}` : ''}</Typography>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell padding="checkbox" /><TableCell>Medicine</TableCell><TableCell align="right">Per day</TableCell><TableCell align="right">Given today</TableCell><TableCell align="right">Left on order</TableCell><TableCell align="right">Due</TableCell><TableCell>Supply</TableCell></TableRow>
              </TableHead>
              <TableBody>{pt.lines.map(lineRow)}</TableBody>
            </Table>
          </Paper>
        ))}
      </Stack>
    </>
  );
}

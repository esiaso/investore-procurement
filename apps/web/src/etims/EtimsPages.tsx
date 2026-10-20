import { Alert, Box, Button, Chip, FormControlLabel, Link, List, ListItem, ListItemText, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList } from '../api/hooks';
import type { EtimsConfig, EtimsImportItem, EtimsMapping, EtimsOutbox, EtimsPurchase, EtimsTransmission } from '../api/pharmacy-types';
import type { Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StoreSelect } from '../inventory/components';
import { formatDate, humanise } from '../lib/format';
import { EtimsChip } from '../pharmacy/ui';
import { useMoney } from '../purchasing/common';
import { useSettings } from '../settings/SettingsContext';

const P = Permissions;
const MAPPING_KINDS = ['TAX_CATEGORY', 'QTY_UNIT', 'PACKAGING_UNIT', 'ITEM_CLASS', 'COUNTRY'];

function useDt() {
  const { dateFormat, timezone } = useSettings();
  return (v: string | null | undefined) => (v ? formatDate(v, dateFormat, timezone, true) : '—');
}

/** KRA eTIMS console: control units, code mapping, outbox and reprocessing, call log, purchases, imports, assumptions. */
export function EtimsConsolePage() {
  const [tab, setTab] = useState(0);
  return (
    <>
      <PageHeader title="KRA eTIMS" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="Control units" />
        <Tab label="Code mapping" />
        <Tab label="Outbox" />
        <Tab label="Supplier purchases" />
        <Tab label="Imports" />
        <Tab label="Specification notes" />
      </Tabs>
      {tab === 0 && <ConfigsTab />}
      {tab === 1 && <MappingTab />}
      {tab === 2 && <OutboxTab />}
      {tab === 3 && <PurchasesTab />}
      {tab === 4 && <ImportsTab />}
      {tab === 5 && <AssumptionsTab />}
    </>
  );
}

function ConfigsTab() {
  const { can } = useAuth();
  const dt = useDt();
  const configs = useList<EtimsConfig>('/etims/configs');
  const [edit, setEdit] = useState<EtimsConfig | null | 'new'>(null);
  const init = useApiMutation<string>((id) => [`/etims/configs/${id}/initialise`, { method: 'POST' }], { invalidate: ['/etims'], success: 'Control unit initialised' });
  const stock = useApiMutation<void, { movements: number; masters: number; paused: string[] }>(() => ['/etims/stock/report', { method: 'POST' }], { invalidate: ['/etims'], success: 'Stock movements queued' });
  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        {can(P.ETIMS_MANAGE) && <Button variant="contained" onClick={() => setEdit('new')}>Add outlet</Button>}
        {can(P.ETIMS_MANAGE) && <Button onClick={() => stock.mutate()}>Report stock movements now</Button>}
      </Stack>
      <Typography variant="body2" sx={{ mb: 1 }}>One control unit per selling outlet; each outlet is its own KRA branch (bhfId). The communication key is stored encrypted.</Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Outlet</TableCell><TableCell>Type</TableCell><TableCell>PIN / branch</TableCell><TableCell>Device</TableCell><TableCell>CU ID</TableCell><TableCell>Initialised</TableCell><TableCell>Stock reporting</TableCell><TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {(configs.data ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.store?.name}{!c.isActive && <Chip size="small" label="Inactive" sx={{ ml: 1 }} />}</TableCell>
              <TableCell>{c.adapter}{c.adapter === 'MOCK' && <Chip size="small" color="warning" label="Not KRA" sx={{ ml: 1 }} />}</TableCell>
              <TableCell>{c.kraPin} / {c.branchId}</TableCell>
              <TableCell>{c.deviceSerial}</TableCell>
              <TableCell>{c.cuId ?? '—'}</TableCell>
              <TableCell>{dt(c.initialisedAt)}</TableCell>
              <TableCell>{c.stockReportError ? <Alert severity="warning" sx={{ py: 0 }}>{c.stockReportError}</Alert> : 'OK'}</TableCell>
              <TableCell>
                {can(P.ETIMS_MANAGE) && (
                  <Stack direction="row" spacing={1}>
                    <Button size="small" onClick={() => init.mutate(c.id)}>Initialise</Button>
                    <Button size="small" onClick={() => setEdit(c)}>Edit</Button>
                  </Stack>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {edit && <ConfigDialog row={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function ConfigDialog({ row, onClose }: { row?: EtimsConfig; onClose(): void }) {
  const [f, setF] = useState({ storeId: row?.storeId ?? '', adapter: row?.adapter ?? 'OSCU', baseUrl: row?.baseUrl ?? '', kraPin: row?.kraPin ?? '', branchId: row?.branchId ?? '00', deviceSerial: row?.deviceSerial ?? '', isActive: row?.isActive ?? true });
  const save = useApiMutation<void>(() => ['/etims/configs', { method: 'PUT', body: { ...f, baseUrl: f.baseUrl || undefined } }], { invalidate: ['/etims'], success: 'Saved — initialise the control unit next' });
  return (
    <FormDialog open title={row ? 'Edit control unit' : 'Add outlet to eTIMS'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <StoreSelect value={f.storeId} onChange={(storeId) => setF({ ...f, storeId })} label="Selling outlet" />
      <TextField select label="Integration" value={f.adapter} onChange={(e) => setF({ ...f, adapter: e.target.value as EtimsConfig['adapter'] })}>
        <MenuItem value="OSCU">OSCU (online, KRA API)</MenuItem>
        <MenuItem value="VSCU">VSCU (virtual control unit server)</MenuItem>
        <MenuItem value="MOCK">Mock (testing only — not KRA)</MenuItem>
      </TextField>
      <TextField label="Base URL" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} helperText="OSCU: KRA eTIMS API URL (sandbox or production); VSCU: your VSCU server; mock: empty or the mock-etims URL" />
      <TextField label="KRA PIN" value={f.kraPin} onChange={(e) => setF({ ...f, kraPin: e.target.value.toUpperCase() })} required />
      <TextField label="Branch ID (bhfId)" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} required />
      <TextField label="Device serial number" value={f.deviceSerial} onChange={(e) => setF({ ...f, deviceSerial: e.target.value })} required />
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active (sales at this outlet go to eTIMS)" />
      <Typography variant="caption">Changing the PIN, branch, device or integration clears the stored key: initialise again.</Typography>
    </FormDialog>
  );
}

function MappingTab() {
  const { can } = useAuth();
  const dt = useDt();
  const mappings = useList<EtimsMapping>('/etims/mappings');
  const unmapped = useQuery({ queryKey: ['/etims/unmapped-items'], queryFn: () => api<{ itemId: string; code: string; name: string; missing: string[] }[]>('/etims/unmapped-items') });
  const status = useQuery({ queryKey: ['/etims/codes/status'], queryFn: () => api<{ codes: number; lastSync: string | null; itemClasses: number }>('/etims/codes/status') });
  const sync = useApiMutation<void>(() => ['/etims/codes/sync', { method: 'POST' }], { invalidate: ['/etims'], success: 'Code tables synchronised' });
  const [f, setF] = useState({ kind: 'ITEM_CLASS', localKey: '', etimsCode: '' });
  const save = useApiMutation<void>(() => ['/etims/mappings', { method: 'PUT', body: f }], { invalidate: ['/etims'], success: 'Mapping saved' });
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography sx={{ flexGrow: 1 }}>
            {status.data?.codes ?? 0} codes and {status.data?.itemClasses ?? 0} item classes synced (last {dt(status.data?.lastSync)}).
          </Typography>
          {can(P.ETIMS_MANAGE) && <Button onClick={() => sync.mutate()}>Sync now</Button>}
        </Stack>
      </Paper>
      {(unmapped.data ?? []).length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Alert severity="warning" sx={{ mb: 1 }}>{unmapped.data!.length} item(s) cannot be invoiced until mapped.</Alert>
          <Table size="small">
            <TableBody>
              {unmapped.data!.slice(0, 50).map((u) => (
                <TableRow key={u.itemId}><TableCell>{u.code}</TableCell><TableCell>{u.name}</TableCell><TableCell>{u.missing.join('; ')}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      <Paper sx={{ p: 2 }}>
        {can(P.ETIMS_MANAGE) && (
          <Stack direction="row" spacing={1} sx={{ mb: 2 }} component="form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <TextField select label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} sx={{ minWidth: 180 }}>
              {MAPPING_KINDS.map((k) => <MenuItem key={k} value={k}>{humanise(k)}</MenuItem>)}
            </TextField>
            <TextField label="Local key" value={f.localKey} onChange={(e) => setF({ ...f, localKey: e.target.value })} helperText='Tax category / unit code, or "category:DRUG", "item:ITM000123"' />
            <TextField label="eTIMS code" value={f.etimsCode} onChange={(e) => setF({ ...f, etimsCode: e.target.value })} />
            <Box><Button type="submit" variant="contained">Save mapping</Button></Box>
          </Stack>
        )}
        <Table size="small">
          <TableHead><TableRow><TableCell>Kind</TableCell><TableCell>Local</TableCell><TableCell>eTIMS code</TableCell></TableRow></TableHead>
          <TableBody>
            {(mappings.data ?? []).map((m) => (
              <TableRow key={m.id} hover onClick={() => setF({ kind: m.kind, localKey: m.localKey, etimsCode: m.etimsCode })}>
                <TableCell>{humanise(m.kind)}</TableCell><TableCell>{m.localKey}</TableCell><TableCell>{m.etimsCode}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}

function OutboxTab() {
  const { can } = useAuth();
  const dt = useDt();
  const [status, setStatus] = useState('');
  const outbox = useList<EtimsOutbox>('/etims/outbox', { status: status || undefined });
  const [log, setLog] = useState<EtimsOutbox | null>(null);
  const dispatch = useApiMutation<void, { sent: number; accepted: number; failed: number }>(() => ['/etims/outbox/dispatch', { method: 'POST' }], { invalidate: ['/etims', '/billing'], success: 'Queue processed' });
  const reprocess = useApiMutation<string>((id) => [`/etims/outbox/${id}/reprocess`, { method: 'POST' }], { invalidate: ['/etims', '/billing'], success: 'Reprocessed' });
  const docLink = (o: EtimsOutbox) => (o.kind === 'SALE' && o.docId ? <Link component={RouterLink} to={`/sales/${o.docId}`}>{o.docNo}</Link> : o.docNo);
  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 180 }}>
          <MenuItem value="">All</MenuItem>
          {['PENDING', 'FAILED', 'ACCEPTED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        {can(P.ETIMS_MANAGE) && <Button onClick={() => dispatch.mutate()}>Send due documents now</Button>}
      </Stack>
      <Table size="small">
        <TableHead>
          <TableRow><TableCell>Created</TableCell><TableCell>Kind</TableCell><TableCell>Document</TableCell><TableCell>Status</TableCell><TableCell align="right">Attempts</TableCell><TableCell>Next attempt</TableCell><TableCell>Result</TableCell><TableCell /></TableRow>
        </TableHead>
        <TableBody>
          {(outbox.data ?? []).map((o) => (
            <TableRow key={o.id}>
              <TableCell>{dt(o.createdAt)}</TableCell>
              <TableCell>{humanise(o.kind)}</TableCell>
              <TableCell>{docLink(o)}</TableCell>
              <TableCell><EtimsChip status={o.status} /></TableCell>
              <TableCell align="right">{o.attempts}</TableCell>
              <TableCell>{o.status === 'PENDING' ? dt(o.nextAttemptAt) : ''}</TableCell>
              <TableCell>{o.resultCd} {o.resultMsg}</TableCell>
              <TableCell>
                <Stack direction="row" spacing={1}>
                  <Button size="small" onClick={() => setLog(o)}>Log</Button>
                  {o.status !== 'ACCEPTED' && can(P.ETIMS_MANAGE) && <Button size="small" onClick={() => reprocess.mutate(o.id)}>Reprocess</Button>}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {log && <TransmissionsDialog outbox={log} onClose={() => setLog(null)} />}
    </Paper>
  );
}

function TransmissionsDialog({ outbox, onClose }: { outbox: EtimsOutbox; onClose(): void }) {
  const dt = useDt();
  const rows = useList<EtimsTransmission>('/etims/transmissions', { outboxId: outbox.id });
  return (
    <FormDialog open title={`Calls for ${outbox.kind} ${outbox.docNo ?? ''}`} submitLabel="Close" maxWidth="lg" onClose={onClose} onSubmit={(e) => { e.preventDefault(); onClose(); }}>
      <Typography variant="body2">Every call to the control unit, with the communication key masked.</Typography>
      {(rows.data ?? []).map((t) => (
        <Paper key={t.id} variant="outlined" sx={{ p: 1 }}>
          <Typography variant="subtitle2">{dt(t.at)} · {t.operation} · HTTP {t.httpStatus ?? '—'} · {t.resultCd ?? ''} · {t.durationMs} ms {t.error ? `· ${t.error}` : ''}</Typography>
          <Box component="pre" sx={{ fontSize: 11, overflowX: 'auto', m: 0 }}>{JSON.stringify({ request: t.request, response: t.response }, null, 2)}</Box>
        </Paper>
      ))}
    </FormDialog>
  );
}

function PurchasesTab() {
  const { can } = useAuth();
  const money = useMoney();
  const [status, setStatus] = useState('RECEIVED');
  const rows = useList<EtimsPurchase>('/etims/purchases', { status: status || undefined });
  const fetch = useApiMutation<void, { fetched: number; matched: number }>(() => ['/etims/purchases/fetch', { method: 'POST' }], { invalidate: ['/etims', '/invoices'], success: 'Fetched from eTIMS' });
  const decide = useApiMutation<{ id: string; accept: boolean }>(({ id, accept }) => [`/etims/purchases/${id}/decision`, { method: 'POST', body: { accept } }], { invalidate: ['/etims'], success: 'Sent to eTIMS' });
  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 180 }}>
          <MenuItem value="">All</MenuItem>
          {['RECEIVED', 'CONFIRMED', 'REJECTED'].map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
        {can(P.ETIMS_MANAGE) && <Button onClick={() => fetch.mutate()}>Fetch supplier sales</Button>}
      </Stack>
      <Typography variant="body2" sx={{ mb: 1 }}>Supplier sales to the hospital as recorded on eTIMS. Captured supplier invoices are matched to them automatically; invoices not found are flagged NOT ON ETIMS in the three-way match.</Typography>
      <Table size="small">
        <TableHead><TableRow><TableCell>Supplier PIN</TableCell><TableCell>Supplier</TableCell><TableCell>Invoice no.</TableCell><TableCell>Date</TableCell><TableCell align="right">Total</TableCell><TableCell align="right">VAT</TableCell><TableCell>Matched</TableCell><TableCell>Status</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(rows.data ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.spplrTin}</TableCell>
              <TableCell>{p.spplrNm}</TableCell>
              <TableCell>{p.spplrInvcNo}</TableCell>
              <TableCell>{p.salesDt}</TableCell>
              <TableCell align="right">{money(p.totAmt)}</TableCell>
              <TableCell align="right">{money(p.totTaxAmt)}</TableCell>
              <TableCell>{p.supplierInvoiceId ? <Link component={RouterLink} to={`/invoices/${p.supplierInvoiceId}`}>Invoice</Link> : '—'}</TableCell>
              <TableCell>{humanise(p.status)}</TableCell>
              <TableCell>
                {p.status === 'RECEIVED' && can(P.ETIMS_MANAGE) && (
                  <Stack direction="row" spacing={1}>
                    <Button size="small" onClick={() => decide.mutate({ id: p.id, accept: true })}>Confirm</Button>
                    <Button size="small" color="error" onClick={() => decide.mutate({ id: p.id, accept: false })}>Reject</Button>
                  </Stack>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

function ImportsTab() {
  const { can } = useAuth();
  const rows = useList<EtimsImportItem>('/etims/imports');
  const fetch = useApiMutation<void>(() => ['/etims/imports/fetch', { method: 'POST' }], { invalidate: ['/etims'], success: 'Fetched from eTIMS' });
  const [linking, setLinking] = useState<EtimsImportItem | null>(null);
  return (
    <Paper sx={{ p: 2 }}>
      {can(P.ETIMS_MANAGE) && <Button onClick={() => fetch.mutate()} sx={{ mb: 1 }}>Fetch declared imports</Button>}
      <Table size="small">
        <TableHead><TableRow><TableCell>Task</TableCell><TableCell>Declared</TableCell><TableCell>#</TableCell><TableCell>HS code</TableCell><TableCell>Description</TableCell><TableCell>Status</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(rows.data ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.taskCd}</TableCell><TableCell>{r.dclDe}</TableCell><TableCell>{r.itemSeq}</TableCell><TableCell>{r.hsCd}</TableCell><TableCell>{r.itemNm}</TableCell>
              <TableCell>{r.imptItemSttsCd === '3' ? 'Approved' : r.imptItemSttsCd === '4' ? 'Cancelled' : 'Waiting'}</TableCell>
              <TableCell>{!r.itemId && can(P.ETIMS_MANAGE) && <Button size="small" onClick={() => setLinking(r)}>Link to item</Button>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {linking && <LinkImportDialog row={linking} onClose={() => setLinking(null)} />}
    </Paper>
  );
}

function LinkImportDialog({ row, onClose }: { row: EtimsImportItem; onClose(): void }) {
  const [item, setItem] = useState<Item | null>(null);
  const save = useApiMutation<void>(() => [`/etims/imports/${row.id}/link`, { method: 'POST', body: { itemId: item?.id } }], { invalidate: ['/etims'], success: 'Linked and approved on eTIMS' });
  return (
    <FormDialog open title={`Link ${row.itemNm}`} submitLabel="Link and approve" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <ItemPicker value={item} onChange={setItem} />
    </FormDialog>
  );
}

function AssumptionsTab() {
  const { data } = useQuery({ queryKey: ['/etims/assumptions'], queryFn: () => api<string[]>('/etims/assumptions') });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="body2">Where the KRA OSCU/VSCU v2.0 and TIS v2.0 specifications left room for interpretation, this is what the integration does. Confirm with KRA during certification.</Typography>
      <List dense>
        {(data ?? []).map((a, i) => (
          <ListItem key={i}><ListItemText primary={`${i + 1}. ${a}`} /></ListItem>
        ))}
      </List>
    </Paper>
  );
}

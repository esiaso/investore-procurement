import { Alert, Box, Button, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { Permissions } from '@sil/shared';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { CurrencyRow, ExchangeRate, GlAccount, Project } from '../api/nonstock-types';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useDate, useMoney } from '../purchasing/common';

const P = Permissions;
const GL_TYPES = ['EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'BANK'];

/** Chart of accounts, projects, currencies and exchange rates. */
export function FinanceSetupPage() {
  const [tab, setTab] = useState(0);
  return (
    <>
      <PageHeader title="Accounts, projects and currencies" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="GL accounts" />
        <Tab label="Projects" />
        <Tab label="Currencies and rates" />
      </Tabs>
      {tab === 0 && <GlTab />}
      {tab === 1 && <ProjectsTab />}
      {tab === 2 && <CurrenciesTab />}
    </>
  );
}

function GlTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 50 });
  const [edit, setEdit] = useState<GlAccount | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<GlAccount>('/gl-accounts', { ...pagination, search: q });
  const importQb = useApiMutation<void, { added: number; updated: number; linked: number }>(() => ['/gl-accounts/import-quickbooks', { method: 'POST' }], { invalidate: ['/gl-accounts'] });
  const columns: GridColDef<GlAccount>[] = [
    { field: 'code', headerName: 'Code', width: 120 },
    { field: 'name', headerName: 'Name', flex: 1, minWidth: 260 },
    { field: 'type', headerName: 'Type', width: 150, valueFormatter: (v: string) => humanise(v) },
    { field: 'qboAccountId', headerName: 'QuickBooks', width: 120, renderCell: (p) => (p.value ? <Chip size="small" label={`#${p.value}`} /> : '') },
    { field: 'isActive', headerName: 'Active', type: 'boolean', width: 90 },
  ];
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1}>
        <TextField size="small" placeholder="Code or name" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ minWidth: 260 }} />
        {can(P.GL_MANAGE) && <Button variant="outlined" onClick={() => setEdit('new')}>New account</Button>}
        {can(P.GL_MANAGE) && <Button disabled={importQb.isPending} onClick={() => importQb.mutate()}>Import from QuickBooks</Button>}
      </Stack>
      {importQb.data && <Alert severity="success">QuickBooks: {importQb.data.added} added, {importQb.data.updated} refreshed ({importQb.data.linked} linked in all).</Alert>}
      <Paper>
        <DataGrid autoHeight rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[50, 100]} onRowClick={({ row }) => can(P.GL_MANAGE) && setEdit(row)} disableRowSelectionOnClick />
      </Paper>
      {edit && <GlDialog account={edit} onClose={() => setEdit(null)} />}
    </Stack>
  );
}

function GlDialog({ account, onClose }: { account: GlAccount | 'new'; onClose(): void }) {
  const isNew = account === 'new';
  const [f, setF] = useState({ code: isNew ? '' : account.code, name: isNew ? '' : account.name, type: isNew ? 'EXPENSE' : account.type, description: isNew ? '' : (account.description ?? ''), qboAccountId: isNew ? '' : (account.qboAccountId ?? ''), isActive: isNew ? true : account.isActive });
  const save = useApiMutation<void>(() => [isNew ? '/gl-accounts' : `/gl-accounts/${account.id}`, { method: isNew ? 'POST' : 'PUT', body: { ...f, description: f.description || null, qboAccountId: f.qboAccountId || null } }], { invalidate: ['/gl-accounts'], success: 'Account saved' });
  return (
    <FormDialog open title={isNew ? 'New GL account' : `Edit ${account.code}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} sx={{ width: 140 }} />
        <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} sx={{ flex: 1 }} />
      </Stack>
      <TextField select label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
        {GL_TYPES.map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
      </TextField>
      <TextField label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <TextField label="QuickBooks account id" value={f.qboAccountId} onChange={(e) => setF({ ...f, qboAccountId: e.target.value })} helperText="Set by Import from QuickBooks" />
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function ProjectsTab() {
  const { can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const { data } = useList<Project>('/projects');
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  return (
    <Stack spacing={2}>
      {can(P.PROJECTS_MANAGE) && <Box><Button variant="outlined" onClick={() => setEdit('new')}>New project</Button></Box>}
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Department</TableCell><TableCell>Dates</TableCell><TableCell align="right">Budget</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
          <TableBody>
            {(data ?? []).map((p) => (
              <TableRow key={p.id} hover sx={{ cursor: can(P.PROJECTS_MANAGE) ? 'pointer' : undefined }} onClick={() => can(P.PROJECTS_MANAGE) && setEdit(p)}>
                <TableCell>{p.code}</TableCell><TableCell>{p.name}</TableCell><TableCell>{p.department?.name ?? '—'}</TableCell>
                <TableCell>{p.startsOn || p.endsOn ? `${date(p.startsOn) || '…'} – ${date(p.endsOn) || '…'}` : '—'}</TableCell>
                <TableCell align="right">{p.budget == null ? '—' : money(p.budget)}</TableCell>
                <TableCell><Chip size="small" label={p.isActive ? 'Active' : 'Closed'} color={p.isActive ? 'success' : 'default'} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {edit && <ProjectDialog project={edit} onClose={() => setEdit(null)} />}
    </Stack>
  );
}

function ProjectDialog({ project, onClose }: { project: Project | 'new'; onClose(): void }) {
  const isNew = project === 'new';
  const departments = useAll<Department>('/departments');
  const [f, setF] = useState({
    code: isNew ? '' : project.code,
    name: isNew ? '' : project.name,
    departmentId: isNew ? '' : (project.departmentId ?? ''),
    startsOn: isNew ? '' : (project.startsOn ?? ''),
    endsOn: isNew ? '' : (project.endsOn ?? ''),
    budget: isNew ? '' : String(project.budget ?? ''),
    isActive: isNew ? true : project.isActive,
  });
  const save = useApiMutation<void>(
    () => [isNew ? '/projects' : `/projects/${project.id}`, { method: isNew ? 'POST' : 'PUT', body: { ...f, departmentId: f.departmentId || null, startsOn: f.startsOn || null, endsOn: f.endsOn || null, budget: f.budget === '' ? null : Number(f.budget) } }],
    { invalidate: ['/projects'], success: 'Project saved' },
  );
  return (
    <FormDialog open title={isNew ? 'New project' : `Edit ${project.code}`} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} sx={{ width: 160 }} />
        <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} sx={{ flex: 1 }} />
      </Stack>
      <TextField select label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
        <MenuItem value="">Hospital-wide</MenuItem>
        {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
      </TextField>
      <Stack direction="row" spacing={2}>
        <TextField type="date" label="Starts" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField type="date" label="Ends" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField type="number" label="Budget" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
      </Stack>
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

function CurrenciesTab() {
  const { can } = useAuth();
  const date = useDate();
  const currencies = useList<CurrencyRow>('/currencies');
  const rates = useList<ExchangeRate>('/exchange-rates');
  const today = new Date().toLocaleDateString('en-CA');
  const [f, setF] = useState({ currencyCode: 'USD', rateDate: today, rate: '', source: '' });
  const [cur, setCur] = useState({ code: '', name: '' });
  const saveRate = useApiMutation<void>(() => ['/exchange-rates', { method: 'PUT', body: { ...f, rate: Number(f.rate), source: f.source || undefined } }], { invalidate: ['/exchange-rates', '/currencies'], success: 'Rate saved' });
  const saveCur = useApiMutation<void>(() => ['/currencies', { method: 'PUT', body: cur }], { invalidate: ['/currencies'], success: 'Currency saved' });
  const foreign = (currencies.data ?? []).filter((c) => !c.isBase && c.isActive);
  return (
    <Stack spacing={2}>
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Currency</TableCell><TableCell>Latest rate</TableCell><TableCell>Since</TableCell></TableRow></TableHead>
          <TableBody>
            {(currencies.data ?? []).map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.code} · {c.name} {c.isBase && <Chip size="small" label="Base" sx={{ ml: 1 }} />}</TableCell>
                <TableCell>{c.latestRate === 1 ? '1' : c.latestRate ? c.latestRate.rate : <Chip size="small" color="warning" label="No rate" />}</TableCell>
                <TableCell>{c.latestRate && c.latestRate !== 1 ? date(c.latestRate.rate_date) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {can(P.FX_MANAGE) && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
            <TextField select label="Currency" value={f.currencyCode} onChange={(e) => setF({ ...f, currencyCode: e.target.value })} sx={{ width: 140 }}>
              {foreign.map((c) => <MenuItem key={c.code} value={c.code}>{c.code}</MenuItem>)}
            </TextField>
            <TextField type="date" label="From" value={f.rateDate} onChange={(e) => setF({ ...f, rateDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField type="number" label="Base currency per unit" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            <TextField label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="CBK" />
            <Button variant="contained" disabled={!f.rate || saveRate.isPending} onClick={() => saveRate.mutate()}>Save rate</Button>
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} sx={{ mt: 2 }}>
            <TextField label="New currency code" value={cur.code} onChange={(e) => setCur({ ...cur, code: e.target.value.toUpperCase().slice(0, 3) })} sx={{ width: 160 }} />
            <TextField label="Name" value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
            <Button disabled={cur.code.length !== 3 || !cur.name || saveCur.isPending} onClick={() => saveCur.mutate()}>Add currency</Button>
          </Stack>
        </Paper>
      )}
      <Paper>
        <Table size="small">
          <TableHead><TableRow><TableCell>Date</TableCell><TableCell>Currency</TableCell><TableCell align="right">Rate</TableCell><TableCell>Source</TableCell></TableRow></TableHead>
          <TableBody>
            {(rates.data ?? []).map((r) => (
              <TableRow key={r.id}><TableCell>{date(r.rateDate)}</TableCell><TableCell>{r.currencyCode}</TableCell><TableCell align="right">{r.rate}</TableCell><TableCell>{r.source ?? ''}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}

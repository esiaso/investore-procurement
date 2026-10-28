import { Chip, FormControlLabel, Link, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { api, buildUrl } from '../api/client';
import { usePaged } from '../api/hooks';
import type { DocumentRow, ExpiringDocument } from '../api/report-types';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { useDate } from '../purchasing/common';

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Documents register (every attachment the user may read) and supplier documents expiring. */
export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'expiring' ? 1 : 0;
  return (
    <>
      <PageHeader title="Documents" />
      <Tabs value={tab} onChange={(_, v) => setParams(v ? { tab: 'expiring' } : {})} sx={{ mb: 2 }}>
        <Tab label="Register" />
        <Tab label="Expiring supplier documents" />
      </Tabs>
      {tab === 0 ? <RegisterTab /> : <ExpiringTab />}
    </>
  );
}

function RegisterTab() {
  const date = useDate();
  const [model, setModel] = useState({ page: 0, pageSize: 25 });
  const [f, setF] = useState({ search: '', ownerType: '', category: '', from: '', to: '', versions: false });
  const facets = useQuery({ queryKey: ['/documents/register/facets'], queryFn: () => api<{ ownerTypes: { value: string; label: string }[]; categories: string[] }>('/documents/register/facets') });
  const { data, isFetching } = usePaged<DocumentRow>('/documents/register', {
    ...model,
    search: f.search || undefined,
    ownerType: f.ownerType || undefined,
    category: f.category || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    currentOnly: f.versions ? false : undefined,
  });
  const cols: GridColDef<DocumentRow>[] = [
    {
      field: 'fileName',
      headerName: 'File',
      flex: 2,
      minWidth: 220,
      renderCell: (p) => (
        <Link href={buildUrl(`/attachments/${p.row.id}/download`)} underline="hover">
          {p.row.fileName}
        </Link>
      ),
    },
    { field: 'category', headerName: 'Category', width: 150, valueFormatter: (v: string) => humanise(v) },
    { field: 'ownerTypeName', headerName: 'Record', width: 170 },
    {
      field: 'owner',
      headerName: 'Number / name',
      flex: 1.5,
      minWidth: 180,
      renderCell: (p) => (p.row.link ? <Link component={RouterLink} to={p.row.link}>{p.row.owner}</Link> : p.row.owner),
    },
    { field: 'version', headerName: 'Version', width: 90, renderCell: (p) => <>{`v${p.row.version}`}{!p.row.isCurrent && <Chip size="small" label="old" sx={{ ml: 0.5 }} />}</> },
    { field: 'sizeBytes', headerName: 'Size', width: 90, valueFormatter: (v: number) => size(v) },
    { field: 'uploadedBy', headerName: 'By', width: 160, valueGetter: (_v, r) => (r.generated ? 'System' : r.uploadedBy) },
    { field: 'createdAt', headerName: 'Added', width: 120, valueFormatter: (v: string) => date(v) },
  ];
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
        <TextField label="File, record number or note" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} sx={{ minWidth: 260, flex: 1 }} />
        <TextField select label="Record" value={f.ownerType} onChange={(e) => setF({ ...f, ownerType: e.target.value })} sx={{ minWidth: 200, width: 'auto' }}>
          <MenuItem value="">All</MenuItem>
          {(facets.data?.ownerTypes ?? []).map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>
        <TextField select label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} sx={{ minWidth: 180, width: 'auto' }}>
          <MenuItem value="">All</MenuItem>
          {(facets.data?.categories ?? []).map((c) => <MenuItem key={c} value={c}>{humanise(c)}</MenuItem>)}
        </TextField>
        <TextField sx={{ flex: 1 }} type="date" label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} InputLabelProps={{ shrink: true }} />
        <TextField sx={{ flex: 1 }} type="date" label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} InputLabelProps={{ shrink: true }} />
        <FormControlLabel control={<Switch checked={f.versions} onChange={(e) => setF({ ...f, versions: e.target.checked })} />} label="Earlier versions" />
      </Stack>
      <Paper>
        <DataGrid autoHeight rows={data?.items ?? []} columns={cols} rowCount={data?.total ?? 0} loading={isFetching} paginationMode="server" paginationModel={model} onPaginationModelChange={setModel} pageSizeOptions={[25, 50, 100]} disableRowSelectionOnClick />
      </Paper>
      <Typography variant="caption" color="text.secondary">Files are attached on each record (delivery notes on GRNs, licences on suppliers, certificates on disposals…). This register only lists the records your role and stores let you see.</Typography>
    </Stack>
  );
}

function ExpiringTab() {
  const date = useDate();
  const [days, setDays] = useState(60);
  const { data } = useQuery({ queryKey: ['/documents/register/expiring', days], queryFn: () => api<ExpiringDocument[]>('/documents/register/expiring', { query: { days } }) });
  return (
    <Stack spacing={2}>
      <TextField select label="Expiring within" value={days} onChange={(e) => setDays(Number(e.target.value))} sx={{ width: 200 }}>
        {[30, 60, 90, 180].map((d) => <MenuItem key={d} value={d}>{d} days</MenuItem>)}
      </TextField>
      <Paper>
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Supplier</TableCell><TableCell>Document</TableCell><TableCell>Reference</TableCell><TableCell>Expires</TableCell><TableCell>Status</TableCell><TableCell align="right">Files</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {(data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell><Link component={RouterLink} to="/suppliers">{d.supplier}</Link></TableCell>
                <TableCell>{humanise(d.documentType)}</TableCell>
                <TableCell>{d.reference ?? ''}</TableCell>
                <TableCell>{date(d.expiresOn)}</TableCell>
                <TableCell>
                  {d.daysLeft < 0 ? <Chip size="small" color="error" label={`Expired ${-d.daysLeft} days ago`} /> : <Chip size="small" color={d.daysLeft <= 30 ? 'warning' : 'default'} label={`${d.daysLeft} days left`} />}
                </TableCell>
                <TableCell align="right">{d.files}</TableCell>
              </TableRow>
            ))}
            {data?.length === 0 && <TableRow><TableCell colSpan={6}>No supplier documents expire in this window.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}

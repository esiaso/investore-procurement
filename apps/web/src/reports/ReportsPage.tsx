import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
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
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import SearchIcon from '@mui/icons-material/Search';
import SendIcon from '@mui/icons-material/Send';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList } from '../api/hooks';
import type { FilterKey, ReportColumn, ReportDef, ReportGroup, ReportResult, ReportSchedule } from '../api/report-types';
import type { Supplier } from '../api/purchasing-types';
import type { Department, Item, ItemCategory } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StoreSelect } from '../inventory/components';
import { humanise } from '../lib/format';
import { DOC_ROUTES, useDate, useMoney } from '../purchasing/common';
import { ReportChart } from './ReportChart';

const GROUPS: { key: ReportGroup; label: string }[] = [
  { key: 'INVENTORY', label: 'Inventory' },
  { key: 'PHARMACY', label: 'Pharmacy performance' },
  { key: 'PURCHASING', label: 'Purchasing' },
  { key: 'SUPPLY_CHAIN', label: 'Supply chain' },
  { key: 'PAYMENTS', label: 'Payments' },
  { key: 'PETTY_CASH', label: 'Petty cash' },
  { key: 'AUDIT', label: 'Audit & integration' },
];

const PAY_METHODS = ['EFT', 'CHEQUE', 'CASH', 'MPESA_PAYBILL', 'MPESA_TILL', 'MPESA_B2C'];
const BUCKETS = [
  { value: 'DAY', label: 'Day' },
  { value: 'WEEK', label: 'Week' },
  { value: 'MONTH', label: 'Month' },
  { value: 'QUARTER', label: 'Quarter' },
  { value: 'YEAR', label: 'Year' },
];

const PERIODS: { value: string; label: string }[] = [
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'LAST_7_DAYS', label: 'Last 7 days' },
  { value: 'LAST_30_DAYS', label: 'Last 30 days' },
  { value: 'LAST_WEEK', label: 'Last week (Mon–Sun)' },
  { value: 'LAST_MONTH', label: 'Last month' },
  { value: 'MONTH_TO_DATE', label: 'Month to date' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Filters = Partial<Record<FilterKey, string>>;

const localToday = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => `${localToday().slice(0, 8)}01`;

/** Default filters for a report: this month for dated reports. */
function defaults(d: ReportDef): Filters {
  return d.filters.includes('from') ? { from: monthStart(), to: localToday() } : {};
}

/** Reports catalog, filters, results, exports and scheduled emails. */
export function ReportsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'schedules' ? 1 : 0;
  return (
    <>
      <PageHeader title="Reports" />
      {can(Permissions.REPORTS_SCHEDULE) && (
        <Tabs value={tab} onChange={(_, v) => setParams(v ? { tab: 'schedules' } : {})} sx={{ mb: 2 }}>
          <Tab label="Run a report" />
          <Tab label="Scheduled" />
        </Tabs>
      )}
      {tab === 0 ? <RunTab /> : <SchedulesTab />}
    </>
  );
}

function RunTab() {
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['/reports'], queryFn: () => api<ReportDef[]>('/reports') });
  const [search, setSearch] = useState('');
  const key = params.get('key');
  const def = catalog.data?.find((d) => d.key === key) ?? null;
  const list = (catalog.data ?? []).filter((d) => !search || `${d.title} ${d.description}`.toLowerCase().includes(search.toLowerCase()));
  if (catalog.data && !catalog.data.length) return <Alert severity="info">No reports are available to your role.</Alert>;
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
      <Paper sx={{ width: { xs: '100%', md: 300 }, flexShrink: 0, maxHeight: { md: 'calc(100vh - 200px)' }, overflow: 'auto' }}>
        <Box sx={{ p: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Find a report"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
        </Box>
        <List dense disablePadding>
          {GROUPS.map((g) => {
            const items = list.filter((d) => d.group === g.key);
            if (!items.length) return null;
            return (
              <li key={g.key}>
                <ul style={{ padding: 0 }}>
                  <ListSubheader>{g.label}</ListSubheader>
                  {items.map((d) => (
                    <ListItemButton key={d.key} selected={d.key === key} onClick={() => setParams({ key: d.key })}>
                      <ListItemText primary={d.title} />
                    </ListItemButton>
                  ))}
                </ul>
              </li>
            );
          })}
        </List>
      </Paper>
      <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>{def ? <ReportView key={def.key} def={def} /> : <Alert severity="info">Choose a report on the left.</Alert>}</Box>
    </Stack>
  );
}

function ReportView({ def }: { def: ReportDef }) {
  const { can } = useAuth();
  const [f, setF] = useState<Filters>(() => defaults(def));
  const [ran, setRan] = useState<Filters | null>(null);
  const [schedule, setSchedule] = useState(false);
  const missing = (def.required ?? []).filter((k) => !f[k]);
  const clean = (x: Filters) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== ''));
  const result = useQuery({ queryKey: ['/reports', def.key, ran], queryFn: () => api<ReportResult>(`/reports/${def.key}`, { query: clean(ran!) }), enabled: !!ran, retry: false });
  // Snapshot reports (no required filters) run straight away.
  useEffect(() => {
    if (!def.required?.length) setRan(defaults(def));
  }, [def]);
  const href = (format: string) => buildUrl(`/reports/${def.key}/export`, { ...clean(ran ?? f), format });
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">{def.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{def.description}</Typography>
        <FilterBar def={def} f={f} setF={setF} />
        <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
          <Button variant="contained" disabled={!!missing.length || result.isFetching} onClick={() => setRan({ ...f })}>
            Run
          </Button>
          <ButtonGroup variant="outlined" disabled={!!missing.length}>
            <Button component="a" href={href('csv')}>CSV</Button>
            <Button component="a" href={href('xlsx')}>Excel</Button>
            <Button component="a" href={href('pdf')}>PDF</Button>
          </ButtonGroup>
          {can(Permissions.REPORTS_SCHEDULE) && (
            <Button startIcon={<ScheduleSendIcon />} onClick={() => setSchedule(true)}>
              Email on a schedule
            </Button>
          )}
          {missing.length > 0 && <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>Choose {missing.map((m) => FILTER_LABELS[m].toLowerCase()).join(', ')}.</Typography>}
        </Stack>
      </Paper>
      {result.error && <Alert severity="error">{(result.error as Error).message}</Alert>}
      {result.data && def.chart && <ReportChart def={def} r={result.data} />}
      {result.data && <ResultTable r={result.data} />}
      {schedule && (
        <ScheduleDialog
          initial={{ name: def.title, reportKey: def.key, filters: Object.fromEntries(Object.entries(clean(f)).filter(([k]) => k !== 'from' && k !== 'to')) }}
          onClose={() => setSchedule(false)}
        />
      )}
    </Stack>
  );
}

const FILTER_LABELS: Record<FilterKey, string> = {
  from: 'From',
  to: 'To',
  storeId: 'Store',
  categoryId: 'Category',
  itemId: 'Item',
  supplierId: 'Supplier',
  departmentId: 'Department',
  groupBy: 'Group by',
  days: 'Days',
  limit: 'Show top',
  status: 'Status',
  projectId: 'Project',
  userId: 'User',
  currency: 'Currency',
  floatId: 'Float',
  method: 'Method',
  period: 'Per',
};

function FilterBar({ def, f, setF }: { def: ReportDef; f: Filters; setF(f: Filters): void }) {
  const has = (k: FilterKey) => def.filters.includes(k);
  const req = (k: FilterKey) => !!def.required?.includes(k);
  const categories = useList<ItemCategory>('/item-categories', undefined, has('categoryId'));
  const suppliers = useAll<Supplier>('/suppliers', undefined, has('supplierId'));
  const departments = useAll<Department>('/departments', undefined, has('departmentId'));
  const projects = useQuery({ queryKey: ['/projects'], queryFn: () => api<{ id: string; code: string; name: string }[]>('/projects'), enabled: has('projectId') });
  const users = useQuery({ queryKey: ['/users/directory'], queryFn: () => api<{ id: string; fullName: string }[]>('/users/directory'), enabled: has('userId') });
  const currencies = useQuery({ queryKey: ['/currencies'], queryFn: () => api<{ code: string }[]>('/currencies'), enabled: has('currency') });
  const floats = useQuery({ queryKey: ['/petty-cash/floats'], queryFn: () => api<{ id: string; name: string }[]>('/petty-cash/floats'), enabled: has('floatId') });
  const [item, setItem] = useState<Item | null>(null);
  const set = (k: FilterKey, v: string) => setF({ ...f, [k]: v });
  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
      {has('from') && <TextField type="date" label="From" required={req('from')} value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} InputLabelProps={{ shrink: true }} />}
      {has('to') && <TextField type="date" label="To" required={req('to')} value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} InputLabelProps={{ shrink: true }} />}
      {has('storeId') && <StoreSelect label={req('storeId') ? 'Store *' : 'Store'} value={f.storeId ?? ''} onChange={(v) => set('storeId', v)} allowAll={req('storeId') ? undefined : 'All my stores'} sx={{ minWidth: 200 }} />}
      {has('categoryId') && (
        <TextField select label="Category" value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">All categories</MenuItem>
          {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
        </TextField>
      )}
      {has('itemId') && (
        <Box sx={{ minWidth: 280 }}>
          <ItemPicker label={req('itemId') ? 'Item *' : 'Item'} value={item} onChange={(i) => { setItem(i); set('itemId', i?.id ?? ''); }} />
        </Box>
      )}
      {has('supplierId') && (
        <TextField select label="Supplier" value={f.supplierId ?? ''} onChange={(e) => set('supplierId', e.target.value)} sx={{ minWidth: 220 }}>
          <MenuItem value="">All suppliers</MenuItem>
          {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
      )}
      {has('departmentId') && (
        <TextField select label="Department" value={f.departmentId ?? ''} onChange={(e) => set('departmentId', e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">All departments</MenuItem>
          {(departments.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
      )}
      {has('groupBy') && def.groupBy && (
        <TextField select label="Group by" value={f.groupBy ?? def.groupBy[0].value} onChange={(e) => set('groupBy', e.target.value)} sx={{ minWidth: 180 }}>
          {def.groupBy.map((g) => <MenuItem key={g.value} value={g.value}>{g.label}</MenuItem>)}
        </TextField>
      )}
      {has('period') && (
        <TextField select label="Per" value={f.period ?? 'MONTH'} onChange={(e) => set('period', e.target.value)} sx={{ minWidth: 130 }}>
          {BUCKETS.map((b) => <MenuItem key={b.value} value={b.value}>{b.label}</MenuItem>)}
        </TextField>
      )}
      {has('floatId') && (
        <TextField select label={req('floatId') ? 'Float *' : 'Float'} value={f.floatId ?? ''} onChange={(e) => set('floatId', e.target.value)} sx={{ minWidth: 200 }}>
          {!req('floatId') && <MenuItem value="">All floats</MenuItem>}
          {(floats.data ?? []).map((x) => <MenuItem key={x.id} value={x.id}>{x.name}</MenuItem>)}
        </TextField>
      )}
      {has('projectId') && (
        <TextField select label="Project" value={f.projectId ?? ''} onChange={(e) => set('projectId', e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">All projects</MenuItem>
          {(projects.data ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.code} {p.name}</MenuItem>)}
        </TextField>
      )}
      {has('userId') && (
        <TextField select label="User" value={f.userId ?? ''} onChange={(e) => set('userId', e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="">Everyone</MenuItem>
          {(users.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.fullName}</MenuItem>)}
        </TextField>
      )}
      {has('currency') && (
        <TextField select label="Currency" value={f.currency ?? ''} onChange={(e) => set('currency', e.target.value)} sx={{ minWidth: 120 }}>
          <MenuItem value="">Any</MenuItem>
          {(currencies.data ?? []).map((x) => <MenuItem key={x.code} value={x.code}>{x.code}</MenuItem>)}
        </TextField>
      )}
      {has('method') && (
        <TextField select label="Method" value={f.method ?? ''} onChange={(e) => set('method', e.target.value)} sx={{ minWidth: 160 }}>
          <MenuItem value="">All methods</MenuItem>
          {PAY_METHODS.map((m) => <MenuItem key={m} value={m}>{humanise(m)}</MenuItem>)}
        </TextField>
      )}
      {has('days') && <TextField type="number" label="Days" value={f.days ?? ''} onChange={(e) => set('days', e.target.value)} sx={{ width: 110 }} helperText="Default from settings" />}
      {has('limit') && <TextField type="number" label="Show top" value={f.limit ?? ''} onChange={(e) => set('limit', e.target.value)} sx={{ width: 110 }} placeholder="50" />}
      {has('status') && <TextField label="Status" value={f.status ?? ''} onChange={(e) => set('status', e.target.value.toUpperCase())} sx={{ width: 180 }} placeholder="e.g. POSTED" />}
    </Stack>
  );
}

/** A report's rows with formatting by column type and a totals row. */
export function ResultTable({ r }: { r: ReportResult }) {
  const money = useMoney();
  const date = useDate();
  const fmt = (v: unknown, c: ReportColumn) => {
    if (v === null || v === undefined || v === '') return '';
    switch (c.type) {
      case 'money':
        return money(Number(v));
      case 'qty':
      case 'number':
        return Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
      case 'percent':
        return `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
      case 'date':
        return date(String(v));
      case 'datetime':
        return date(String(v)) + ' ' + String(v).slice(11, 16);
      default:
        return c.key === 'status' || c.key === 'type' ? humanise(String(v)) : String(v);
    }
  };
  const num = (c: ReportColumn) => ['money', 'qty', 'number', 'percent'].includes(c.type);
  /** Drill-down: the document the cell names. */
  const cell = (row: Record<string, unknown>, c: ReportColumn) => {
    const text = fmt(row[c.key], c);
    if (!c.link || !text) return text;
    const type = c.link.docType.startsWith('@') ? String(row[c.link.docType.slice(1)] ?? '') : c.link.docType;
    const id = row[c.link.idKey];
    const to = id ? DOC_ROUTES[type]?.(String(id)) : undefined;
    return to ? <Link component={RouterLink} to={to}>{text}</Link> : text;
  };
  return (
    <Paper>
      <Stack direction="row" spacing={1} sx={{ p: 1.5 }} flexWrap="wrap" useFlexGap alignItems="center">
        {r.criteria.map((c) => <Chip key={c} size="small" label={c} />)}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{r.rows.length} row(s)</Typography>
      </Stack>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>{r.columns.map((c) => <TableCell key={c.key} align={num(c) ? 'right' : 'left'}>{c.label}</TableCell>)}</TableRow>
          </TableHead>
          <TableBody>
            {r.rows.map((row, i) => (
              <TableRow key={i} hover>
                {r.columns.map((c) => <TableCell key={c.key} align={num(c) ? 'right' : 'left'} sx={{ whiteSpace: num(c) ? 'nowrap' : undefined }}>{cell(row, c)}</TableCell>)}
              </TableRow>
            ))}
            {r.rows.length === 0 && <TableRow><TableCell colSpan={r.columns.length}>No rows for these filters.</TableCell></TableRow>}
            {r.totals && r.rows.length > 0 && (
              <TableRow>
                {r.columns.map((c, i) => (
                  <TableCell key={c.key} align={num(c) ? 'right' : 'left'} sx={{ fontWeight: 700 }}>{i === 0 ? 'Total' : fmt(r.totals![c.key], c)}</TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
      {r.notes?.map((n) => <Typography key={n} variant="caption" color="text.secondary" display="block" sx={{ px: 1.5, pb: 1 }}>{n}</Typography>)}
    </Paper>
  );
}

// ------------------------------------------------------------------ schedules

type ScheduleForm = { name: string; reportKey: string; filters: Record<string, unknown>; period: string; format: string; frequency: string; hour: number; weekday: number; monthDay: number; recipients: string; isActive: boolean };

function ScheduleDialog({ initial, id, onClose }: { initial: Partial<ScheduleForm> & { name: string; reportKey: string }; id?: string; onClose(): void }) {
  const { user } = useAuth();
  const [f, setF] = useState<ScheduleForm>({ period: 'LAST_7_DAYS', format: 'xlsx', frequency: 'WEEKLY', hour: 7, weekday: 1, monthDay: 1, recipients: user?.email ?? '', isActive: true, filters: {}, ...initial });
  const save = useApiMutation<void>(
    () => [
      id ? `/reports/schedules/${id}` : '/reports/schedules',
      {
        method: id ? 'PUT' : 'POST',
        body: {
          name: f.name,
          reportKey: f.reportKey,
          filters: f.filters,
          period: f.period,
          format: f.format,
          frequency: f.frequency,
          hour: f.hour,
          weekday: f.frequency === 'WEEKLY' ? f.weekday : undefined,
          monthDay: f.frequency === 'MONTHLY' ? f.monthDay : undefined,
          recipients: f.recipients.split(/[\s,;]+/).filter(Boolean),
          isActive: f.isActive,
        },
      },
    ],
    { invalidate: ['/reports/schedules'], success: 'Schedule saved' },
  );
  const set = <K extends keyof ScheduleForm>(k: K, v: ScheduleForm[K]) => setF({ ...f, [k]: v });
  const fixed = Object.entries(f.filters);
  return (
    <FormDialog open title={id ? 'Edit scheduled report' : 'Email this report on a schedule'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField label="Name (email subject)" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        {fixed.length > 0 && <Typography variant="body2" color="text.secondary">Filters kept: {fixed.map(([k, v]) => `${humanise(k)} ${String(v).slice(0, 8)}`).join(', ')}</Typography>}
        <Stack direction="row" spacing={2}>
          <TextField select label="Period" value={f.period} onChange={(e) => set('period', e.target.value)} sx={{ flex: 1 }} helperText="Worked out on the day it is sent">
            {PERIODS.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
          </TextField>
          <TextField select label="Format" value={f.format} onChange={(e) => set('format', e.target.value)} sx={{ width: 120 }}>
            <MenuItem value="xlsx">Excel</MenuItem>
            <MenuItem value="pdf">PDF</MenuItem>
            <MenuItem value="csv">CSV</MenuItem>
          </TextField>
        </Stack>
        <Stack direction="row" spacing={2}>
          <TextField select label="Every" value={f.frequency} onChange={(e) => set('frequency', e.target.value)} sx={{ width: 140 }}>
            <MenuItem value="DAILY">Day</MenuItem>
            <MenuItem value="WEEKLY">Week</MenuItem>
            <MenuItem value="MONTHLY">Month</MenuItem>
          </TextField>
          {f.frequency === 'WEEKLY' && (
            <TextField select label="On" value={f.weekday} onChange={(e) => set('weekday', Number(e.target.value))} sx={{ width: 160 }}>
              {WEEKDAYS.map((d, i) => <MenuItem key={d} value={i + 1}>{d}</MenuItem>)}
            </TextField>
          )}
          {f.frequency === 'MONTHLY' && <TextField type="number" label="Day of month" value={f.monthDay} onChange={(e) => set('monthDay', Number(e.target.value))} inputProps={{ min: 1, max: 28 }} sx={{ width: 140 }} />}
          <TextField type="number" label="At hour" value={f.hour} onChange={(e) => set('hour', Number(e.target.value))} inputProps={{ min: 0, max: 23 }} sx={{ width: 110 }} />
        </Stack>
        <TextField label="Send to" required multiline minRows={2} value={f.recipients} onChange={(e) => set('recipients', e.target.value)} helperText="Email addresses, separated by commas or new lines" />
        <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />} label="Active" />
        <Typography variant="caption" color="text.secondary">The report runs with your permissions and stores at the time it is sent.</Typography>
      </Stack>
    </FormDialog>
  );
}

function SchedulesTab() {
  const date = useDate();
  const list = useQuery({ queryKey: ['/reports/schedules'], queryFn: () => api<ReportSchedule[]>('/reports/schedules') });
  const [edit, setEdit] = useState<ReportSchedule | null>(null);
  const send = useApiMutation<string, { queued: number; error?: string }>((id) => [`/reports/schedules/${id}/send`, { method: 'POST' }], { invalidate: ['/reports/schedules'] });
  const del = useApiMutation<string>((id) => [`/reports/schedules/${id}`, { method: 'DELETE' }], { invalidate: ['/reports/schedules'], success: 'Schedule deleted' });
  const when = (s: ReportSchedule) =>
    `${s.frequency === 'DAILY' ? 'Daily' : s.frequency === 'WEEKLY' ? `${WEEKDAYS[(s.weekday ?? 1) - 1]}s` : `Day ${s.monthDay} of each month`} at ${String(s.hour).padStart(2, '0')}:00`;
  const rows = useMemo(() => list.data ?? [], [list.data]);
  return (
    <Paper>
      {send.data && <Alert severity={send.data.error ? 'error' : 'success'} sx={{ m: 1 }}>{send.data.error ?? `Queued ${send.data.queued} email(s).`}</Alert>}
      <Table size="small">
        <TableHead>
          <TableRow><TableCell>Name</TableCell><TableCell>Report</TableCell><TableCell>When</TableCell><TableCell>Period</TableCell><TableCell>Recipients</TableCell><TableCell>Next</TableCell><TableCell>Last</TableCell><TableCell /></TableRow>
        </TableHead>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.name}{!s.isActive && <Chip size="small" label="Paused" sx={{ ml: 1 }} />}<Typography variant="caption" display="block" color="text.secondary">{s.owner}</Typography></TableCell>
              <TableCell>{s.title} <Chip size="small" variant="outlined" label={s.format.toUpperCase()} /></TableCell>
              <TableCell>{when(s)}</TableCell>
              <TableCell>{PERIODS.find((p) => p.value === s.period)?.label ?? s.period}</TableCell>
              <TableCell>{s.recipients.join(', ')}</TableCell>
              <TableCell>{s.isActive ? date(s.nextRunAt) : '—'}</TableCell>
              <TableCell>
                {s.lastRunAt ? date(s.lastRunAt) : '—'}
                {s.lastError && <Typography variant="caption" color="error" display="block">{s.lastError}</Typography>}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                <Tooltip title="Send now"><IconButton size="small" onClick={() => send.mutate(s.id)}><SendIcon fontSize="small" /></IconButton></Tooltip>
                <Tooltip title="Edit"><IconButton size="small" onClick={() => setEdit(s)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                <Tooltip title="Delete"><IconButton size="small" onClick={() => del.mutate(s.id)}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
              </TableCell>
            </TableRow>
          ))}
          {list.data?.length === 0 && <TableRow><TableCell colSpan={8}>No scheduled reports. Open a report and choose “Email on a schedule”.</TableCell></TableRow>}
        </TableBody>
      </Table>
      {edit && (
        <ScheduleDialog
          id={edit.id}
          initial={{ ...edit, weekday: edit.weekday ?? 1, monthDay: edit.monthDay ?? 1, recipients: edit.recipients.join(', ') }}
          onClose={() => setEdit(null)}
        />
      )}
    </Paper>
  );
}

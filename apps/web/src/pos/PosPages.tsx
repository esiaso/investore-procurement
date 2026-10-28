import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Link,
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
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Permissions } from '@sil/shared';
import { api, buildUrl } from '../api/client';
import { useAll, useApiMutation, useList, usePaged } from '../api/hooks';
import type { PriceList } from '../api/pharmacy-types';
import type { Item, ItemCategory, Store } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StoreSelect } from '../inventory/components';
import { formatDate, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useMoney } from '../purchasing/common';
import { useSettings } from '../settings/SettingsContext';
import { ShiftReportDialog } from './TillPage';

const P = Permissions;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());

function useDt() {
  const { dateFormat, timezone } = useSettings();
  return (v: string | null | undefined) => (v ? formatDate(v, dateFormat, timezone, true) : '—');
}

// ------------------------------------------------------------------ shifts and cash-up

interface ShiftRow {
  id: string;
  number: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  varianceStatus: string;
  terminal: string;
  cashier: string;
  sales: number;
}

export function PosShiftsPage() {
  const { can } = useAuth();
  const money = useMoney();
  const dt = useDt();
  const [status, setStatus] = useState('');
  const [varianceStatus, setVarianceStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<ShiftRow | null>(null);
  const shifts = useQuery({ queryKey: ['/pos/shifts', status, varianceStatus], queryFn: () => api<ShiftRow[]>('/pos/shifts', { query: { status: status || undefined, varianceStatus: varianceStatus || undefined } }) });
  return (
    <>
      <PageHeader title="Shifts and cash-up" />
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 160, width: 'auto' }}>
          <MenuItem value="">All</MenuItem><MenuItem value="OPEN">Open</MenuItem><MenuItem value="CLOSED">Closed</MenuItem>
        </TextField>
        <TextField select label="Variance" value={varianceStatus} onChange={(e) => setVarianceStatus(e.target.value)} sx={{ minWidth: 200, width: 'auto' }}>
          <MenuItem value="">All</MenuItem>{['PENDING', 'APPROVED', 'REJECTED', 'NONE'].map((s) => <MenuItem key={s} value={s}>{s === 'NONE' ? 'Within tolerance' : humanise(s)}</MenuItem>)}
        </TextField>
      </Stack>
      <Paper>
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Shift</TableCell><TableCell>Till</TableCell><TableCell>Cashier</TableCell><TableCell>Opened</TableCell><TableCell>Closed</TableCell><TableCell align="right">Sales</TableCell><TableCell align="right">Expected</TableCell><TableCell align="right">Counted</TableCell><TableCell align="right">Variance</TableCell><TableCell /></TableRow>
          </TableHead>
          <TableBody>
            {(shifts.data ?? []).map((s) => (
              <TableRow key={s.id} hover>
                <TableCell><Link component="button" onClick={() => setOpen(s.id)}>{s.number}</Link></TableCell>
                <TableCell>{s.terminal}</TableCell>
                <TableCell>{s.cashier}</TableCell>
                <TableCell>{dt(s.openedAt)}</TableCell>
                <TableCell>{s.status === 'OPEN' ? <Chip size="small" color="info" label="Open" /> : dt(s.closedAt)}</TableCell>
                <TableCell align="right">{money(s.sales)}</TableCell>
                <TableCell align="right">{s.expectedCash === null ? '' : money(s.expectedCash)}</TableCell>
                <TableCell align="right">{s.countedCash === null ? '' : money(s.countedCash)}</TableCell>
                <TableCell align="right">
                  {s.variance === null ? '' : money(s.variance)}{' '}
                  {s.varianceStatus !== 'NONE' && <Chip size="small" color={s.varianceStatus === 'PENDING' ? 'warning' : s.varianceStatus === 'APPROVED' ? 'success' : 'error'} label={humanise(s.varianceStatus)} />}
                </TableCell>
                <TableCell>{s.varianceStatus === 'PENDING' && can(P.POS_APPROVE_VARIANCE) && <Button size="small" onClick={() => setDeciding(s)}>Decide</Button>}</TableCell>
              </TableRow>
            ))}
            {(shifts.data ?? []).length === 0 && <TableRow><TableCell colSpan={10}>No shifts.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      {open && <ShiftReportDialog shiftId={open} onClose={() => setOpen(null)} />}
      {deciding && <VarianceDialog shift={deciding} onClose={() => setDeciding(null)} />}
    </>
  );
}

function VarianceDialog({ shift, onClose }: { shift: ShiftRow; onClose(): void }) {
  const money = useMoney();
  const [approve, setApprove] = useState(true);
  const [note, setNote] = useState('');
  const save = useApiMutation<void>(() => [`/pos/shifts/${shift.id}/variance`, { method: 'POST', body: { approve, note } }], { invalidate: ['/pos/shifts'], success: 'Decision recorded' });
  return (
    <FormDialog open title={`Variance on ${shift.number}`} submitLabel="Record decision" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography>{shift.cashier}: expected {money(shift.expectedCash ?? 0)}, counted {money(shift.countedCash ?? 0)}, variance <strong>{money(shift.variance ?? 0)}</strong>.</Typography>
      <TextField select label="Decision" value={approve ? 'yes' : 'no'} onChange={(e) => setApprove(e.target.value === 'yes')}>
        <MenuItem value="yes">Accept the variance</MenuItem>
        <MenuItem value="no">Reject (follow up with the cashier)</MenuItem>
      </TextField>
      <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} required />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ setup

/** Tills, promotions, customers and M-Pesa settings. */
export function PosSetupPage() {
  const { can } = useAuth();
  const manage = can(P.POS_MANAGE);
  const [tab, setTab] = useState(manage ? 0 : 2);
  return (
    <>
      <PageHeader title="POS setup" />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab label="Tills" value={0} disabled={!manage} />
        <Tab label="Promotions" value={1} />
        <Tab label="Customers" value={2} />
        <Tab label="M-Pesa" value={3} disabled={!manage} />
      </Tabs>
      {tab === 0 && <TillsTab />}
      {tab === 1 && <PromotionsTab />}
      {tab === 2 && <CustomersTab />}
      {tab === 3 && <MpesaTab />}
    </>
  );
}

interface TerminalRow {
  id: string;
  code: string;
  name: string;
  storeId: string;
  store?: Store;
  defaultPriceListId: string | null;
  defaultPriceList?: PriceList | null;
  isActive: boolean;
  lastSeenAt: string | null;
}

function TillsTab() {
  const dt = useDt();
  const tills = useList<TerminalRow>('/pos/terminals');
  const [edit, setEdit] = useState<Partial<TerminalRow> | null>(null);
  return (
    <Paper sx={{ p: 2 }}>
      <Button variant="contained" onClick={() => setEdit({})} sx={{ mb: 1 }}>Add till</Button>
      <Table size="small">
        <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Sells from</TableCell><TableCell>Default price list</TableCell><TableCell>Last sale</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(tills.data ?? []).map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.code}{!t.isActive && <Chip size="small" label="Inactive" sx={{ ml: 1 }} />}</TableCell><TableCell>{t.name}</TableCell><TableCell>{t.store?.name}</TableCell>
              <TableCell>{t.defaultPriceList?.name ?? 'Default'}</TableCell><TableCell>{dt(t.lastSeenAt)}</TableCell>
              <TableCell><Button size="small" onClick={() => setEdit(t)}>Edit</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {edit && <TillDialog value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function TillDialog({ value, onClose }: { value: Partial<TerminalRow>; onClose(): void }) {
  const lists = useList<PriceList>('/billing/price-lists');
  const [f, setF] = useState({ code: value.code ?? '', name: value.name ?? '', storeId: value.storeId ?? '', defaultPriceListId: value.defaultPriceListId ?? '', isActive: value.isActive ?? true });
  const save = useApiMutation<void>(() => [value.id ? `/pos/terminals/${value.id}` : '/pos/terminals', { method: value.id ? 'PUT' : 'POST', body: { ...f, defaultPriceListId: f.defaultPriceListId || undefined } }], { invalidate: ['/pos/terminals'], success: 'Till saved' });
  return (
    <FormDialog open title={value.id ? `Till ${value.code}` : 'New till'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required />
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <StoreSelect value={f.storeId} onChange={(storeId) => setF({ ...f, storeId })} label="Sells from (stock and eTIMS outlet)" />
      <TextField select label="Default price list" value={f.defaultPriceListId} onChange={(e) => setF({ ...f, defaultPriceListId: e.target.value })}>
        <MenuItem value="">System default</MenuItem>{(lists.data ?? []).map((l) => <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>)}
      </TextField>
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

interface PromotionRow {
  id: string;
  code: string;
  name: string;
  itemId: string | null;
  item?: Item | null;
  categoryId: string | null;
  category?: ItemCategory | null;
  discountPercent: number;
  minQty: number;
  startsOn: string;
  endsOn: string;
  isActive: boolean;
}

function PromotionsTab() {
  const { can } = useAuth();
  const promos = useList<PromotionRow>('/pos/promotions');
  const [edit, setEdit] = useState<Partial<PromotionRow> | null>(null);
  return (
    <Paper sx={{ p: 2 }}>
      {can(P.POS_MANAGE) && <Button variant="contained" onClick={() => setEdit({})} sx={{ mb: 1 }}>Add promotion</Button>}
      <Typography variant="body2" sx={{ mb: 1 }}>Applied automatically at the till; the best active promotion for an item (or its category) wins, from the minimum quantity.</Typography>
      <Table size="small">
        <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>On</TableCell><TableCell align="right">Discount</TableCell><TableCell align="right">From qty</TableCell><TableCell>Period</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(promos.data ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.code}{!p.isActive && <Chip size="small" label="Off" sx={{ ml: 1 }} />}</TableCell><TableCell>{p.name}</TableCell><TableCell>{p.item?.name ?? p.category?.name}</TableCell>
              <TableCell align="right">{p.discountPercent}%</TableCell><TableCell align="right">{p.minQty}</TableCell><TableCell>{p.startsOn} – {p.endsOn}</TableCell>
              <TableCell>{can(P.POS_MANAGE) && <Button size="small" onClick={() => setEdit(p)}>Edit</Button>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {edit && <PromotionDialog value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function PromotionDialog({ value, onClose }: { value: Partial<PromotionRow>; onClose(): void }) {
  const categories = useList<ItemCategory>('/item-categories');
  const [item, setItem] = useState<Item | null>(value.item ?? null);
  const [f, setF] = useState({ code: value.code ?? '', name: value.name ?? '', categoryId: value.categoryId ?? '', discountPercent: value.discountPercent ?? 10, minQty: value.minQty ?? 1, startsOn: value.startsOn ?? today(), endsOn: value.endsOn ?? today(), isActive: value.isActive ?? true });
  const save = useApiMutation<void>(
    () => [value.id ? `/pos/promotions/${value.id}` : '/pos/promotions', { method: value.id ? 'PUT' : 'POST', body: { ...f, itemId: item?.id, categoryId: item ? undefined : f.categoryId || undefined } }],
    { invalidate: ['/pos/promotions'], success: 'Promotion saved' },
  );
  return (
    <FormDialog open title={value.id ? `Promotion ${value.code}` : 'New promotion'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction="row" spacing={1}>
        <TextField sx={{ flex: 1 }} label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required />
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required sx={{ flex: 1 }} />
      </Stack>
      <ItemPicker value={item} onChange={setItem} label="Item (or choose a category)" />
      {!item && (
        <TextField select label="Category" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
          {(categories.data ?? []).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
        </TextField>
      )}
      <Stack direction="row" spacing={1}>
        <TextField label="Discount %" type="number" value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: Number(e.target.value) })} />
        <TextField label="From quantity" type="number" value={f.minQty} onChange={(e) => setF({ ...f, minQty: Number(e.target.value) })} />
        <TextField label="From" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
    </FormDialog>
  );
}

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  kraPin: string | null;
  priceListId: string | null;
  priceList?: PriceList | null;
  creditAllowed: boolean;
  creditLimit: number;
  loyaltyPoints: number;
  balance: number;
  isActive: boolean;
}

function CustomersTab() {
  const money = useMoney();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [paging] = useState({ page: 0, pageSize: 100 });
  const customers = usePaged<CustomerRow>('/pos/customers', { ...paging, search: q || undefined });
  const [edit, setEdit] = useState<Partial<CustomerRow> | null>(null);
  const [statement, setStatement] = useState<CustomerRow | null>(null);
  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <TextField size="small" label="Search name, phone or code" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => setEdit({})}>Add customer</Button>
      </Stack>
      <Table size="small">
        <TableHead><TableRow><TableCell>Code</TableCell><TableCell>Name</TableCell><TableCell>Phone</TableCell><TableCell>Price list</TableCell><TableCell align="right">Points</TableCell><TableCell align="right">Owes</TableCell><TableCell align="right">Credit limit</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {(customers.data?.items ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.code}</TableCell><TableCell>{c.name}</TableCell><TableCell>{c.phone}</TableCell><TableCell>{c.priceList?.name ?? ''}</TableCell>
              <TableCell align="right">{c.loyaltyPoints}</TableCell><TableCell align="right">{money(c.balance)}</TableCell><TableCell align="right">{c.creditAllowed ? money(c.creditLimit) : '—'}</TableCell>
              <TableCell><Button size="small" onClick={() => setEdit(c)}>Edit</Button><Button size="small" onClick={() => setStatement(c)}>Account</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {edit && <CustomerDialog value={edit} onClose={() => setEdit(null)} />}
      {statement && <StatementDialog customer={statement} onClose={() => setStatement(null)} />}
    </Paper>
  );
}

function CustomerDialog({ value, onClose }: { value: Partial<CustomerRow>; onClose(): void }) {
  const { can } = useAuth();
  const lists = useList<PriceList>('/billing/price-lists');
  const [f, setF] = useState({ name: value.name ?? '', phone: value.phone ?? '', kraPin: value.kraPin ?? '', priceListId: value.priceListId ?? '', creditAllowed: value.creditAllowed ?? false, creditLimit: value.creditLimit ?? 0 });
  const manage = can(P.POS_MANAGE);
  const save = useApiMutation<void>(
    () => [value.id ? `/pos/customers/${value.id}` : '/pos/customers', { method: value.id ? 'PUT' : 'POST', body: { name: f.name, phone: f.phone || undefined, kraPin: f.kraPin || undefined, priceListId: f.priceListId || undefined, ...(manage ? { creditAllowed: f.creditAllowed, creditLimit: f.creditLimit } : {}) } }],
    { invalidate: ['/pos/customers'], success: 'Customer saved' },
  );
  return (
    <FormDialog open title={value.id ? `Customer ${value.code}` : 'New customer'} onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <Stack direction="row" spacing={1}>
        <TextField label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <TextField label="KRA PIN (business buyers)" value={f.kraPin} onChange={(e) => setF({ ...f, kraPin: e.target.value.toUpperCase() })} />
      </Stack>
      <TextField select label="Price list" value={f.priceListId} onChange={(e) => setF({ ...f, priceListId: e.target.value })}>
        <MenuItem value="">Till default</MenuItem>{(lists.data ?? []).map((l) => <MenuItem key={l.id} value={l.id}>{l.name}</MenuItem>)}
      </TextField>
      {manage && (
        <Stack direction="row" spacing={1} alignItems="center">
          <FormControlLabel control={<Switch checked={f.creditAllowed} onChange={(e) => setF({ ...f, creditAllowed: e.target.checked })} />} label="Buys on account" />
          <TextField label="Credit limit" type="number" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: Number(e.target.value) })} disabled={!f.creditAllowed} />
        </Stack>
      )}
    </FormDialog>
  );
}

function StatementDialog({ customer, onClose }: { customer: CustomerRow; onClose(): void }) {
  const money = useMoney();
  const dt = useDt();
  const st = useQuery({ queryKey: ['/pos/customers', customer.id, 'statement'], queryFn: () => api<{ balance: number; entries: { id: string; type: string; amount: number; reference: string | null; at: string; balance: number }[] }>(`/pos/customers/${customer.id}/statement`) });
  const [amount, setAmount] = useState<number | ''>('');
  const [mode, setMode] = useState('CASH');
  const [reference, setReference] = useState('');
  const pay = useApiMutation<void>(() => [`/pos/customers/${customer.id}/payments`, { method: 'POST', body: { amount: Number(amount), modeCode: mode, reference: reference || undefined } }], { invalidate: ['/pos/customers'], success: 'Payment recorded' });
  return (
    <FormDialog open title={`${customer.name} — account`} submitLabel="Record payment" onClose={onClose} submitting={pay.isPending} onSubmit={(e) => { e.preventDefault(); pay.mutate(undefined, { onSuccess: () => { setAmount(''); setReference(''); void st.refetch(); } }); }}>
      <Table size="small">
        <TableHead><TableRow><TableCell>When</TableCell><TableCell>Entry</TableCell><TableCell align="right">Amount</TableCell><TableCell align="right">Balance</TableCell></TableRow></TableHead>
        <TableBody>
          {(st.data?.entries ?? []).map((e) => <TableRow key={e.id}><TableCell>{dt(e.at)}</TableCell><TableCell>{humanise(e.type)} {e.reference}</TableCell><TableCell align="right">{money(e.amount)}</TableCell><TableCell align="right">{money(e.balance)}</TableCell></TableRow>)}
        </TableBody>
      </Table>
      <Typography variant="h6">Owes {money(st.data?.balance ?? 0)}</Typography>
      <Stack direction="row" spacing={1}>
        <TextField label="Payment" type="number" value={amount} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} />
        <TextField select label="By" value={mode} onChange={(e) => setMode(e.target.value)} sx={{ minWidth: 120, width: 'auto' }}>
          <MenuItem value="CASH">Cash</MenuItem><MenuItem value="MPESA">M-Pesa</MenuItem><MenuItem value="CARD">Card</MenuItem>
        </TextField>
        {mode !== 'CASH' && <TextField label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} />}
      </Stack>
      <Typography variant="caption">Cash taken at a till is counted in that till’s shift (use the till for that).</Typography>
    </FormDialog>
  );
}

interface MpesaConfigView {
  environment: string;
  shortcode: string;
  transactionType: string;
  partyB: string | null;
  apiBaseUrl: string | null;
  callbackBaseUrl: string | null;
  hasCredentials: boolean;
  isActive: boolean;
  callbackUrls: { stk: string; c2bConfirmation: string; c2bValidation: string } | null;
}

function MpesaTab() {
  const cfg = useQuery({ queryKey: ['/pos/mpesa/config'], queryFn: () => api<MpesaConfigView | null>('/pos/mpesa/config') });
  const [f, setF] = useState({ environment: 'SANDBOX', shortcode: '', transactionType: 'CustomerPayBillOnline', partyB: '', apiBaseUrl: 'https://sandbox.safaricom.co.ke', callbackBaseUrl: '', consumerKey: '', consumerSecret: '', passkey: '', isActive: true });
  useEffect(() => {
    if (cfg.data) setF((x) => ({ ...x, environment: cfg.data!.environment, shortcode: cfg.data!.shortcode, transactionType: cfg.data!.transactionType, partyB: cfg.data!.partyB ?? '', apiBaseUrl: cfg.data!.apiBaseUrl ?? '', callbackBaseUrl: cfg.data!.callbackBaseUrl ?? '', isActive: cfg.data!.isActive }));
  }, [cfg.data]);
  const save = useApiMutation<boolean>(
    (rotate) => ['/pos/mpesa/config', { method: 'PUT', body: { ...f, partyB: f.partyB || undefined, apiBaseUrl: f.apiBaseUrl || undefined, callbackBaseUrl: f.callbackBaseUrl || undefined, consumerKey: f.consumerKey || undefined, consumerSecret: f.consumerSecret || undefined, passkey: f.passkey || undefined, rotateCallbackToken: rotate || undefined } }],
    { invalidate: ['/pos/mpesa'], success: 'M-Pesa settings saved' },
  );
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 680 }}>
        <TextField select label="Environment" value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>
          <MenuItem value="SANDBOX">Daraja sandbox</MenuItem><MenuItem value="PRODUCTION">Daraja production</MenuItem><MenuItem value="MOCK">Mock (no Safaricom)</MenuItem>
        </TextField>
        <Stack direction="row" spacing={1}>
          <TextField label="Business shortcode" value={f.shortcode} onChange={(e) => setF({ ...f, shortcode: e.target.value })} />
          <TextField select label="Type" value={f.transactionType} onChange={(e) => setF({ ...f, transactionType: e.target.value })} sx={{ minWidth: 220, width: 'auto' }}>
            <MenuItem value="CustomerPayBillOnline">Paybill</MenuItem><MenuItem value="CustomerBuyGoodsOnline">Buy goods (till)</MenuItem>
          </TextField>
          {f.transactionType === 'CustomerBuyGoodsOnline' && <TextField label="Till number" value={f.partyB} onChange={(e) => setF({ ...f, partyB: e.target.value })} />}
        </Stack>
        {f.environment !== 'MOCK' && (
          <>
            <TextField label="Daraja API base URL" value={f.apiBaseUrl} onChange={(e) => setF({ ...f, apiBaseUrl: e.target.value })} />
            <Stack direction="row" spacing={1}>
              <TextField label={cfg.data?.hasCredentials ? 'Consumer key (stored)' : 'Consumer key'} type="password" value={f.consumerKey} onChange={(e) => setF({ ...f, consumerKey: e.target.value })} />
              <TextField label="Consumer secret" type="password" value={f.consumerSecret} onChange={(e) => setF({ ...f, consumerSecret: e.target.value })} />
              <TextField label="Passkey" type="password" value={f.passkey} onChange={(e) => setF({ ...f, passkey: e.target.value })} />
            </Stack>
          </>
        )}
        <TextField label="Public base URL for callbacks" value={f.callbackBaseUrl} onChange={(e) => setF({ ...f, callbackBaseUrl: e.target.value })} helperText="The address Safaricom can reach, e.g. https://pharmacy.hospital.co.ke" />
        <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={() => save.mutate(false)}>Save</Button>
          {cfg.data && <Button onClick={() => save.mutate(true)}>Save and change the callback secret</Button>}
        </Stack>
        {cfg.data?.callbackUrls && (
          <Alert severity="info">
            Register with Safaricom — STK callback: <code>{cfg.data.callbackUrls.stk}</code>; C2B confirmation: <code>{cfg.data.callbackUrls.c2bConfirmation}</code>; C2B validation: <code>{cfg.data.callbackUrls.c2bValidation}</code>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

// ------------------------------------------------------------------ reports

export function PosReportsPage() {
  const money = useMoney();
  const dt = useDt();
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [storeId, setStoreId] = useState('');
  const [groupBy, setGroupBy] = useState('item');
  const query = { from, to, storeId: storeId || undefined, groupBy };
  const rows = useQuery({ queryKey: ['/pos/reports/sales', query], queryFn: () => api<Record<string, number | string | null>[]>('/pos/reports/sales', { query }) });
  const events = useQuery({ queryKey: ['/pos/reports/events', from, to, storeId], queryFn: () => api<Record<string, string | number | null>[]>('/pos/reports/events', { query: { from, to, storeId: storeId || undefined } }) });
  const mode = groupBy === 'mode';
  return (
    <>
      <PageHeader title="POS reports" />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <StoreSelect value={storeId} onChange={setStoreId} label="Store" allowAll="All" sx={{ minWidth: 200 }} />
        <TextField select label="By" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} sx={{ minWidth: 180, width: 'auto' }}>
          {['cashier', 'shift', 'item', 'category', 'mode', 'hour'].map((g) => <MenuItem key={g} value={g}>{g === 'mode' ? 'Payment mode' : humanise(g)}</MenuItem>)}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        <Button href={buildUrl('/pos/reports/sales', { ...query, format: 'csv' })}>CSV</Button>
      </Stack>
      <Paper sx={{ mb: 2, overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{humanise(groupBy)}</TableCell><TableCell align="right">Sales</TableCell>
              {mode ? <TableCell align="right">Amount</TableCell> : (
                <>
                  <TableCell align="right">Qty</TableCell><TableCell align="right">Gross</TableCell><TableCell align="right">Discounts</TableCell><TableCell align="right">Net of VAT</TableCell><TableCell align="right">Cost</TableCell><TableCell align="right">Margin</TableCell><TableCell align="right">Margin %</TableCell>
                </>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {(rows.data ?? []).map((r) => (
              <TableRow key={String(r.key)}>
                <TableCell>{r.label ?? r.key}</TableCell><TableCell align="right">{r.sales}</TableCell>
                {mode ? <TableCell align="right">{money(Number(r.amount))}</TableCell> : (
                  <>
                    <TableCell align="right">{r.quantity}</TableCell><TableCell align="right">{money(Number(r.gross))}</TableCell><TableCell align="right">{money(Number(r.discounts))}</TableCell>
                    <TableCell align="right">{money(Number(r.net))}</TableCell><TableCell align="right">{money(Number(r.cost))}</TableCell><TableCell align="right">{money(Number(r.margin))}</TableCell><TableCell align="right">{r.marginPct ?? '—'}</TableCell>
                  </>
                )}
              </TableRow>
            ))}
            {(rows.data ?? []).length === 0 && <TableRow><TableCell colSpan={9}>No sales in this period.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Paper>
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>Voids, refunds, overrides and approvals</Typography>
        <Button href={buildUrl('/pos/reports/events', { from, to, storeId: storeId || undefined, format: 'csv' })}>CSV</Button>
      </Stack>
      <Paper sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead><TableRow><TableCell>When</TableCell><TableCell>What</TableCell><TableCell>Till / shift</TableCell><TableCell>Invoice</TableCell><TableCell>By</TableCell><TableCell>Approved by</TableCell><TableCell align="right">Amount</TableCell><TableCell>Reason</TableCell></TableRow></TableHead>
          <TableBody>
            {(events.data ?? []).map((e, i) => (
              <TableRow key={i}>
                <TableCell>{dt(String(e.at))}</TableCell><TableCell>{humanise(String(e.type))}</TableCell><TableCell>{e.terminal} {e.shift}</TableCell><TableCell>{e.invoice}</TableCell>
                <TableCell>{e.user}</TableCell><TableCell>{e.approvedBy}</TableCell><TableCell align="right">{e.amount === null ? '' : money(Number(e.amount))}</TableCell><TableCell>{e.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </>
  );
}

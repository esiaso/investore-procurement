import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  List,
  ListItemButton,
  ListItemText,
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Permissions } from '@sil/shared';
import { api, ApiError, API_BASE } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { useNotify } from '../components/Notify';
import { PageHeader } from '../components/PageHeader';
import { humanise } from '../lib/format';
import { useMoney } from '../purchasing/common';
import {
  CatalogItem,
  enqueue,
  findInCatalog,
  isOffline,
  lineAmount,
  loadCatalog,
  loadQueue,
  loadRejected,
  newClientRef,
  offlineBlock,
  QueuedSale,
  saveCatalog,
  saveQueue,
  saveRejected,
  TERMINAL_KEY,
  TillCatalog,
} from './offline';

const P = Permissions;

interface Terminal {
  id: string;
  code: string;
  name: string;
  storeId: string;
  store?: { name: string };
}
interface Shift {
  id: string;
  number: string;
  status: 'OPEN' | 'CLOSED';
  openingFloat: number;
  openedAt: string;
  report: ShiftReport | null;
  variance: number | null;
  varianceStatus: string;
}
export interface ShiftReport {
  shift: string;
  openingFloat: number;
  sales: { count: number; gross: number; discounts: number; offline: number; pointsRedeemed: number };
  byMode: { mode: string; amount: number; sales: number }[];
  voids: { count: number; amount: number; cash: number; lineVoids: number };
  refunds: { count: number; amount: number; cash: number };
  accountPayments: { count: number; amount: number; cash: number };
  overrides: { discounts: number; pharmacist: number; interactions: number };
  unverifiedMpesa: { receiptNo: string; amount: number }[];
  expectedCash: number;
  countedCash?: number;
  variance?: number;
}
interface Quote {
  lines: { itemId: string; salesClass: string; listPrice: number; promotion: { name: string; percent: number } | null; discountPercent: number; gross: number; available: number; lowStock: boolean }[];
  total: number;
  discountAmount: number;
  loyalty: { points: number; value: number } | null;
  needs: { pharmacist: boolean; prescription: boolean; supervisor: boolean; interactionReason: boolean };
  blocked: string[];
  alerts: { type: string; severity: string; message: string; management: string | null; blocking: boolean }[];
  maxDiscountPercent: number;
}
interface BasketLine {
  item: CatalogItem;
  quantity: number;
  discountPercent: number;
}
interface SaleResult {
  id: string;
  total: number;
  change: number;
  warnings: string[];
  invoice: { id: string; number: string; etimsStatus: string; cuInvoiceNo: string | null; totalAmount: number };
}
type Payment = { modeCode: string; amount: number; reference?: string; mpesaTransactionId?: string };

export function TillPage() {
  const { can, user } = useAuth();
  const notify = useNotify();
  const money = useMoney();
  const qc = useQueryClient();
  const [terminalId, setTerminalId] = useState<string>(() => {
    try {
      return localStorage.getItem(TERMINAL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [catalog, setCatalog] = useState<TillCatalog | null>(() => (terminalId ? loadCatalog(terminalId) : null));
  const [queue, setQueue] = useState<QueuedSale[]>(() => (terminalId ? loadQueue(terminalId) : []));
  const [rejected, setRejected] = useState(() => (terminalId ? loadRejected(terminalId) : []));
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [voided, setVoided] = useState<{ itemId: string; quantity: number; reason?: string }[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState<CatalogItem[]>([]);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<SaleResult | { offline: QueuedSale } | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [xReport, setXReport] = useState(false);
  const [recent, setRecent] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const terminals = useQuery({ queryKey: ['/pos/terminals'], queryFn: () => api<Terminal[]>('/pos/terminals'), enabled: online });
  const shift = useQuery({
    queryKey: ['/pos/shifts/current', terminalId],
    queryFn: () => api<Shift | null>('/pos/shifts/current', { query: { terminalId } }),
    enabled: !!terminalId && online,
    retry: false,
  });

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const chooseTerminal = (id: string) => {
    setTerminalId(id);
    try {
      localStorage.setItem(TERMINAL_KEY, id);
    } catch {
      /* private window: remember for this page only */
    }
    setCatalog(loadCatalog(id));
    setQueue(loadQueue(id));
    setRejected(loadRejected(id));
  };

  const refreshCatalog = useCallback(async () => {
    if (!terminalId) return;
    try {
      const c = await api<TillCatalog>(`/pos/terminals/${terminalId}/catalog`);
      saveCatalog(c);
      setCatalog(c);
      setOnline(true);
    } catch (e) {
      if (isOffline(e)) setOnline(false);
    }
  }, [terminalId]);
  useEffect(() => {
    if (terminalId && online) void refreshCatalog();
  }, [terminalId, online, refreshCatalog]);

  const sync = useCallback(async () => {
    const pending = loadQueue(terminalId);
    if (!pending.length) return;
    try {
      const r = await api<{ results: { clientRef: string; status: string; error?: string }[]; created: number; rejected: number }>('/pos/sales/sync', {
        method: 'POST',
        body: { sales: pending.map(({ display: _d, ...s }) => s) },
      });
      const done = new Set(r.results.filter((x) => x.status !== 'REJECTED').map((x) => x.clientRef));
      const refused = r.results.filter((x) => x.status === 'REJECTED');
      const nowRejected = [...loadRejected(terminalId), ...refused.map((x) => ({ sale: pending.find((p) => p.clientRef === x.clientRef)!, error: x.error ?? 'Refused', at: new Date().toISOString() }))];
      saveQueue(terminalId, []);
      saveRejected(terminalId, nowRejected);
      setQueue([]);
      setRejected(nowRejected);
      notify.success(`${done.size} offline sale(s) sent${refused.length ? `; ${refused.length} refused — see below` : ''}`);
      await refreshCatalog();
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/pos') });
    } catch (e) {
      if (isOffline(e)) setOnline(false);
      else notify.error((e as Error).message);
    }
  }, [terminalId, notify, refreshCatalog, qc]);
  useEffect(() => {
    if (online && queue.length && shift.data) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, shift.data?.id]);

  // Live basket check (prices, promotions, controls, interactions) while online.
  const lines = basket.map((b) => ({ itemId: b.item.itemId, quantity: b.quantity, discountPercent: b.discountPercent || undefined }));
  const key = JSON.stringify([lines, customerId]);
  const quote = useQuery({
    queryKey: ['/pos/check', terminalId, key],
    queryFn: () => api<Quote>('/pos/check', { method: 'POST', body: { terminalId, customerId: customerId ?? undefined, lines } }),
    enabled: online && !!terminalId && lines.length > 0,
    retry: false,
  });
  const localTotal = basket.reduce((s, b) => s + lineAmount(b.item.price, b.quantity, Math.min(100, b.discountPercent + (b.item.promotion?.percent ?? 0))), 0);
  const total = online && quote.data ? quote.data.total : Math.round(localTotal * 100) / 100;

  const add = (item: CatalogItem) => {
    setBasket((bs) => {
      const i = bs.findIndex((b) => b.item.itemId === item.itemId);
      if (i >= 0) return bs.map((b, j) => (j === i ? { ...b, quantity: b.quantity + 1 } : b));
      return [...bs, { item, quantity: 1, discountPercent: 0 }];
    });
    setTerm('');
    setMatches([]);
    search.current?.focus();
  };
  const remove = (i: number) => {
    const b = basket[i];
    setVoided((v) => [...v, { itemId: b.item.itemId, quantity: b.quantity, reason: 'Removed before payment' }]);
    setBasket((bs) => bs.filter((_, j) => j !== i));
  };
  const onSearch = async (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    let found = findInCatalog(catalog, term);
    if (!found.length && online && term.trim()) {
      try {
        found = (await api<CatalogItem[]>('/pos/items', { query: { terminalId, q: term } })).map((x) => ({ ...x, barcode: null, gtin: null, uom: null, maxQtyPerSale: null }));
      } catch (err) {
        if (isOffline(err)) setOnline(false);
      }
    }
    if (found.length === 1) add(found[0]);
    else if (!found.length) notify.error(`Nothing matches “${term}”`);
    else setMatches(found);
  };
  const clear = () => {
    setBasket([]);
    setVoided([]);
    setCustomerId(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'F2') {
      e.preventDefault();
      search.current?.focus();
    } else if (e.key === 'F9' && basket.length && shift.data) {
      e.preventDefault();
      setPaying(true);
    }
  };

  const canApprove = can(P.POS_APPROVE_POM);
  const customer = catalog?.customers.find((c) => c.id === customerId) ?? null;
  const offlineShiftOk = !online && !!catalog; // the shift was checked when last online

  return (
    <Box onKeyDown={onKey}>
      <PageHeader title="Till" />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} sx={{ mb: 2 }}>
        <TextField select size="small" label="Till" value={terminalId} onChange={(e) => chooseTerminal(e.target.value)} sx={{ minWidth: 220, width: 'auto' }}>
          {(terminals.data ?? (catalog ? [{ ...catalog.terminal }] : [])).map((t) => (
            <MenuItem key={t.id} value={t.id}>{t.code} · {t.name}</MenuItem>
          ))}
        </TextField>
        <Chip color={online ? 'success' : 'warning'} label={online ? 'Online' : 'Offline — sales are kept on this till'} />
        {queue.length > 0 && <Chip color="warning" variant="outlined" label={`${queue.length} offline sale(s) waiting`} />}
        {queue.length > 0 && online && <Button size="small" onClick={() => void sync()}>Send now</Button>}
        {catalog && <Typography variant="caption">Prices and stock as at {new Date(catalog.snapshotAt).toLocaleTimeString()}</Typography>}
        <Box sx={{ flexGrow: 1 }} />
        {shift.data ? (
          <>
            <Typography variant="body2">Shift {shift.data.number}</Typography>
            <Button size="small" onClick={() => setRecent(true)}>Sales</Button>
            <Button size="small" onClick={() => setXReport(true)}>X report</Button>
            <Button size="small" color="warning" onClick={() => setClosing(true)} disabled={queue.length > 0}>Cash up</Button>
          </>
        ) : (
          terminalId && online && !shift.isLoading && can(P.POS_SELL) && <Button variant="contained" onClick={() => setOpening(true)}>Open shift</Button>
        )}
      </Stack>
      {!terminalId && <Alert severity="info">Choose this computer’s till.</Alert>}
      {rejected.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => { saveRejected(terminalId, []); setRejected([]); }}>
          {rejected.length} offline sale(s) were refused when sent; a supervisor sees them in POS reports. {rejected.map((r) => `${r.sale.display?.total ?? ''} — ${r.error}`).join('; ')}
        </Alert>
      )}
      {terminalId && (shift.data || offlineShiftOk) && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
          <Paper sx={{ p: 2, flex: 2, width: '100%' }}>
            <TextField
              inputRef={search}
              autoFocus
              fullWidth
              label="Scan or search (F2) — Enter adds"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onSearch}
            />
            {matches.length > 0 && (
              <List dense sx={{ maxHeight: 240, overflow: 'auto' }}>
                {matches.map((m) => (
                  <ListItemButton key={m.itemId} onClick={() => add(m)}>
                    <ListItemText primary={`${m.name} — ${money(m.price)}`} secondary={`${m.generic ?? ''} · ${m.salesClass} · ${m.available} in stock${m.lowStock ? ' (low)' : ''}`} />
                  </ListItemButton>
                ))}
              </List>
            )}
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow><TableCell>Item</TableCell><TableCell align="right">Qty</TableCell><TableCell align="right">Disc. %</TableCell><TableCell align="right">Price</TableCell><TableCell align="right">Amount</TableCell><TableCell /></TableRow>
              </TableHead>
              <TableBody>
                {basket.map((b, i) => {
                  const ql = online ? quote.data?.lines[i] : undefined;
                  return (
                    <TableRow key={b.item.itemId}>
                      <TableCell>
                        {b.item.name}
                        <Stack direction="row" spacing={0.5}>
                          {b.item.salesClass !== 'OTC' && <Chip size="small" color={b.item.salesClass === 'CD' ? 'error' : 'warning'} label={b.item.salesClass} />}
                          {(ql?.promotion ?? b.item.promotion) && <Chip size="small" color="success" label={`${(ql?.promotion ?? b.item.promotion)!.name} −${(ql?.promotion ?? b.item.promotion)!.percent}%`} />}
                          {(ql?.lowStock ?? b.item.lowStock) && <Chip size="small" variant="outlined" label="Low stock" />}
                          {b.item.maxQtyPerSale && <Chip size="small" variant="outlined" label={`Max ${b.item.maxQtyPerSale}`} />}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        <TextField size="small" type="number" value={b.quantity} onChange={(e) => setBasket(basket.map((x, j) => (j === i ? { ...x, quantity: Math.max(0, Number(e.target.value)) } : x)))} sx={{ width: 80 }} inputProps={{ 'aria-label': `Quantity of ${b.item.name}`, min: 0, step: 'any' }} />
                      </TableCell>
                      <TableCell align="right">
                        <TextField size="small" type="number" value={b.discountPercent || ''} onChange={(e) => setBasket(basket.map((x, j) => (j === i ? { ...x, discountPercent: Math.min(100, Math.max(0, Number(e.target.value))) } : x)))} sx={{ width: 70 }} inputProps={{ 'aria-label': `Discount on ${b.item.name}` }} />
                      </TableCell>
                      <TableCell align="right">{money(ql?.listPrice ?? b.item.price)}</TableCell>
                      <TableCell align="right">{money(ql?.gross ?? lineAmount(b.item.price, b.quantity, Math.min(100, b.discountPercent + (b.item.promotion?.percent ?? 0))))}</TableCell>
                      <TableCell><IconButton size="small" aria-label={`Remove ${b.item.name}`} onClick={() => remove(i)}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                    </TableRow>
                  );
                })}
                {basket.length === 0 && <TableRow><TableCell colSpan={6}>Scan an item to start a sale.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Paper>
          <Paper sx={{ p: 2, flex: 1, width: '100%' }}>
            <Stack spacing={1.5}>
              <Autocomplete
                size="small"
                options={catalog?.customers ?? []}
                value={customer}
                getOptionLabel={(c) => `${c.name}${c.phone ? ` · ${c.phone}` : ''}`}
                onChange={(_, v) => setCustomerId(v?.id ?? null)}
                renderInput={(params) => <TextField {...params} label="Customer (optional)" />}
              />
              {customer && <Typography variant="caption">{customer.loyaltyPoints} points{customer.creditAllowed ? ' · credit account' : ''}</Typography>}
              <Typography variant="h4" aria-label="Total">{money(total)}</Typography>
              {online && quote.data && quote.data.discountAmount > 0 && <Typography variant="body2">Discounts {money(quote.data.discountAmount)}</Typography>}
              {online && quote.data?.blocked.map((b) => <Alert key={b} severity="error">{b}</Alert>)}
              {online && quote.data?.alerts.map((a) => <Alert key={a.message} severity={a.blocking ? 'error' : 'warning'}>{humanise(a.severity)} · {a.message}{a.management ? ` — ${a.management}` : ''}</Alert>)}
              {online && quote.data?.needs.pharmacist && <Alert severity="info">A pharmacist must approve this sale{quote.data.needs.prescription ? ' (prescription-only: enter the prescription)' : ''}.</Alert>}
              {!online && basket.some((b) => offlineBlock(b.item, canApprove)) && <Alert severity="error">{basket.map((b) => offlineBlock(b.item, canApprove)).filter(Boolean).join('; ')}</Alert>}
              <Stack direction="row" spacing={1}>
                <Button variant="contained" size="large" sx={{ flex: 1 }} disabled={!basket.length || basket.some((b) => b.quantity <= 0) || (online && (!quote.data || quote.data.blocked.length > 0))} onClick={() => setPaying(true)}>
                  Pay (F9)
                </Button>
                <Button onClick={clear} disabled={!basket.length}>Clear</Button>
              </Stack>
            </Stack>
          </Paper>
        </Stack>
      )}
      {paying && (
        <PayDialog
          terminalId={terminalId}
          online={online}
          total={total}
          quote={online ? (quote.data ?? null) : null}
          customer={customer}
          canApprove={canApprove}
          basket={basket}
          voided={voided}
          onOffline={() => setOnline(false)}
          onClose={() => setPaying(false)}
          onDone={(r) => {
            setPaying(false);
            setReceipt(r);
            clear();
            if ('offline' in r) setQueue(loadQueue(terminalId));
            else void refreshCatalog();
            void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/pos/shifts') });
          }}
          userName={user?.fullName ?? ''}
        />
      )}
      {receipt && <ReceiptDialog result={receipt} onClose={() => { setReceipt(null); search.current?.focus(); }} />}
      {opening && <OpenShiftDialog terminalId={terminalId} onClose={() => setOpening(false)} />}
      {closing && shift.data && <CloseShiftDialog shift={shift.data} onClose={() => setClosing(false)} />}
      {xReport && shift.data && <ShiftReportDialog shiftId={shift.data.id} onClose={() => setXReport(false)} />}
      {recent && shift.data && <ShiftSalesDialog shiftId={shift.data.id} terminalId={terminalId} onClose={() => setRecent(false)} />}
    </Box>
  );
}

function PayDialog(props: {
  terminalId: string;
  online: boolean;
  total: number;
  quote: Quote | null;
  customer: TillCatalog['customers'][number] | null;
  canApprove: boolean;
  basket: BasketLine[];
  voided: { itemId: string; quantity: number; reason?: string }[];
  userName: string;
  onOffline(): void;
  onClose(): void;
  onDone(r: SaleResult | { offline: QueuedSale }): void;
}) {
  const { terminalId, online, total, quote, customer, basket, voided } = props;
  const money = useMoney();
  const notify = useNotify();
  const [cash, setCash] = useState<number | ''>('');
  const [card, setCard] = useState<{ amount: number | ''; reference: string }>({ amount: '', reference: '' });
  const [mpesa, setMpesa] = useState<{ amount: number | ''; phone: string; code: string; txnId: string | null; status: string | null; receipt: string | null }>({ amount: '', phone: '', code: '', txnId: null, status: null, receipt: null });
  const [credit, setCredit] = useState<number | ''>('');
  const [points, setPoints] = useState<number | ''>('');
  const [rx, setRx] = useState('');
  const [pharmacist, setPharmacist] = useState({ username: '', password: '' });
  const [supervisor, setSupervisor] = useState({ username: '', password: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [clientRef] = useState(newClientRef);
  const confirmations = useQuery({ queryKey: ['/pos/mpesa/confirmations'], queryFn: () => api<{ id: string; receiptNo: string; amount: number; phone: string | null; payerName: string | null }[]>('/pos/mpesa/confirmations'), enabled: online, refetchInterval: 10_000 });

  // Poll an STK push until the customer answers.
  useEffect(() => {
    if (!mpesa.txnId || mpesa.status !== 'PENDING') return;
    const t = setInterval(async () => {
      try {
        const s = await api<{ status: string; receiptNo: string | null; resultDesc: string | null }>(`/pos/mpesa/${mpesa.txnId}`);
        if (s.status !== 'PENDING') {
          setMpesa((m) => ({ ...m, status: s.status, receipt: s.receiptNo }));
          if (s.status !== 'SUCCESS') notify.error(`M-Pesa: ${s.resultDesc ?? s.status}`);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [mpesa.txnId, mpesa.status, notify]);

  const loyaltyValue = quote?.loyalty?.value ?? 0;
  const paid = Number(cash || 0) + Number(card.amount || 0) + Number(mpesa.amount || 0) + Number(credit || 0) + loyaltyValue;
  const change = Math.max(0, Math.round((paid - total) * 100) / 100);
  const stk = async () => {
    try {
      const t = await api<{ id: string; status: string; receiptNo: string | null }>('/pos/mpesa/stk', { method: 'POST', body: { terminalId, phone: mpesa.phone, amount: Number(mpesa.amount) } });
      setMpesa((m) => ({ ...m, txnId: t.id, status: t.status, receipt: t.receiptNo }));
    } catch (e) {
      notify.error((e as Error).message);
    }
  };

  const payments = (): Payment[] => [
    ...(cash ? [{ modeCode: 'CASH', amount: Number(cash) }] : []),
    ...(card.amount ? [{ modeCode: 'CARD', amount: Number(card.amount), reference: card.reference || undefined }] : []),
    ...(mpesa.amount ? [{ modeCode: 'MPESA', amount: Number(mpesa.amount), ...(mpesa.txnId && mpesa.status === 'SUCCESS' ? { mpesaTransactionId: mpesa.txnId } : { reference: mpesa.code || undefined }) }] : []),
    ...(credit ? [{ modeCode: 'CREDIT', amount: Number(credit) }] : []),
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const sale = {
      terminalId,
      clientRef,
      soldAt: new Date().toISOString(),
      customerId: customer?.id,
      lines: basket.map((b) => ({ itemId: b.item.itemId, quantity: b.quantity, discountPercent: b.discountPercent || undefined })),
      payments: payments(),
      prescriptionRef: rx || undefined,
      voidedLines: voided.length ? voided : undefined,
    };
    const keepOffline = () => {
      const blocked = basket.map((b) => offlineBlock(b.item, props.canApprove)).filter(Boolean);
      if (blocked.length) return notify.error(blocked.join('; '));
      if (sale.payments.some((p) => p.mpesaTransactionId)) return notify.error('The M-Pesa prompt needs a connection: take the code the customer received');
      const queued: QueuedSale = { ...sale, offline: true, display: { total, lines: basket.map((b) => ({ name: b.item.name, quantity: b.quantity, amount: lineAmount(b.item.price, b.quantity, Math.min(100, b.discountPercent + (b.item.promotion?.percent ?? 0))) })) } };
      if (!enqueue(queued)) return notify.error('This browser could not keep the sale (storage full or blocked)');
      props.onOffline();
      props.onDone({ offline: queued });
    };
    try {
      if (!online) return keepOffline();
      const r = await api<SaleResult>('/pos/sales', {
        method: 'POST',
        body: {
          ...sale,
          redeemPoints: points ? Number(points) : undefined,
          pharmacist: pharmacist.username ? pharmacist : undefined,
          supervisor: supervisor.username ? supervisor : undefined,
          interactionOverrideReason: reason || undefined,
        },
      });
      props.onDone(r);
    } catch (err) {
      if (isOffline(err)) keepOffline();
      else notify.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needs = quote?.needs;
  return (
    <FormDialog open title={`Payment — ${money(total)}`} submitLabel={online ? 'Complete sale' : 'Complete (offline)'} maxWidth="md" onClose={props.onClose} submitting={busy} onSubmit={submit}>
      {!online && <Alert severity="warning">Offline: the sale is kept on this till and sent (once) when the connection is back. The receipt is not an eTIMS receipt until then.</Alert>}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
        <TextField label="Cash tendered" type="number" value={cash} onChange={(e) => setCash(e.target.value === '' ? '' : Number(e.target.value))} autoFocus />
        <TextField label="Card amount" type="number" value={card.amount} onChange={(e) => setCard({ ...card, amount: e.target.value === '' ? '' : Number(e.target.value) })} />
        {card.amount !== '' && <TextField label="Card slip no." value={card.reference} onChange={(e) => setCard({ ...card, reference: e.target.value })} />}
      </Stack>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center">
        <TextField label="M-Pesa amount" type="number" value={mpesa.amount} onChange={(e) => setMpesa({ ...mpesa, amount: e.target.value === '' ? '' : Number(e.target.value) })} />
        {online && <TextField label="Customer phone" value={mpesa.phone} onChange={(e) => setMpesa({ ...mpesa, phone: e.target.value })} />}
        {online && <Button onClick={() => void stk()} disabled={!mpesa.phone || !mpesa.amount || mpesa.status === 'PENDING'}>Send prompt</Button>}
        <TextField label="or M-Pesa code" value={mpesa.code} onChange={(e) => setMpesa({ ...mpesa, code: e.target.value.toUpperCase() })} />
      </Stack>
      {mpesa.status && <Alert severity={mpesa.status === 'SUCCESS' ? 'success' : mpesa.status === 'PENDING' ? 'info' : 'error'}>M-Pesa: {mpesa.status === 'PENDING' ? 'waiting for the customer to enter their PIN…' : `${humanise(mpesa.status)}${mpesa.receipt ? ` · ${mpesa.receipt}` : ''}`}</Alert>}
      {online && (confirmations.data ?? []).length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="caption">Paid to the till:</Typography>
          {confirmations.data!.slice(0, 6).map((c) => <Chip key={c.id} size="small" label={`${c.receiptNo} · ${money(c.amount)}${c.payerName ? ` · ${c.payerName}` : ''}`} onClick={() => setMpesa({ ...mpesa, code: c.receiptNo, amount: c.amount })} />)}
        </Stack>
      )}
      {customer?.creditAllowed && <TextField label="On account" type="number" value={credit} onChange={(e) => setCredit(e.target.value === '' ? '' : Number(e.target.value))} />}
      {customer && online && <TextField label={`Redeem points (has ${customer.loyaltyPoints})`} type="number" value={points} onChange={(e) => setPoints(e.target.value === '' ? '' : Number(e.target.value))} helperText="Applied when the sale completes" />}
      {(needs?.pharmacist || needs?.prescription) && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack spacing={1}>
            <Typography variant="subtitle2">Pharmacist approval</Typography>
            {needs.prescription && <TextField label="Prescription reference" value={rx} onChange={(e) => setRx(e.target.value)} required />}
            {needs.interactionReason && <TextField label="Reason to proceed despite the interaction" value={reason} onChange={(e) => setReason(e.target.value)} required />}
            {!props.canApprove && (
              <Stack direction="row" spacing={1}>
                <TextField label="Pharmacist username" value={pharmacist.username} onChange={(e) => setPharmacist({ ...pharmacist, username: e.target.value })} />
                <TextField label="Password" type="password" value={pharmacist.password} onChange={(e) => setPharmacist({ ...pharmacist, password: e.target.value })} />
              </Stack>
            )}
          </Stack>
        </Paper>
      )}
      {needs?.supervisor && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" gutterBottom>Discount above your limit ({quote?.maxDiscountPercent}%): supervisor</Typography>
          <Stack direction="row" spacing={1}>
            <TextField label="Supervisor username" value={supervisor.username} onChange={(e) => setSupervisor({ ...supervisor, username: e.target.value })} />
            <TextField label="Password" type="password" value={supervisor.password} onChange={(e) => setSupervisor({ ...supervisor, password: e.target.value })} />
          </Stack>
        </Paper>
      )}
      <Typography variant="h6">Paid {money(paid)} · {paid + 0.001 >= total ? `Change ${money(change)}` : `Still due ${money(total - paid)}`}</Typography>
    </FormDialog>
  );
}

function ReceiptDialog({ result, onClose }: { result: SaleResult | { offline: QueuedSale }; onClose(): void }) {
  const money = useMoney();
  const offline = 'offline' in result;
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{offline ? 'Sale kept offline' : `Sale ${result.invoice.number}`}</DialogTitle>
      <DialogContent dividers>
        {offline ? (
          <Stack spacing={1}>
            <Alert severity="warning">eTIMS PENDING — THIS IS NOT AN OFFICIAL RECEIPT. The tax invoice is issued when the till is back online.</Alert>
            {result.offline.display?.lines.map((l, i) => <Typography key={i} variant="body2">{l.quantity} × {l.name} — {money(l.amount)}</Typography>)}
            <Typography variant="h6">{money(result.offline.display?.total ?? 0)}</Typography>
          </Stack>
        ) : (
          <Stack spacing={1}>
            <Typography variant="h5">Change {money(result.change)}</Typography>
            <Typography variant="body2">Total {money(result.total)} · eTIMS {humanise(result.invoice.etimsStatus)}{result.invoice.cuInvoiceNo ? ` · ${result.invoice.cuInvoiceNo}` : ''}</Typography>
            {result.warnings.map((w) => <Alert key={w} severity="info">{w}</Alert>)}
            <Link href={`${API_BASE}/billing/invoices/${result.invoice.id}/receipt?layout=THERMAL`} target="_blank" rel="noopener">Print receipt</Link>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {offline && <Button onClick={() => window.print()}>Print</Button>}
        <Button variant="contained" onClick={onClose} autoFocus>Next customer</Button>
      </DialogActions>
    </Dialog>
  );
}

function OpenShiftDialog({ terminalId, onClose }: { terminalId: string; onClose(): void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const [float, setFloat] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog open title="Open shift" submitLabel="Open" onClose={onClose} submitting={busy} onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await api('/pos/shifts', { method: 'POST', body: { terminalId, openingFloat: Number(float || 0) } });
        await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/pos/shifts') });
        onClose();
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <TextField label="Opening float (cash in the drawer)" type="number" value={float} onChange={(e) => setFloat(e.target.value === '' ? '' : Number(e.target.value))} autoFocus required />
    </FormDialog>
  );
}

const DENOMINATIONS = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1];

function CloseShiftDialog({ shift, onClose }: { shift: Shift; onClose(): void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const money = useMoney();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [z, setZ] = useState<Shift | null>(null);
  const counted = useMemo(() => Object.entries(counts).reduce((s, [d, n]) => s + Number(d) * (n || 0), 0), [counts]);
  if (z) return <ShiftReportDialog shiftId={z.id} onClose={onClose} />;
  return (
    <FormDialog open title={`Cash up ${shift.number}`} submitLabel="Close shift (Z report)" onClose={onClose} submitting={busy} onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const r = await api<Shift>(`/pos/shifts/${shift.id}/close`, { method: 'POST', body: { countedCash: counted, denominations: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), note: note || undefined } });
        await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/pos/shifts') });
        setZ(r);
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <Typography variant="body2">Count the drawer. The expected amount is shown on the Z report after closing.</Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
        {DENOMINATIONS.map((d) => (
          <TextField key={d} label={`${d} ×`} type="number" size="small" value={counts[d] ?? ''} onChange={(e) => setCounts({ ...counts, [d]: Number(e.target.value) })} sx={{ width: 100 }} />
        ))}
      </Stack>
      <Typography variant="h6">Counted {money(counted)}</Typography>
      <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
    </FormDialog>
  );
}

export function ShiftReportDialog({ shiftId, onClose }: { shiftId: string; onClose(): void }) {
  const money = useMoney();
  const { data } = useQuery({ queryKey: ['/pos/shifts', shiftId], queryFn: () => api<Shift & { report: ShiftReport; cashierName: string }>(`/pos/shifts/${shiftId}`) });
  const r = data?.report;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{data?.status === 'CLOSED' ? 'Z report' : 'X report'} {data?.number}</DialogTitle>
      <DialogContent dividers>
        {r && (
          <Stack spacing={1}>
            <Typography variant="body2">{data?.cashierName} · float {money(r.openingFloat)} · {r.sales.count} sales ({r.sales.offline} offline) · discounts {money(r.sales.discounts)}</Typography>
            <Table size="small">
              <TableBody>
                {r.byMode.map((m) => <TableRow key={m.mode}><TableCell>{humanise(m.mode)}</TableCell><TableCell align="right">{m.sales}</TableCell><TableCell align="right">{money(m.amount)}</TableCell></TableRow>)}
                <TableRow><TableCell>Voids</TableCell><TableCell align="right">{r.voids.count}</TableCell><TableCell align="right">−{money(r.voids.amount)}</TableCell></TableRow>
                <TableRow><TableCell>Refunds</TableCell><TableCell align="right">{r.refunds.count}</TableCell><TableCell align="right">−{money(r.refunds.amount)}</TableCell></TableRow>
                <TableRow><TableCell>Payments on account</TableCell><TableCell align="right">{r.accountPayments.count}</TableCell><TableCell align="right">{money(r.accountPayments.amount)}</TableCell></TableRow>
                <TableRow><TableCell><strong>Expected cash</strong></TableCell><TableCell /><TableCell align="right"><strong>{money(r.expectedCash)}</strong></TableCell></TableRow>
                {r.countedCash !== undefined && <TableRow><TableCell>Counted</TableCell><TableCell /><TableCell align="right">{money(r.countedCash)}</TableCell></TableRow>}
                {r.variance !== undefined && <TableRow><TableCell>Variance</TableCell><TableCell /><TableCell align="right">{money(r.variance)}</TableCell></TableRow>}
              </TableBody>
            </Table>
            <Typography variant="caption">Line voids {r.voids.lineVoids} · discount overrides {r.overrides.discounts} · pharmacist approvals {r.overrides.pharmacist} · interaction overrides {r.overrides.interactions}</Typography>
            {r.unverifiedMpesa.length > 0 && <Alert severity="warning">M-Pesa codes not yet confirmed by Safaricom: {r.unverifiedMpesa.map((u) => `${u.receiptNo} (${money(u.amount)})`).join(', ')}</Alert>}
            {data?.varianceStatus === 'PENDING' && <Alert severity="warning">The variance is outside the tolerance and waits for a supervisor.</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => window.print()}>Print</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function ShiftSalesDialog({ shiftId, terminalId, onClose }: { shiftId: string; terminalId: string; onClose(): void }) {
  const { can } = useAuth();
  const money = useMoney();
  const notify = useNotify();
  const qc = useQueryClient();
  const sales = useQuery({ queryKey: ['/pos/shifts', shiftId, 'sales'], queryFn: () => api<{ id: string; status: string; total: number; soldAt: string; invoiceNo: string; etimsStatus: string; customer: string | null; offline: boolean }[]>(`/pos/shifts/${shiftId}/sales`) });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sup, setSup] = useState({ username: '', password: '' });
  const [qty, setQty] = useState<Record<string, number>>({});
  const detail = useQuery({ queryKey: ['/pos/sales', refunding], queryFn: () => api<{ invoice: { lines: { id: string; description: string; quantity: number }[] } }>(`/pos/sales/${refunding}`), enabled: !!refunding });
  const done = async () => {
    setVoiding(null);
    setRefunding(null);
    setReason('');
    await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/pos') });
  };
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Sales this shift</DialogTitle>
      <DialogContent dividers>
        <Table size="small">
          <TableHead><TableRow><TableCell>Time</TableCell><TableCell>Invoice</TableCell><TableCell>Customer</TableCell><TableCell align="right">Total</TableCell><TableCell>Status</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {(sales.data ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{new Date(s.soldAt).toLocaleTimeString()}{s.offline && <Chip size="small" label="offline" sx={{ ml: 1 }} />}</TableCell>
                <TableCell>{s.invoiceNo}</TableCell>
                <TableCell>{s.customer ?? ''}</TableCell>
                <TableCell align="right">{money(s.total)}</TableCell>
                <TableCell>{humanise(s.status)}</TableCell>
                <TableCell>
                  {s.status === 'COMPLETED' && <Button size="small" onClick={() => setVoiding(s.id)}>Void</Button>}
                  {can(P.POS_REFUND) && (s.status === 'COMPLETED' || s.status === 'PARTLY_REFUNDED') && <Button size="small" onClick={() => setRefunding(s.id)}>Refund</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {(voiding || refunding) && (
          <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{voiding ? 'Void the sale (full credit note, stock back)' : 'Refund (credit note)'}</Typography>
              {refunding && detail.data?.invoice.lines.map((l) => (
                <TextField key={l.id} size="small" type="number" label={`${l.description} (of ${l.quantity})`} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: Math.min(l.quantity, Number(e.target.value)) })} />
              ))}
              <TextField size="small" label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              {voiding && !can(P.POS_VOID) && (
                <Stack direction="row" spacing={1}>
                  <TextField size="small" label="Supervisor username" value={sup.username} onChange={(e) => setSup({ ...sup, username: e.target.value })} />
                  <TextField size="small" label="Password" type="password" value={sup.password} onChange={(e) => setSup({ ...sup, password: e.target.value })} />
                </Stack>
              )}
              <Box>
                <Button variant="contained" color="warning" disabled={reason.trim().length < 3} onClick={async () => {
                  try {
                    if (voiding) await api(`/pos/sales/${voiding}/void`, { method: 'POST', body: { reason, supervisor: sup.username ? sup : undefined } });
                    else await api(`/pos/sales/${refunding}/refund`, { method: 'POST', body: { reason, terminalId, lines: Object.entries(qty).filter(([, q]) => q > 0).map(([invoiceLineId, quantity]) => ({ invoiceLineId, quantity })) } });
                    notify.success(voiding ? 'Sale voided' : 'Refunded');
                    await done();
                  } catch (err) {
                    notify.error((err as Error).message);
                  }
                }}>{voiding ? 'Void sale' : 'Refund'}</Button>
              </Box>
            </Stack>
          </Paper>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

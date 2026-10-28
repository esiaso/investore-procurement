import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
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
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Permissions, PurchaseLineType, RfqStatus } from '@sil/shared';
import { API_BASE, api } from '../api/client';
import { useApiMutation, usePaged } from '../api/hooks';
import type { Comparison, Rfq, Supplier, SupplierEvaluation } from '../api/purchasing-types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { formatMoney, humanise } from '../lib/format';
import { DetailLayout, DocumentChain, useDate, useMoney } from './common';

type DirectoryUser = { id: string; username: string; fullName: string };
type RfqLineView = NonNullable<Rfq['lines']>[number];

const lineName = (l: RfqLineView) => l.item?.name ?? l.description ?? '';
const isNonStock = (lineType?: string) => !!lineType && lineType !== PurchaseLineType.STOCK;
/** Bidding has closed: the comparison may be evaluated and awarded. */
const AWARDABLE = [RfqStatus.EVALUATION, RfqStatus.CLOSED, RfqStatus.EVALUATED] as string[];

function QuotationDialog({ rfq, suppliers, onClose }: { rfq: Rfq; suppliers: Supplier[]; onClose(): void }) {
  const [supplierId, setSupplierId] = useState('');
  const [currency, setCurrency] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [paymentTermsDays, setPaymentTermsDays] = useState('');
  const [compliant, setCompliant] = useState(true);
  const [notes, setNotes] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const currencies = useQuery({ queryKey: ['/currencies'], queryFn: () => api<{ code: string; name: string }[]>('/currencies') });
  const save = useApiMutation<void>(
    () => [
      `/rfqs/${rfq.id}/quotations`,
      {
        method: 'POST',
        body: {
          supplierId,
          currency: currency || undefined,
          deliveryDays: deliveryDays ? Number(deliveryDays) : undefined,
          paymentTermsDays: paymentTermsDays ? Number(paymentTermsDays) : undefined,
          compliant,
          complianceNotes: notes || undefined,
          lines: Object.entries(prices).filter(([, v]) => v !== '').map(([rfqLineId, v]) => ({ rfqLineId, unitPrice: Number(v) })),
        },
      },
    ],
    { invalidate: ['/rfqs'], success: 'Quotation recorded' },
  );
  return (
    <FormDialog open maxWidth="md" title="Record a quotation" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} sx={{ minWidth: 200, width: 'auto' }}>
          {suppliers.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
        <TextField select label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} sx={{ minWidth: 140, width: 'auto' }} helperText="Blank: base currency">
          <MenuItem value="">Base currency</MenuItem>
          {(currencies.data ?? []).map((c) => <MenuItem key={c.code} value={c.code}>{c.code}</MenuItem>)}
        </TextField>
        <TextField label="Delivery (days)" type="number" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} />
        <TextField label="Payment terms (days)" type="number" value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} />
      </Stack>
      <FormControlLabel control={<Checkbox checked={compliant} onChange={(e) => setCompliant(e.target.checked)} />} label="Compliant (documents, registration, specifications)" />
      {!compliant && <TextField label="Why not compliant" value={notes} onChange={(e) => setNotes(e.target.value)} />}
      <Typography variant="subtitle2">Unit prices excl. VAT, in the quotation currency (leave blank if not quoted)</Typography>
      {(rfq.lines ?? []).map((l) => (
        <Stack key={l.id} direction="row" spacing={1} alignItems="center">
          <Typography sx={{ flexGrow: 1 }}>
            {lineName(l)} × {l.quantity} {l.uom?.code ?? ''}
            {isNonStock(l.lineType) && <Chip size="small" variant="outlined" label={humanise(l.lineType!)} sx={{ ml: 1 }} />}
          </Typography>
          <TextField label="Unit price" type="number" value={prices[l.id] ?? ''} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} sx={{ width: 160 }} slotProps={{ htmlInput: { step: 'any', 'aria-label': `Unit price for ${lineName(l)}` } }} />
        </Stack>
      ))}
    </FormDialog>
  );
}

function SendDialog({ rfq, onClose }: { rfq: Rfq; onClose(): void }) {
  const [justification, setJustification] = useState('');
  const send = useApiMutation<void>(() => [`/rfqs/${rfq.id}/send`, { method: 'POST', body: { fewerSuppliersJustification: justification || undefined } }], {
    invalidate: ['/rfqs'],
    success: 'Invitations queued by email',
  });
  return (
    <FormDialog open title="Send invitations" submitLabel="Send" onClose={onClose} submitting={send.isPending} onSubmit={(e) => { e.preventDefault(); send.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">Each invited supplier receives the RFQ by email with the PDF attached ({rfq.supplierIds.length} invited).</Typography>
      <TextField label="Why fewer suppliers than the minimum (if so)" value={justification} onChange={(e) => setJustification(e.target.value)} multiline minRows={2} helperText="Required by policy when fewer suppliers are invited than the configured minimum" />
    </FormDialog>
  );
}

function EvaluationSetupDialog({ rfq, users, onClose }: { rfq: Rfq; users: DirectoryUser[]; onClose(): void }) {
  const [weight, setWeight] = useState(String(rfq.technicalWeight ?? 0));
  const [passMark, setPassMark] = useState(String(rfq.passMark ?? 70));
  const [committee, setCommittee] = useState<DirectoryUser[]>(users.filter((u) => rfq.committeeUserIds?.includes(u.id)));
  const save = useApiMutation<void>(
    () => [`/rfqs/${rfq.id}/evaluation`, { method: 'PUT', body: { technicalWeight: Number(weight), passMark: Number(passMark), committeeUserIds: committee.map((u) => u.id) } }],
    { invalidate: ['/rfqs'], success: 'Evaluation set up' },
  );
  return (
    <FormDialog open title="Evaluation set-up" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2" color="text.secondary">
        Combined score = technical × weight + financial × (100 − weight). Financial = lowest compliant total ÷ this total × 100. With a weight of 0 the award is on price alone.
      </Typography>
      <Stack direction="row" spacing={2}>
        <TextField label="Technical weight (%)" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} slotProps={{ htmlInput: { min: 0, max: 100 } }} />
        <TextField label="Technical pass mark" type="number" value={passMark} onChange={(e) => setPassMark(e.target.value)} slotProps={{ htmlInput: { min: 0, max: 100 } }} />
      </Stack>
      <Autocomplete
        multiple
        options={users}
        value={committee}
        onChange={(_e, v) => setCommittee(v)}
        getOptionLabel={(u) => `${u.fullName} (${u.username})`}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        renderInput={(p) => <TextField {...p} label="Evaluation committee" helperText={Number(weight) > 0 ? 'Every member scores every compliant quotation' : undefined} />}
      />
    </FormDialog>
  );
}

/** A committee member's technical scores, one per compliant quotation. */
function ScoringPanel({ rfq, suppliers, memberId }: { rfq: Rfq; suppliers: SupplierEvaluation[]; memberId: string }) {
  const [draft, setDraft] = useState<Record<string, { score: string; comment: string }>>({});
  const score = useApiMutation<{ quotationId: string; technicalScore: number; comment?: string }>(
    (body) => [`/rfqs/${rfq.id}/scores`, { method: 'POST', body }],
    { invalidate: ['/rfqs'], success: 'Score saved' },
  );
  const compliant = suppliers.filter((s) => s.compliant);
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Your technical scores</Typography>
      <Stack spacing={1}>
        {compliant.map((s) => {
          const mine = s.scores.find((x) => x.memberId === memberId);
          const d = draft[s.quotationId] ?? { score: mine ? String(mine.technicalScore) : '', comment: mine?.comment ?? '' };
          const set = (patch: Partial<typeof d>) => setDraft({ ...draft, [s.quotationId]: { ...d, ...patch } });
          return (
            <Stack key={s.quotationId} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              <Typography sx={{ minWidth: 180 }}>{s.supplierName}</Typography>
              <TextField size="small" label="Score (0–100)" type="number" value={d.score} onChange={(e) => set({ score: e.target.value })} sx={{ width: 140 }} slotProps={{ htmlInput: { min: 0, max: 100, 'aria-label': `Technical score for ${s.supplierName}` } }} />
              <TextField size="small" label="Comment" value={d.comment} onChange={(e) => set({ comment: e.target.value })} sx={{ flexGrow: 1 }} />
              <Button disabled={d.score === '' || score.isPending} onClick={() => score.mutate({ quotationId: s.quotationId, technicalScore: Number(d.score), comment: d.comment || undefined })}>
                {mine ? 'Update' : 'Save'}
              </Button>
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}

function EvaluateDialog({ rfq, recommended, onClose }: { rfq: Rfq; recommended?: SupplierEvaluation; onClose(): void }) {
  const [recommendation, setRecommendation] = useState(recommended ? `Recommend ${recommended.supplierName}` : '');
  const evaluate = useApiMutation<void>(() => [`/rfqs/${rfq.id}/evaluate`, { method: 'POST', body: { recommendation } }], { invalidate: ['/rfqs'], success: 'Evaluation complete' });
  return (
    <FormDialog open title="Complete the evaluation" onClose={onClose} submitting={evaluate.isPending} onSubmit={(e) => { e.preventDefault(); evaluate.mutate(undefined, { onSuccess: onClose }); }}>
      {recommended ? <Alert severity="success">Highest score: {recommended.supplierName}</Alert> : <Alert severity="warning">No quotation qualifies for a recommendation.</Alert>}
      <TextField label="Committee recommendation" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} multiline minRows={3} required />
    </FormDialog>
  );
}

/** Technical, financial and combined scores per supplier. */
export function EvaluationSummary({ rfq, suppliers, users }: { rfq: Rfq; suppliers: SupplierEvaluation[]; users: DirectoryUser[] }) {
  const money = useMoney();
  const weighted = rfq.technicalWeight > 0;
  const name = (id: string) => users.find((u) => u.id === id)?.fullName ?? 'Member';
  return (
    <Paper sx={{ p: 2, overflowX: 'auto' }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Evaluation {weighted ? `(technical ${rfq.technicalWeight}% · pass mark ${rfq.passMark})` : '(price only)'}
      </Typography>
      <Table size="small" aria-label="Evaluation">
        <TableHead>
          <TableRow>
            <TableCell>Supplier</TableCell>
            <TableCell align="right">Quoted</TableCell>
            <TableCell align="right">Total (base)</TableCell>
            {weighted && <TableCell align="right">Technical</TableCell>}
            <TableCell align="right">Financial</TableCell>
            {weighted && <TableCell align="right">Combined</TableCell>}
            <TableCell align="right">Rank</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {suppliers.map((s) => (
            <TableRow key={s.supplierId} sx={{ opacity: s.compliant ? 1 : 0.6 }}>
              <TableCell>
                {s.supplierName} {s.recommended && <Chip size="small" color="success" label="Recommended" />}
                {!s.compliant && <Chip size="small" variant="outlined" label="Not compliant" sx={{ ml: 0.5 }} />}
                {weighted && s.compliant && s.technicalScore != null && !s.passes && <Chip size="small" color="warning" variant="outlined" label="Below pass mark" sx={{ ml: 0.5 }} />}
                {s.scores.length > 0 && (
                  <Box sx={{ fontSize: 11, color: 'text.secondary' }}>{s.scores.map((x) => `${name(x.memberId)}: ${x.technicalScore}${x.comment ? ` (${x.comment})` : ''}`).join(' · ')}</Box>
                )}
              </TableCell>
              <TableCell align="right">{s.currency ? formatMoney(s.quotedTotal, s.currency) : '—'}</TableCell>
              <TableCell align="right">{money(s.total)}</TableCell>
              {weighted && <TableCell align="right">{s.technicalScore ?? '—'}</TableCell>}
              <TableCell align="right">{s.financialScore ?? '—'}</TableCell>
              {weighted && <TableCell align="right"><b>{s.combinedScore ?? '—'}</b></TableCell>}
              <TableCell align="right">{s.rank ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rfq.recommendation && <Alert severity="info" sx={{ mt: 2 }}>Committee recommendation: {rfq.recommendation}</Alert>}
    </Paper>
  );
}

/** Comparative analysis sheet with award selection. */
export function ComparativeSheet({ rfq, comparison, canAward }: { rfq: Rfq; comparison: Comparison; canAward: boolean }) {
  const money = useMoney();
  const navigate = useNavigate();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  useEffect(() => {
    // Default: the recommended supplier where the evaluation named one, else the lowest compliant quote per line.
    const rec = rfq.recommendedSupplierId;
    setChoice(
      Object.fromEntries(
        comparison.lines.map((l) => [l.rfqLineId, (rec && l.quotes.find((q) => q.supplierId === rec)?.quotationLineId) || l.quotes.find((q) => q.lowestCompliant)?.quotationLineId || '']),
      ),
    );
  }, [comparison, rfq.recommendedSupplierId]);
  const deviates = comparison.lines.some((l) => choice[l.rfqLineId] && !l.quotes.find((q) => q.quotationLineId === choice[l.rfqLineId])?.lowestCompliant);
  const nonStock = comparison.lines.some((l) => isNonStock(l.lineType));
  const award = useApiMutation<void, { purchaseOrderIds: string[] }>(
    () => [
      `/rfqs/${rfq.id}/award`,
      {
        method: 'POST',
        body: {
          awards: Object.entries(choice).filter(([, v]) => v).map(([rfqLineId, quotationLineId]) => ({ rfqLineId, quotationLineId })),
          justification: justification || undefined,
          expectedDelivery: expectedDelivery || null,
          deliveryAddress: deliveryAddress || undefined,
        },
      },
    ],
    { invalidate: ['/rfqs', '/purchase-orders', '/requisitions', '/documents'], success: 'Awarded: draft order(s) created' },
  );
  const suppliers = comparison.suppliers;
  const needsEvaluation = rfq.technicalWeight > 0 && rfq.status !== RfqStatus.EVALUATED;
  const awarding = AWARDABLE.includes(rfq.status) && canAward && !needsEvaluation;
  return (
    <Paper sx={{ p: 2, overflowX: 'auto' }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Comparative analysis
      </Typography>
      <Table size="small" aria-label="Comparative analysis">
        <TableHead>
          <TableRow>
            <TableCell>Item / service</TableCell>
            <TableCell align="right">Qty</TableCell>
            {suppliers.map((s) => (
              <TableCell key={s.supplierId} align="right">
                <Box fontWeight={600}>{s.supplierName}</Box>
                <Box sx={{ fontSize: 11, color: 'text.secondary' }}>
                  {s.deliveryDays != null ? `${s.deliveryDays} days` : '—'} · {s.compliant ? 'compliant' : 'not compliant'}
                  {s.currency ? ` · ${s.currency}` : ''}
                  {s.paymentTermsDays != null ? ` · ${s.paymentTermsDays}-day terms` : ''}
                </Box>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {comparison.lines.map((l) => (
            <TableRow key={l.rfqLineId}>
              <TableCell>
                {l.itemName}
                {isNonStock(l.lineType) && <Chip size="small" variant="outlined" label={humanise(l.lineType!)} sx={{ ml: 1 }} />}
              </TableCell>
              <TableCell align="right">{l.quantity} {l.uom ?? ''}</TableCell>
              {suppliers.map((s) => {
                const q = l.quotes.find((x) => x.supplierId === s.supplierId);
                if (!q) return <TableCell key={s.supplierId} align="right">—</TableCell>;
                const awarded = l.awardedQuotationLineId === q.quotationLineId;
                return (
                  <TableCell key={s.supplierId} align="right" sx={{ bgcolor: q.lowestCompliant ? 'rgba(46, 125, 50, 0.08)' : undefined, opacity: q.compliant ? 1 : 0.6 }}>
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                      {awarding && (
                        <Radio size="small" checked={choice[l.rfqLineId] === q.quotationLineId} onChange={() => setChoice({ ...choice, [l.rfqLineId]: q.quotationLineId })} inputProps={{ 'aria-label': `Award ${l.itemName} to ${s.supplierName}` }} />
                      )}
                      <Box>
                        <Box>{money(q.unitPrice)}</Box>
                        {q.currency && <Box sx={{ fontSize: 11, color: 'text.secondary' }}>{formatMoney(q.quotedUnitPrice, q.currency)}</Box>}
                        <Box sx={{ fontSize: 11 }}>{money(q.lineTotal)}</Box>
                      </Box>
                      {q.lowestCompliant && <Chip size="small" color="success" label="Lowest" />}
                      {awarded && <Chip size="small" color="primary" label="Awarded" />}
                    </Stack>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={2}><b>Total (base currency)</b></TableCell>
            {suppliers.map((s) => (
              <TableCell key={s.supplierId} align="right">
                <b>{money(s.total)}</b>
                <Box sx={{ fontSize: 11 }}>lowest on {s.lowestOnLines} line(s)</Box>
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
      {suppliers.filter((s) => !s.compliant && s.complianceNotes).map((s) => (
        <Typography key={s.supplierId} variant="body2" color="text.secondary">{s.supplierName}: {s.complianceNotes}</Typography>
      ))}
      {canAward && needsEvaluation && AWARDABLE.includes(rfq.status) && <Alert severity="info" sx={{ mt: 2 }}>Complete the technical evaluation before awarding.</Alert>}
      {awarding && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          {deviates && <Alert severity="warning">At least one line is not awarded to the lowest compliant quote: a justification is required.</Alert>}
          <TextField label="Award justification" value={justification} onChange={(e) => setJustification(e.target.value)} multiline minRows={2} required={deviates} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Expected delivery" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 220 }} />
            {nonStock && <TextField label="Delivery address / site" value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} sx={{ flexGrow: 1 }} />}
          </Stack>
          <Box>
            <Button variant="contained" disabled={award.isPending || (deviates && !justification)} onClick={() => award.mutate(undefined, { onSuccess: (r) => r.purchaseOrderIds[0] && navigate(`/purchase-orders/${r.purchaseOrderIds[0]}`) })}>
              Award and create orders
            </Button>
          </Box>
        </Stack>
      )}
      {rfq.awardJustification && <Alert severity="info" sx={{ mt: 2 }}>Award justification: {rfq.awardJustification}</Alert>}
    </Paper>
  );
}

export function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const date = useDate();
  const [dialog, setDialog] = useState<'quote' | 'send' | 'setup' | 'evaluate' | null>(null);
  const { data: rfq } = useQuery({ queryKey: ['/rfqs', id], queryFn: () => api<Rfq>(`/rfqs/${id}`) });
  const comparison = useQuery({ queryKey: ['/rfqs', id, 'comparison'], queryFn: () => api<Comparison>(`/rfqs/${id}/comparison`), enabled: !!rfq });
  const supplierList = useQuery({
    queryKey: ['/suppliers', 'byIds', rfq?.supplierIds],
    queryFn: async () => Promise.all(rfq!.supplierIds.map((s) => api<Supplier>(`/suppliers/${s}`))),
    enabled: !!rfq,
  });
  const users = useQuery({ queryKey: ['/users/directory'], queryFn: () => api<DirectoryUser[]>('/users/directory') });
  const close = useApiMutation<void>(() => [`/rfqs/${id}/close`, { method: 'POST' }], { invalidate: ['/rfqs'], success: 'Bidding closed' });
  const cancel = useApiMutation<void>(() => [`/rfqs/${id}/cancel`, { method: 'POST' }], { invalidate: ['/rfqs'], success: 'RFQ cancelled' });
  if (!rfq) return null;
  const manage = can(Permissions.PURCHASING_RFQ);
  const s = rfq.status;
  const evaluation = comparison.data?.suppliers ?? [];
  const scored = evaluation.some((x) => x.scores.length > 0);
  const onCommittee = !!user && (rfq.committeeUserIds ?? []).includes(user.id);
  const committee = (users.data ?? []).filter((u) => (rfq.committeeUserIds ?? []).includes(u.id));
  return (
    <>
      <PageHeader
        title={`RFQ ${rfq.number}`}
        actions={
          <Button startIcon={<PictureAsPdfIcon />} href={`${API_BASE}/rfqs/${rfq.id}/pdf`} target="_blank" rel="noopener">
            PDF
          </Button>
        }
      />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <StatusChip status={s} />
                <Typography>{rfq.title} · closes {date(rfq.closingDate)}</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">Invited: {(supplierList.data ?? []).map((x) => x.name).join(', ')}</Typography>
              {rfq.fewerSuppliersJustification && <Typography variant="body2" color="text.secondary">Fewer suppliers: {rfq.fewerSuppliersJustification}</Typography>}
              <Typography variant="body2" color="text.secondary">
                Evaluation: {rfq.technicalWeight > 0 ? `technical ${rfq.technicalWeight}%, pass mark ${rfq.passMark}` : 'price only'}
                {committee.length > 0 && ` · committee: ${committee.map((u) => u.fullName).join(', ')}`}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                {manage && s === RfqStatus.DRAFT && <Button variant="contained" onClick={() => setDialog('send')}>Send invitations</Button>}
                {manage && [RfqStatus.SENT, RfqStatus.EVALUATION].includes(s as RfqStatus) && <Button variant="outlined" onClick={() => setDialog('quote')}>Record quotation</Button>}
                {manage && [RfqStatus.SENT, RfqStatus.EVALUATION].includes(s as RfqStatus) && evaluation.length > 0 && <Button variant="outlined" onClick={() => close.mutate()}>Close bidding</Button>}
                {manage && !scored && ![RfqStatus.EVALUATED, RfqStatus.AWARDED, RfqStatus.CANCELLED].includes(s as RfqStatus) && <Button onClick={() => setDialog('setup')}>Evaluation set-up</Button>}
                {manage && s === RfqStatus.CLOSED && <Button variant="contained" onClick={() => setDialog('evaluate')}>Complete evaluation</Button>}
                {manage && s !== RfqStatus.AWARDED && s !== RfqStatus.CANCELLED && <Button color="error" onClick={() => cancel.mutate()}>Cancel RFQ</Button>}
              </Stack>
            </Paper>
            {s === RfqStatus.CLOSED && onCommittee && rfq.technicalWeight > 0 && evaluation.length > 0 && user && <ScoringPanel rfq={rfq} suppliers={evaluation} memberId={user.id} />}
            {evaluation.length > 0 && <EvaluationSummary rfq={rfq} suppliers={evaluation} users={users.data ?? []} />}
            {comparison.data && evaluation.length > 0 ? (
              <ComparativeSheet rfq={rfq} comparison={comparison.data} canAward={manage} />
            ) : (
              <Paper sx={{ p: 2 }}><Typography color="text.secondary">No quotations recorded yet.</Typography></Paper>
            )}
          </>
        }
        side={<DocumentChain type="RFQ" id={rfq.id} />}
      />
      {dialog === 'quote' && <QuotationDialog rfq={rfq} suppliers={supplierList.data ?? []} onClose={() => setDialog(null)} />}
      {dialog === 'send' && <SendDialog rfq={rfq} onClose={() => setDialog(null)} />}
      {dialog === 'setup' && <EvaluationSetupDialog rfq={rfq} users={users.data ?? []} onClose={() => setDialog(null)} />}
      {dialog === 'evaluate' && <EvaluateDialog rfq={rfq} recommended={evaluation.find((x) => x.recommended)} onClose={() => setDialog(null)} />}
    </>
  );
}

export function RfqsPage() {
  const navigate = useNavigate();
  const date = useDate();
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const { data, isFetching } = usePaged<Rfq>('/rfqs', { ...pagination });
  const columns: GridColDef<Rfq>[] = [
    { field: 'number', headerName: 'Number', width: 170 },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
    { field: 'supplierIds', headerName: 'Invited', width: 90, valueGetter: (_v, r) => r.supplierIds.length },
    { field: 'closingDate', headerName: 'Closes', width: 110, valueFormatter: (v: string) => date(v) },
    { field: 'status', headerName: 'Status', width: 140, renderCell: ({ value }) => <StatusChip status={value} /> },
  ];
  return (
    <>
      <PageHeader title="Requests for quotation" />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>RFQs are raised from an approved requisition.</Typography>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data?.items ?? []} rowCount={data?.total ?? 0} columns={columns} loading={isFetching} paginationMode="server" paginationModel={pagination} onPaginationModelChange={setPagination} pageSizeOptions={[25, 50]} onRowClick={({ row }) => navigate(`/rfqs/${row.id}`)} disableRowSelectionOnClick />
      </Paper>
    </>
  );
}

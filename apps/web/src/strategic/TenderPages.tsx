import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
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
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { ContractType, Permissions, TenderStatus } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList } from '../api/hooks';
import type { Supplier } from '../api/purchasing-types';
import type { Item } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ItemPicker, StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { ApprovalPanel, DetailLayout, DocumentChain, Field, useDate, useMoney } from '../purchasing/common';
import { useSupplierOptions } from '../purchasing/RequisitionsPages';
import { Criterion, Evaluation, methodLabel, Tender, TenderDetail, useSourcingMethods } from './api';

const TENDER_METHODS = ['OPEN_TENDER', 'RESTRICTED_TENDER', 'RFP'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function useDateTime() {
  const date = useDate();
  return (v: string | null | undefined) => (v ? `${date(v)} ${new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })}` : '');
}

/** Technical weights must add up to 100 when there are technical criteria. */
export function technicalWeightProblem(criteria: { stage: string; weight?: number }[], technicalWeight: number): string | null {
  const tech = criteria.filter((c) => c.stage === 'TECHNICAL');
  if (tech.length) {
    const sum = tech.reduce((s, c) => s + (Number(c.weight) || 0), 0);
    return sum === 100 ? null : `Technical criteria weights add up to ${sum}; they must add up to 100`;
  }
  return technicalWeight > 0 ? 'A technical weight needs technical criteria' : null;
}

// ------------------------------------------------------------------ new tender

export function TenderFormPage() {
  const navigate = useNavigate();
  const methods = useSourcingMethods();
  const suppliers = useSupplierOptions();
  const [form, setForm] = useState({ title: '', description: '', method: 'OPEN_TENDER', estimatedValue: 0, closingAt: `${plusDays(today(), 21)}T10:00`, bidSecurityAmount: 0, technicalWeight: 30, technicalPassMark: 60, justification: '' });
  const [invited, setInvited] = useState<Supplier[]>([]);
  const [lines, setLines] = useState<{ item: Item | null; description: string; quantity: number; specification: string }[]>([{ item: null, description: '', quantity: 1, specification: '' }]);
  const [criteria, setCriteria] = useState<{ stage: 'PRELIMINARY' | 'TECHNICAL'; name: string; weight: number; maxScore: number }[]>([
    { stage: 'PRELIMINARY', name: 'Valid tax compliance certificate', weight: 0, maxScore: 1 },
    { stage: 'PRELIMINARY', name: 'Valid business permit and registration', weight: 0, maxScore: 1 },
    { stage: 'TECHNICAL', name: 'Compliance with specifications', weight: 60, maxScore: 10 },
    { stage: 'TECHNICAL', name: 'Delivery capacity and references', weight: 40, maxScore: 10 },
  ]);
  const problem = technicalWeightProblem(criteria, form.technicalWeight);
  const rule = methods.data?.find((m) => m.code === form.method);
  const save = useApiMutation<void, Tender>(
    () => [
      '/tenders',
      {
        method: 'POST',
        body: {
          ...form,
          description: form.description || undefined,
          justification: form.justification || undefined,
          estimatedValue: Number(form.estimatedValue),
          bidSecurityAmount: Number(form.bidSecurityAmount),
          technicalWeight: Number(form.technicalWeight),
          technicalPassMark: Number(form.technicalPassMark),
          closingAt: new Date(`${form.closingAt}:00+03:00`).toISOString(),
          invitedSupplierIds: form.method === 'OPEN_TENDER' ? [] : invited.map((s) => s.id),
          lines: lines.map((l) => ({ itemId: l.item?.id, description: l.item ? undefined : l.description, quantity: Number(l.quantity), specification: l.specification || undefined })),
          criteria: criteria.map((c) => ({ stage: c.stage, name: c.name, weight: c.stage === 'TECHNICAL' ? Number(c.weight) : undefined, maxScore: c.stage === 'TECHNICAL' ? Number(c.maxScore) : undefined })),
        },
      },
    ],
    { invalidate: ['/tenders'], success: 'Tender created as a draft' },
  );
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setCrit = (i: number, patch: Partial<(typeof criteria)[number]>) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      <PageHeader title="New tender" />
      <Paper sx={{ p: 2 }}>
        <form noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: (t) => navigate(`/tenders/${t.id}`) }); }}>
          <Stack spacing={2}>
            <TextField label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            <TextField label="Description / scope" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={2} />
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <TextField select label="Method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} sx={{ minWidth: 220 }}>
                {TENDER_METHODS.map((m) => <MenuItem key={m} value={m}>{methodLabel(methods.data, m)}</MenuItem>)}
              </TextField>
              <TextField label="Estimated value" type="number" value={form.estimatedValue} onChange={(e) => setForm({ ...form, estimatedValue: Number(e.target.value) })} />
              <TextField label="Closing (Nairobi time)" type="datetime-local" value={form.closingAt} onChange={(e) => setForm({ ...form, closingAt: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField label="Bid security" type="number" value={form.bidSecurityAmount} onChange={(e) => setForm({ ...form, bidSecurityAmount: Number(e.target.value) })} />
            </Stack>
            {rule?.requiresJustification && <TextField label="Justification for the method" value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} required />}
            {form.method !== 'OPEN_TENDER' && (
              <Autocomplete
                multiple
                options={suppliers.data ?? []}
                getOptionLabel={(s) => s.name}
                value={invited}
                onChange={(_, v) => setInvited(v)}
                isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(p) => <TextField {...p} label={`Invited suppliers (at least ${rule?.minBidders ?? 1})`} />}
              />
            )}
            <Typography variant="subtitle2">Lines</Typography>
            {lines.map((l, i) => (
              <Stack key={i} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
                <ItemPicker value={l.item} onChange={(item) => setLine(i, { item })} label="Catalogue item" />
                {!l.item && <TextField label="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />}
                <TextField label="Quantity" type="number" value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} sx={{ width: { md: 120 } }} />
                <TextField label="Specification" value={l.specification} onChange={(e) => setLine(i, { specification: e.target.value })} sx={{ flex: 1 }} />
                <IconButton aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}><DeleteIcon /></IconButton>
              </Stack>
            ))}
            <Box><Button startIcon={<AddIcon />} onClick={() => setLines([...lines, { item: null, description: '', quantity: 1, specification: '' }])}>Add line</Button></Box>
            <Typography variant="subtitle2">Evaluation</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <TextField label="Technical weight in the combined score (%)" type="number" value={form.technicalWeight} onChange={(e) => setForm({ ...form, technicalWeight: Number(e.target.value) })} helperText="0 = lowest evaluated price among qualified bids" />
              <TextField label="Technical pass mark (of 100)" type="number" value={form.technicalPassMark} onChange={(e) => setForm({ ...form, technicalPassMark: Number(e.target.value) })} />
            </Stack>
            {criteria.map((c, i) => (
              <Stack key={i} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
                <TextField select label="Stage" value={c.stage} onChange={(e) => setCrit(i, { stage: e.target.value as 'PRELIMINARY' | 'TECHNICAL' })} sx={{ width: { md: 170 } }}>
                  <MenuItem value="PRELIMINARY">Preliminary (pass/fail)</MenuItem>
                  <MenuItem value="TECHNICAL">Technical (scored)</MenuItem>
                </TextField>
                <TextField label="Criterion" value={c.name} onChange={(e) => setCrit(i, { name: e.target.value })} sx={{ flex: 1 }} />
                {c.stage === 'TECHNICAL' && (
                  <>
                    <TextField label="Weight" type="number" value={c.weight} onChange={(e) => setCrit(i, { weight: Number(e.target.value) })} sx={{ width: { md: 100 } }} />
                    <TextField label="Max score" type="number" value={c.maxScore} onChange={(e) => setCrit(i, { maxScore: Number(e.target.value) })} sx={{ width: { md: 110 } }} />
                  </>
                )}
                <IconButton aria-label={`Remove criterion ${i + 1}`} onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}><DeleteIcon /></IconButton>
              </Stack>
            ))}
            <Box><Button startIcon={<AddIcon />} onClick={() => setCriteria([...criteria, { stage: 'TECHNICAL', name: '', weight: 0, maxScore: 10 }])}>Add criterion</Button></Box>
            {problem && <Alert severity="warning">{problem}</Alert>}
            <Box><Button type="submit" variant="contained" disabled={save.isPending || !!problem}>Save draft</Button></Box>
          </Stack>
        </form>
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ list

export function TendersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useMoney();
  const when = useDateTime();
  const methods = useSourcingMethods();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, isFetching } = useList<Tender>('/tenders', { status: status || undefined, search: q || undefined });
  const columns: GridColDef<Tender>[] = [
    { field: 'number', headerName: 'Number', width: 150 },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 240 },
    { field: 'method', headerName: 'Method', width: 170, valueFormatter: (v: string) => methodLabel(methods.data, v) },
    { field: 'status', headerName: 'Status', width: 150, renderCell: ({ value }) => <StatusChip status={value} /> },
    { field: 'estimatedValue', headerName: 'Estimate', type: 'number', width: 140, valueFormatter: (v: number) => money(v) },
    { field: 'closingAt', headerName: 'Closes', width: 170, valueFormatter: (v: string) => when(v) },
  ];
  return (
    <>
      <PageHeader title="Tenders" search={search} onSearch={setSearch} onNew={can(Permissions.TENDERS_MANAGE) ? () => navigate('/tenders/new') : undefined} newLabel="New tender" />
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: 220 }}>
          <MenuItem value="">All</MenuItem>
          {Object.values(TenderStatus).map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
        </TextField>
      </Stack>
      <Paper>
        <DataGrid autoHeight density="compact" rows={data ?? []} columns={columns} loading={isFetching} onRowClick={({ row }) => navigate(`/tenders/${row.id}`)} disableRowSelectionOnClick pageSizeOptions={[25, 50]} initialState={{ pagination: { paginationModel: { pageSize: 25 } } }} />
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ detail: dialogs

function StaffBidDialog({ t, onClose }: { t: TenderDetail; onClose(): void }) {
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState('');
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ bidSecurityRef: '', bidSecurityAmount: t.bidSecurityAmount, deliveryDays: '' as number | '' });
  const save = useApiMutation<void>(
    () => [`/tenders/${t.id}/bids`, { method: 'POST', body: { supplierId, bidSecurityRef: form.bidSecurityRef || undefined, bidSecurityAmount: Number(form.bidSecurityAmount), deliveryDays: form.deliveryDays === '' ? undefined : Number(form.deliveryDays), lines: (t.lines ?? []).map((l) => ({ tenderLineId: l.id, unitPrice: Number(prices[l.id] ?? 0) })) } }],
    { invalidate: ['/tenders'], success: 'Bid recorded in the register (sealed until opening)' },
  );
  return (
    <FormDialog open title="Record a physical bid" submitLabel="Record bid" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
        {(suppliers.data ?? []).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </TextField>
      {(t.lines ?? []).map((l) => (
        <TextField key={l.id} label={`Unit price: ${l.description} (× ${l.quantity})`} type="number" value={prices[l.id] ?? ''} onChange={(e) => setPrices({ ...prices, [l.id]: Number(e.target.value) })} required />
      ))}
      <Stack direction="row" spacing={2}>
        <TextField label="Bid security ref." value={form.bidSecurityRef} onChange={(e) => setForm({ ...form, bidSecurityRef: e.target.value })} />
        <TextField label="Bid security amount" type="number" value={form.bidSecurityAmount} onChange={(e) => setForm({ ...form, bidSecurityAmount: Number(e.target.value) })} />
        <TextField label="Delivery days" type="number" value={form.deliveryDays} onChange={(e) => setForm({ ...form, deliveryDays: e.target.value === '' ? '' : Number(e.target.value) })} />
      </Stack>
    </FormDialog>
  );
}

function OpenDialog({ t, onClose }: { t: TenderDetail; onClose(): void }) {
  const [attendees, setAttendees] = useState('');
  const [minutes, setMinutes] = useState('');
  const open = useApiMutation<void>(() => [`/tenders/${t.id}/open`, { method: 'POST', body: { attendees: attendees.split('\n').map((s) => s.trim()).filter(Boolean), minutes: minutes || undefined } }], {
    invalidate: ['/tenders'],
    success: 'Bids opened; prices read out',
  });
  return (
    <FormDialog open title="Open the bids" submitLabel="Open and record minutes" onClose={onClose} submitting={open.isPending} onSubmit={(e) => { e.preventDefault(); open.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">{t.bids.length} sealed bid(s). The opening is recorded with the price read-outs and cannot be undone.</Typography>
      <TextField label="Attendees (one per line)" value={attendees} onChange={(e) => setAttendees(e.target.value)} multiline minRows={3} required />
      <TextField label="Minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} multiline minRows={3} />
    </FormDialog>
  );
}

function CommitteeDialog({ t, onClose }: { t: TenderDetail; onClose(): void }) {
  const evaluators = useQuery({ queryKey: ['/tenders/evaluators'], queryFn: () => api<{ id: string; fullName: string; username: string }[]>('/tenders/evaluators') });
  const [members, setMembers] = useState<{ userId: string; role: string }[]>(t.members.map((m) => ({ userId: m.userId, role: m.role })));
  const save = useApiMutation<void>(() => [`/tenders/${t.id}/committee`, { method: 'PUT', body: { members } }], { invalidate: ['/tenders'], success: 'Committee appointed; members are notified' });
  const chairs = members.filter((m) => m.role === 'CHAIR').length;
  return (
    <FormDialog open title="Evaluation committee" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {(evaluators.data ?? []).map((u) => {
        const m = members.find((x) => x.userId === u.id);
        return (
          <Stack key={u.id} direction="row" spacing={1} alignItems="center">
            <FormControlLabel
              sx={{ flex: 1 }}
              control={<Checkbox checked={!!m} onChange={(e) => setMembers(e.target.checked ? [...members, { userId: u.id, role: 'MEMBER' }] : members.filter((x) => x.userId !== u.id))} />}
              label={`${u.fullName} (${u.username})`}
            />
            {m && (
              <TextField select size="small" label="Role" value={m.role} onChange={(e) => setMembers(members.map((x) => (x.userId === u.id ? { ...x, role: e.target.value } : x)))} sx={{ width: 140 }}>
                <MenuItem value="CHAIR">Chair</MenuItem>
                <MenuItem value="MEMBER">Member</MenuItem>
                <MenuItem value="SECRETARY">Secretary</MenuItem>
              </TextField>
            )}
          </Stack>
        );
      })}
      {chairs !== 1 && <Alert severity="warning">Appoint exactly one chair.</Alert>}
    </FormDialog>
  );
}

function DeclarationDialog({ t, onClose }: { t: TenderDetail; onClose(): void }) {
  const [hasConflict, setHasConflict] = useState(false);
  const [declaration, setDeclaration] = useState('I have no personal or financial interest in any bidder for this tender.');
  const save = useApiMutation<void>(() => [`/tenders/${t.id}/declaration`, { method: 'POST', body: { hasConflict, declaration } }], { invalidate: ['/tenders'], success: 'Declaration recorded' });
  return (
    <FormDialog open title="Conflict-of-interest declaration" submitLabel="Sign declaration" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <Typography variant="body2">Bidders: {t.bids.map((b) => b.supplier).join(', ') || '—'}. The declaration is final; a member with a conflict does not score.</Typography>
      <FormControlLabel control={<Switch checked={hasConflict} onChange={(e) => { setHasConflict(e.target.checked); setDeclaration(e.target.checked ? '' : declaration); }} />} label="I have a conflict of interest" />
      <TextField label={hasConflict ? 'Nature of the conflict' : 'Declaration'} value={declaration} onChange={(e) => setDeclaration(e.target.value)} multiline minRows={3} required />
    </FormDialog>
  );
}

function ScoreSheet({ t }: { t: TenderDetail }) {
  const bids = t.bids.filter((b) => !['WITHDRAWN', 'SUBMITTED'].includes(b.status));
  const [scores, setScores] = useState<Record<string, number>>({});
  const key = (c: string, b: string) => `${c}:${b}`;
  const save = useApiMutation<void>(
    () => [`/tenders/${t.id}/scores`, { method: 'POST', body: { scores: Object.entries(scores).map(([k, score]) => ({ criterionId: k.split(':')[0], bidId: k.split(':')[1], score })) } }],
    { invalidate: ['/tenders'], success: 'Scores saved' },
  );
  const crit = (c: Criterion) => (
    <TableRow key={c.id}>
      <TableCell>
        {c.name}
        <Typography variant="caption" display="block">{c.stage === 'PRELIMINARY' ? 'Pass / fail' : `Weight ${c.weight} · 0–${c.maxScore}`}</Typography>
      </TableCell>
      {bids.map((b) => (
        <TableCell key={b.id} align="center">
          {c.stage === 'PRELIMINARY' ? (
            <Checkbox checked={scores[key(c.id, b.id)] === 1} onChange={(e) => setScores({ ...scores, [key(c.id, b.id)]: e.target.checked ? 1 : 0 })} slotProps={{ input: { 'aria-label': `${c.name} — ${b.supplier}` } }} />
          ) : (
            <TextField size="small" type="number" value={scores[key(c.id, b.id)] ?? ''} onChange={(e) => setScores({ ...scores, [key(c.id, b.id)]: Number(e.target.value) })} slotProps={{ htmlInput: { min: 0, max: c.maxScore, 'aria-label': `${c.name} — ${b.supplier}` } }} sx={{ width: 80 }} />
          )}
        </TableCell>
      ))}
    </TableRow>
  );
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>My score sheet</Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>Unticked preliminary criteria count as fails. Technical scores are only needed for bids that pass the preliminary stage by majority.</Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="Score sheet">
          <TableHead><TableRow><TableCell>Criterion</TableCell>{bids.map((b) => <TableCell key={b.id} align="center">{b.supplier}</TableCell>)}</TableRow></TableHead>
          <TableBody>{t.criteria.map(crit)}</TableBody>
        </Table>
      </Box>
      <Button sx={{ mt: 1 }} variant="contained" disabled={save.isPending || !Object.keys(scores).length} onClick={() => save.mutate()}>Save scores</Button>
    </Paper>
  );
}

function EvaluationPanel({ t }: { t: TenderDetail }) {
  const money = useMoney();
  const { data } = useQuery({ queryKey: ['/tenders', t.id, 'evaluation'], queryFn: () => api<Evaluation>(`/tenders/${t.id}/evaluation`) });
  if (!data) return null;
  const rows = [...data.bids].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Evaluation {data.complete ? <Chip size="small" color="success" label="Complete" /> : <Chip size="small" label={`${data.missing.length} score(s) missing`} />}</Typography>
      {data.undeclared.length > 0 && <Alert severity="info" sx={{ mb: 1 }}>{data.undeclared.length} member(s) have not declared.</Alert>}
      <Table size="small" aria-label="Ranking">
        <TableHead><TableRow><TableCell>Rank</TableCell><TableCell>Bidder</TableCell><TableCell align="right">Price</TableCell><TableCell>Preliminary</TableCell><TableCell align="right">Technical</TableCell><TableCell align="right">Financial</TableCell><TableCell align="right">Combined</TableCell></TableRow></TableHead>
        <TableBody>
          {rows.map((b) => (
            <TableRow key={b.id}>
              <TableCell>{b.rank ?? '—'}</TableCell>
              <TableCell>{b.supplier}</TableCell>
              <TableCell align="right">{money(b.totalPrice)}</TableCell>
              <TableCell>{b.responsive ? 'Pass' : <Chip size="small" color="error" label="Non-responsive" />}</TableCell>
              <TableCell align="right">{b.technicalScore ?? '—'}{b.responsive && !b.qualified && <Typography variant="caption" color="error" display="block">below pass mark</Typography>}</TableCell>
              <TableCell align="right">{b.financialScore ?? '—'}</TableCell>
              <TableCell align="right"><b>{b.combinedScore ?? '—'}</b></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="caption" color="text.secondary">
        Financial score = lowest qualified price ÷ bid price × 100. Combined = technical × {t.technicalWeight}% + financial × {100 - t.technicalWeight}%.
      </Typography>
    </Paper>
  );
}

function TextActionDialog({ title, label, submitLabel, path, field, onClose, success, minLength = 10 }: { title: string; label: string; submitLabel: string; path: string; field: string; onClose(): void; success: string; minLength?: number }) {
  const [text, setText] = useState('');
  const act = useApiMutation<void>(() => [path, { method: 'POST', body: { [field]: text } }], { invalidate: ['/tenders', '/approvals', '/contracts'], success });
  return (
    <FormDialog open title={title} submitLabel={submitLabel} onClose={onClose} submitting={act.isPending} onSubmit={(e) => { e.preventDefault(); act.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField label={label} value={text} onChange={(e) => setText(e.target.value)} multiline minRows={4} required error={text.length > 0 && text.length < minLength} helperText={`At least ${minLength} characters`} />
    </FormDialog>
  );
}

function SignDialog({ t, onClose }: { t: TenderDetail; onClose(): void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ type: ContractType.FRAMEWORK as string, startDate: today(), endDate: plusDays(today(), 365), supplierSignatory: '', deliveryTerms: '', paymentTermsDays: 30, leadTimeDays: 7 });
  const [security, setSecurity] = useState({ on: false, securityType: 'BANK_GUARANTEE', reference: '', issuer: '', amount: 0, expiresOn: plusDays(today(), 395) });
  const sign = useApiMutation<void, { contractId: string }>(
    () => [
      `/tenders/${t.id}/contract`,
      { method: 'POST', body: { ...form, deliveryTerms: form.deliveryTerms || undefined, paymentTermsDays: Number(form.paymentTermsDays), leadTimeDays: Number(form.leadTimeDays), security: security.on ? { securityType: security.securityType, reference: security.reference, issuer: security.issuer, amount: Number(security.amount), expiresOn: security.expiresOn } : undefined } },
    ],
    { invalidate: ['/tenders', '/contracts'], success: 'Contract signed' },
  );
  return (
    <FormDialog open title="Sign the contract" submitLabel="Sign contract" onClose={onClose} submitting={sign.isPending} onSubmit={(e) => { e.preventDefault(); sign.mutate(undefined, { onSuccess: (r) => navigate(`/contracts/${r.contractId}`) }); }}>
      <TextField select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
        <MenuItem value="FRAMEWORK">Framework agreement (call-off orders)</MenuItem>
        <MenuItem value="FIXED">Fixed contract</MenuItem>
      </TextField>
      <Stack direction="row" spacing={2}>
        <TextField label="Start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="End" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <TextField label="Supplier signatory" value={form.supplierSignatory} onChange={(e) => setForm({ ...form, supplierSignatory: e.target.value })} required />
      <TextField label="Delivery terms" value={form.deliveryTerms} onChange={(e) => setForm({ ...form, deliveryTerms: e.target.value })} />
      <Stack direction="row" spacing={2}>
        <TextField label="Payment terms (days)" type="number" value={form.paymentTermsDays} onChange={(e) => setForm({ ...form, paymentTermsDays: Number(e.target.value) })} />
        <TextField label="Lead time (days)" type="number" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: Number(e.target.value) })} />
      </Stack>
      <FormControlLabel control={<Switch checked={security.on} onChange={(e) => setSecurity({ ...security, on: e.target.checked })} />} label="Performance security received" />
      {security.on && (
        <>
          <Stack direction="row" spacing={2}>
            <TextField select label="Type" value={security.securityType} onChange={(e) => setSecurity({ ...security, securityType: e.target.value })}>
              <MenuItem value="BANK_GUARANTEE">Bank guarantee</MenuItem>
              <MenuItem value="INSURANCE_BOND">Insurance bond</MenuItem>
              <MenuItem value="CASH">Cash deposit</MenuItem>
            </TextField>
            <TextField label="Reference" value={security.reference} onChange={(e) => setSecurity({ ...security, reference: e.target.value })} />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Issuer" value={security.issuer} onChange={(e) => setSecurity({ ...security, issuer: e.target.value })} />
            <TextField label="Amount" type="number" value={security.amount} onChange={(e) => setSecurity({ ...security, amount: Number(e.target.value) })} />
            <TextField label="Expires" type="date" value={security.expiresOn} onChange={(e) => setSecurity({ ...security, expiresOn: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
        </>
      )}
    </FormDialog>
  );
}

function ClarificationsPanel({ t, manage }: { t: TenderDetail; manage: boolean }) {
  const date = useDate();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [addendum, setAddendum] = useState({ question: '', answer: '' });
  const answer = useApiMutation<{ id: string; body: object }>((v) => [`/tenders/${t.id}/clarifications/${v.id}`, { method: 'PUT', body: v.body }], { invalidate: ['/tenders'], success: 'Sent to every supplier holding the documents' });
  const open = t.status === 'PUBLISHED';
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Clarifications and addenda</Typography>
      {t.clarifications.length === 0 && <Typography color="text.secondary">None.</Typography>}
      <Stack spacing={1.5}>
        {t.clarifications.map((c) => (
          <Box key={c.id}>
            <Typography variant="body2"><b>{c.isAddendum ? 'Addendum' : 'Q'}:</b> {c.question} <Typography component="span" variant="caption" color="text.secondary">{date(c.createdAt)}</Typography></Typography>
            {c.answer ? (
              <Typography variant="body2" color="text.secondary">A: {c.answer}</Typography>
            ) : (
              manage && open && (
                <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                  <TextField size="small" label="Answer" value={answers[c.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [c.id]: e.target.value })} sx={{ flex: 1 }} />
                  <Button size="small" disabled={!answers[c.id]} onClick={() => answer.mutate({ id: c.id, body: { answer: answers[c.id] } })}>Answer</Button>
                </Stack>
              )
            )}
          </Box>
        ))}
      </Stack>
      {manage && open && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          <Typography variant="subtitle2">Issue an addendum</Typography>
          <TextField size="small" label="Subject" value={addendum.question} onChange={(e) => setAddendum({ ...addendum, question: e.target.value })} />
          <TextField size="small" label="Addendum text" value={addendum.answer} onChange={(e) => setAddendum({ ...addendum, answer: e.target.value })} multiline minRows={2} />
          <Box>
            <Button size="small" variant="outlined" disabled={!addendum.answer} onClick={() => answer.mutate({ id: 'new', body: { question: addendum.question || 'Addendum', answer: addendum.answer, isAddendum: true } }, { onSuccess: () => setAddendum({ question: '', answer: '' }) })}>Issue addendum</Button>
          </Box>
        </Stack>
      )}
    </Paper>
  );
}

// ------------------------------------------------------------------ detail

export function TenderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, can } = useAuth();
  const money = useMoney();
  const date = useDate();
  const when = useDateTime();
  const methods = useSourcingMethods();
  const { data: t } = useQuery({ queryKey: ['/tenders', id], queryFn: () => api<TenderDetail>(`/tenders/${id}`) });
  const [dialog, setDialog] = useState<null | 'bid' | 'open' | 'committee' | 'declare' | 'recommend' | 'award' | 'sign' | 'cancel'>(null);
  const publish = useApiMutation<void>(() => [`/tenders/${id}/publish`, { method: 'POST' }], { invalidate: ['/tenders'], success: 'Tender published' });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!t) return null;
  const manage = can(Permissions.TENDERS_MANAGE);
  const closed = Date.parse(t.closingAt) <= now;
  const me = t.members.find((m) => m.userId === user?.id);
  const canScore = !!me && !!me.declaredAt && !me.hasConflict && ['OPENED', 'EVALUATION'].includes(t.status);
  const isChair = me?.role === 'CHAIR';
  const awarded = t.bids.find((b) => b.id === t.awardedBidId);
  const standstill = t.standstillUntil && Date.parse(t.standstillUntil) > now;
  return (
    <>
      <PageHeader title={`${t.number} · ${t.title}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={t.status} />
                <Typography>{methodLabel(methods.data, t.method)} · closes {when(t.closingAt)}</Typography>
                {t.sealed && t.status === 'PUBLISHED' && <Chip size="small" variant="outlined" label="Bids sealed" />}
              </Stack>
              {t.cancellationReason && <Alert severity={t.status === 'CANCELLED' ? 'error' : 'warning'} sx={{ mb: 2 }}>{t.cancellationReason}</Alert>}
              {t.description && <Typography variant="body2" sx={{ mb: 2 }}>{t.description}</Typography>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
                <Field label="Estimated value">{money(t.estimatedValue)}</Field>
                <Field label="Bid security">{t.bidSecurityAmount ? money(t.bidSecurityAmount) : 'None'}</Field>
                <Field label="Bid validity">{t.bidValidityDays} days</Field>
                <Field label="Weights">{t.technicalWeight ? `Technical ${t.technicalWeight}% / price ${100 - t.technicalWeight}% · pass mark ${t.technicalPassMark}` : 'Lowest evaluated price'}</Field>
              </Stack>
              <Table size="small" aria-label="Tender lines">
                <TableHead><TableRow><TableCell>#</TableCell><TableCell>Description</TableCell><TableCell align="right">Qty</TableCell><TableCell>Specification</TableCell></TableRow></TableHead>
                <TableBody>
                  {(t.lines ?? []).map((l) => (
                    <TableRow key={l.id}><TableCell>{l.lineNo}</TableCell><TableCell>{l.description}</TableCell><TableCell align="right">{l.quantity}</TableCell><TableCell>{l.specification}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
              <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                {manage && t.status === 'DRAFT' && <Button variant="contained" disabled={publish.isPending} onClick={() => publish.mutate()}>Publish notice</Button>}
                {manage && t.status === 'PUBLISHED' && !closed && <Button onClick={() => setDialog('bid')}>Record a physical bid</Button>}
                {manage && ['PUBLISHED', 'CLOSED'].includes(t.status) && closed && <Button variant="contained" onClick={() => setDialog('open')}>Open bids</Button>}
                {manage && ['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION'].includes(t.status) && <Button onClick={() => setDialog('committee')}>Evaluation committee</Button>}
                {me && !me.declaredAt && <Button variant="contained" color="secondary" onClick={() => setDialog('declare')}>Declare conflict of interest</Button>}
                {t.status === 'EVALUATION' && (isChair || manage) && <Button variant="contained" onClick={() => setDialog('recommend')}>Record recommendation</Button>}
                {manage && t.status === 'RECOMMENDED' && !me && <Button variant="contained" onClick={() => setDialog('award')}>Professional opinion → award approval</Button>}
                {manage && can(Permissions.CONTRACTS_MANAGE) && t.status === 'AWARDED' && <Button variant="contained" disabled={!!standstill} onClick={() => setDialog('sign')}>Sign contract</Button>}
                {manage && !['CONTRACTED', 'CANCELLED', 'PENDING_APPROVAL'].includes(t.status) && <Button color="error" onClick={() => setDialog('cancel')}>Cancel tender</Button>}
              </Stack>
              {standstill && <Alert severity="info" sx={{ mt: 2 }}>Standstill period until {date(t.standstillUntil)}: the contract can be signed after it (PPADA rule set).</Alert>}
              {t.contractId && <Alert severity="success" sx={{ mt: 2 }}>Contract signed: <Link component={RouterLink} to={`/contracts/${t.contractId}`}>open the contract</Link>.</Alert>}
            </Paper>

            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Bid register ({t.bids.length})</Typography>
              <Table size="small" aria-label="Bids">
                <TableHead><TableRow><TableCell>Bidder</TableCell><TableCell>Received</TableCell><TableCell>Channel</TableCell><TableCell>Security</TableCell><TableCell align="right">Price</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
                <TableBody>
                  {t.bids.map((b) => (
                    <TableRow key={b.id} selected={b.id === t.awardedBidId}>
                      <TableCell>{b.supplier}</TableCell>
                      <TableCell>{when(b.submittedAt)}</TableCell>
                      <TableCell>{b.viaPortal ? 'Portal' : 'Physical'}</TableCell>
                      <TableCell>{b.bidSecurityRef ?? '—'}</TableCell>
                      <TableCell align="right">{b.totalPrice === undefined ? 'sealed' : money(b.totalPrice)}</TableCell>
                      <TableCell><StatusChip status={b.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {t.opening && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="subtitle2">Opening · {when(t.opening.openedAt)}</Typography>
                  <Typography variant="body2">Attendees: {t.opening.attendees.join(', ')}</Typography>
                  {t.opening.minutes && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{t.opening.minutes}</Typography>}
                </Box>
              )}
            </Paper>

            {!t.sealed && <EvaluationPanel t={t} />}
            {canScore && <ScoreSheet t={t} />}
            {t.evaluationReport && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>Committee recommendation</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{t.evaluationReport}</Typography>
                {t.professionalOpinion && (
                  <>
                    <Typography variant="subtitle2" sx={{ mt: 1 }}>Professional opinion</Typography>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{t.professionalOpinion}</Typography>
                  </>
                )}
                {awarded && <Typography sx={{ mt: 1 }}>Awarded to <b>{awarded.supplier}</b> for {money(awarded.totalPrice)} on {date(t.awardedAt)}.</Typography>}
              </Paper>
            )}
            <ClarificationsPanel t={t} manage={manage} />
          </>
        }
        side={
          <>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Committee</Typography>
              {t.members.length === 0 && <Typography color="text.secondary">Not appointed.</Typography>}
              {t.members.map((m) => (
                <Stack key={m.id} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>{m.fullName} · {humanise(m.role)}</Typography>
                  {!m.declaredAt ? <Chip size="small" label="Not declared" /> : m.hasConflict ? <Chip size="small" color="warning" label="Conflict" /> : <Chip size="small" color="success" label="Declared" />}
                </Stack>
              ))}
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Bid documents issued</Typography>
              {t.documents.length === 0 && <Typography color="text.secondary">None yet.</Typography>}
              {t.documents.map((d) => <Typography key={d.supplierId} variant="body2">{d.supplier} · {date(d.issuedAt)}{d.fee ? ` · ${money(d.fee)}` : ''}</Typography>)}
            </Paper>
            {['PENDING_APPROVAL', 'AWARDED', 'CONTRACTED'].includes(t.status) && <ApprovalPanel type="TND" id={t.id} />}
            <DocumentChain type="TND" id={t.id} />
          </>
        }
      />
      {dialog === 'bid' && <StaffBidDialog t={t} onClose={() => setDialog(null)} />}
      {dialog === 'open' && <OpenDialog t={t} onClose={() => setDialog(null)} />}
      {dialog === 'committee' && <CommitteeDialog t={t} onClose={() => setDialog(null)} />}
      {dialog === 'declare' && <DeclarationDialog t={t} onClose={() => setDialog(null)} />}
      {dialog === 'recommend' && <TextActionDialog title="Committee recommendation" label="Evaluation report and recommendation" submitLabel="Lock evaluation and recommend" path={`/tenders/${t.id}/recommend`} field="report" success="Recommendation recorded" onClose={() => setDialog(null)} />}
      {dialog === 'award' && <TextActionDialog title="Professional opinion" label="Opinion of the head of procurement" submitLabel="Submit for award approval" path={`/tenders/${t.id}/award`} field="opinion" success="Submitted for award approval" onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <TextActionDialog title="Cancel the tender" label="Reason" submitLabel="Cancel tender" path={`/tenders/${t.id}/cancel`} field="reason" success="Tender cancelled" minLength={3} onClose={() => setDialog(null)} />}
      {dialog === 'sign' && <SignDialog t={t} onClose={() => setDialog(null)} />}
    </>
  );
}

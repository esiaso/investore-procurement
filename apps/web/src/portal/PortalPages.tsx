import { Alert, Box, Button, Card, CardActionArea, CardContent, Chip, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid2';
import { DataGrid } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DeliveryStage, SupplierSubmissionType } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList } from '../api/hooks';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { DetailLayout, Field, useDate, useMoney } from '../purchasing/common';
import type { PortalMe, PortalOrder, PortalOrderRow, PortalPayment, PortalRfq, PortalRfqRow, PortalSubmission, PortalTender, PortalTenderRow } from '../strategic/api';

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** Stages a supplier may report (delivery itself is confirmed by the hospital's GRN). */
export const SUPPLIER_STAGES = Object.values(DeliveryStage).filter((s) => s !== DeliveryStage.DELIVERED && s !== DeliveryStage.ORDER_SENT);

function useWhen() {
  const date = useDate();
  return (v: string | null | undefined) => (v ? `${date(v)} ${new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })}` : '');
}

export function PortalHomePage() {
  const navigate = useNavigate();
  const date = useDate();
  const { data } = useQuery({ queryKey: ['/portal/me'], queryFn: () => api<PortalMe>('/portal/me') });
  if (!data) return null;
  const s = data.supplier;
  const card = (label: string, value: number, path: string) => (
    <Grid size={{ xs: 12, sm: 4 }} key={label}>
      <Card><CardActionArea onClick={() => navigate(path)}><CardContent><Typography color="text.secondary" variant="body2">{label}</Typography><Typography variant="h4">{value}</Typography></CardContent></CardActionArea></Card>
    </Grid>
  );
  return (
    <>
      <PageHeader title={s.name} />
      {s.status !== 'ACTIVE' && <Alert severity="error" sx={{ mb: 2 }}>Your account is {humanise(s.status)}{s.statusReason ? `: ${s.statusReason}` : ''}. You cannot bid or quote until it is reinstated.</Alert>}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {card('Open requests for quotation', data.counts.rfqs, '/portal/rfqs')}
        {card('Open tenders', data.counts.tenders, '/portal/tenders')}
        {card('Orders to acknowledge', data.counts.unacknowledgedOrders, '/portal/orders')}
      </Grid>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Our details with the hospital</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Field label="Supplier code">{s.code}</Field>
          <Field label="KRA PIN">{s.kraPin}</Field>
          <Field label="Prequalification">{s.prequalificationStatus ? `${humanise(s.prequalificationStatus)}${s.prequalifiedUntil ? ` until ${date(s.prequalifiedUntil)}` : ''}` : '—'}</Field>
          <Field label="Payment terms">{s.paymentTermsDays != null ? `${s.paymentTermsDays} days` : '—'}</Field>
          <Field label="Bank account">{s.bankAccount ?? '—'}</Field>
        </Stack>
        <Typography variant="subtitle2">Compliance documents</Typography>
        {data.documents.length === 0 && <Typography color="text.secondary">None on file.</Typography>}
        {data.documents.map((d) => (
          <Typography key={d.documentType} variant="body2">{humanise(d.documentType)} {d.reference ?? ''} · expires {d.expiresOn ? date(d.expiresOn) : '—'}</Typography>
        ))}
      </Paper>
    </>
  );
}

// ------------------------------------------------------------------ RFQs

function QuoteDialog({ rfq, onClose }: { rfq: PortalRfq; onClose(): void }) {
  const [prices, setPrices] = useState<Record<string, number>>(Object.fromEntries((rfq.quotation?.lines ?? []).map((l) => [l.rfqLineId, l.unitPrice])));
  const [form, setForm] = useState({ supplierReference: '', validUntil: '', deliveryDays: '' as number | '' });
  const save = useApiMutation<void>(
    () => [`/portal/rfqs/${rfq.id}/quotation`, { method: 'POST', body: { supplierReference: form.supplierReference || undefined, validUntil: form.validUntil || undefined, deliveryDays: form.deliveryDays === '' ? undefined : Number(form.deliveryDays), lines: rfq.lines.filter((l) => prices[l.id] !== undefined).map((l) => ({ rfqLineId: l.id, unitPrice: Number(prices[l.id]) })) } }],
    { invalidate: ['/portal'], success: 'Quotation submitted' },
  );
  return (
    <FormDialog open title={`Quote for ${rfq.number}`} submitLabel="Submit quotation" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {rfq.lines.map((l) => (
        <TextField key={l.id} label={`Unit price excl. VAT: ${l.item} (${l.quantity} ${l.uom ?? ''})`} type="number" value={prices[l.id] ?? ''} onChange={(e) => setPrices({ ...prices, [l.id]: Number(e.target.value) })} />
      ))}
      <Stack direction="row" spacing={2}>
        <TextField label="Your reference" value={form.supplierReference} onChange={(e) => setForm({ ...form, supplierReference: e.target.value })} />
        <TextField label="Valid until" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Delivery (days)" type="number" value={form.deliveryDays} onChange={(e) => setForm({ ...form, deliveryDays: e.target.value === '' ? '' : Number(e.target.value) })} />
      </Stack>
    </FormDialog>
  );
}

export function PortalRfqsPage() {
  const date = useDate();
  const { data, isFetching } = useList<PortalRfqRow>('/portal/rfqs');
  const [openId, setOpenId] = useState<string | null>(null);
  const rfq = useQuery({ queryKey: ['/portal/rfqs', openId], queryFn: () => api<PortalRfq>(`/portal/rfqs/${openId}`), enabled: !!openId });
  return (
    <>
      <PageHeader title="Requests for quotation" />
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'RFQ', width: 150 },
            { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
            { field: 'closingDate', headerName: 'Closes', width: 120, valueFormatter: (v: string) => date(v) },
            { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'quoted', headerName: 'Quoted', width: 90, type: 'boolean' },
          ]}
          onRowClick={({ row }) => setOpenId(row.id)}
          disableRowSelectionOnClick
        />
      </Paper>
      {rfq.data && openId && (rfq.data.status === 'SENT' && rfq.data.closingDate >= todayStr() ? (
        <QuoteDialog rfq={rfq.data} onClose={() => setOpenId(null)} />
      ) : (
        <FormDialog open title={rfq.data.number} submitLabel="Close" onClose={() => setOpenId(null)} onSubmit={(e) => { e.preventDefault(); setOpenId(null); }}>
          <Typography>This RFQ is {humanise(rfq.data.status)}.{rfq.data.awardedLineIds.length ? ` You were awarded ${rfq.data.awardedLineIds.length} line(s); the purchase order follows.` : ''}</Typography>
        </FormDialog>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ tenders

export function PortalTendersPage() {
  const navigate = useNavigate();
  const when = useWhen();
  const money = useMoney();
  const { data, isFetching } = useList<PortalTenderRow>('/portal/tenders');
  return (
    <>
      <PageHeader title="Tenders" />
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'Tender', width: 150 },
            { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
            { field: 'method', headerName: 'Method', width: 160, valueFormatter: (v: string) => humanise(v) },
            { field: 'closingAt', headerName: 'Closes', width: 170, valueFormatter: (v: string) => when(v) },
            { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'myBid', headerName: 'Our bid', width: 160, valueGetter: (_v, r: PortalTenderRow) => (r.myBid ? `${humanise(r.myBid.status)} · ${money(r.myBid.totalPrice)}` : '') },
          ]}
          onRowClick={({ row }) => navigate(`/portal/tenders/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

function BidForm({ t }: { t: PortalTender }) {
  const [prices, setPrices] = useState<Record<string, number>>(Object.fromEntries((t.myBid?.lines ?? []).map((l) => [l.tenderLineId, l.unitPrice])));
  const [form, setForm] = useState({ bidSecurityRef: t.myBid?.bidSecurityRef ?? '', bidSecurityAmount: t.bidSecurityAmount, deliveryDays: (t.myBid?.deliveryDays ?? '') as number | '', technicalProposal: t.myBid?.technicalProposal ?? '' });
  const total = t.lines.reduce((s, l) => s + (prices[l.id] ?? 0) * l.quantity, 0);
  const money = useMoney();
  const save = useApiMutation<void>(
    () => [
      `/portal/tenders/${t.id}/bid`,
      { method: 'POST', body: { lines: t.lines.map((l) => ({ tenderLineId: l.id, unitPrice: Number(prices[l.id] ?? 0) })), bidSecurityRef: form.bidSecurityRef || undefined, bidSecurityAmount: Number(form.bidSecurityAmount), deliveryDays: form.deliveryDays === '' ? undefined : Number(form.deliveryDays), technicalProposal: form.technicalProposal || undefined } },
    ],
    { invalidate: ['/portal'], success: 'Bid submitted. It stays sealed until the opening.' },
  );
  const withdraw = useApiMutation<void>(() => [`/portal/tenders/${t.id}/withdraw`, { method: 'POST' }], { invalidate: ['/portal'], success: 'Bid withdrawn' });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>{t.myBid ? 'Our bid (you may replace it until closing)' : 'Submit a bid'}</Typography>
      <Stack spacing={1.5}>
        {t.lines.map((l) => (
          <TextField key={l.id} label={`Unit price excl. VAT · ${l.description} (× ${l.quantity})`} type="number" value={prices[l.id] ?? ''} onChange={(e) => setPrices({ ...prices, [l.id]: Number(e.target.value) })} />
        ))}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Bid security reference" value={form.bidSecurityRef} onChange={(e) => setForm({ ...form, bidSecurityRef: e.target.value })} />
          <TextField label="Bid security amount" type="number" value={form.bidSecurityAmount} onChange={(e) => setForm({ ...form, bidSecurityAmount: Number(e.target.value) })} />
          <TextField label="Delivery (days)" type="number" value={form.deliveryDays} onChange={(e) => setForm({ ...form, deliveryDays: e.target.value === '' ? '' : Number(e.target.value) })} />
        </Stack>
        <TextField label="Technical proposal" value={form.technicalProposal} onChange={(e) => setForm({ ...form, technicalProposal: e.target.value })} multiline minRows={3} />
        <Typography>Total bid: <b>{money(total)}</b></Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={save.isPending || t.lines.some((l) => prices[l.id] === undefined)} onClick={() => save.mutate()}>{t.myBid ? 'Replace bid' : 'Submit bid'}</Button>
          {t.myBid?.status === 'SUBMITTED' && <Button color="error" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</Button>}
        </Stack>
      </Stack>
    </Paper>
  );
}

export function PortalTenderPage() {
  const { id } = useParams<{ id: string }>();
  const when = useWhen();
  const money = useMoney();
  const { data: t } = useQuery({ queryKey: ['/portal/tenders', id], queryFn: () => api<PortalTender>(`/portal/tenders/${id}`) });
  const [question, setQuestion] = useState('');
  const docs = useApiMutation<void>(() => [`/portal/tenders/${id}/documents`, { method: 'POST' }], { invalidate: ['/portal'], success: 'Bid documents issued to you; you will be emailed any addenda' });
  const ask = useApiMutation<void>(() => [`/portal/tenders/${id}/clarifications`, { method: 'POST', body: { question } }], { invalidate: ['/portal'], success: 'Question sent; answers are shared with all bidders' });
  if (!t) return null;
  const open = t.status === 'PUBLISHED' && Date.parse(t.closingAt) > Date.now();
  return (
    <>
      <PageHeader title={`${t.number} · ${t.title}`} />
      <DetailLayout
        main={
          <>
            <Paper sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <StatusChip status={t.status} />
                <Typography>{humanise(t.method)} · closes {when(t.closingAt)}</Typography>
              </Stack>
              {t.result === 'AWARDED' && <Alert severity="success" sx={{ mb: 2 }}>Your bid was successful. The procurement office will contact you to sign the contract.</Alert>}
              {t.result === 'NOT_SUCCESSFUL' && <Alert severity="info" sx={{ mb: 2 }}>Your bid was not successful this time.</Alert>}
              {t.description && <Typography variant="body2" sx={{ mb: 2 }}>{t.description}</Typography>}
              <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
                <Field label="Bid security">{t.bidSecurityAmount ? money(t.bidSecurityAmount) : 'Not required'}</Field>
                <Field label="Bid validity">{t.bidValidityDays} days</Field>
              </Stack>
              <Table size="small" aria-label="Tender lines">
                <TableHead><TableRow><TableCell>#</TableCell><TableCell>Description</TableCell><TableCell align="right">Qty</TableCell><TableCell>Specification</TableCell></TableRow></TableHead>
                <TableBody>{t.lines.map((l) => <TableRow key={l.id}><TableCell>{l.lineNo}</TableCell><TableCell>{l.description}</TableCell><TableCell align="right">{l.quantity}</TableCell><TableCell>{l.specification}</TableCell></TableRow>)}</TableBody>
              </Table>
              {open && <Button sx={{ mt: 2 }} disabled={docs.isPending} onClick={() => docs.mutate()}>Request bid documents</Button>}
            </Paper>
            {open ? <BidForm t={t} /> : t.myBid && (
              <Paper sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>Our bid</Typography>
                <Typography>{humanise(t.myBid.status)} · {money(t.myBid.totalPrice)} · submitted {when(t.myBid.submittedAt)}</Typography>
              </Paper>
            )}
          </>
        }
        side={
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>Clarifications and addenda</Typography>
            {t.clarifications.length === 0 && <Typography color="text.secondary">None yet.</Typography>}
            {t.clarifications.map((c) => (
              <Box key={c.id} sx={{ mb: 1.5 }}>
                <Typography variant="body2"><b>{c.isAddendum ? 'Addendum' : 'Q'}:</b> {c.question} {c.mine && <Chip size="small" label="Ours" />}</Typography>
                <Typography variant="body2" color="text.secondary">{c.answer ? `A: ${c.answer}` : 'Awaiting answer'}</Typography>
              </Box>
            ))}
            {open && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <TextField size="small" label="Ask a question" value={question} onChange={(e) => setQuestion(e.target.value)} multiline minRows={2} />
                <Box><Button size="small" disabled={question.length < 3 || ask.isPending} onClick={() => ask.mutate(undefined, { onSuccess: () => setQuestion('') })}>Send</Button></Box>
              </Stack>
            )}
          </Paper>
        }
      />
    </>
  );
}

// ------------------------------------------------------------------ orders

export function PortalOrdersPage() {
  const navigate = useNavigate();
  const date = useDate();
  const money = useMoney();
  const { data, isFetching } = useList<PortalOrderRow>('/portal/purchase-orders');
  return (
    <>
      <PageHeader title="Purchase orders" />
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'number', headerName: 'PO', width: 150 },
            { field: 'orderDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'store', headerName: 'Deliver to', flex: 1, minWidth: 160, valueGetter: (_v, r: PortalOrderRow) => r.store?.name ?? '' },
            { field: 'expectedDelivery', headerName: 'Expected', width: 110, valueFormatter: (v: string | null) => date(v) },
            { field: 'status', headerName: 'Status', width: 160, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'acknowledgedAt', headerName: 'Acknowledged', width: 130, renderCell: ({ value }) => (value ? date(value) : <Chip size="small" color="warning" label="Not yet" />) },
            { field: 'deliveryStage', headerName: 'Delivery', width: 120, valueFormatter: (v: string | null) => (v ? humanise(v) : '') },
            { field: 'total', headerName: 'Total', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
          ]}
          onRowClick={({ row }) => navigate(`/portal/orders/${row.id}`)}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

function SubmitDocumentDialog({ po, onClose }: { po: PortalOrder; onClose(): void }) {
  const [form, setForm] = useState({ type: SupplierSubmissionType.DELIVERY_NOTE as string, reference: '', documentDate: todayStr(), amount: '' as number | '', fileName: '', notes: '' });
  const save = useApiMutation<void>(
    () => [`/portal/purchase-orders/${po.id}/documents`, { method: 'POST', body: { ...form, amount: form.amount === '' ? undefined : Number(form.amount), fileName: form.fileName || undefined, notes: form.notes || undefined } }],
    { invalidate: ['/portal'], success: 'Sent to the hospital' },
  );
  return (
    <FormDialog open title={`Send a document for ${po.number}`} submitLabel="Send" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <TextField select label="Document" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
        {Object.values(SupplierSubmissionType).map((t) => <MenuItem key={t} value={t}>{humanise(t)}</MenuItem>)}
      </TextField>
      <Stack direction="row" spacing={2}>
        <TextField label="Number / reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} required />
        <TextField label="Date" type="date" value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
      </Stack>
      <TextField label="Amount (invoices)" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value === '' ? '' : Number(e.target.value) })} />
      <TextField label="File name" value={form.fileName} onChange={(e) => setForm({ ...form, fileName: e.target.value })} helperText="Bring or email the document itself; the hospital captures it against the order" />
      <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
    </FormDialog>
  );
}

export function PortalOrderPage() {
  const { id } = useParams<{ id: string }>();
  const date = useDate();
  const when = useWhen();
  const money = useMoney();
  const { data: po } = useQuery({ queryKey: ['/portal/purchase-orders', id], queryFn: () => api<PortalOrder>(`/portal/purchase-orders/${id}`) });
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<string>(DeliveryStage.DISPATCHED);
  const [ref, setRef] = useState('');
  const [expected, setExpected] = useState('');
  const [docDialog, setDocDialog] = useState(false);
  const ack = useApiMutation<void>(() => [`/portal/purchase-orders/${id}/acknowledge`, { method: 'POST', body: { note: note || undefined } }], { invalidate: ['/portal'], success: 'Order acknowledged' });
  const track = useApiMutation<void>(() => [`/portal/purchase-orders/${id}/delivery`, { method: 'POST', body: { stage, reference: ref || undefined, expectedDate: expected || undefined } }], { invalidate: ['/portal'], success: 'Delivery status sent' });
  if (!po) return null;
  return (
    <>
      <PageHeader title={`Purchase order ${po.number}${po.version > 1 ? ` (v${po.version})` : ''}`} />
      <DetailLayout
        main={
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={po.status} /><Typography>Deliver to {po.store?.name}</Typography></Stack>
            <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
              <Field label="Order date">{date(po.orderDate)}</Field>
              <Field label="Expected delivery">{date(po.expectedDelivery) || '—'}</Field>
              <Field label="Total">{money(po.total)}</Field>
            </Stack>
            <Table size="small" aria-label="Order lines">
              <TableHead><TableRow><TableCell>#</TableCell><TableCell>Item</TableCell><TableCell align="right">Qty</TableCell><TableCell>Unit</TableCell><TableCell align="right">Price</TableCell><TableCell align="right">Total</TableCell><TableCell align="right">Received</TableCell></TableRow></TableHead>
              <TableBody>
                {po.lines.map((l) => (
                  <TableRow key={l.lineNo}>
                    <TableCell>{l.lineNo}</TableCell><TableCell>{l.item}</TableCell><TableCell align="right">{l.quantity}</TableCell><TableCell>{l.uom}</TableCell>
                    <TableCell align="right">{money(l.unitPrice)}</TableCell><TableCell align="right">{money(l.lineTotal)}</TableCell><TableCell align="right">{l.conversionFactor ? l.receivedBaseQty / l.conversionFactor : l.receivedBaseQty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        }
        side={
          <>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Acknowledgement</Typography>
              {po.acknowledgedAt ? (
                <Typography>Acknowledged {when(po.acknowledgedAt)}</Typography>
              ) : (
                <Stack spacing={1}>
                  <TextField size="small" label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Box><Button variant="contained" disabled={ack.isPending} onClick={() => ack.mutate()}>Acknowledge order</Button></Box>
                </Stack>
              )}
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Delivery</Typography>
              {po.deliveries.map((d) => (
                <Typography key={d.id} variant="body2">{date(d.at)} · {humanise(d.stage)}{d.reference ? ` · ${d.reference}` : ''}{d.expectedDate ? ` · expected ${date(d.expectedDate)}` : ''}</Typography>
              ))}
              <Stack spacing={1} sx={{ mt: 1 }}>
                <TextField select size="small" label="Status" value={stage} onChange={(e) => setStage(e.target.value)}>
                  {SUPPLIER_STAGES.map((s) => <MenuItem key={s} value={s}>{humanise(s)}</MenuItem>)}
                </TextField>
                <TextField size="small" label="Delivery note / waybill" value={ref} onChange={(e) => setRef(e.target.value)} />
                <TextField size="small" label="Expected on" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                <Box><Button disabled={track.isPending} onClick={() => track.mutate()}>Update delivery status</Button></Box>
                <Typography variant="caption" color="text.secondary">Receipt is confirmed by the hospital’s goods received note.</Typography>
              </Stack>
            </Paper>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Documents</Typography>
              <Button onClick={() => setDocDialog(true)}>Send delivery note or invoice</Button>
            </Paper>
          </>
        }
      />
      {docDialog && <SubmitDocumentDialog po={po} onClose={() => setDocDialog(false)} />}
    </>
  );
}

/** Staff: delivery notes and invoices suppliers sent through the portal. */
export function PortalSubmissionsPage() {
  const date = useDate();
  const money = useMoney();
  const [status, setStatus] = useState('SUBMITTED');
  const { data, isFetching } = useList<PortalSubmission>('/procurement/portal-submissions', { status: status || undefined });
  const review = useApiMutation<{ id: string; status: 'CAPTURED' | 'REJECTED' }>((v) => [`/procurement/portal-submissions/${v.id}`, { method: 'PUT', body: { status: v.status } }], { invalidate: ['/procurement/portal-submissions'], success: 'Updated' });
  return (
    <>
      <PageHeader title="Supplier portal documents" />
      <Stack direction="row" sx={{ mb: 2 }}>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: 180 }}>
          <MenuItem value="">All</MenuItem>
          <MenuItem value="SUBMITTED">Submitted</MenuItem>
          <MenuItem value="CAPTURED">Captured</MenuItem>
          <MenuItem value="REJECTED">Rejected</MenuItem>
        </TextField>
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={data ?? []}
          loading={isFetching}
          columns={[
            { field: 'supplier', headerName: 'Supplier', width: 200 },
            { field: 'purchaseOrder', headerName: 'PO', width: 150 },
            { field: 'type', headerName: 'Document', width: 140, valueFormatter: (v: string) => humanise(v) },
            { field: 'reference', headerName: 'Reference', width: 140 },
            { field: 'documentDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'amount', headerName: 'Amount', type: 'number', width: 120, valueFormatter: (v: number | null) => (v == null ? '' : money(v)) },
            { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
            {
              field: 'actions',
              headerName: '',
              width: 200,
              sortable: false,
              renderCell: ({ row }) =>
                row.status === 'SUBMITTED' && (
                  <Stack direction="row" spacing={0.5} sx={{ height: '100%' }} alignItems="center">
                    <Button size="small" onClick={() => review.mutate({ id: row.id, status: 'CAPTURED' })}>Captured</Button>
                    <Button size="small" color="error" onClick={() => review.mutate({ id: row.id, status: 'REJECTED' })}>Reject</Button>
                  </Stack>
                ),
            },
          ]}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

export function PortalPaymentsPage() {
  const date = useDate();
  const money = useMoney();
  const payments = useList<PortalPayment>('/portal/payments');
  const submissions = useList<PortalSubmission>('/portal/submissions');
  return (
    <>
      <PageHeader title="Invoices and payments" />
      <Paper sx={{ mb: 3 }}>
        <DataGrid
          autoHeight
          density="compact"
          getRowId={(r) => r.number}
          rows={payments.data ?? []}
          loading={payments.isFetching}
          columns={[
            { field: 'invoiceNo', headerName: 'Your invoice', width: 140 },
            { field: 'purchaseOrder', headerName: 'PO', width: 150 },
            { field: 'invoiceDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'total', headerName: 'Amount', type: 'number', width: 130, valueFormatter: (v: number) => money(v) },
            { field: 'status', headerName: 'Status', width: 130, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'dueDate', headerName: 'Due', width: 110, valueFormatter: (v: string | null) => date(v) },
            { field: 'paidOn', headerName: 'Paid', width: 110, valueFormatter: (v: string | null) => date(v) },
            { field: 'paymentReference', headerName: 'Payment ref.', flex: 1, minWidth: 140 },
          ]}
          disableRowSelectionOnClick
        />
      </Paper>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Documents we sent</Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={submissions.data ?? []}
          loading={submissions.isFetching}
          columns={[
            { field: 'type', headerName: 'Document', width: 140, valueFormatter: (v: string) => humanise(v) },
            { field: 'reference', headerName: 'Reference', width: 150 },
            { field: 'documentDate', headerName: 'Date', width: 110, valueFormatter: (v: string) => date(v) },
            { field: 'amount', headerName: 'Amount', type: 'number', width: 120, valueFormatter: (v: number | null) => (v == null ? '' : money(v)) },
            { field: 'status', headerName: 'Status', width: 120, renderCell: ({ value }) => <StatusChip status={value} /> },
            { field: 'reviewNote', headerName: 'Hospital note', flex: 1, minWidth: 160 },
          ]}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

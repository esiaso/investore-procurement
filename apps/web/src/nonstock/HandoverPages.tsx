import { Alert, Button, Link, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Permissions } from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList } from '../api/hooks';
import type { Deliverable, Handover, StaffRequisition } from '../api/nonstock-types';
import { useAuth } from '../auth/AuthContext';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { AttachmentsPanel } from '../files/AttachmentsPanel';
import { StatusChip } from '../inventory/components';
import { humanise } from '../lib/format';
import { DetailLayout, DocumentChain, Field, useDate } from '../purchasing/common';

const CONDITIONS = ['GOOD', 'DAMAGED', 'INCOMPLETE'];

/** Hand received lines over to the requester (or a colleague in the department). */
export function HandoverDialog({ requisition, onClose }: { requisition: StaffRequisition; onClose(): void }) {
  const available = (requisition.deliverable ?? []).filter((d) => d.available > 0);
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(available.map((d) => [d.requisitionLineId, String(d.available)])));
  const [condition, setCondition] = useState('GOOD');
  const [notes, setNotes] = useState('');
  const save = useApiMutation<void, Handover>(
    () => [
      '/handovers',
      {
        method: 'POST',
        body: {
          requisitionId: requisition.id,
          condition,
          notes: notes || undefined,
          lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([requisitionLineId, v]) => ({ requisitionLineId, quantity: Number(v) })),
        },
      },
    ],
    { invalidate: ['/handovers', '/staff-requisitions'], success: 'Ready for collection: the requester is told' },
  );
  return (
    <FormDialog open maxWidth="md" title={`Hand over to ${requisition.requestedByName ?? 'the requester'}`} submitLabel="Hand over" onClose={onClose} submitting={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      {available.length === 0 && <Alert severity="info">Nothing received is waiting to be handed over.</Alert>}
      {available.map((d) => (
        <Stack key={d.requisitionLineId} direction="row" spacing={2} alignItems="center">
          <Typography sx={{ flex: 1 }}>{d.lineNo}. {d.description} (received {d.receivedQty}, delivered {d.deliveredQty})</Typography>
          <TextField size="small" type="number" label="Quantity" value={qty[d.requisitionLineId] ?? ''} onChange={(e) => setQty({ ...qty, [d.requisitionLineId]: e.target.value })} sx={{ width: 120 }} slotProps={{ htmlInput: { min: 0, max: d.available, step: 'any', 'aria-label': `Hand over quantity for line ${d.lineNo}` } }} />
        </Stack>
      ))}
      <TextField select label="Condition" value={condition} onChange={(e) => setCondition(e.target.value)} sx={{ maxWidth: 200 }}>
        {CONDITIONS.map((c) => <MenuItem key={c} value={c}>{humanise(c)}</MenuItem>)}
      </TextField>
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
    </FormDialog>
  );
}

/** Received / delivered per line and the hand-overs, on the requisition page. */
export function DeliveryPanel({ requisition }: { requisition: StaffRequisition }) {
  const { can } = useAuth();
  const date = useDate();
  const [open, setOpen] = useState(false);
  const handovers = useList<Handover>(`/handovers?requisitionId=${requisition.id}`);
  const lines = requisition.deliverable ?? [];
  if (!lines.some((l) => l.receivedQty > 0) && !(handovers.data ?? []).length) return null;
  const canHand = can(Permissions.PURCHASING_HANDOVER) && lines.some((l) => l.available > 0) && !['CLOSED', 'CANCELLED'].includes(requisition.status);
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Delivery to the requester</Typography>
      <Table size="small" aria-label="Delivery">
        <TableHead><TableRow><TableCell>Line</TableCell><TableCell align="right">Ordered</TableCell><TableCell align="right">Received</TableCell><TableCell align="right">Delivered</TableCell><TableCell align="right">Waiting</TableCell></TableRow></TableHead>
        <TableBody>
          {lines.map((l: Deliverable) => (
            <TableRow key={l.requisitionLineId}>
              <TableCell>{l.lineNo}. {l.description}</TableCell>
              <TableCell align="right">{l.quantity} {l.uom ?? ''}</TableCell>
              <TableCell align="right">{l.receivedQty}</TableCell>
              <TableCell align="right">{l.deliveredQty}</TableCell>
              <TableCell align="right">{l.pendingQty || ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {(handovers.data ?? []).map((h) => (
        <Typography key={h.id} variant="body2" sx={{ mt: 1 }}>
          <Link component={RouterLink} to={`/handovers/${h.id}`}>{h.number}</Link> · {date(h.createdAt)} · <StatusChip status={h.status} />
        </Typography>
      ))}
      {canHand && <Button variant="outlined" sx={{ mt: 2 }} onClick={() => setOpen(true)}>Hand over</Button>}
      {open && <HandoverDialog requisition={requisition} onClose={() => setOpen(false)} />}
    </Paper>
  );
}

function OtpPanel({ h }: { h: Handover }) {
  const [code, setCode] = useState('');
  const send = useApiMutation<void>(() => [`/handovers/${h.id}/otp`, { method: 'POST' }], { invalidate: ['/handovers'], success: 'Code sent to the receiver' });
  const verify = useApiMutation<void>(() => [`/handovers/${h.id}/otp/verify`, { method: 'POST', body: { code } }], { invalidate: ['/handovers', '/staff-requisitions'], success: 'Confirmed with the code' });
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
      <Button variant="outlined" disabled={send.isPending} onClick={() => send.mutate()}>{h.otpPending ? 'Send a new code' : 'Send code to the receiver'}</Button>
      {h.otpPending && (
        <>
          <TextField size="small" label="Code from the receiver" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
          <Button variant="contained" disabled={code.length !== 6 || verify.isPending} onClick={() => verify.mutate()}>Confirm</Button>
        </>
      )}
    </Stack>
  );
}

export function HandoverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const date = useDate();
  const [comment, setComment] = useState('');
  const { data: h } = useQuery({ queryKey: ['/handovers', id], queryFn: () => api<Handover>(`/handovers/${id}`) });
  const ack = useApiMutation<void>(() => [`/handovers/${id}/acknowledge`, { method: 'POST', body: { comment: comment || undefined } }], { invalidate: ['/handovers', '/staff-requisitions'], success: 'Thank you: receipt confirmed' });
  const cancel = useApiMutation<void>(() => [`/handovers/${id}/cancel`, { method: 'POST' }], { invalidate: ['/handovers', '/staff-requisitions'], success: 'Cancelled' });
  if (!h) return null;
  const pending = h.status === 'PENDING';
  const receiver = h.receivedBy === user?.id;
  const officer = h.preparedBy === user?.id;
  return (
    <>
      <PageHeader title={`Hand-over ${h.number}`} />
      <DetailLayout
        main={
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <StatusChip status={h.status} />
              {h.requisition && <Typography>Requisition <Link component={RouterLink} to={`/staff-requisitions/${h.requisitionId}`}>{h.requisition.number}</Link></Typography>}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ mb: 2 }}>
              <Field label="Handed over by">{h.preparedByName}</Field>
              <Field label="Receiver">{h.receivedByName}</Field>
              <Field label="Condition">{humanise(h.condition)}</Field>
              {h.acknowledgedAt && <Field label="Confirmed">{date(h.acknowledgedAt)} ({h.ackChannel === 'OTP' ? 'one-time code' : 'in the app'})</Field>}
            </Stack>
            {h.notes && <Typography variant="body2" sx={{ mb: 2 }}>{h.notes}</Typography>}
            <Table size="small" aria-label="Handed over">
              <TableHead><TableRow><TableCell>Line</TableCell><TableCell align="right">Quantity</TableCell><TableCell>Remarks</TableCell></TableRow></TableHead>
              <TableBody>
                {(h.lines ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.requisitionLine?.lineNo}. {l.requisitionLine?.description}</TableCell>
                    <TableCell align="right">{l.quantity} {l.requisitionLine?.uom?.code ?? ''}</TableCell>
                    <TableCell>{l.remarks}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {h.ackComment && <Alert severity="info" sx={{ mt: 2 }}>{h.ackComment}</Alert>}
            {pending && receiver && (
              <Stack spacing={1} sx={{ mt: 2 }}>
                <TextField label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button variant="contained" disabled={ack.isPending} onClick={() => ack.mutate()} sx={{ alignSelf: 'flex-start' }}>I have received these</Button>
              </Stack>
            )}
            {pending && officer && (
              <Stack spacing={1} sx={{ mt: 2 }}>
                <Typography variant="body2" color="text.secondary">The receiver confirms in the app, or at the counter by giving you the code sent to them.</Typography>
                <OtpPanel h={h} />
                <Button color="error" onClick={() => cancel.mutate()} sx={{ alignSelf: 'flex-start' }}>Cancel hand-over</Button>
              </Stack>
            )}
          </Paper>
        }
        side={
          <>
            <AttachmentsPanel ownerType="HANDOVER" ownerId={h.id} categories={['SIGNED_NOTE', 'PHOTO', 'GENERAL']} canUpload={officer} />
            <DocumentChain type="HOV" id={h.id} />
          </>
        }
      />
    </>
  );
}

/** Deliveries and hand-overs waiting for the signed-in user. */
export function AwaitingMePanel() {
  const certs = useList<{ id: string; number: string; orderNumber: string; supplier: string; requisitionNumber: string }>('/service-certificates/awaiting-me');
  const handovers = useList<Handover>('/handovers?mine=true&status=PENDING');
  const c = certs.data ?? [];
  const h = handovers.data ?? [];
  if (!c.length && !h.length) return null;
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <Typography fontWeight={600}>Waiting for you</Typography>
      {c.map((x) => (
        <div key={x.id}>
          Confirm the delivery on <Link component={RouterLink} to={`/service-certificates/${x.id}`}>{x.number}</Link> ({x.supplier}, {x.requisitionNumber})
        </div>
      ))}
      {h.map((x) => (
        <div key={x.id}>
          Collect / confirm <Link component={RouterLink} to={`/handovers/${x.id}`}>{x.number}</Link>{x.requisition ? ` (${x.requisition.number})` : ''}
        </div>
      ))}
    </Alert>
  );
}

import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { Alert, Box, Button, Chip, Link, Paper, Stack, Step, StepContent, StepLabel, Stepper, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client';
import { useApiMutation } from '../api/hooks';
import type { ApprovalHistory, ApprovalInboxRow, ChainNode } from '../api/purchasing-types';
import { formatDate, formatMoney, humanise } from '../lib/format';
import { useSettings } from '../settings/SettingsContext';
import { StatusChip } from '../inventory/components';

/** Front-end route for each document type in the chain. */
export const DOC_ROUTES: Partial<Record<string, (id: string) => string>> = {
  PR: (id) => `/requisitions/${id}`,
  RFQ: (id) => `/rfqs/${id}`,
  PO: (id) => `/purchase-orders/${id}`,
  GRN: (id) => `/grns/${id}`,
  INV: (id) => `/invoices/${id}`,
  PV: (id) => `/payment-vouchers/${id}`,
  PCV: (id) => `/petty-cash/${id}`,
  PCRP: (id) => `/petty-cash/replenishments/${id}`,
  RTS: (id) => `/supplier-returns/${id}`,
  SR: (id) => `/store-requisitions/${id}`,
  ISS: (id) => `/issues/${id}`,
  DRT: (id) => `/department-returns/${id}`,
  APP: (id) => `/procurement-plans/${id}`,
  TND: (id) => `/tenders/${id}`,
  CTR: (id) => `/contracts/${id}`,
  DSL: (id) => `/disposals/${id}`,
  RCL: (id) => `/recalls/${id}`,
  SCC: (id) => `/service-certificates/${id}`,
  HOV: (id) => `/handovers/${id}`,
  DRN: (id) => `/distribution/${id}`,
};

export const DOC_LABELS: Record<string, string> = {
  REQ: 'Staff requisition',
  HOV: 'Hand-over',
  PR: 'Purchase requisition',
  RFQ: 'RFQ',
  PO: 'Purchase order',
  GRN: 'Goods received',
  INV: 'Invoice',
  PV: 'Payment voucher',
  PCV: 'Petty cash voucher',
  PCRP: 'Petty cash replenishment',
  RTS: 'Return to supplier',
  SR: 'Internal requisition',
  ISS: 'Issue voucher',
  DRT: 'Department return',
  APP: 'Procurement plan',
  TND: 'Tender',
  CTR: 'Contract',
  CV: 'Contract variation',
  SSN: 'Supplier sanction',
  DSL: 'Disposal',
  RCL: 'Recall',
  SCC: 'Acceptance / completion certificate',
  SHP: 'Inbound shipment',
  DRN: 'Delivery run',
};

const ORDER = ['APP', 'REQ', 'PR', 'TND', 'CTR', 'CV', 'RFQ', 'PO', 'SHP', 'GRN', 'SCC', 'RTS', 'INV', 'PV', 'HOV', 'PCRP', 'PCV', 'SR', 'ISS', 'DRT', 'DRN', 'RCL', 'DSL'];

export function useMoney() {
  const { currency } = useSettings();
  return (v: number | null | undefined) => formatMoney(v ?? 0, currency);
}

export function useDate() {
  const { dateFormat, timezone } = useSettings();
  return (v: string | null | undefined) => (v ? formatDate(v.length === 10 ? `${v}T12:00:00Z` : v, dateFormat, timezone) : '');
}

/** PR → RFQ → PO → GRN → invoice → payment, linked both ways. */
export function DocumentChain({ type, id }: { type: string; id: string }) {
  const money = useMoney();
  const date = useDate();
  const { data } = useQuery({ queryKey: ['/documents/chain', type, id], queryFn: () => api<{ nodes: ChainNode[] }>('/documents/chain', { query: { type, id } }) });
  const nodes = [...(data?.nodes ?? [])].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.no.localeCompare(b.no));
  return (
    <Paper sx={{ p: 2 }} aria-label="Document chain">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <AccountTreeIcon fontSize="small" color="primary" />
        <Typography variant="subtitle1" fontWeight={600}>
          Document chain
        </Typography>
      </Stack>
      {nodes.length === 0 && <Typography color="text.secondary">No linked documents yet.</Typography>}
      <Stack spacing={1}>
        {nodes.map((n) => {
          const current = n.type === type && n.id === id;
          const route = DOC_ROUTES[n.type];
          return (
            <Stack key={n.key} direction="row" spacing={1} alignItems="center" sx={{ opacity: current ? 1 : 0.9 }}>
              <Chip size="small" label={DOC_LABELS[n.type] ?? n.type} variant={current ? 'filled' : 'outlined'} color={current ? 'primary' : 'default'} sx={{ minWidth: 120 }} />
              {route && !current ? (
                <Link component={RouterLink} to={route(n.id)}>
                  {n.no}
                </Link>
              ) : (
                <Typography fontWeight={current ? 600 : 400}>{n.no}</Typography>
              )}
              {n.status && <Typography variant="body2" color="text.secondary">{humanise(n.status.split(' ')[0])}{n.status.includes(' ') ? n.status.slice(n.status.indexOf(' ')) : ''}</Typography>}
              {n.amount != null && <Typography variant="body2">{money(n.amount)}</Typography>}
              {n.date && <Typography variant="body2" color="text.secondary">{date(n.date)}</Typography>}
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}

/** Approval history and, if the user can act on the current step, decision buttons. */
export function ApprovalPanel({ type, id }: { type: string; id: string }) {
  const date = useDate();
  const [comment, setComment] = useState('');
  const history = useQuery({ queryKey: ['/approvals/history', type, id], queryFn: () => api<ApprovalHistory[]>('/approvals/history', { query: { type, id } }) });
  const inbox = useQuery({ queryKey: ['/approvals/inbox'], queryFn: () => api<ApprovalInboxRow[]>('/approvals/inbox') });
  const mine = inbox.data?.find((r) => r.documentId === id && r.documentType === type);
  const decide = useApiMutation<'approve' | 'reject' | 'return'>((action) => [`/approvals/${mine!.id}/${action}`, { method: 'POST', body: { comment: comment || undefined } }], {
    invalidate: ['/approvals', '/requisitions', '/purchase-orders', '/invoices', '/budgets', '/documents', '/notifications', '/store-requisitions', '/procurement-plans', '/tenders', '/contracts', '/supplier-performance', '/disposals'],
    success: 'Decision recorded',
  });
  const latest = history.data?.at(-1);
  return (
    <Paper sx={{ p: 2 }} aria-label="Approvals">
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Approvals {latest && <StatusChip status={latest.status} />}
      </Typography>
      {!latest && <Typography color="text.secondary">Not submitted yet.</Typography>}
      {latest && (
        <>
          <Typography variant="body2" color="text.secondary">
            {latest.workflow?.name}
          </Typography>
          <Stepper orientation="vertical" activeStep={latest.workflow?.steps.findIndex((s) => s.sequence === latest.currentStep) ?? 0} sx={{ mt: 1 }}>
            {(latest.workflow?.steps ?? []).map((s) => {
              const acts = latest.actions.filter((a) => a.stepSequence === s.sequence);
              const approved = acts.some((a) => a.action === 'APPROVE');
              return (
                <Step key={s.sequence} completed={approved}>
                  <StepLabel optional={<Typography variant="caption">{s.role?.name ?? 'Named approver'}</Typography>}>{s.name}</StepLabel>
                  <StepContent TransitionProps={{ unmountOnExit: false }}>
                    {acts.map((a) => (
                      <Typography key={a.id} variant="body2">
                        {humanise(a.action)} by {a.userName}
                        {a.onBehalfOfName ? ` for ${a.onBehalfOfName}` : ''} · {date(a.at)}
                        {a.comment ? ` — “${a.comment}”` : ''}
                      </Typography>
                    ))}
                  </StepContent>
                </Step>
              );
            })}
          </Stepper>
          {latest.actions
            .filter((a) => ['REJECT', 'RETURN'].includes(a.action))
            .map((a) => (
              <Alert key={a.id} severity={a.action === 'REJECT' ? 'error' : 'warning'} sx={{ mt: 1 }}>
                {humanise(a.action)}ed by {a.userName}: {a.comment}
              </Alert>
            ))}
        </>
      )}
      {mine && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          <Typography variant="body2">Awaiting your decision ({mine.stepName}).</Typography>
          <TextField label="Comment (required to reject or return)" value={comment} onChange={(e) => setComment(e.target.value)} multiline minRows={2} />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" color="success" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              Approve
            </Button>
            <Button color="warning" disabled={!comment || decide.isPending} onClick={() => decide.mutate('return')}>
              Return for amendment
            </Button>
            <Button color="error" disabled={!comment || decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject
            </Button>
          </Stack>
        </Stack>
      )}
    </Paper>
  );
}

export function DetailLayout({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' }, gap: 2, alignItems: 'start' }}>
      <Stack spacing={2} sx={{ minWidth: 0 }}>
        {main}
      </Stack>
      <Stack spacing={2}>{side}</Stack>
    </Box>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Box>{children}</Box>
    </Box>
  );
}

import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { API_BASE } from '../api/client';

interface LinkInfo {
  documentType: string;
  documentNo: string;
  amount: number;
  currency: string | null;
  summary: string | null;
  stepName: string | null;
  approver: string | null;
  expiresAt: string;
}

/**
 * Approve, reject or return a document from the link in an approval email —
 * without signing in. The token is single use and expires.
 */
export function ApproveLinkPage({ token }: { token: string }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/approval-links/${encodeURIComponent(token)}`)
      .then(async (r) => (r.ok ? setInfo(await r.json()) : setError((await r.json().catch(() => ({}))).message ?? 'This link is not valid')))
      .catch(() => setError('The system could not be reached'));
  }, [token]);

  const act = async (action: 'APPROVE' | 'REJECT' | 'RETURN') => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/approval-links/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, comment: comment || undefined }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setError(body.message ?? 'That did not work');
      else setDone(action === 'APPROVE' ? `Approved. ${body.documentNo} is now ${String(body.status).toLowerCase()}.` : action === 'REJECT' ? `${body.documentNo} rejected.` : `${body.documentNo} returned for amendment.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, maxWidth: 520, width: '100%' }}>
        <Typography variant="h6" gutterBottom>Approval</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {done && <Alert severity="success">{done}</Alert>}
        {info && !done && !error && (
          <Stack spacing={2}>
            <Typography>
              <b>{info.documentNo}</b> · {info.currency ?? ''} {Number(info.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </Typography>
            {info.summary && <Typography variant="body2">{info.summary}</Typography>}
            <Typography variant="body2" color="text.secondary">
              Step “{info.stepName}” for {info.approver}. The link works once and expires {new Date(info.expiresAt).toLocaleString()}.
            </Typography>
            <TextField label="Comment (needed to reject or return)" multiline minRows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            <Stack direction="row" spacing={1}>
              <Button variant="contained" color="success" disabled={busy} onClick={() => act('APPROVE')}>Approve</Button>
              <Button variant="outlined" disabled={busy || !comment.trim()} onClick={() => act('RETURN')}>Return for amendment</Button>
              <Button color="error" disabled={busy || !comment.trim()} onClick={() => act('REJECT')}>Reject</Button>
            </Stack>
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
          To see the whole document, sign in to the system.
        </Typography>
      </Paper>
    </Box>
  );
}

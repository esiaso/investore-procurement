import { Chip, Tooltip } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface SyncState {
  localDocId: string;
  status: 'SYNCED' | 'PENDING' | 'FAILED' | 'NOT_QUEUED';
  postings: { docType: string; status: string; externalId: string | null; error: string | null }[];
}

const COLOURS = { SYNCED: 'success', PENDING: 'info', FAILED: 'error', NOT_QUEUED: 'default' } as const;
const LABELS = { SYNCED: 'QuickBooks: synced', PENDING: 'QuickBooks: pending', FAILED: 'QuickBooks: failed', NOT_QUEUED: 'QuickBooks: not sent' } as const;

/** QuickBooks sync status of a document (and what failed, on hover). */
export function SyncChip({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['/accounting/sync-status', id], queryFn: () => api<SyncState[]>('/accounting/sync-status', { query: { ids: id } }), staleTime: 30_000, retry: false });
  const s = data?.[0];
  if (!s) return null;
  const detail = s.postings.map((p) => `${p.docType.replace(/_/g, ' ').toLowerCase()}: ${p.status.toLowerCase()}${p.externalId ? ` (#${p.externalId})` : ''}${p.error ? ` — ${p.error}` : ''}`).join('\n');
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{detail || 'Not queued for QuickBooks yet'}</span>}>
      <Chip size="small" variant="outlined" color={COLOURS[s.status]} label={LABELS[s.status]} />
    </Tooltip>
  );
}

import AttachFileIcon from '@mui/icons-material/AttachFile';
import { Box, Button, Chip, Link, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Permissions } from '@sil/shared';
import { api, API_BASE, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useNotify } from '../components/Notify';
import { useDate } from '../purchasing/common';

export interface AttachmentRow {
  id: string;
  ownerType: string;
  ownerId: string;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  isCurrent: boolean;
  generated: boolean;
  notes: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const downloadUrl = (id: string) => `${API_BASE}/attachments/${id}/download`;

/** Uploads one file to a record; a file with the same name and category becomes a new version. */
export async function uploadAttachment(ownerType: string, ownerId: string, category: string, file: File, notes?: string) {
  const form = new FormData();
  form.set('ownerType', ownerType);
  form.set('ownerId', ownerId);
  form.set('category', category);
  if (notes) form.set('notes', notes);
  form.set('file', file);
  return api<AttachmentRow>('/attachments', { method: 'POST', form });
}

/**
 * Files on a record (current versions; older versions on demand), with
 * upload for users who may attach. Stored in object storage (MinIO).
 */
export function AttachmentsPanel({ ownerType, ownerId, categories = ['GENERAL'], title = 'Attachments', canUpload = true }: { ownerType: string; ownerId: string; categories?: string[]; title?: string; canUpload?: boolean }) {
  const { can } = useAuth();
  const date = useDate();
  const notify = useNotify();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(categories[0]);
  const [versions, setVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = ['/attachments', ownerType, ownerId, versions];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<AttachmentRow[]>('/attachments', { query: { ownerType, ownerId, versions: versions || undefined } }) });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const a = await uploadAttachment(ownerType, ownerId, category, file);
      notify.success(a.version > 1 ? `Uploaded as version ${a.version}` : 'File attached');
      await qc.invalidateQueries({ queryKey: ['/attachments', ownerType, ownerId] });
    } catch (e) {
      notify.error((e as ApiError).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Paper sx={{ p: 2 }} aria-label={title}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <AttachFileIcon fontSize="small" color="primary" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flexGrow: 1 }}>{title}</Typography>
        <Button size="small" onClick={() => setVersions(!versions)}>{versions ? 'Current only' : 'All versions'}</Button>
      </Stack>
      {(data ?? []).length === 0 && <Typography color="text.secondary">No files.</Typography>}
      <Stack spacing={0.75}>
        {(data ?? []).map((a) => (
          <Box key={a.id}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Link href={downloadUrl(a.id)}>{a.fileName}</Link>
              <Chip size="small" label={a.category.replace(/_/g, ' ').toLowerCase()} />
              {a.version > 1 && <Chip size="small" variant="outlined" label={`v${a.version}`} />}
              {!a.isCurrent && <Chip size="small" variant="outlined" label="superseded" />}
              {a.generated && <Chip size="small" color="info" variant="outlined" label="generated" />}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {formatBytes(a.sizeBytes)} · {date(a.uploadedAt)}{a.uploadedBy ? ` · ${a.uploadedBy}` : ''} · SHA-256 {a.sha256.slice(0, 12)}…
            </Typography>
          </Box>
        ))}
      </Stack>
      {canUpload && can(Permissions.FILES_UPLOAD) && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
          {categories.length > 1 && (
            <TextField select size="small" label="Type" value={category} onChange={(e) => setCategory(e.target.value)} sx={{ minWidth: 170, width: 'auto' }}>
              {categories.map((c) => <MenuItem key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</MenuItem>)}
            </TextField>
          )}
          <Button component="label" size="small" variant="outlined" disabled={busy}>
            {busy ? 'Uploading…' : 'Attach file'}
            <input ref={input} hidden type="file" aria-label="File to attach" onChange={(e) => upload(e.target.files?.[0])} />
          </Button>
        </Stack>
      )}
    </Paper>
  );
}

import DownloadIcon from '@mui/icons-material/Download';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ImportIssue, ImportReport } from '@sil/shared';
import { api, API_BASE, ApiError } from '../api/client';
import { PageHeader } from '../components/PageHeader';

function IssueTable({ title, issues, severity }: { title: string; issues: ImportIssue[]; severity: 'error' | 'warning' }) {
  if (!issues.length) return null;
  return (
    <Box>
      <Typography variant="subtitle1" color={severity === 'error' ? 'error' : 'warning.main'} gutterBottom>
        {title} ({issues.length})
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
        <Table size="small" stickyHeader aria-label={title}>
          <TableHead>
            <TableRow>
              <TableCell width={80}>Row</TableCell>
              <TableCell width={160}>Column</TableCell>
              <TableCell>Problem</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {issues.map((i, idx) => (
              <TableRow key={idx}>
                <TableCell>{i.row}</TableCell>
                <TableCell>{i.field}</TableCell>
                <TableCell>{i.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export function ImportPage() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const run = useMutation<ImportReport, ApiError, boolean>({
    mutationFn: (dryRun) => {
      const form = new FormData();
      form.append('file', file!);
      return api<ImportReport>('/catalog/import/items', { method: 'POST', form, query: { dryRun, skipDuplicates } });
    },
    onSuccess: (r) => {
      setReport(r);
      if (r.committed) qc.invalidateQueries({ predicate: (q) => /^\/(items|generics)/.test(String(q.queryKey[0])) });
    },
  });

  const canCommit =
    !!report && report.dryRun && report.errors.length === 0 && report.validRows > 0 && (skipDuplicates || report.duplicates.length === 0);

  return (
    <>
      <PageHeader
        title="Bulk import items"
        actions={
          <Button startIcon={<DownloadIcon />} href={`${API_BASE}/catalog/import/items/template`}>
            Download template
          </Button>
        }
      />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Upload a CSV or Excel (.xlsx) file. The first row must hold the column names from the template. Category-specific
            attributes go in <code>attr_&lt;key&gt;</code> columns. Validate first; the import is all-or-nothing.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx"
              hidden
              aria-label="Import file"
              data-testid="import-file"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReport(null);
              }}
            />
            <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => inputRef.current?.click()}>
              {file ? file.name : 'Choose file'}
            </Button>
            <FormControlLabel
              control={<Checkbox checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />}
              label="Skip duplicates"
            />
            <Button variant="contained" disabled={!file || run.isPending} onClick={() => run.mutate(true)}>
              Validate
            </Button>
            <Button variant="contained" color="success" disabled={!canCommit || run.isPending} onClick={() => run.mutate(false)}>
              Import {report?.validRows ? `${report.validRows} items` : ''}
            </Button>
          </Stack>
          {run.error && <Alert severity="error">{run.error.message}</Alert>}
        </Stack>
      </Paper>

      {report && (
        <Stack spacing={2}>
          {report.committed ? (
            <Alert severity="success">
              Imported {report.createdItems} items and {report.createdGenerics} new generics
              {report.skippedDuplicates ? `; skipped ${report.skippedDuplicates} duplicate rows` : ''}.
            </Alert>
          ) : (
            <Alert severity={report.errors.length ? 'error' : report.duplicates.length && !skipDuplicates ? 'warning' : 'info'}>
              {report.totalRows} rows read · {report.validRows} valid · {report.errors.length} errors · {report.duplicates.length}{' '}
              duplicates{report.dryRun ? ' (validation only, nothing saved)' : ' — nothing was imported'}
            </Alert>
          )}
          <IssueTable title="Errors" issues={report.errors} severity="error" />
          <IssueTable title="Duplicates" issues={report.duplicates} severity="warning" />
        </Stack>
      )}
    </>
  );
}

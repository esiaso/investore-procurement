import { Box, MenuItem, Paper, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { AuditAction } from '@sil/shared';
import { usePaged } from '../api/hooks';
import type { AuditEntry } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { formatDate } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';

const json = (v: unknown) => (v ? JSON.stringify(v) : '');

export function AuditPage() {
  const { dateFormat, timezone } = useSettings();
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 50 });
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const type = useDebounced(entityType);
  const { data, isFetching } = usePaged<AuditEntry>('/audit-logs', { ...pagination, entityType: type, action });

  const columns: GridColDef<AuditEntry>[] = [
    { field: 'occurredAt', headerName: 'When', width: 150, valueFormatter: (v: string) => formatDate(v, dateFormat, timezone, true) },
    { field: 'username', headerName: 'User', width: 130 },
    { field: 'action', headerName: 'Action', width: 130 },
    { field: 'entityType', headerName: 'Entity', width: 140 },
    { field: 'entityId', headerName: 'Entity id', width: 150 },
    { field: 'ip', headerName: 'IP', width: 120 },
    { field: 'after', headerName: 'Change', flex: 1, minWidth: 200, sortable: false, valueGetter: (_v, row) => json(row.after ?? row.before) },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        actions={
          <>
            <TextField label="Entity type" value={entityType} onChange={(e) => setEntityType(e.target.value)} sx={{ width: { xs: '100%', sm: 180 } }} />
            <TextField select label="Action" value={action} onChange={(e) => setAction(e.target.value)} sx={{ width: { xs: '100%', sm: 180 } }}>
              <MenuItem value="">All actions</MenuItem>
              {Object.values(AuditAction).map((a) => (
                <MenuItem key={a} value={a}>
                  {a}
                </MenuItem>
              ))}
            </TextField>
          </>
        }
      />
      <Paper>
        <DataGrid
          autoHeight
          rows={data?.items ?? []}
          rowCount={data?.total ?? 0}
          columns={columns}
          loading={isFetching}
          paginationMode="server"
          paginationModel={pagination}
          onPaginationModelChange={setPagination}
          pageSizeOptions={[50, 100]}
          onRowClick={({ row }) => setSelected(row)}
        />
      </Paper>
      {selected && (
        <Paper sx={{ p: 2, mt: 2 }}>
          <Typography variant="subtitle1">
            {selected.action} {selected.entityType} {selected.entityId}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontSize: 12, m: 0 }}>
              Before: {JSON.stringify(selected.before, null, 2)}
            </Box>
            <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontSize: 12, m: 0 }}>
              After: {JSON.stringify(selected.after, null, 2)}
            </Box>
          </Box>
        </Paper>
      )}
    </>
  );
}

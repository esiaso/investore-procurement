import CloseIcon from '@mui/icons-material/Close';
import {
  Box,
  Chip,
  Drawer,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { BatchHoldStatus, Permissions } from '@sil/shared';
import { usePaged } from '../api/hooks';
import type { LedgerRow, StockRow } from '../api/inventory-types';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { formatDate, formatMoney, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';
import { ExpiryChip, HoldChip, StoreSelect } from './components';

export function BinCard({ storeId, itemId, title, onClose }: { storeId: string; itemId: string; title: string; onClose(): void }) {
  const { currency, dateFormat, timezone } = useSettings();
  const { can } = useAuth();
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 50 });
  const { data, isFetching } = usePaged<LedgerRow>('/inventory/ledger', { ...pagination, storeId, itemId });
  const columns: GridColDef<LedgerRow>[] = [
    { field: 'effectiveDate', headerName: 'Date', width: 105, valueFormatter: (v: string) => formatDate(`${v}T12:00:00Z`, dateFormat, timezone) },
    { field: 'txnType', headerName: 'Type', width: 150, valueFormatter: (v: string) => humanise(v) },
    { field: 'sourceDocNo', headerName: 'Document', width: 170 },
    {
      field: 'batchNo',
      headerName: 'Batch',
      width: 110,
      renderCell: ({ row }) => (
        <Link component={RouterLink} to={`/batches/${row.batchId}/trace`} onClick={onClose}>
          {row.batchNo}
        </Link>
      ),
    },
    { field: 'from', headerName: 'From', width: 170 },
    { field: 'to', headerName: 'To', width: 170 },
    { field: 'quantity', headerName: 'Qty', type: 'number', width: 90 },
    { field: 'inTransitDelta', headerName: 'In transit', type: 'number', width: 90, valueFormatter: (v: number) => (v ? v : '') },
    { field: 'balance', headerName: 'Balance', type: 'number', width: 100 },
    ...(can(Permissions.INVENTORY_VALUATION)
      ? [{ field: 'valueDelta', headerName: 'Value', type: 'number', width: 120, valueFormatter: (v: number) => formatMoney(v, currency) } as GridColDef<LedgerRow>]
      : []),
    {
      field: 'detail',
      headerName: 'Detail',
      flex: 1,
      minWidth: 200,
      sortable: false,
      valueGetter: (_v, r) =>
        [r.patientRef && `patient ${r.patientRef}`, r.reasonCode, r.fefoOverrideReason && `FEFO override: ${r.fefoOverrideReason}`, r.user, r.secondSigner && `witness ${r.secondSigner}`]
          .filter(Boolean)
          .join(' · '),
    },
  ];
  return (
    <Box sx={{ width: { xs: '100vw', md: 1300 }, p: 2 }} role="region" aria-label="Bin card">
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>
          Bin card · {title}
        </Typography>
        <IconButton aria-label="Close bin card" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <DataGrid
        autoHeight
        density="compact"
        rows={data?.items ?? []}
        rowCount={data?.total ?? 0}
        columns={columns}
        loading={isFetching}
        paginationMode="server"
        paginationModel={pagination}
        onPaginationModelChange={setPagination}
        pageSizeOptions={[50, 100]}
        disableRowSelectionOnClick
      />
    </Box>
  );
}

export function StockPage() {
  const { can } = useAuth();
  const { currency, expiryWarningDays } = useSettings();
  const [storeId, setStoreId] = useState('');
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<'item' | 'batch'>('item');
  const [expiry, setExpiry] = useState('');
  const [hold, setHold] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 50 });
  const [card, setCard] = useState<StockRow | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<StockRow>('/inventory/stock', {
    ...pagination,
    storeId,
    search: q,
    groupBy,
    expired: expiry === 'expired' ? true : undefined,
    expiringWithinDays: expiry && expiry !== 'expired' ? Number(expiry) : undefined,
    holdStatus: hold,
  });
  const showValue = can(Permissions.INVENTORY_VALUATION);
  const reset = () => setPagination((p) => ({ ...p, page: 0 }));

  const columns: GridColDef<StockRow>[] = [
    { field: 'storeName', headerName: 'Store', width: 150 },
    { field: 'itemCode', headerName: 'Code', width: 110 },
    {
      field: 'itemName',
      headerName: 'Item',
      flex: 1,
      minWidth: 220,
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
          <span>{row.itemName}</span>
          {row.isControlled && <Chip size="small" color="error" label="CD" />}
          {row.isColdChain && <Chip size="small" color="info" label="2–8°C" />}
        </Stack>
      ),
    },
    ...(groupBy === 'batch'
      ? ([
          { field: 'batchNo', headerName: 'Batch', width: 120 },
          {
            field: 'binCode',
            headerName: 'Bin',
            width: 130,
            renderCell: ({ row }) => (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
                <span>{row.binCode}</span>
                {row.inQuarantine && <Chip size="small" color="warning" label="Quarantine" />}
              </Stack>
            ),
          },
          { field: 'expiryDate', headerName: 'Expiry', width: 170, renderCell: ({ value }) => <ExpiryChip date={value} /> },
          { field: 'holdStatus', headerName: 'Hold', width: 110, renderCell: ({ value }) => <HoldChip status={value} /> },
        ] as GridColDef<StockRow>[])
      : ([
          { field: 'batches', headerName: 'Batches', type: 'number', width: 80 },
          { field: 'nearestExpiry', headerName: 'Nearest expiry', width: 170, renderCell: ({ value }) => <ExpiryChip date={value} /> },
          { field: 'usable', headerName: 'Usable', type: 'number', width: 90 },
        ] as GridColDef<StockRow>[])),
    { field: 'onHand', headerName: 'On hand', type: 'number', width: 100 },
    { field: 'reserved', headerName: 'Reserved', type: 'number', width: 90, valueFormatter: (v: number) => (v ? v : '') },
    { field: 'inTransit', headerName: 'In transit', type: 'number', width: 90 },
    { field: 'uom', headerName: 'Unit', width: 70 },
    ...(showValue
      ? [{ field: 'value', headerName: 'Value', type: 'number', width: 130, valueFormatter: (v: number) => formatMoney(v, currency) } as GridColDef<StockRow>]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Stock on hand"
        search={search}
        searchPlaceholder="Search item, code, GTIN, batch, generic"
        onSearch={(v) => {
          setSearch(v);
          reset();
        }}
      />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <StoreSelect value={storeId} onChange={(v) => { setStoreId(v); reset(); }} allowAll="All my stores" sx={{ width: { xs: '100%', md: 220 } }} />
        <TextField select label="Expiry" value={expiry} onChange={(e) => { setExpiry(e.target.value); reset(); }} sx={{ width: { xs: '100%', md: 200 } }}>
          <MenuItem value="">Any</MenuItem>
          <MenuItem value="expired">Expired</MenuItem>
          {[...expiryWarningDays].sort((a, b) => a - b).map((d) => (
            <MenuItem key={d} value={String(d)}>
              Within {d} days
            </MenuItem>
          ))}
        </TextField>
        <TextField select label="Hold" value={hold} onChange={(e) => { setHold(e.target.value); reset(); }} sx={{ width: { xs: '100%', md: 170 } }}>
          <MenuItem value="">Any</MenuItem>
          {Object.values(BatchHoldStatus).map((s) => (
            <MenuItem key={s} value={s}>
              {humanise(s)}
            </MenuItem>
          ))}
        </TextField>
        <ToggleButtonGroup exclusive size="small" value={groupBy} onChange={(_, v) => v && (setGroupBy(v), reset())} aria-label="Group by">
          <ToggleButton value="item">By item</ToggleButton>
          <ToggleButton value="batch">By batch</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          getRowId={(r) => r.id ?? `${r.storeId}:${r.itemId}`}
          rows={data?.items ?? []}
          rowCount={data?.total ?? 0}
          columns={columns}
          loading={isFetching}
          paginationMode="server"
          paginationModel={pagination}
          onPaginationModelChange={setPagination}
          pageSizeOptions={[50, 100, 200]}
          onRowClick={({ row }) => setCard(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      <Drawer anchor="right" open={!!card} onClose={() => setCard(null)}>
        {card && <BinCard storeId={card.storeId} itemId={card.itemId} title={`${card.itemName} · ${card.storeName}`} onClose={() => setCard(null)} />}
      </Drawer>
    </>
  );
}

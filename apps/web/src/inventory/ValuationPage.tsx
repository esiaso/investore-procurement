import { MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { formatMoney } from '../lib/format';
import { StoreSelect } from './components';

interface Valuation {
  asOf: string;
  method: string;
  currency: string;
  groupBy: string;
  total: number;
  rows: Record<string, string | number>[];
}

export function ValuationPage() {
  const [groupBy, setGroupBy] = useState('store');
  const [storeId, setStoreId] = useState('');
  const [asOf, setAsOf] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['/inventory/valuation', groupBy, storeId, asOf],
    queryFn: () => api<Valuation>('/inventory/valuation', { query: { groupBy, storeId, asOf } }),
  });
  const key = groupBy === 'store' ? 'storeName' : groupBy === 'category' ? 'categoryName' : 'itemName';
  const columns: GridColDef[] = [
    { field: key, headerName: groupBy === 'store' ? 'Store' : groupBy === 'category' ? 'Category' : 'Item', flex: 1, minWidth: 200 },
    { field: 'quantity', headerName: 'Quantity (base units)', type: 'number', width: 180 },
    { field: 'value', headerName: 'Value', type: 'number', width: 180, valueFormatter: (v: number) => formatMoney(v, data?.currency ?? 'KES') },
  ];
  return (
    <>
      <PageHeader title="Stock valuation" />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField select label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} sx={{ width: { sm: 180 } }}>
          <MenuItem value="store">Store</MenuItem>
          <MenuItem value="category">Category</MenuItem>
          <MenuItem value="item">Item</MenuItem>
        </TextField>
        <StoreSelect value={storeId} onChange={setStoreId} allowAll="All my stores" sx={{ width: { sm: 220 } }} />
        <TextField label="As at" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: { sm: 180 } }} />
      </Stack>
      <Typography sx={{ mb: 1 }}>
        {data ? `Total ${formatMoney(data.total, data.currency)} as at ${data.asOf} · method ${data.method === 'WAC' ? 'weighted average cost' : 'FIFO (batch cost)'}` : ''}
      </Typography>
      <Paper>
        <DataGrid
          autoHeight
          density="compact"
          rows={(data?.rows ?? []).map((r, i) => ({ id: i, ...r }))}
          columns={columns}
          loading={isFetching}
          initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
          pageSizeOptions={[50, 100]}
          disableRowSelectionOnClick
        />
      </Paper>
    </>
  );
}

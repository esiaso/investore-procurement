import { zodResolver } from '@hookform/resolvers/zod';
import CloseIcon from '@mui/icons-material/Close';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  AttributeDefinition,
  AttributeType,
  ItemInput,
  itemSchema,
  Paginated,
  Permissions,
  SalesClass,
  validateAttributes,
} from '@sil/shared';
import { api } from '../api/client';
import { useApiMutation, useList, usePaged } from '../api/hooks';
import type { Generic, Item, ItemCategory, TaxCategory, Uom } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { enumOptions, RHFCheckbox, RHFNumber, RHFSelect, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { emptyToNull, formatMoney } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';

const genericLabel = (g: Generic) => [g.innName, g.strength, g.dosageForm].filter(Boolean).join(' ');

function GenericPicker({ value, onChange, error }: { value: Generic | null; onChange(g: Generic | null): void; error?: string }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input);
  const { data, isFetching } = useQuery({
    queryKey: ['/generics', 'picker', q],
    queryFn: () => api<Paginated<Generic>>('/generics', { query: { search: q, pageSize: 20, active: true } }),
    enabled: q.length >= 2,
  });
  return (
    <Autocomplete
      value={value}
      options={data?.items ?? (value ? [value] : [])}
      loading={isFetching}
      getOptionLabel={genericLabel}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterOptions={(x) => x}
      onInputChange={(_, v) => setInput(v)}
      onChange={(_, g) => onChange(g)}
      renderInput={(params) => (
        <TextField {...params} label="Generic (INN)" error={!!error} helperText={error ?? 'Type 2+ letters to search'} />
      )}
    />
  );
}

function AttributeField({ def, value, onChange, error }: { def: AttributeDefinition; value: unknown; onChange(v: unknown): void; error?: string }) {
  const label = `${def.label}${def.required ? ' *' : ''}`;
  switch (def.type) {
    case AttributeType.BOOLEAN:
      return (
        <TextField select label={label} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')} error={!!error} helperText={error}>
          <MenuItem value="">—</MenuItem>
          <MenuItem value="true">Yes</MenuItem>
          <MenuItem value="false">No</MenuItem>
        </TextField>
      );
    case AttributeType.ENUM:
      return (
        <TextField select label={label} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} error={!!error} helperText={error}>
          <MenuItem value="">—</MenuItem>
          {(def.options ?? []).map((o) => (
            <MenuItem key={o} value={o}>
              {o}
            </MenuItem>
          ))}
        </TextField>
      );
    case AttributeType.NUMBER:
      return (
        <TextField type="number" label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} error={!!error} helperText={error} />
      );
    default:
      return <TextField label={label} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} error={!!error} helperText={error} />;
  }
}

function ItemDialog({ item, onClose }: { item: Item | 'new'; onClose(): void }) {
  const isNew = item === 'new';
  const categories = useList<ItemCategory>('/item-categories');
  const uoms = useList<Uom>('/uoms');
  const taxes = useList<TaxCategory>('/tax/categories');
  const [generic, setGeneric] = useState<Generic | null>(isNew ? null : (item.generic ?? null));
  const [attrErrors, setAttrErrors] = useState<Record<string, string>>({});

  const { control, handleSubmit, setValue, setError, formState } = useForm<ItemInput>({
    resolver: zodResolver(itemSchema),
    defaultValues: isNew
      ? {
          code: '', genericId: null, categoryId: '', name: '', brandName: '', manufacturer: '', ppbRegNo: '', packSize: '',
          gtin: '', barcode: '', baseUomId: '', unitPrice: 0, salesClass: null, taxCategoryId: '', isFormulary: false,
          isBatchTracked: true, isColdChain: false, isControlled: false, reorderLevel: null, attributes: {}, isActive: true,
        }
      : {
          code: item.code, genericId: item.genericId, categoryId: item.categoryId, name: item.name, brandName: item.brandName ?? '',
          manufacturer: item.manufacturer ?? '', ppbRegNo: item.ppbRegNo ?? '', packSize: item.packSize ?? '', gtin: item.gtin ?? '',
          barcode: item.barcode ?? '', baseUomId: item.baseUomId, unitPrice: item.unitPrice, salesClass: item.salesClass,
          taxCategoryId: item.taxCategoryId, isFormulary: item.isFormulary, isBatchTracked: item.isBatchTracked,
          isColdChain: item.isColdChain, isControlled: item.isControlled, reorderLevel: item.reorderLevel,
          attributes: item.attributes ?? {}, isActive: item.isActive,
        },
  });
  const categoryId = useWatch({ control, name: 'categoryId' });
  const category = categories.data?.find((c) => c.id === categoryId);
  const schema = category?.attributeSchema ?? [];

  const save = useApiMutation<ItemInput>(
    (values) => {
      const body = { ...emptyToNull(values), attributes: values.attributes };
      if (isNew && !values.code) delete (body as Partial<ItemInput>).code;
      return isNew ? ['/items', { method: 'POST', body }] : [`/items/${item.id}`, { method: 'PATCH', body }];
    },
    { invalidate: ['/items', '/generics'], success: 'Item saved' },
  );

  return (
    <FormDialog
      open
      maxWidth="md"
      title={isNew ? 'New item' : `Edit ${item.code}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => {
        // Keep only attributes defined for the chosen category.
        const attributes = Object.fromEntries(
          schema.map((d) => [d.key, values.attributes?.[d.key] ?? null]).filter(([, v]) => v !== null && v !== ''),
        );
        const errors = validateAttributes(schema, attributes);
        setAttrErrors(errors);
        if (Object.keys(errors).length) return;
        if (category?.isDrug && !values.genericId) {
          setError('genericId', { message: 'Drug items must map to a generic' });
          return;
        }
        save.mutate({ ...values, attributes }, { onSuccess: onClose });
      })}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFSelect
          control={control}
          name="categoryId"
          label="Category"
          options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          autoFocus
        />
        <RHFText control={control} name="code" label="Code" helperText={isNew ? 'Leave blank to auto-number' : undefined} disabled={!isNew} />
      </Stack>
      {(category?.isDrug ?? true) && (
        <GenericPicker
          value={generic}
          error={formState.errors.genericId?.message}
          onChange={(g) => {
            setGeneric(g);
            setValue('genericId', g?.id ?? null);
          }}
        />
      )}
      <RHFText control={control} name="name" label="Item name" />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="brandName" label="Brand" />
        <RHFText control={control} name="manufacturer" label="Manufacturer" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="ppbRegNo" label="PPB reg. no." />
        <RHFText control={control} name="packSize" label="Pack size" placeholder="10x10" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="gtin" label="GTIN" />
        <RHFText control={control} name="barcode" label="Other barcode" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFSelect control={control} name="baseUomId" label="Base unit of issue" options={(uoms.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }))} />
        <RHFNumber control={control} name="unitPrice" label="Unit price (excl. VAT)" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFSelect control={control} name="salesClass" label="Sales class" allowEmpty="None" options={enumOptions(SalesClass)} />
        <RHFSelect control={control} name="taxCategoryId" label="Tax category" options={(taxes.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        <RHFNumber control={control} name="reorderLevel" label="Reorder level" />
      </Stack>
      <Stack direction="row" flexWrap="wrap">
        <RHFCheckbox control={control} name="isFormulary" label="Formulary" />
        <RHFCheckbox control={control} name="isBatchTracked" label="Batch tracked" />
        <RHFCheckbox control={control} name="isColdChain" label="Cold chain" />
        <RHFCheckbox control={control} name="isControlled" label="Controlled" />
        <RHFCheckbox control={control} name="isActive" label="Active" />
      </Stack>
      {schema.length > 0 && (
        <>
          <Divider textAlign="left">{category?.name} attributes</Divider>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            {schema.map((def) => (
              <Controller
                key={def.key}
                control={control}
                name={`attributes.${def.key}`}
                render={({ field }) => (
                  <AttributeField def={def} value={field.value} onChange={field.onChange} error={attrErrors[def.key]} />
                )}
              />
            ))}
          </Box>
        </>
      )}
    </FormDialog>
  );
}

function ItemDetails({ item, onClose, onEdit }: { item: Item; onClose(): void; onEdit?(): void }) {
  const { currency } = useSettings();
  const equivalents = useList<Item>(`/items/${item.id}/equivalents`, undefined, !!item.genericId);
  return (
    <Box sx={{ width: { xs: '100vw', sm: 420 }, p: 2 }} role="region" aria-label="Item details">
      <Stack direction="row" alignItems="center">
        <Typography variant="h6" sx={{ flexGrow: 1 }}>
          {item.name}
        </Typography>
        <IconButton aria-label="Close details" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {item.code} · {item.category?.name}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ my: 1 }} flexWrap="wrap" useFlexGap>
        {item.salesClass && <Chip size="small" label={item.salesClass} />}
        {item.isFormulary && <Chip size="small" color="primary" label="Formulary" />}
        {item.isColdChain && <Chip size="small" color="info" label="Cold chain" />}
        {item.isControlled && <Chip size="small" color="error" label="Controlled" />}
      </Stack>
      <List dense>
        <ListItem disableGutters>
          <ListItemText primary="Generic" secondary={item.generic ? genericLabel(item.generic) : '— (non-drug)'} />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="Brand / manufacturer" secondary={[item.brandName, item.manufacturer].filter(Boolean).join(' · ') || '—'} />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="Pack / base unit" secondary={`${item.packSize ?? '—'} · ${item.baseUom?.name ?? ''}`} />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="Price (excl. VAT)" secondary={`${formatMoney(item.unitPrice, currency)} · ${item.taxCategory?.name ?? ''}`} />
        </ListItem>
        {Object.entries(item.attributes ?? {}).map(([k, v]) => (
          <ListItem key={k} disableGutters>
            <ListItemText primary={k} secondary={String(v)} />
          </ListItem>
        ))}
      </List>
      {onEdit && (
        <Button variant="outlined" onClick={onEdit} sx={{ mb: 2 }}>
          Edit item
        </Button>
      )}
      {item.genericId && (
        <>
          <Divider />
          <Typography variant="overline">Equivalent brands (substitutes)</Typography>
          {equivalents.data?.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No other active brands of this generic.
            </Typography>
          )}
          <List dense aria-label="Equivalent brands">
            {(equivalents.data ?? []).map((e) => (
              <ListItem key={e.id} disableGutters divider>
                <ListItemText primary={e.brandName ?? e.name} secondary={[e.manufacturer, e.packSize].filter(Boolean).join(' · ')} />
                <Typography variant="body2">{formatMoney(e.unitPrice, currency)}</Typography>
              </ListItem>
            ))}
          </List>
        </>
      )}
    </Box>
  );
}

export function ItemsPage() {
  const { can } = useAuth();
  const { currency } = useSettings();
  const categories = useList<ItemCategory>('/item-categories');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<Item | null>(null);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Item>('/items', { ...pagination, search: q, categoryId });
  const canManage = can(Permissions.CATALOG_MANAGE);

  const columns: GridColDef<Item>[] = [
    { field: 'code', headerName: 'Code', width: 110 },
    { field: 'name', headerName: 'Item', flex: 1.4, minWidth: 220 },
    { field: 'generic', headerName: 'Generic', flex: 1, minWidth: 160, valueGetter: (_v, row) => (row.generic ? genericLabel(row.generic) : '') },
    { field: 'manufacturer', headerName: 'Manufacturer', width: 170 },
    { field: 'packSize', headerName: 'Pack', width: 100 },
    { field: 'baseUom', headerName: 'Unit', width: 80, valueGetter: (_v, row) => row.baseUom?.code ?? '' },
    { field: 'unitPrice', headerName: 'Price', width: 120, type: 'number', valueFormatter: (v: number) => formatMoney(v, currency) },
    { field: 'salesClass', headerName: 'Class', width: 70 },
    { field: 'isFormulary', headerName: 'Formulary', width: 90, type: 'boolean' },
  ];

  return (
    <>
      <PageHeader
        title="Items & brands"
        search={search}
        searchPlaceholder="Search name, brand, generic, code, GTIN"
        onSearch={(v) => {
          setSearch(v);
          setPagination((p) => ({ ...p, page: 0 }));
        }}
        onNew={canManage ? () => setEditing('new') : undefined}
        actions={
          <TextField
            select
            label="Category"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPagination((p) => ({ ...p, page: 0 }));
            }}
            sx={{ width: { xs: '100%', sm: 220 } }}
          >
            <MenuItem value="">All categories</MenuItem>
            {(categories.data ?? []).map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
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
          pageSizeOptions={[25, 50, 100]}
          onRowClick={({ row }) => setSelected(row)}
          disableRowSelectionOnClick
        />
      </Paper>
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <ItemDetails
            item={selected}
            onClose={() => setSelected(null)}
            onEdit={
              canManage
                ? () => {
                    setEditing(selected);
                    setSelected(null);
                  }
                : undefined
            }
          />
        )}
      </Drawer>
      {editing && <ItemDialog item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

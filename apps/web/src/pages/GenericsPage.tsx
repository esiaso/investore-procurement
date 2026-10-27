import { zodResolver } from '@hookform/resolvers/zod';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Chip,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ControlledSchedule, GenericInput, genericSchema, Permissions } from '@sil/shared';
import { useApiMutation, usePaged } from '../api/hooks';
import type { Generic } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { enumOptions, RHFNumber, RHFSelect, RHFSwitch, RHFText } from '../components/form';
import { FormDialog } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { emptyToNull, formatMoney, humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useSettings } from '../settings/SettingsContext';

export function GenericDialog({ generic, onClose }: { generic: Generic | 'new'; onClose(): void }) {
  const isNew = generic === 'new';
  const { control, handleSubmit } = useForm<GenericInput>({
    resolver: zodResolver(genericSchema),
    defaultValues: isNew
      ? { innName: '', strength: '', dosageForm: '', route: '', atcCode: '', therapeuticClass: '', isKeml: false, controlledSchedule: ControlledSchedule.NONE, isActive: true }
      : {
          innName: generic.innName,
          strength: generic.strength,
          dosageForm: generic.dosageForm,
          route: generic.route,
          atcCode: generic.atcCode ?? '',
          therapeuticClass: generic.therapeuticClass ?? '',
          isKeml: generic.isKeml,
          controlledSchedule: generic.controlledSchedule,
          storageRequirements: generic.storageRequirements ?? '',
          pregnancyNotes: generic.pregnancyNotes ?? '',
          lactationNotes: generic.lactationNotes ?? '',
          pregnancyContraindicated: generic.pregnancyContraindicated ?? false,
          minAgeYears: generic.minAgeYears ?? null,
          maxQtyPerSale: generic.maxQtyPerSale ?? null,
          vedClass: generic.vedClass ?? null,
          isActive: generic.isActive,
        },
  });
  const save = useApiMutation<GenericInput>(
    (values) => {
      const body = { ...emptyToNull(values), strength: values.strength ?? '', dosageForm: values.dosageForm ?? '', route: values.route ?? '' };
      return isNew ? ['/generics', { method: 'POST', body }] : [`/generics/${generic.id}`, { method: 'PATCH', body }];
    },
    { invalidate: ['/generics', '/items'], success: 'Generic saved' },
  );

  return (
    <FormDialog
      open
      maxWidth="md"
      title={isNew ? 'New generic' : `Edit ${generic.innName}`}
      onClose={onClose}
      submitting={save.isPending}
      onSubmit={handleSubmit((values) => save.mutate(values, { onSuccess: onClose }))}
    >
      <RHFText control={control} name="innName" label="INN (generic name)" autoFocus />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="strength" label="Strength" placeholder="500 mg" />
        <RHFText control={control} name="dosageForm" label="Dosage form" placeholder="Tablet" />
        <RHFText control={control} name="route" label="Route" placeholder="Oral" />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <RHFText control={control} name="atcCode" label="ATC code" placeholder="N02BE01" />
        <RHFText control={control} name="therapeuticClass" label="Therapeutic class" />
      </Stack>
      <RHFSelect
        control={control}
        name="controlledSchedule"
        label="Controlled schedule"
        options={enumOptions(ControlledSchedule, humanise)}
      />
      <RHFSelect control={control} name="vedClass" label="VED class (ABC-VED analysis)" allowEmpty="Not classified" options={[{ value: 'V', label: 'V — vital' }, { value: 'E', label: 'E — essential' }, { value: 'D', label: 'D — desirable' }]} />
      <RHFText control={control} name="storageRequirements" label="Storage requirements" />
      <RHFText control={control} name="pregnancyNotes" label="Pregnancy notes" multiline minRows={2} />
      <RHFText control={control} name="lactationNotes" label="Lactation notes" multiline minRows={2} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
        <RHFSwitch control={control} name="pregnancyContraindicated" label="Contraindicated in pregnancy (dispensing alert)" />
        <RHFNumber control={control} name="minAgeYears" label="Minimum age (years)" />
        <RHFNumber control={control} name="maxQtyPerSale" label="Over-the-counter limit per sale (base units)" />
      </Stack>
      <Stack direction="row" spacing={2}>
        <RHFSwitch control={control} name="isKeml" label="On KEML" />
        <RHFSwitch control={control} name="isActive" label="Active" />
      </Stack>
    </FormDialog>
  );
}

/** Brands mapped to the selected generic. */
export function BrandsPanel({ generic }: { generic: Generic }) {
  const { currency } = useSettings();
  const brands = generic.items ?? [];
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600}>
        {generic.innName} {generic.strength}
      </Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {[generic.dosageForm, generic.route, generic.atcCode].filter(Boolean).join(' · ')}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        {generic.isKeml && <Chip size="small" color="primary" label="KEML" />}
        {generic.controlledSchedule !== ControlledSchedule.NONE && (
          <Chip size="small" color="error" label={humanise(generic.controlledSchedule)} />
        )}
      </Stack>
      <Divider />
      <Typography variant="overline">Brands ({brands.length})</Typography>
      {brands.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No brands mapped yet.
        </Typography>
      ) : (
        <List dense disablePadding aria-label="Mapped brands">
          {brands.map((b) => (
            <ListItem key={b.id} disableGutters divider>
              <ListItemText
                primary={b.brandName ?? b.name}
                secondary={[b.manufacturer, b.packSize, b.code].filter(Boolean).join(' · ')}
              />
              <Typography variant="body2">{formatMoney(b.unitPrice, currency)}</Typography>
            </ListItem>
          ))}
        </List>
      )}
    </Paper>
  );
}

export function GenericsPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [selected, setSelected] = useState<Generic | null>(null);
  const [editing, setEditing] = useState<Generic | 'new' | null>(null);
  const q = useDebounced(search);
  const { data, isFetching } = usePaged<Generic>('/generics', { ...pagination, search: q, includeItems: true });
  const canManage = can(Permissions.CATALOG_MANAGE);
  const current = selected ? (data?.items.find((g) => g.id === selected.id) ?? selected) : null;

  const columns: GridColDef<Generic>[] = [
    { field: 'innName', headerName: 'INN', flex: 1, minWidth: 180 },
    { field: 'strength', headerName: 'Strength', width: 130 },
    { field: 'dosageForm', headerName: 'Form', width: 150 },
    { field: 'route', headerName: 'Route', width: 120 },
    { field: 'atcCode', headerName: 'ATC', width: 100 },
    { field: 'isKeml', headerName: 'KEML', width: 70, type: 'boolean' },
    { field: 'items', headerName: 'Brands', width: 80, valueGetter: (_v, row) => row.items?.length ?? 0 },
    ...(canManage
      ? [
          {
            field: 'actions',
            headerName: '',
            width: 60,
            sortable: false,
            renderCell: ({ row }) => (
              <Tooltip title="Edit">
                <IconButton
                  size="small"
                  aria-label={`Edit ${row.innName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(row);
                  }}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ),
          } as GridColDef<Generic>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Generics"
        search={search}
        searchPlaceholder="Search INN, ATC or brand"
        onSearch={(v) => {
          setSearch(v);
          setPagination((p) => ({ ...p, page: 0 }));
        }}
        onNew={canManage ? () => setEditing('new') : undefined}
      />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' }, gap: 2, alignItems: 'start' }}>
        <Paper sx={{ minWidth: 0 }}>
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
            rowSelectionModel={current ? [current.id] : []}
          />
        </Paper>
        {current ? (
          <BrandsPanel generic={current} />
        ) : (
          <Paper sx={{ p: 2 }}>
            <Typography color="text.secondary">Select a generic to see its brands.</Typography>
          </Paper>
        )}
      </Box>
      {editing && <GenericDialog generic={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

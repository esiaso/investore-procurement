import { Alert, AlertColor, Autocomplete, Chip, ChipProps, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import type { Paginated } from '@sil/shared';
import { api } from '../api/client';
import type { ClinicalAlert, EtimsSync, Patient, Severity } from '../api/pharmacy-types';
import type { Generic } from '../api/types';
import { humanise } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';

/** Contraindicated red, major orange, moderate blue, minor grey. */
export const SEVERITY_COLOUR: Record<Severity, ChipProps['color']> = { CONTRAINDICATED: 'error', MAJOR: 'warning', MODERATE: 'info', MINOR: 'default' };
const SEVERITY_ALERT: Record<Severity, AlertColor> = { CONTRAINDICATED: 'error', MAJOR: 'warning', MODERATE: 'info', MINOR: 'success' };

export function SeverityChip({ severity }: { severity: Severity }) {
  return <Chip size="small" color={SEVERITY_COLOUR[severity]} label={humanise(severity)} />;
}

export function AlertLine({ alert, action }: { alert: ClinicalAlert; action?: ReactNode }) {
  return (
    <Alert severity={SEVERITY_ALERT[alert.severity]} variant={alert.severity === 'MINOR' ? 'outlined' : 'standard'} action={action}>
      <strong>
        {humanise(alert.severity)} · {humanise(alert.type)}
      </strong>
      : {alert.message}
      {alert.management && <div>Advice: {alert.management}</div>}
      {alert.override && (
        <div>
          Overridden: “{alert.override.reason}”
        </div>
      )}
    </Alert>
  );
}

const ETIMS_COLOUR: Record<EtimsSync, ChipProps['color']> = { ACCEPTED: 'success', PENDING: 'warning', SENT: 'info', FAILED: 'error', NOT_REQUIRED: 'default' };

export function EtimsChip({ status }: { status: EtimsSync }) {
  return <Chip size="small" variant="outlined" color={ETIMS_COLOUR[status] ?? 'default'} label={status === 'ACCEPTED' ? 'eTIMS signed' : `eTIMS ${humanise(status).toLowerCase()}`} />;
}

export function GenericPicker({ value, onChange, label = 'Generic (INN, strength, form)' }: { value: Generic | null; onChange(g: Generic | null): void; label?: string }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 200);
  const { data, isFetching } = useQuery({
    queryKey: ['/generics', 'picker', q],
    queryFn: () => api<Paginated<Generic>>('/generics', { query: { search: q, pageSize: 20, active: true } }),
    enabled: q.trim().length >= 2,
  });
  return (
    <Autocomplete
      sx={{ flex: 2, minWidth: 240 }}
      value={value}
      options={data?.items ?? (value ? [value] : [])}
      loading={isFetching}
      getOptionLabel={(g) => `${g.innName} ${g.strength} ${g.dosageForm}`.trim()}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterOptions={(x) => x}
      inputValue={input}
      onInputChange={(_, v, reason) => reason !== 'reset' && setInput(v)}
      onChange={(_, v) => {
        onChange(v);
        setInput('');
      }}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

export function PatientPicker({ value, onChange }: { value: Patient | null; onChange(p: Patient | null): void }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 200);
  const { data, isFetching } = useQuery({
    queryKey: ['/patients', 'picker', q],
    queryFn: () => api<Paginated<Patient>>('/patients', { query: { search: q, pageSize: 20 } }),
    enabled: q.trim().length >= 2,
  });
  return (
    <Autocomplete
      sx={{ flex: 1, minWidth: 260 }}
      value={value}
      options={data?.items ?? (value ? [value] : [])}
      loading={isFetching}
      getOptionLabel={(p) => `${p.hospitalNo} · ${p.name}`}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterOptions={(x) => x}
      inputValue={input}
      onInputChange={(_, v, reason) => reason !== 'reset' && setInput(v)}
      onChange={(_, v) => {
        onChange(v);
        setInput('');
      }}
      renderInput={(params) => <TextField {...params} label="Patient (hospital no. or name)" />}
    />
  );
}

/** Whole years from a date of birth. */
export function ageText(dob: string | null): string {
  if (!dob) return 'age unknown';
  const years = (Date.now() - Date.parse(`${dob}T00:00:00Z`)) / (365.25 * 86_400_000);
  return years < 2 ? `${Math.floor(years * 12)} months` : `${Math.floor(years)} years`;
}

import {
  Autocomplete,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  TextFieldProps,
} from '@mui/material';
import { Control, Controller, FieldPath, FieldValues } from 'react-hook-form';

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

export function RHFText<T extends FieldValues>({
  control,
  name,
  label,
  ...rest
}: BaseProps<T> & Omit<TextFieldProps, 'name' | 'label'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...rest}
          {...field}
          value={field.value ?? ''}
          label={label}
          error={!!fieldState.error}
          helperText={fieldState.error?.message ?? rest.helperText}
        />
      )}
    />
  );
}

/** Numeric input that stores a number (or null when empty). */
export function RHFNumber<T extends FieldValues>({
  control,
  name,
  label,
  ...rest
}: BaseProps<T> & Omit<TextFieldProps, 'name' | 'label'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...rest}
          name={field.name}
          inputRef={field.ref}
          onBlur={field.onBlur}
          type="number"
          label={label}
          value={field.value ?? ''}
          onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))}
          error={!!fieldState.error}
          helperText={fieldState.error?.message ?? rest.helperText}
          slotProps={{ htmlInput: { step: 'any' } }}
        />
      )}
    />
  );
}

export interface Option {
  value: string;
  label: string;
}

export function RHFSelect<T extends FieldValues>({
  control,
  name,
  label,
  options,
  allowEmpty,
  ...rest
}: BaseProps<T> & { options: Option[]; allowEmpty?: string } & Omit<TextFieldProps, 'name' | 'label'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...rest}
          {...field}
          select
          label={label}
          value={field.value ?? ''}
          onChange={(e) => field.onChange(e.target.value === '' ? null : e.target.value)}
          error={!!fieldState.error}
          helperText={fieldState.error?.message ?? rest.helperText}
        >
          {allowEmpty !== undefined && (
            <MenuItem value="">
              <em>{allowEmpty}</em>
            </MenuItem>
          )}
          {options.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
      )}
    />
  );
}

export function RHFMultiSelect<T extends FieldValues>({
  control,
  name,
  label,
  options,
}: BaseProps<T> & { options: Option[] }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Autocomplete
          multiple
          options={options}
          value={options.filter((o) => ((field.value as string[] | undefined) ?? []).includes(o.value))}
          onChange={(_, v) => field.onChange(v.map((o) => o.value))}
          isOptionEqualToValue={(a, b) => a.value === b.value}
          disableCloseOnSelect
          renderInput={(params) => (
            <TextField {...params} label={label} error={!!fieldState.error} helperText={fieldState.error?.message} />
          )}
        />
      )}
    />
  );
}

export function RHFSwitch<T extends FieldValues>({ control, name, label }: BaseProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <FormControlLabel
          control={<Switch checked={!!field.value} onChange={(e) => field.onChange(e.target.checked)} />}
          label={label}
        />
      )}
    />
  );
}

export function RHFCheckbox<T extends FieldValues>({ control, name, label }: BaseProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <FormControlLabel
          control={<Checkbox checked={!!field.value} onChange={(e) => field.onChange(e.target.checked)} />}
          label={label}
        />
      )}
    />
  );
}

export const enumOptions = (values: Record<string, string>, label: (v: string) => string = (v) => v): Option[] =>
  Object.values(values).map((v) => ({ value: v, label: label(v) }));

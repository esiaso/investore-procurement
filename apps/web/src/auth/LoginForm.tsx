import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Stack } from '@mui/material';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { LoginInput, loginSchema, TotpCodeInput, totpCodeSchema } from '@sil/shared';
import { RHFText } from '../components/form';

export function LoginForm({ onSubmit }: { onSubmit(values: LoginInput): Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, formState } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        try {
          await onSubmit(values);
        } catch (e) {
          setError((e as Error).message);
        }
      })}
    >
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        <RHFText control={control} name="username" label="Username" autoFocus autoComplete="username" />
        <RHFText control={control} name="password" label="Password" type="password" autoComplete="current-password" />
        <Button type="submit" variant="contained" size="large" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </Stack>
    </form>
  );
}

export function TotpForm({ onSubmit, onCancel }: { onSubmit(code: string): Promise<void>; onCancel(): void }) {
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, formState } = useForm<TotpCodeInput>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: '' },
  });

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async ({ code }) => {
        setError(null);
        try {
          await onSubmit(code);
        } catch (e) {
          setError((e as Error).message);
        }
      })}
    >
      <Stack spacing={2}>
        <Alert severity="info">Enter the 6-digit code from your authenticator app.</Alert>
        {error && <Alert severity="error">{error}</Alert>}
        <RHFText
          control={control}
          name="code"
          label="Authentication code"
          autoFocus
          autoComplete="one-time-code"
          slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
        />
        <Button type="submit" variant="contained" size="large" disabled={formState.isSubmitting}>
          Verify
        </Button>
        <Button onClick={onCancel}>Back</Button>
      </Stack>
    </form>
  );
}

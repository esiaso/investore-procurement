import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { passwordSchema } from '@sil/shared';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { RHFText } from '../components/form';
import { useNotify } from '../components/Notify';
import { useSettings } from '../settings/SettingsContext';

export function ChangePasswordForm({ onDone }: { onDone?(): void }) {
  const { user, refresh } = useAuth();
  const { passwordPolicy } = useSettings();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(
    () =>
      z
        .object({
          currentPassword: z.string().min(1, 'Required'),
          newPassword: passwordSchema(passwordPolicy, user?.username),
          confirm: z.string(),
        })
        .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' }),
    [passwordPolicy, user?.username],
  );
  type Values = z.infer<typeof schema>;
  const { control, handleSubmit, formState, reset } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async ({ currentPassword, newPassword }) => {
        setError(null);
        try {
          await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
          notify.success('Password changed');
          reset();
          await refresh();
          onDone?.();
        } catch (e) {
          const err = e as ApiError;
          const details = (err.body?.errors as string[] | undefined)?.join(', ');
          setError(details ? `${err.message}: ${details}` : err.message);
        }
      })}
    >
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        <RHFText control={control} name="currentPassword" label="Current password" type="password" autoComplete="current-password" />
        <RHFText
          control={control}
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          helperText={`At least ${passwordPolicy.minLength} characters with upper and lower case, a digit and a symbol`}
        />
        <RHFText control={control} name="confirm" label="Confirm new password" type="password" autoComplete="new-password" />
        <Box>
          <Button type="submit" variant="contained" disabled={formState.isSubmitting}>
            Change password
          </Button>
        </Box>
      </Stack>
    </form>
  );
}

function TwoFactorSection() {
  const { user, refresh } = useAuth();
  const notify = useNotify();
  const [enrolment, setEnrolment] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (user?.totpEnabled) {
    return (
      <Stack spacing={2}>
        <Alert severity="success">Two-factor authentication is on.</Alert>
        {error && <Alert severity="error">{error}</Alert>}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <TextField label="Current code" value={code} onChange={(e) => setCode(e.target.value)} slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }} />
          <Button
            color="error"
            variant="outlined"
            onClick={() =>
              call(async () => {
                await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
                notify.success('Two-factor authentication turned off');
                setCode('');
                setPassword('');
                await refresh();
              })
            }
          >
            Turn off
          </Button>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Protect your account with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!enrolment ? (
        <Box>
          <Button variant="outlined" onClick={() => call(async () => setEnrolment(await api('/auth/2fa/setup', { method: 'POST' })))}>
            Set up two-factor authentication
          </Button>
        </Box>
      ) : (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="flex-start">
          <img src={enrolment.qrDataUrl} alt="Scan this QR code with your authenticator app" width={180} height={180} />
          <Stack spacing={2} sx={{ flex: 1 }}>
            <Typography variant="body2">
              Scan the code, or enter this key manually: <code>{enrolment.secret}</code>
            </Typography>
            <TextField
              label="6-digit code"
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value)}
              slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
            />
            <Box>
              <Button
                variant="contained"
                onClick={() =>
                  call(async () => {
                    await api('/auth/2fa/enable', { method: 'POST', body: { code } });
                    notify.success('Two-factor authentication is on');
                    setEnrolment(null);
                    setCode('');
                    await refresh();
                  })
                }
              >
                Confirm
              </Button>
            </Box>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <Typography variant="h5" component="h1">
        My account
      </Typography>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          {user?.fullName} ({user?.username})
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {user?.roles.map((r) => r.name).join(', ')}
        </Typography>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Password
        </Typography>
        <ChangePasswordForm />
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Two-factor authentication
        </Typography>
        <TwoFactorSection />
      </Paper>
    </Stack>
  );
}

/** Shown instead of the app while an admin-set password must be changed. */
export function ForcedPasswordChangePage() {
  const { logout } = useAuth();
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper sx={{ p: 3, width: '100%', maxWidth: 440 }}>
        <Typography variant="h6" gutterBottom>
          Choose a new password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Your password was set by an administrator. Choose your own to continue.
        </Typography>
        <ChangePasswordForm />
        <Button sx={{ mt: 2 }} onClick={() => logout()}>
          Sign out
        </Button>
      </Paper>
    </Box>
  );
}

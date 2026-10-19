import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import { Box, Paper, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useAuth } from './AuthContext';
import { LoginForm, TotpForm } from './LoginForm';

export function LoginPage() {
  const auth = useAuth();
  const [step, setStep] = useState<'password' | 'totp'>('password');

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Paper sx={{ p: { xs: 3, sm: 4 }, width: '100%', maxWidth: 400 }} elevation={3}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
          <LocalHospitalIcon color="primary" fontSize="large" />
          <Box>
            <Typography variant="h6">Procurement & Inventory</Typography>
            <Typography variant="body2" color="text.secondary">
              Sign in to continue
            </Typography>
          </Box>
        </Stack>
        {step === 'password' ? (
          <LoginForm
            onSubmit={async ({ username, password }) => {
              const res = await auth.login(username, password);
              if (res.twoFactorRequired) setStep('totp');
            }}
          />
        ) : (
          <TotpForm
            onSubmit={async (code) => {
              await auth.verifyTotp(code);
            }}
            onCancel={() => setStep('password')}
          />
        )}
      </Paper>
    </Box>
  );
}

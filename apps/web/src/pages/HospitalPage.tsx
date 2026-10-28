import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadIcon from '@mui/icons-material/Upload';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Permissions } from '@sil/shared';
import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApiMutation } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { useNotify } from '../components/Notify';

interface Hospital {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  kraPin: string | null;
  hasLogo: boolean;
  mailFrom: string;
}

type Form = { name: string; address: string; phone: string; email: string; kraPin: string; mailFrom: string };

const MAX_LOGO_KB = 500;

/** Organisation → Hospital details: name and contacts on every document, the letterhead logo and the e-mail sender. */
export function HospitalPage() {
  const { can } = useAuth();
  const manage = can(Permissions.ORG_MANAGE);
  const notify = useNotify();
  const hospital = useQuery({ queryKey: ['/hospital'], queryFn: () => api<Hospital>('/hospital') });
  const logo = useQuery({ queryKey: ['/hospital/logo'], queryFn: () => api<{ dataUrl: string | null }>('/hospital/logo'), enabled: !!hospital.data?.hasLogo });
  const [f, setF] = useState<Form | null>(null);

  useEffect(() => {
    const h = hospital.data;
    if (h) setF({ name: h.name, address: h.address ?? '', phone: h.phone ?? '', email: h.email ?? '', kraPin: h.kraPin ?? '', mailFrom: h.mailFrom });
  }, [hospital.data]);

  const save = useApiMutation(() => ['/hospital', { method: 'PUT', body: f }], { invalidate: ['/hospital'], success: 'Hospital details saved' });
  const upload = useApiMutation((dataUrl: string) => ['/hospital/logo', { method: 'PUT', body: { dataUrl } }], { invalidate: ['/hospital'], success: 'Logo saved' });
  const remove = useApiMutation(() => ['/hospital/logo', { method: 'DELETE' }], { invalidate: ['/hospital'], success: 'Logo removed' });

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return notify.error('The logo must be a PNG or JPEG image');
    if (file.size > MAX_LOGO_KB * 1024) return notify.error(`The logo must be at most ${MAX_LOGO_KB} KB`);
    const reader = new FileReader();
    reader.onload = () => upload.mutate(String(reader.result));
    reader.readAsDataURL(file);
  };

  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement>) => setF((x) => (x ? { ...x, [k]: e.target.value } : x));

  if (!f) return <PageHeader title="Hospital details" />;

  return (
    <Box>
      <PageHeader title="Hospital details" />
      {!manage && <Alert severity="info" sx={{ mb: 2 }}>Only administrators can change these details.</Alert>}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
        <Paper variant="outlined" sx={{ p: 2, flex: 2, width: '100%' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Name and contacts</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Shown on the letterhead of every document (orders, RFQs, requisitions, vouchers, certificates, reports) and on receipts.
          </Typography>
          <form
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              save.mutate(undefined);
            }}
          >
            <Stack spacing={2}>
              <TextField label="Hospital name" value={f.name} onChange={set('name')} required disabled={!manage} />
              <TextField label="Postal / physical address" value={f.address} onChange={set('address')} multiline minRows={2} disabled={!manage} />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Phone" value={f.phone} onChange={set('phone')} disabled={!manage} sx={{ flex: 1 }} />
                <TextField label="E-mail" type="email" value={f.email} onChange={set('email')} disabled={!manage} sx={{ flex: 1 }} />
              </Stack>
              <TextField label="KRA PIN" value={f.kraPin} onChange={set('kraPin')} disabled={!manage} helperText="e.g. P051234567X" />
              <TextField
                label="Sender of outgoing e-mail"
                value={f.mailFrom}
                onChange={set('mailFrom')}
                required
                disabled={!manage}
                helperText="Name and address, e.g. Upendo Procurement <procurement@upendo.org>. The mail server must accept this address."
              />
              {manage && (
                <Box>
                  <Button type="submit" variant="contained" disabled={save.isPending || !f.name.trim()}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </Box>
              )}
            </Stack>
          </form>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, flex: 1, width: '100%' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Letterhead logo</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            PNG or JPEG, at most {MAX_LOGO_KB} KB. A wide logo about 3:2 (e.g. 330 × 180 px) prints best. It replaces the LOGO box on every PDF.
          </Typography>
          <Box
            sx={{ height: 120, border: 1, borderColor: 'divider', borderStyle: hospital.data?.hasLogo ? 'solid' : 'dashed', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2, bgcolor: 'background.default' }}
          >
            {hospital.data?.hasLogo && logo.data?.dataUrl ? (
              <Box component="img" src={logo.data.dataUrl} alt="Hospital logo" sx={{ maxWidth: '90%', maxHeight: 100, objectFit: 'contain' }} />
            ) : (
              <Typography color="text.secondary">No logo</Typography>
            )}
          </Box>
          {manage && (
            <Stack direction="row" spacing={1}>
              <Button component="label" variant="outlined" startIcon={<UploadIcon />} disabled={upload.isPending}>
                {hospital.data?.hasLogo ? 'Replace logo' : 'Upload logo'}
                <input hidden type="file" accept="image/png,image/jpeg" onChange={pick} />
              </Button>
              {hospital.data?.hasLogo && (
                <Button color="error" startIcon={<DeleteOutlineIcon />} onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>
                  Remove
                </Button>
              )}
            </Stack>
          )}
        </Paper>
      </Stack>
    </Box>
  );
}

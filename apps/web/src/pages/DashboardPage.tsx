import { Box, Card, CardActionArea, CardContent, Paper, Skeleton, Typography, useTheme } from '@mui/material';
import Grid from '@mui/material/Grid2';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Dashboard, DashboardTile, DashboardTrend } from '../api/report-types';
import { useAuth } from '../auth/AuthContext';
import { formatMoney } from '../lib/format';
import { useSettings } from '../settings/SettingsContext';

const SECTIONS = ['My work', 'Pharmacy', 'Stock', 'Value', 'Procurement', 'Sales', 'Integrations', 'Documents'];

function Tile({ t }: { t: DashboardTile }) {
  const navigate = useNavigate();
  const { currency } = useSettings();
  const colour = t.tone === 'error' ? 'error.main' : t.tone === 'warning' ? 'warning.main' : t.tone === 'success' ? 'success.main' : undefined;
  return (
    <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
      <Card sx={{ height: '100%' }}>
        <CardActionArea onClick={() => navigate(t.link)} sx={{ height: '100%' }}>
          <CardContent>
            <Typography color="text.secondary" variant="body2">{t.label}</Typography>
            <Typography variant="h5" color={t.value ? colour : undefined}>{t.format === 'money' ? formatMoney(t.value, currency) : t.value.toLocaleString()}</Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
}

/** Six bars, labelled with the month and value. */
function TrendChart({ t }: { t: DashboardTrend }) {
  const theme = useTheme();
  const { currency } = useSettings();
  const max = Math.max(1, ...t.points.map((p) => p.value));
  const w = 320;
  const h = 140;
  const bw = w / t.points.length;
  const short = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Typography variant="subtitle2" gutterBottom>{t.label}</Typography>
      <Box component="svg" viewBox={`0 0 ${w} ${h + 34}`} role="img" aria-label={t.label} sx={{ width: '100%', height: 'auto', display: 'block' }}>
        {t.points.map((p, i) => {
          const bh = Math.max(0, (p.value / max) * h);
          return (
            <g key={p.period}>
              <title>{`${p.period}: ${t.format === 'money' ? formatMoney(p.value, currency) : p.value}`}</title>
              <rect x={i * bw + bw * 0.2} y={h - bh + 14} width={bw * 0.6} height={bh} rx={3} fill={theme.palette.primary.main} opacity={i === t.points.length - 1 ? 1 : 0.65} />
              <text x={i * bw + bw / 2} y={h - bh + 10} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>{short(p.value)}</text>
              <text x={i * bw + bw / 2} y={h + 30} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>{p.period.slice(5)}/{p.period.slice(2, 4)}</text>
            </g>
          );
        })}
      </Box>
    </Paper>
  );
}

/** Home: tiles for the user's role and stores, and six-month trends. */
export function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['/dashboard'], queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 120_000 });
  const sections = SECTIONS.map((s) => ({ s, tiles: (data?.tiles ?? []).filter((t) => t.section === s) })).filter((x) => x.tiles.length);
  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Welcome, {user?.fullName}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        {user?.roles.map((r) => r.name).join(', ')}
        {user?.storeIds ? ` · ${user.storeIds.length} assigned store(s)` : ' · all stores'}
      </Typography>
      {isLoading && <Skeleton variant="rounded" height={120} />}
      {sections.map(({ s, tiles }) => (
        <Box key={s} sx={{ mb: 3 }} component="section" aria-label={s}>
          <Typography variant="h6" gutterBottom>{s}</Typography>
          <Grid container spacing={2}>
            {tiles.map((t) => <Tile key={t.key} t={t} />)}
          </Grid>
        </Box>
      ))}
      {!!data?.trends.length && (
        <Box component="section" aria-label="Trends">
          <Typography variant="h6" gutterBottom>Last six months</Typography>
          <Grid container spacing={2}>
            {data.trends.map((t) => (
              <Grid key={t.key} size={{ xs: 12, md: 6, lg: 3 }}>
                <TrendChart t={t} />
              </Grid>
            ))}
          </Grid>
        </Box>
      )}
    </>
  );
}

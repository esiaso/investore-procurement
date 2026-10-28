import { Box, Paper, Typography, useTheme } from '@mui/material';
import type { ReportDef, ReportResult } from '../api/report-types';

/** 2.5k, 12k, 1.3M (one decimal while it matters). */
const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${Number((v / 1e6).toFixed(1))}M`;
  if (a >= 1e3) return `${Number((v / 1e3).toFixed(a < 1e4 ? 1 : 0))}k`;
  return v.toFixed(0);
};

/** Trend (line) or comparison (bar) of a report's rows: x = a row key, y = the first series, summed per x. */
export function ReportChart({ def, r }: { def: ReportDef; r: ReportResult }) {
  const theme = useTheme();
  const chart = def.chart;
  if (!chart || !r.rows.length) return null;
  const key = chart.series[0];
  const byX = new Map<string, number>();
  for (const row of r.rows) {
    const x = String(row[chart.x] ?? '');
    byX.set(x, (byX.get(x) ?? 0) + Number(row[key] ?? 0));
  }
  const points = [...byX].slice(0, 40);
  const label = r.columns.find((c) => c.key === key)?.label ?? key;
  const max = Math.max(1, ...points.map(([, v]) => v));
  const w = Math.max(320, points.length * 48);
  const h = 160;
  const step = w / points.length;
  const y = (v: number) => h - Math.max(0, (v / max) * h) + 14;
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>{label}</Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Box component="svg" viewBox={`0 0 ${w} ${h + 34}`} role="img" aria-label={`${label} chart`} sx={{ width: '100%', minWidth: Math.min(w, 640), height: 'auto', display: 'block' }}>
          {chart.type === 'line' && (
            <polyline fill="none" stroke={theme.palette.primary.main} strokeWidth={2} points={points.map(([, v], i) => `${i * step + step / 2},${y(v)}`).join(' ')} />
          )}
          {points.map(([x, v], i) => (
            <g key={x}>
              <title>{`${x}: ${v.toLocaleString()}`}</title>
              {chart.type === 'bar' ? (
                <rect x={i * step + step * 0.2} y={y(v)} width={step * 0.6} height={h + 14 - y(v)} rx={3} fill={theme.palette.primary.main} opacity={0.8} />
              ) : (
                <circle cx={i * step + step / 2} cy={y(v)} r={3.5} fill={theme.palette.primary.main} />
              )}
              <text x={i * step + step / 2} y={y(v) - 5} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>{short(v)}</text>
              <text x={i * step + step / 2} y={h + 30} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>{x.length > 10 ? `${x.slice(0, 9)}…` : x}</text>
            </g>
          ))}
        </Box>
      </Box>
    </Paper>
  );
}

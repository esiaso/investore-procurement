import { Card, CardActionArea, CardContent, Typography } from '@mui/material';
import Grid from '@mui/material/Grid2';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Paginated, Permissions, type PermissionCode } from '@sil/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PlanningWidgets } from '../planning/PlanningPages';

function CountCard({ label, path, apiPath, permission }: { label: string; path: string; apiPath: string; permission: PermissionCode }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const enabled = can(permission);
  const { data } = useQuery({
    queryKey: [apiPath, 'count'],
    queryFn: () => api<Paginated<unknown>>(apiPath, { query: { pageSize: 1 } }),
    enabled,
  });
  if (!enabled) return null;
  return (
    <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
      <Card>
        <CardActionArea onClick={() => navigate(path)}>
          <CardContent>
            <Typography color="text.secondary" variant="body2">
              {label}
            </Typography>
            <Typography variant="h4">{data?.total ?? '—'}</Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Welcome, {user?.fullName}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        {user?.roles.map((r) => r.name).join(', ')}
        {user?.storeIds ? ` · ${user.storeIds.length} assigned store(s)` : ' · all stores'}
      </Typography>
      <PlanningWidgets />
      <Grid container spacing={2}>
        <CountCard label="Catalog items" path="/items" apiPath="/items" permission={Permissions.CATALOG_READ} />
        <CountCard label="Generics" path="/generics" apiPath="/generics" permission={Permissions.CATALOG_READ} />
        <CountCard label="Stores" path="/stores" apiPath="/stores" permission={Permissions.ORG_READ} />
        <CountCard label="Users" path="/users" apiPath="/users" permission={Permissions.USERS_READ} />
      </Grid>
    </>
  );
}

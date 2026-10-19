import { Alert, Box, CircularProgress } from '@mui/material';
import { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionCode, Permissions } from '@sil/shared';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { AppLayout } from './layout/AppLayout';
import { AccountPage, ForcedPasswordChangePage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { BinsPage } from './pages/BinsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DepartmentsPage } from './pages/DepartmentsPage';
import { GenericsPage } from './pages/GenericsPage';
import { ImportPage } from './pages/ImportPage';
import { ItemsPage } from './pages/ItemsPage';
import { RolesPage } from './pages/RolesPage';
import { StoresPage } from './pages/StoresPage';
import { UsersPage } from './pages/UsersPage';

export function RequirePermission({ permissions, children }: { permissions: PermissionCode[]; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(...permissions)) return <Alert severity="warning">You do not have access to this page.</Alert>;
  return <>{children}</>;
}

const guarded = (permissions: PermissionCode[], element: ReactNode) => (
  <RequirePermission permissions={permissions}>{element}</RequirePermission>
);

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ForcedPasswordChangePage />;

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="items" element={guarded([Permissions.CATALOG_READ], <ItemsPage />)} />
        <Route path="generics" element={guarded([Permissions.CATALOG_READ], <GenericsPage />)} />
        <Route path="import" element={guarded([Permissions.CATALOG_IMPORT], <ImportPage />)} />
        <Route path="stores" element={guarded([Permissions.ORG_READ], <StoresPage />)} />
        <Route path="bins" element={guarded([Permissions.ORG_READ], <BinsPage />)} />
        <Route path="departments" element={guarded([Permissions.ORG_READ], <DepartmentsPage />)} />
        <Route path="users" element={guarded([Permissions.USERS_READ], <UsersPage />)} />
        <Route path="roles" element={guarded([Permissions.ROLES_READ], <RolesPage />)} />
        <Route path="audit" element={guarded([Permissions.AUDIT_READ], <AuditPage />)} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

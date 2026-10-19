import { Alert, Box, CircularProgress } from '@mui/material';
import { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionCode, Permissions } from '@sil/shared';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { AdjustmentsPage } from './inventory/AdjustmentsPage';
import { ApprovalsPage } from './purchasing/ApprovalsPage';
import { BudgetsPage } from './purchasing/BudgetsPage';
import { GrnDetailPage, GrnFormPage, GrnsPage } from './purchasing/GrnPages';
import { InvoiceDetailPage, InvoiceFormPage, InvoicesPage } from './purchasing/InvoicePages';
import { PurchaseOrderDetailPage, PurchaseOrdersPage } from './purchasing/PoPages';
import { RequisitionDetailPage, RequisitionFormPage, RequisitionsPage } from './purchasing/RequisitionsPages';
import { RfqDetailPage, RfqsPage } from './purchasing/RfqPages';
import { SuppliersPage } from './purchasing/SuppliersPage';
import { ReceiptsPage } from './inventory/ReceiptsPage';
import { StockPage } from './inventory/StockPage';
import { StockTakeDetailPage, StockTakesPage } from './inventory/StockTakesPage';
import { TransfersPage } from './inventory/TransfersPage';
import { ValuationPage } from './inventory/ValuationPage';
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
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="requisitions" element={guarded([Permissions.PURCHASING_READ], <RequisitionsPage />)} />
        <Route path="requisitions/new" element={guarded([Permissions.PURCHASING_REQUISITION], <RequisitionFormPage />)} />
        <Route path="requisitions/:id/edit" element={guarded([Permissions.PURCHASING_REQUISITION], <RequisitionFormPage />)} />
        <Route path="requisitions/:id" element={guarded([Permissions.PURCHASING_READ], <RequisitionDetailPage />)} />
        <Route path="rfqs" element={guarded([Permissions.PURCHASING_READ], <RfqsPage />)} />
        <Route path="rfqs/:id" element={guarded([Permissions.PURCHASING_READ], <RfqDetailPage />)} />
        <Route path="purchase-orders" element={guarded([Permissions.PURCHASING_READ], <PurchaseOrdersPage />)} />
        <Route path="purchase-orders/:id" element={guarded([Permissions.PURCHASING_READ], <PurchaseOrderDetailPage />)} />
        <Route path="grns" element={guarded([Permissions.PURCHASING_READ], <GrnsPage />)} />
        <Route path="grns/new" element={guarded([Permissions.PURCHASING_RECEIVE], <GrnFormPage />)} />
        <Route path="grns/:id" element={guarded([Permissions.PURCHASING_READ], <GrnDetailPage />)} />
        <Route path="invoices" element={guarded([Permissions.PURCHASING_READ], <InvoicesPage />)} />
        <Route path="invoices/new" element={guarded([Permissions.PURCHASING_INVOICE], <InvoiceFormPage />)} />
        <Route path="invoices/:id" element={guarded([Permissions.PURCHASING_READ], <InvoiceDetailPage />)} />
        <Route path="suppliers" element={guarded([Permissions.SUPPLIERS_READ], <SuppliersPage />)} />
        <Route path="budgets" element={guarded([Permissions.BUDGETS_READ], <BudgetsPage />)} />
        <Route path="stock" element={guarded([Permissions.INVENTORY_READ], <StockPage />)} />
        <Route path="receipts" element={guarded([Permissions.INVENTORY_READ], <ReceiptsPage />)} />
        <Route path="transfers" element={guarded([Permissions.INVENTORY_READ], <TransfersPage />)} />
        <Route path="adjustments" element={guarded([Permissions.INVENTORY_READ], <AdjustmentsPage />)} />
        <Route path="stock-takes" element={guarded([Permissions.INVENTORY_READ], <StockTakesPage />)} />
        <Route path="stock-takes/:id" element={guarded([Permissions.INVENTORY_READ], <StockTakeDetailPage />)} />
        <Route path="valuation" element={guarded([Permissions.INVENTORY_VALUATION], <ValuationPage />)} />
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

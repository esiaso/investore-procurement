import { Alert, Box, CircularProgress } from '@mui/material';
import { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionCode, Permissions } from '@sil/shared';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { AdjustmentsPage } from './inventory/AdjustmentsPage';
import { BillingReportsPage, BillingSetupPage, SaleFormPage, SalesInvoiceDetailPage, SalesInvoicesPage } from './billing/BillingPages';
import { EtimsConsolePage } from './etims/EtimsPages';
import { EncounterDetailPage, EncountersPage, HmisConsolePage, WardSupplyPage } from './hmis/HmisPages';
import { PosReportsPage, PosSetupPage, PosShiftsPage } from './pos/PosPages';
import { TillPage } from './pos/TillPage';
import { QuickBooksPage } from './accounting/QuickBooksPage';
import { DocumentsPage } from './reports/DocumentsPage';
import { ReportsPage } from './reports/ReportsPage';
import { InteractionsPage, PatientsPage, PharmacyWorklistPage, PrescriptionDetailPage, PrescriptionFormPage } from './pharmacy/PharmacyPages';
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
import { AssetDetailPage, AssetsPage, LabelsPage } from './assets/AssetPages';
import { DistributionPage, RunDetailPage, ServiceCertificateDetailPage, ServiceCertificatesPage, ShipmentsPage } from './logistics/LogisticsPages';
import { ColdChainPage, ComplaintsPage, DisposalDetailPage, DisposalsPage, HoldDetailPage, HoldsPage, RecallDetailPage, RecallsPage } from './quality/QualityPages';
import {
  PortalHomePage,
  PortalOrderPage,
  PortalOrdersPage,
  PortalPaymentsPage,
  PortalRfqsPage,
  PortalSubmissionsPage,
  PortalTenderPage,
  PortalTendersPage,
} from './portal/PortalPages';
import { ContractDetailPage, ContractsPage } from './strategic/ContractPages';
import { ForecastsPage, FundingSourcesPage, QuantificationPage, SupplyPlanPage } from './strategic/ForecastPages';
import { AgencyOrdersPage, KpiPage, SupplierPerformancePage } from './strategic/PerformancePages';
import { PlanDetailPage, PlanFormPage, PlansPage } from './strategic/PlanPages';
import { TenderDetailPage, TenderFormPage, TendersPage } from './strategic/TenderPages';
import { isPortalUser, STORES_SEE } from './layout/nav';
import { AlertsPage, ExpiryPage, JobsPage, ReorderPage, StockLevelsPage } from './planning/PlanningPages';
import { IssueFormPage, IssueVoucherDetailPage, IssueVouchersPage } from './stores/IssuePages';
import { BatchTracePage, ConsumptionPage } from './stores/ReportPages';
import { BackordersPage, StoreRequisitionDetailPage, StoreRequisitionFormPage, StoreRequisitionsPage } from './stores/RequisitionPages';
import {
  DepartmentReturnDetailPage,
  DepartmentReturnFormPage,
  DepartmentReturnsPage,
  SupplierReturnDetailPage,
  SupplierReturnFormPage,
  SupplierReturnsPage,
} from './stores/ReturnPages';
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

export function RequirePermission({ permissions, any, children }: { permissions: PermissionCode[]; any?: boolean; children: ReactNode }) {
  const { can, canAny } = useAuth();
  if (!(any ? canAny(...permissions) : can(...permissions))) return <Alert severity="warning">You do not have access to this page.</Alert>;
  return <>{children}</>;
}

const guarded = (permissions: PermissionCode[], element: ReactNode) => (
  <RequirePermission permissions={permissions}>{element}</RequirePermission>
);
const guardedAny = (permissions: PermissionCode[], element: ReactNode) => (
  <RequirePermission permissions={permissions} any>
    {element}
  </RequirePermission>
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

  if (isPortalUser(user)) {
    // Supplier portal: nothing of the staff application is routed.
    return (
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={guarded([Permissions.PORTAL_ACCESS], <PortalHomePage />)} />
          <Route path="portal/rfqs" element={guarded([Permissions.PORTAL_ACCESS], <PortalRfqsPage />)} />
          <Route path="portal/tenders" element={guarded([Permissions.PORTAL_ACCESS], <PortalTendersPage />)} />
          <Route path="portal/tenders/:id" element={guarded([Permissions.PORTAL_ACCESS], <PortalTenderPage />)} />
          <Route path="portal/orders" element={guarded([Permissions.PORTAL_ACCESS], <PortalOrdersPage />)} />
          <Route path="portal/orders/:id" element={guarded([Permissions.PORTAL_ACCESS], <PortalOrderPage />)} />
          <Route path="portal/payments" element={guarded([Permissions.PORTAL_ACCESS], <PortalPaymentsPage />)} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );
  }

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
        <Route path="procurement-plans" element={guarded([Permissions.PLANS_READ], <PlansPage />)} />
        <Route path="procurement-plans/new" element={guarded([Permissions.PLANS_MANAGE], <PlanFormPage mode="new" />)} />
        <Route path="procurement-plans/:id/edit" element={guarded([Permissions.PLANS_MANAGE], <PlanFormPage mode="edit" />)} />
        <Route path="procurement-plans/:id/revise" element={guarded([Permissions.PLANS_MANAGE], <PlanFormPage mode="revise" />)} />
        <Route path="procurement-plans/:id" element={guarded([Permissions.PLANS_READ], <PlanDetailPage />)} />
        <Route path="tenders" element={guardedAny([Permissions.TENDERS_READ, Permissions.TENDERS_EVALUATE], <TendersPage />)} />
        <Route path="tenders/new" element={guarded([Permissions.TENDERS_MANAGE], <TenderFormPage />)} />
        <Route path="tenders/:id" element={guardedAny([Permissions.TENDERS_READ, Permissions.TENDERS_EVALUATE], <TenderDetailPage />)} />
        <Route path="contracts" element={guarded([Permissions.CONTRACTS_READ], <ContractsPage />)} />
        <Route path="contracts/:id" element={guarded([Permissions.CONTRACTS_READ], <ContractDetailPage />)} />
        <Route path="supplier-performance" element={guardedAny([Permissions.SUPPLIERS_PERFORMANCE, Permissions.SUPPLIERS_READ], <SupplierPerformancePage />)} />
        <Route path="agency-orders" element={guarded([Permissions.PURCHASING_READ], <AgencyOrdersPage />)} />
        <Route path="portal-documents" element={guarded([Permissions.PURCHASING_READ], <PortalSubmissionsPage />)} />
        <Route path="procurement-kpis" element={guarded([Permissions.PROCUREMENT_KPIS], <KpiPage />)} />
        <Route path="quality/holds" element={guardedAny([Permissions.QUALITY_READ, Permissions.QUALITY_RELEASE], <HoldsPage />)} />
        <Route path="quality/holds/:id" element={guardedAny([Permissions.QUALITY_READ, Permissions.QUALITY_RELEASE], <HoldDetailPage />)} />
        <Route path="quality/complaints" element={guardedAny([Permissions.QUALITY_READ, Permissions.QUALITY_MANAGE, Permissions.PHARMACY_READ, Permissions.INVENTORY_READ], <ComplaintsPage />)} />
        <Route path="cold-chain" element={guardedAny([Permissions.QUALITY_READ, Permissions.INVENTORY_HANDLE_COLD_CHAIN], <ColdChainPage />)} />
        <Route path="recalls" element={guardedAny([Permissions.QUALITY_READ, Permissions.RECALLS_MANAGE], <RecallsPage />)} />
        <Route path="recalls/:id" element={guardedAny([Permissions.QUALITY_READ, Permissions.RECALLS_MANAGE], <RecallDetailPage />)} />
        <Route path="disposals" element={guardedAny([Permissions.DISPOSALS_MANAGE, Permissions.INVENTORY_READ], <DisposalsPage />)} />
        <Route path="disposals/:id" element={guardedAny([Permissions.DISPOSALS_MANAGE, Permissions.INVENTORY_READ], <DisposalDetailPage />)} />
        <Route path="distribution" element={guardedAny([Permissions.DISTRIBUTION_MANAGE, Permissions.INVENTORY_READ], <DistributionPage />)} />
        <Route path="distribution/:id" element={guardedAny([Permissions.DISTRIBUTION_MANAGE, Permissions.INVENTORY_READ], <RunDetailPage />)} />
        <Route path="shipments" element={guarded([Permissions.PURCHASING_READ], <ShipmentsPage />)} />
        <Route path="service-certificates" element={guarded([Permissions.PURCHASING_READ], <ServiceCertificatesPage />)} />
        <Route path="service-certificates/:id" element={guarded([Permissions.PURCHASING_READ], <ServiceCertificateDetailPage />)} />
        <Route path="assets" element={guarded([Permissions.ASSETS_READ], <AssetsPage />)} />
        <Route path="assets/:id" element={guarded([Permissions.ASSETS_READ], <AssetDetailPage />)} />
        <Route path="labels" element={guarded([Permissions.INVENTORY_READ], <LabelsPage />)} />
        <Route path="forecasting" element={guarded([Permissions.FORECASTING_READ], <ForecastsPage />)} />
        <Route path="supply-planning" element={guarded([Permissions.FORECASTING_READ], <SupplyPlanPage />)} />
        <Route path="quantification" element={guarded([Permissions.FORECASTING_READ], <QuantificationPage />)} />
        <Route path="funding-sources" element={guarded([Permissions.FORECASTING_READ], <FundingSourcesPage />)} />
        <Route path="pharmacy" element={guarded([Permissions.PHARMACY_READ], <PharmacyWorklistPage />)} />
        <Route path="pharmacy/new" element={guarded([Permissions.PHARMACY_PRESCRIPTION], <PrescriptionFormPage />)} />
        <Route path="pharmacy/prescriptions/:id" element={guarded([Permissions.PHARMACY_READ], <PrescriptionDetailPage />)} />
        <Route path="pharmacy/interactions" element={guarded([Permissions.PHARMACY_READ], <InteractionsPage />)} />
        <Route path="pharmacy/ward-supply" element={guarded([Permissions.PHARMACY_READ], <WardSupplyPage />)} />
        <Route path="encounters" element={guardedAny([Permissions.HMIS_READ, Permissions.PATIENTS_READ], <EncountersPage />)} />
        <Route path="encounters/:id" element={guardedAny([Permissions.HMIS_READ, Permissions.PATIENTS_READ], <EncounterDetailPage />)} />
        <Route path="hmis" element={guarded([Permissions.HMIS_READ], <HmisConsolePage />)} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="documents" element={guarded([Permissions.DOCUMENTS_READ], <DocumentsPage />)} />
        <Route path="accounting/quickbooks" element={guardedAny([Permissions.ACCOUNTING_READ, Permissions.ACCOUNTING_MANAGE, Permissions.ACCOUNTING_POST], <QuickBooksPage />)} />
        <Route path="pos" element={guarded([Permissions.POS_SELL], <TillPage />)} />
        <Route path="pos/shifts" element={guardedAny([Permissions.POS_REPORTS, Permissions.POS_APPROVE_VARIANCE], <PosShiftsPage />)} />
        <Route path="pos/setup" element={guardedAny([Permissions.POS_MANAGE, Permissions.POS_SELL], <PosSetupPage />)} />
        <Route path="pos/reports" element={guarded([Permissions.POS_REPORTS], <PosReportsPage />)} />
        <Route path="patients" element={guardedAny([Permissions.PATIENTS_READ, Permissions.PHARMACY_READ], <PatientsPage />)} />
        <Route path="sales" element={guardedAny([Permissions.BILLING_READ, Permissions.BILLING_INVOICE], <SalesInvoicesPage />)} />
        <Route path="sales/new" element={guarded([Permissions.BILLING_INVOICE], <SaleFormPage />)} />
        <Route path="sales/:id" element={guardedAny([Permissions.BILLING_READ, Permissions.PHARMACY_READ], <SalesInvoiceDetailPage />)} />
        <Route path="billing/setup" element={guarded([Permissions.BILLING_READ], <BillingSetupPage />)} />
        <Route path="billing/reports" element={guardedAny([Permissions.BILLING_READ, Permissions.ETIMS_READ], <BillingReportsPage />)} />
        <Route path="etims" element={guarded([Permissions.ETIMS_READ], <EtimsConsolePage />)} />
        <Route path="store-requisitions" element={guardedAny(STORES_SEE, <StoreRequisitionsPage />)} />
        <Route path="store-requisitions/new" element={guarded([Permissions.INVENTORY_REQUISITION], <StoreRequisitionFormPage />)} />
        <Route path="store-requisitions/:id/edit" element={guarded([Permissions.INVENTORY_REQUISITION], <StoreRequisitionFormPage />)} />
        <Route path="store-requisitions/:id/issue" element={guarded([Permissions.INVENTORY_ISSUE], <IssueFormPage />)} />
        <Route path="store-requisitions/:id" element={guardedAny(STORES_SEE, <StoreRequisitionDetailPage />)} />
        <Route path="backorders" element={guardedAny(STORES_SEE, <BackordersPage />)} />
        <Route path="issues" element={guardedAny(STORES_SEE, <IssueVouchersPage />)} />
        <Route path="issues/:id" element={guardedAny(STORES_SEE, <IssueVoucherDetailPage />)} />
        <Route path="department-returns" element={guardedAny(STORES_SEE, <DepartmentReturnsPage />)} />
        <Route path="department-returns/new" element={guardedAny([Permissions.INVENTORY_REQUISITION, Permissions.INVENTORY_DEPT_RETURN], <DepartmentReturnFormPage />)} />
        <Route path="department-returns/:id" element={guardedAny(STORES_SEE, <DepartmentReturnDetailPage />)} />
        <Route path="supplier-returns" element={guardedAny([Permissions.PURCHASING_READ, Permissions.INVENTORY_SUPPLIER_RETURN], <SupplierReturnsPage />)} />
        <Route path="supplier-returns/new" element={guarded([Permissions.INVENTORY_SUPPLIER_RETURN], <SupplierReturnFormPage />)} />
        <Route path="supplier-returns/:id" element={guardedAny([Permissions.PURCHASING_READ, Permissions.INVENTORY_SUPPLIER_RETURN], <SupplierReturnDetailPage />)} />
        <Route path="consumption" element={guarded([Permissions.INVENTORY_CONSUMPTION], <ConsumptionPage />)} />
        <Route path="batches/:id/trace" element={guarded([Permissions.INVENTORY_READ], <BatchTracePage />)} />
        <Route path="stock-planning/reorder" element={guarded([Permissions.INVENTORY_READ], <ReorderPage />)} />
        <Route path="stock-planning/expiry" element={guarded([Permissions.INVENTORY_READ], <ExpiryPage />)} />
        <Route path="stock-planning/settings" element={guarded([Permissions.INVENTORY_READ], <StockLevelsPage />)} />
        <Route path="stock-planning/alerts" element={guardedAny([Permissions.INVENTORY_READ, Permissions.INVENTORY_ALERTS], <AlertsPage />)} />
        <Route path="jobs" element={guarded([Permissions.JOBS_RUN], <JobsPage />)} />
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

import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import AddShoppingCartIcon from '@mui/icons-material/AddShoppingCart';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import ScheduleIcon from '@mui/icons-material/Schedule';
import StackedLineChartIcon from '@mui/icons-material/StackedLineChart';
import AssignmentIcon from '@mui/icons-material/Assignment';
import AssignmentReturnIcon from '@mui/icons-material/AssignmentReturn';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import InsightsIcon from '@mui/icons-material/Insights';
import KeyboardReturnIcon from '@mui/icons-material/KeyboardReturn';
import OutboxIcon from '@mui/icons-material/Outbox';
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import HandshakeIcon from '@mui/icons-material/Handshake';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import CategoryIcon from '@mui/icons-material/Category';
import DashboardIcon from '@mui/icons-material/Dashboard';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import PaidIcon from '@mui/icons-material/Paid';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import TuneIcon from '@mui/icons-material/Tune';
import WarehouseIcon from '@mui/icons-material/Warehouse';
import GroupIcon from '@mui/icons-material/Group';
import HistoryIcon from '@mui/icons-material/History';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import MedicationIcon from '@mui/icons-material/Medication';
import SecurityIcon from '@mui/icons-material/Security';
import StoreIcon from '@mui/icons-material/Store';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ViewModuleIcon from '@mui/icons-material/ViewModule';
import AssessmentIcon from '@mui/icons-material/Assessment';
import LocalPharmacyIcon from '@mui/icons-material/LocalPharmacy';
import PersonIcon from '@mui/icons-material/Person';
import PointOfSaleIcon from '@mui/icons-material/PointOfSale';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
import VerifiedIcon from '@mui/icons-material/Verified';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CalculateIcon from '@mui/icons-material/Calculate';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import DescriptionIcon from '@mui/icons-material/Description';
import GavelIcon from '@mui/icons-material/Gavel';
import LeaderboardIcon from '@mui/icons-material/Leaderboard';
import PaymentsIcon from '@mui/icons-material/Payments';
import StarHalfIcon from '@mui/icons-material/StarHalf';
import StorefrontIcon from '@mui/icons-material/Storefront';
import TimelineIcon from '@mui/icons-material/Timeline';
import VolunteerActivismIcon from '@mui/icons-material/VolunteerActivism';
import WaterfallChartIcon from '@mui/icons-material/WaterfallChart';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import BlockIcon from '@mui/icons-material/Block';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DevicesOtherIcon from '@mui/icons-material/DevicesOther';
import EngineeringIcon from '@mui/icons-material/Engineering';
import FeedbackIcon from '@mui/icons-material/Feedback';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import ReportIcon from '@mui/icons-material/Report';
import RouteIcon from '@mui/icons-material/Route';
import SailingIcon from '@mui/icons-material/Sailing';
import HubIcon from '@mui/icons-material/Hub';
import HotelIcon from '@mui/icons-material/Hotel';
import VaccinesIcon from '@mui/icons-material/Vaccines';
import type { ReactNode } from 'react';
import { PermissionCode, Permissions } from '@sil/shared';

export interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  /** All required. */
  permissions: PermissionCode[];
  /** At least one required (in addition to `permissions`). */
  anyOf?: PermissionCode[];
  section: string;
  /** Supplier portal item: shown only to users linked to a supplier (who see nothing else). */
  portal?: boolean;
}

const P = Permissions;
/** Department staff, issuing stores and read-only roles see department documents. */
export const STORES_SEE: PermissionCode[] = [P.INVENTORY_REQUISITION, P.INVENTORY_ISSUE, P.INVENTORY_DEPT_RETURN, P.INVENTORY_READ];

/** A user linked to a supplier uses the supplier portal only. */
export const isPortalUser = (user: { supplierId?: string | null } | null | undefined) => !!user?.supplierId;

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: <DashboardIcon />, permissions: [], section: '' },
  { label: 'Approvals', path: '/approvals', icon: <TaskAltIcon />, permissions: [], section: '' },
  { label: 'Requisitions', path: '/requisitions', icon: <PlaylistAddIcon />, permissions: [Permissions.PURCHASING_READ], section: 'Procurement' },
  { label: 'RFQs', path: '/rfqs', icon: <RequestQuoteIcon />, permissions: [Permissions.PURCHASING_READ], section: 'Procurement' },
  { label: 'Purchase orders', path: '/purchase-orders', icon: <ShoppingCartIcon />, permissions: [Permissions.PURCHASING_READ], section: 'Procurement' },
  { label: 'Goods received', path: '/grns', icon: <LocalShippingIcon />, permissions: [Permissions.PURCHASING_READ], section: 'Procurement' },
  { label: 'Invoices', path: '/invoices', icon: <ReceiptLongIcon />, permissions: [Permissions.PURCHASING_READ], section: 'Procurement' },
  { label: 'Suppliers', path: '/suppliers', icon: <HandshakeIcon />, permissions: [Permissions.SUPPLIERS_READ], section: 'Procurement' },
  { label: 'Budgets', path: '/budgets', icon: <AccountBalanceIcon />, permissions: [Permissions.BUDGETS_READ], section: 'Procurement' },
  { label: 'Procurement plans', path: '/procurement-plans', icon: <CalendarMonthIcon />, permissions: [P.PLANS_READ], section: 'Sourcing & contracts' },
  { label: 'Tenders', path: '/tenders', icon: <GavelIcon />, permissions: [], anyOf: [P.TENDERS_READ, P.TENDERS_EVALUATE], section: 'Sourcing & contracts' },
  { label: 'Contracts', path: '/contracts', icon: <DescriptionIcon />, permissions: [P.CONTRACTS_READ], section: 'Sourcing & contracts' },
  { label: 'Supplier performance', path: '/supplier-performance', icon: <StarHalfIcon />, permissions: [], anyOf: [P.SUPPLIERS_PERFORMANCE, P.SUPPLIERS_READ], section: 'Sourcing & contracts' },
  { label: 'KEMSA / MEDS orders', path: '/agency-orders', icon: <LocalShippingIcon />, permissions: [P.PURCHASING_READ], section: 'Sourcing & contracts' },
  { label: 'Portal documents', path: '/portal-documents', icon: <UploadFileIcon />, permissions: [P.PURCHASING_READ], section: 'Sourcing & contracts' },
  { label: 'Procurement KPIs', path: '/procurement-kpis', icon: <LeaderboardIcon />, permissions: [P.PROCUREMENT_KPIS], section: 'Sourcing & contracts' },
  { label: 'Pharmacy worklist', path: '/pharmacy', icon: <LocalPharmacyIcon />, permissions: [P.PHARMACY_READ], section: 'Pharmacy & billing' },
  { label: 'Ward supply', path: '/pharmacy/ward-supply', icon: <VaccinesIcon />, permissions: [P.PHARMACY_READ], section: 'Pharmacy & billing' },
  { label: 'Encounters', path: '/encounters', icon: <HotelIcon />, permissions: [], anyOf: [P.HMIS_READ, P.PATIENTS_READ], section: 'Pharmacy & billing' },
  { label: 'Patients', path: '/patients', icon: <PersonIcon />, permissions: [], anyOf: [P.PATIENTS_READ, P.PHARMACY_READ], section: 'Pharmacy & billing' },
  { label: 'Drug interactions', path: '/pharmacy/interactions', icon: <WarningAmberIcon />, permissions: [P.PHARMACY_READ], section: 'Pharmacy & billing' },
  { label: 'Sales & receipts', path: '/sales', icon: <PointOfSaleIcon />, permissions: [], anyOf: [P.BILLING_READ, P.BILLING_INVOICE], section: 'Pharmacy & billing' },
  { label: 'Tax & eTIMS reports', path: '/billing/reports', icon: <AssessmentIcon />, permissions: [], anyOf: [P.BILLING_READ, P.ETIMS_READ], section: 'Pharmacy & billing' },
  { label: 'Billing setup', path: '/billing/setup', icon: <PriceChangeIcon />, permissions: [P.BILLING_READ], section: 'Pharmacy & billing' },
  { label: 'KRA eTIMS', path: '/etims', icon: <VerifiedIcon />, permissions: [P.ETIMS_READ], section: 'Pharmacy & billing' },
  { label: 'HMIS integration', path: '/hmis', icon: <HubIcon />, permissions: [P.HMIS_READ], section: 'Pharmacy & billing' },
  { label: 'Internal requisitions', path: '/store-requisitions', icon: <AssignmentTurnedInIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Issue vouchers', path: '/issues', icon: <OutboxIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Back-orders', path: '/backorders', icon: <PendingActionsIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Department returns', path: '/department-returns', icon: <AssignmentReturnIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Consumption', path: '/consumption', icon: <InsightsIcon />, permissions: [P.INVENTORY_CONSUMPTION], section: 'Wards & issues' },
  { label: 'Supplier returns', path: '/supplier-returns', icon: <KeyboardReturnIcon />, permissions: [], anyOf: [P.PURCHASING_READ, P.INVENTORY_SUPPLIER_RETURN], section: 'Procurement' },
  { label: 'Suggested reorder', path: '/stock-planning/reorder', icon: <AddShoppingCartIcon />, permissions: [P.INVENTORY_READ], section: 'Planning' },
  { label: 'Near expiry', path: '/stock-planning/expiry', icon: <EventBusyIcon />, permissions: [P.INVENTORY_READ], section: 'Planning' },
  { label: 'Stock levels', path: '/stock-planning/settings', icon: <StackedLineChartIcon />, permissions: [P.INVENTORY_READ], section: 'Planning' },
  { label: 'Stock alerts', path: '/stock-planning/alerts', icon: <NotificationsActiveIcon />, permissions: [], anyOf: [P.INVENTORY_READ, P.INVENTORY_ALERTS], section: 'Planning' },
  { label: 'Demand forecasting', path: '/forecasting', icon: <TimelineIcon />, permissions: [P.FORECASTING_READ], section: 'Planning' },
  { label: 'Supply planning', path: '/supply-planning', icon: <WaterfallChartIcon />, permissions: [P.FORECASTING_READ], section: 'Planning' },
  { label: 'Quantification', path: '/quantification', icon: <CalculateIcon />, permissions: [P.FORECASTING_READ], section: 'Planning' },
  { label: 'Donor stock', path: '/funding-sources', icon: <VolunteerActivismIcon />, permissions: [P.FORECASTING_READ], section: 'Planning' },
  { label: 'Supplier home', path: '/', icon: <StorefrontIcon />, permissions: [P.PORTAL_ACCESS], section: '', portal: true },
  { label: 'Requests for quotation', path: '/portal/rfqs', icon: <RequestQuoteIcon />, permissions: [P.PORTAL_ACCESS], section: 'Supplier portal', portal: true },
  { label: 'Tenders', path: '/portal/tenders', icon: <GavelIcon />, permissions: [P.PORTAL_ACCESS], section: 'Supplier portal', portal: true },
  { label: 'Purchase orders', path: '/portal/orders', icon: <ShoppingCartIcon />, permissions: [P.PORTAL_ACCESS], section: 'Supplier portal', portal: true },
  { label: 'Invoices & payments', path: '/portal/payments', icon: <PaymentsIcon />, permissions: [P.PORTAL_ACCESS], section: 'Supplier portal', portal: true },
  { label: 'Quarantine & holds', path: '/quality/holds', icon: <BlockIcon />, permissions: [], anyOf: [P.QUALITY_READ, P.QUALITY_RELEASE], section: 'Quality & safety' },
  { label: 'Cold chain', path: '/cold-chain', icon: <AcUnitIcon />, permissions: [], anyOf: [P.QUALITY_READ, P.INVENTORY_HANDLE_COLD_CHAIN], section: 'Quality & safety' },
  { label: 'Recalls', path: '/recalls', icon: <ReportIcon />, permissions: [], anyOf: [P.QUALITY_READ, P.RECALLS_MANAGE], section: 'Quality & safety' },
  { label: 'Complaints', path: '/quality/complaints', icon: <FeedbackIcon />, permissions: [], anyOf: [P.QUALITY_READ, P.QUALITY_MANAGE, P.PHARMACY_READ], section: 'Quality & safety' },
  { label: 'Disposals', path: '/disposals', icon: <DeleteSweepIcon />, permissions: [], anyOf: [P.DISPOSALS_MANAGE, P.INVENTORY_READ], section: 'Quality & safety' },
  { label: 'Distribution', path: '/distribution', icon: <RouteIcon />, permissions: [], anyOf: [P.DISTRIBUTION_MANAGE, P.INVENTORY_READ], section: 'Logistics' },
  { label: 'Inbound shipments', path: '/shipments', icon: <SailingIcon />, permissions: [P.PURCHASING_READ], section: 'Logistics' },
  { label: 'Service certificates', path: '/service-certificates', icon: <EngineeringIcon />, permissions: [P.PURCHASING_READ], section: 'Logistics' },
  { label: 'Assets', path: '/assets', icon: <DevicesOtherIcon />, permissions: [P.ASSETS_READ], section: 'Logistics' },
  { label: 'Labels', path: '/labels', icon: <QrCode2Icon />, permissions: [P.INVENTORY_READ], section: 'Logistics' },
  { label: 'Stock on hand', path: '/stock', icon: <WarehouseIcon />, permissions: [Permissions.INVENTORY_READ], section: 'Inventory' },
  { label: 'Receipts', path: '/receipts', icon: <MoveToInboxIcon />, permissions: [Permissions.INVENTORY_READ], section: 'Inventory' },
  { label: 'Transfers', path: '/transfers', icon: <SwapHorizIcon />, permissions: [Permissions.INVENTORY_READ], section: 'Inventory' },
  { label: 'Adjustments', path: '/adjustments', icon: <TuneIcon />, permissions: [Permissions.INVENTORY_READ], section: 'Inventory' },
  { label: 'Stock takes', path: '/stock-takes', icon: <FactCheckIcon />, permissions: [Permissions.INVENTORY_READ], section: 'Inventory' },
  { label: 'Valuation', path: '/valuation', icon: <PaidIcon />, permissions: [Permissions.INVENTORY_VALUATION], section: 'Inventory' },
  { label: 'Items', path: '/items', icon: <Inventory2Icon />, permissions: [Permissions.CATALOG_READ], section: 'Catalog' },
  { label: 'Generics', path: '/generics', icon: <MedicationIcon />, permissions: [Permissions.CATALOG_READ], section: 'Catalog' },
  { label: 'Bulk import', path: '/import', icon: <UploadFileIcon />, permissions: [Permissions.CATALOG_IMPORT], section: 'Catalog' },
  { label: 'Stores', path: '/stores', icon: <StoreIcon />, permissions: [Permissions.ORG_READ], section: 'Organisation' },
  { label: 'Bins', path: '/bins', icon: <ViewModuleIcon />, permissions: [Permissions.ORG_READ], section: 'Organisation' },
  { label: 'Departments', path: '/departments', icon: <CategoryIcon />, permissions: [Permissions.ORG_READ], section: 'Organisation' },
  { label: 'Users', path: '/users', icon: <GroupIcon />, permissions: [Permissions.USERS_READ], section: 'Administration' },
  { label: 'Roles', path: '/roles', icon: <SecurityIcon />, permissions: [Permissions.ROLES_READ], section: 'Administration' },
  { label: 'Background jobs', path: '/jobs', icon: <ScheduleIcon />, permissions: [P.JOBS_RUN], section: 'Administration' },
  { label: 'Audit log', path: '/audit', icon: <HistoryIcon />, permissions: [Permissions.AUDIT_READ], section: 'Administration' },
  { label: 'My account', path: '/account', icon: <AssignmentIcon />, permissions: [], section: 'Administration' },
  { label: 'My account', path: '/account', icon: <AssignmentIcon />, permissions: [], section: 'Supplier portal', portal: true },
];

/**
 * Menu for the user. Portal users (linked to a supplier) see only the portal;
 * staff never see portal items.
 */
export function visibleNav(can: (...p: PermissionCode[]) => boolean, portalUser = false): NavItem[] {
  return NAV_ITEMS.filter((i) => !!i.portal === portalUser && can(...i.permissions) && (!i.anyOf?.length || i.anyOf.some((p) => can(p))));
}

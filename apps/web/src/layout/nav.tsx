import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
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
}

const P = Permissions;
/** Department staff, issuing stores and read-only roles see department documents. */
export const STORES_SEE: PermissionCode[] = [P.INVENTORY_REQUISITION, P.INVENTORY_ISSUE, P.INVENTORY_DEPT_RETURN, P.INVENTORY_READ];

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
  { label: 'Internal requisitions', path: '/store-requisitions', icon: <AssignmentTurnedInIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Issue vouchers', path: '/issues', icon: <OutboxIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Back-orders', path: '/backorders', icon: <PendingActionsIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Department returns', path: '/department-returns', icon: <AssignmentReturnIcon />, permissions: [], anyOf: STORES_SEE, section: 'Wards & issues' },
  { label: 'Consumption', path: '/consumption', icon: <InsightsIcon />, permissions: [P.INVENTORY_CONSUMPTION], section: 'Wards & issues' },
  { label: 'Supplier returns', path: '/supplier-returns', icon: <KeyboardReturnIcon />, permissions: [], anyOf: [P.PURCHASING_READ, P.INVENTORY_SUPPLIER_RETURN], section: 'Procurement' },
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
  { label: 'Audit log', path: '/audit', icon: <HistoryIcon />, permissions: [Permissions.AUDIT_READ], section: 'Administration' },
  { label: 'My account', path: '/account', icon: <AssignmentIcon />, permissions: [], section: 'Administration' },
];

export function visibleNav(can: (...p: PermissionCode[]) => boolean): NavItem[] {
  return NAV_ITEMS.filter((i) => can(...i.permissions) && (!i.anyOf?.length || i.anyOf.some((p) => can(p))));
}

import AssignmentIcon from '@mui/icons-material/Assignment';
import CategoryIcon from '@mui/icons-material/Category';
import DashboardIcon from '@mui/icons-material/Dashboard';
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
  section: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: <DashboardIcon />, permissions: [], section: '' },
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
  return NAV_ITEMS.filter((i) => can(...i.permissions));
}

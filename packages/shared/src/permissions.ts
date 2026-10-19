/**
 * Permission codes understood by the API. Which role holds which permission is
 * data (role_permissions table), seeded by default but editable at runtime.
 */
export const Permissions = {
  SETTINGS_READ: 'settings.read',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_READ: 'audit.read',
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  ROLES_READ: 'roles.read',
  ROLES_MANAGE: 'roles.manage',
  ORG_READ: 'org.read',
  ORG_MANAGE: 'org.manage',
  BINS_MANAGE: 'bins.manage',
  /** Bypasses per-store data scoping. */
  STORE_ALL: 'store.all',
  CATALOG_READ: 'catalog.read',
  CATALOG_MANAGE: 'catalog.manage',
  CATALOG_IMPORT: 'catalog.import',
  TAX_READ: 'tax.read',
  TAX_MANAGE: 'tax.manage',
  NUMBERING_READ: 'numbering.read',
  NUMBERING_MANAGE: 'numbering.manage',
} as const;

export type PermissionCode = (typeof Permissions)[keyof typeof Permissions];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  'settings.read': 'View system settings',
  'settings.manage': 'Change system settings',
  'audit.read': 'View the audit log',
  'users.read': 'View users',
  'users.manage': 'Create, edit and deactivate users',
  'roles.read': 'View roles and permissions',
  'roles.manage': 'Create and edit roles',
  'org.read': 'View facilities, stores, bins and departments',
  'org.manage': 'Manage facilities, stores and departments',
  'bins.manage': 'Manage bins in accessible stores',
  'store.all': 'Access data of all stores (no store scoping)',
  'catalog.read': 'View generics, items, categories and units',
  'catalog.manage': 'Create and edit catalog records',
  'catalog.import': 'Bulk import catalog items',
  'tax.read': 'View tax categories and rates',
  'tax.manage': 'Manage tax categories and rates',
  'numbering.read': 'View document numbering schemes',
  'numbering.manage': 'Manage document numbering schemes',
};

/** Built-in role codes (seeded). Additional roles can be created at runtime. */
export const RoleCodes = {
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
  PROCUREMENT_OFFICER: 'PROCUREMENT_OFFICER',
  PROCUREMENT_MANAGER: 'PROCUREMENT_MANAGER',
  STOREKEEPER: 'STOREKEEPER',
  PHARMACIST: 'PHARMACIST',
  PHARMACY_TECHNICIAN: 'PHARMACY_TECHNICIAN',
  POS_CASHIER: 'POS_CASHIER',
  QUALITY_OFFICER: 'QUALITY_OFFICER',
  WARD_IN_CHARGE: 'WARD_IN_CHARGE',
  FINANCE: 'FINANCE',
  TENDER_COMMITTEE: 'TENDER_COMMITTEE',
  SUPPLY_CHAIN_MANAGER: 'SUPPLY_CHAIN_MANAGER',
  SUPPLIER: 'SUPPLIER',
  AUDITOR: 'AUDITOR',
  HOSPITAL_MANAGEMENT: 'HOSPITAL_MANAGEMENT',
} as const;

export type RoleCode = (typeof RoleCodes)[keyof typeof RoleCodes];

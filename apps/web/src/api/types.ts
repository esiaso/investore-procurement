import type {
  AttributeDefinition,
  ControlledSchedule,
  SalesClass,
  ServicePoint,
  StoreType,
  TaxTreatment,
} from '@sil/shared';

export interface Base {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Facility extends Base {
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  kraPin: string | null;
  isActive: boolean;
}

export interface Store extends Base {
  facilityId: string;
  code: string;
  name: string;
  type: StoreType;
  servicePoint: ServicePoint | null;
  parentStoreId: string | null;
  parentStore?: Store | null;
  isActive: boolean;
}

export interface Bin extends Base {
  storeId: string;
  store?: Store;
  code: string;
  name: string;
  zone: string | null;
  isQuarantine?: boolean;
  isActive: boolean;
}

export interface Department extends Base {
  facilityId: string;
  code: string;
  name: string;
  costCentreCode: string;
  isActive: boolean;
}

export interface Permission {
  code: string;
  description: string;
}

export interface Role extends Base {
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions?: Permission[];
}

export interface User extends Base {
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  departmentId: string | null;
  roles?: Role[];
  stores?: Store[];
}

export interface TaxCategory extends Base {
  code: string;
  name: string;
  treatment: TaxTreatment;
  isActive: boolean;
}

export interface Uom extends Base {
  code: string;
  name: string;
  isActive: boolean;
}

export interface ItemCategory extends Base {
  code: string;
  name: string;
  parentId: string | null;
  isDrug: boolean;
  attributeSchema: AttributeDefinition[];
}

export interface Generic extends Base {
  innName: string;
  strength: string;
  dosageForm: string;
  route: string;
  atcCode: string | null;
  therapeuticClass: string | null;
  isKeml: boolean;
  controlledSchedule: ControlledSchedule;
  storageRequirements: string | null;
  pregnancyNotes: string | null;
  lactationNotes: string | null;
  pregnancyContraindicated?: boolean;
  minAgeYears?: number | null;
  isActive: boolean;
  items?: Item[];
}

export interface Item extends Base {
  code: string;
  genericId: string | null;
  generic?: Generic | null;
  categoryId: string;
  category?: ItemCategory;
  name: string;
  brandName: string | null;
  manufacturer: string | null;
  ppbRegNo: string | null;
  packSize: string | null;
  gtin: string | null;
  barcode: string | null;
  baseUomId: string;
  baseUom?: Uom;
  unitPrice: number;
  salesClass: SalesClass | null;
  taxCategoryId: string;
  taxCategory?: TaxCategory;
  isFormulary: boolean;
  isBatchTracked: boolean;
  isColdChain: boolean;
  isControlled: boolean;
  reorderLevel: number | null;
  attributes: Record<string, string | number | boolean | null>;
  isActive: boolean;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

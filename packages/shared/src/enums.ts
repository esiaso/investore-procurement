/** Kinds of stock-holding location. */
export enum StoreType {
  MAIN_STORE = 'MAIN_STORE',
  MAIN_PHARMACY = 'MAIN_PHARMACY',
  SATELLITE_PHARMACY = 'SATELLITE_PHARMACY',
  SUB_STORE = 'SUB_STORE',
}

/** Service point a satellite pharmacy / sub-store serves. */
export enum ServicePoint {
  OPD = 'OPD',
  IPD = 'IPD',
  THEATRE = 'THEATRE',
  EMERGENCY = 'EMERGENCY',
  ICU = 'ICU',
  MATERNITY = 'MATERNITY',
  OTHER = 'OTHER',
}

/** Kenyan medicine sales classification. */
export enum SalesClass {
  OTC = 'OTC',
  P = 'P',
  POM = 'POM',
  CD = 'CD',
}

/** Narcotic / psychotropic control schedule of a generic. */
export enum ControlledSchedule {
  NONE = 'NONE',
  SCHEDULE_I = 'SCHEDULE_I',
  SCHEDULE_II = 'SCHEDULE_II',
  SCHEDULE_III = 'SCHEDULE_III',
  SCHEDULE_IV = 'SCHEDULE_IV',
}

export enum TaxTreatment {
  STANDARD = 'STANDARD',
  ZERO_RATED = 'ZERO_RATED',
  EXEMPT = 'EXEMPT',
}

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LOGIN = 'LOGIN',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  PASSWORD_CHANGE = 'PASSWORD_CHANGE',
  TWO_FACTOR_ENABLED = 'TWO_FACTOR_ENABLED',
  TWO_FACTOR_DISABLED = 'TWO_FACTOR_DISABLED',
  IMPORT = 'IMPORT',
}

export enum AttributeType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  ENUM = 'enum',
}

/** Document types that draw numbers from the numbering service. */
export enum DocumentType {
  ITEM = 'ITEM',
  PURCHASE_REQUISITION = 'PR',
  PURCHASE_ORDER = 'PO',
  GOODS_RECEIVED_NOTE = 'GRN',
  STORE_REQUISITION = 'SR',
  ISSUE_NOTE = 'ISS',
  TRANSFER = 'TRF',
  STOCK_ADJUSTMENT = 'ADJ',
}

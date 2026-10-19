import {
  AdjustmentDirection,
  AttributeType,
  DocumentType,
  Permissions,
  RoleCodes,
  TaxTreatment,
  type AttributeDefinition,
  type PermissionCode,
} from '@sil/shared';

/**
 * Default configuration for a private hospital in Kenya. Everything here is
 * data: it is inserted once and can then be changed through the API.
 */
export const DEFAULT_SETTINGS: { key: string; value: unknown; description: string; isPublic: boolean }[] = [
  { key: 'locale.currency', value: 'KES', description: 'ISO 4217 currency code', isPublic: true },
  { key: 'locale.timezone', value: 'Africa/Nairobi', description: 'IANA timezone for business dates', isPublic: true },
  { key: 'locale.dateFormat', value: 'DD/MM/YYYY', description: 'Display date format', isPublic: true },
  { key: 'finance.fyStartMonth', value: 1, description: 'Financial year start month (1 = January)', isPublic: true },
  {
    key: 'security.passwordPolicy',
    value: { minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true },
    description: 'Password complexity rules',
    isPublic: true,
  },
  { key: 'security.maxFailedLogins', value: 5, description: 'Failed logins before temporary lockout', isPublic: false },
  { key: 'security.lockoutMinutes', value: 15, description: 'Lockout duration in minutes', isPublic: false },
  { key: 'security.totpIssuer', value: 'SIL Hospital', description: 'Issuer name shown in authenticator apps', isPublic: false },
  { key: 'security.pending2faTtlSeconds', value: 300, description: 'Time allowed to enter the 2FA code', isPublic: false },
  { key: 'import.maxRows', value: 5000, description: 'Maximum rows per bulk import file', isPublic: false },
  { key: 'inventory.valuationMethod', value: 'WAC', description: 'Stock valuation: WAC (weighted average per item per store) or FIFO (batch cost)', isPublic: false },
  {
    key: 'inventory.adjustmentSecondApprovalThreshold',
    value: 50000,
    description: 'Adjustments above this value need a second, different approver',
    isPublic: false,
  },
  { key: 'inventory.expiryWarningDays', value: [30, 60, 90, 180], description: 'Expiry warning buckets (days)', isPublic: true },
];

export const DEFAULT_ADJUSTMENT_REASONS: { code: string; name: string; direction: AdjustmentDirection }[] = [
  { code: 'DAMAGE', name: 'Damaged', direction: AdjustmentDirection.DECREASE },
  { code: 'LOSS', name: 'Lost / unaccounted', direction: AdjustmentDirection.DECREASE },
  { code: 'THEFT', name: 'Theft', direction: AdjustmentDirection.DECREASE },
  { code: 'BREAKAGE', name: 'Breakage', direction: AdjustmentDirection.DECREASE },
  { code: 'EXPIRY', name: 'Expiry write-off', direction: AdjustmentDirection.DECREASE },
  { code: 'FOUND', name: 'Stock found', direction: AdjustmentDirection.INCREASE },
  { code: 'CORRECTION', name: 'Data correction', direction: AdjustmentDirection.BOTH },
  { code: 'TRANSIT_LOSS', name: 'Lost or damaged in transit', direction: AdjustmentDirection.DECREASE },
  { code: 'COUNT_VARIANCE', name: 'Stock-take variance', direction: AdjustmentDirection.BOTH },
];

/**
 * Tax categories and their rates. Treatments follow the Kenyan VAT Act
 * (standard 16%, zero-rated, exempt). Which items fall in which category must
 * be confirmed by Finance; the sample catalog uses them illustratively.
 */
export const DEFAULT_TAX: { code: string; name: string; treatment: TaxTreatment; ratePercent: number; effectiveFrom: string }[] = [
  { code: 'STANDARD', name: 'VAT standard rate', treatment: TaxTreatment.STANDARD, ratePercent: 16, effectiveFrom: '2020-01-01' },
  { code: 'ZERO', name: 'VAT zero-rated', treatment: TaxTreatment.ZERO_RATED, ratePercent: 0, effectiveFrom: '2020-01-01' },
  { code: 'EXEMPT', name: 'VAT exempt', treatment: TaxTreatment.EXEMPT, ratePercent: 0, effectiveFrom: '2020-01-01' },
];

export const DEFAULT_NUMBERING: {
  documentType: string;
  prefix: string;
  format: string;
  padding: number;
  resetEachYear: boolean;
}[] = [
  { documentType: DocumentType.ITEM, prefix: 'ITM', format: '{PREFIX}{SEQ}', padding: 6, resetEachYear: false },
  { documentType: DocumentType.PURCHASE_REQUISITION, prefix: 'PR', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.PURCHASE_ORDER, prefix: 'PO', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.GOODS_RECEIVED_NOTE, prefix: 'GRN', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STORE_REQUISITION, prefix: 'SR', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.ISSUE_NOTE, prefix: 'ISS', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.TRANSFER, prefix: 'TRF', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_ADJUSTMENT, prefix: 'ADJ', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_RECEIPT, prefix: 'RCPT', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.STOCK_TAKE, prefix: 'STK', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
];

export const DEFAULT_UOMS: [code: string, name: string][] = [
  ['TAB', 'Tablet'],
  ['CAP', 'Capsule'],
  ['STRIP', 'Strip'],
  ['BOX', 'Box'],
  ['BTL', 'Bottle'],
  ['VIAL', 'Vial'],
  ['AMP', 'Ampoule'],
  ['TUBE', 'Tube'],
  ['SACHET', 'Sachet'],
  ['PCS', 'Piece'],
  ['PAIR', 'Pair'],
  ['PACK', 'Pack'],
  ['ROLL', 'Roll'],
  ['KIT', 'Kit'],
  ['BAG', 'Bag'],
  ['ML', 'Millilitre'],
  ['L', 'Litre'],
  ['PESS', 'Pessary'],
  ['INH', 'Inhaler'],
];

/** Global conversions (item-independent). */
export const DEFAULT_CONVERSIONS: [from: string, to: string, factor: number][] = [['L', 'ML', 1000]];

const ppe: AttributeDefinition[] = [
  { key: 'size', label: 'Size', type: AttributeType.ENUM, required: true, options: ['XS', 'S', 'M', 'L', 'XL', 'Universal'] },
  { key: 'material', label: 'Material', type: AttributeType.STRING, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const sharps: AttributeDefinition[] = [
  { key: 'gauge', label: 'Gauge (G)', type: AttributeType.NUMBER, required: false },
  { key: 'volumeMl', label: 'Volume (mL)', type: AttributeType.NUMBER, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const dressings: AttributeDefinition[] = [
  { key: 'dimensions', label: 'Dimensions', type: AttributeType.STRING, required: false },
  { key: 'sterile', label: 'Sterile', type: AttributeType.BOOLEAN, required: true },
];
const sutures: AttributeDefinition[] = [
  { key: 'usp', label: 'USP size', type: AttributeType.STRING, required: true },
  { key: 'absorbable', label: 'Absorbable', type: AttributeType.BOOLEAN, required: true },
  { key: 'needle', label: 'Needle type', type: AttributeType.ENUM, required: false, options: ['Round body', 'Cutting', 'Reverse cutting', 'None'] },
];
const lab: AttributeDefinition[] = [
  { key: 'testsPerKit', label: 'Tests per kit', type: AttributeType.NUMBER, required: false },
  { key: 'storageTemp', label: 'Storage temperature', type: AttributeType.STRING, required: false },
];

export const DEFAULT_CATEGORIES: { code: string; name: string; isDrug: boolean; attributeSchema: AttributeDefinition[]; parent?: string }[] = [
  { code: 'DRUG', name: 'Medicines', isDrug: true, attributeSchema: [] },
  { code: 'DRUG-ANALG', name: 'Analgesics & anti-inflammatories', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-ANTIINF', name: 'Anti-infectives', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-CVS', name: 'Cardiovascular', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-ENDO', name: 'Endocrine & diabetes', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-GIT', name: 'Gastro-intestinal', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-RESP', name: 'Respiratory & allergy', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-CNS', name: 'CNS, anaesthesia & controlled', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-FLUIDS', name: 'IV fluids & electrolytes', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-OBS', name: 'Obstetrics & reproductive health', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-VACC', name: 'Vaccines & sera', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-DERM', name: 'Dermatologicals', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'DRUG-VIT', name: 'Vitamins & minerals', isDrug: true, attributeSchema: [], parent: 'DRUG' },
  { code: 'SUP', name: 'Medical supplies', isDrug: false, attributeSchema: [] },
  { code: 'SUP-PPE', name: 'PPE', isDrug: false, attributeSchema: ppe, parent: 'SUP' },
  { code: 'SUP-SHARPS', name: 'Syringes, needles & cannulae', isDrug: false, attributeSchema: sharps, parent: 'SUP' },
  { code: 'SUP-DRESS', name: 'Dressings & bandages', isDrug: false, attributeSchema: dressings, parent: 'SUP' },
  { code: 'SUP-SUTURE', name: 'Sutures', isDrug: false, attributeSchema: sutures, parent: 'SUP' },
  { code: 'SUP-LAB', name: 'Laboratory reagents & kits', isDrug: false, attributeSchema: lab, parent: 'SUP' },
  { code: 'SUP-GEN', name: 'General consumables', isDrug: false, attributeSchema: [], parent: 'SUP' },
];

const P = Permissions;
const ALL = Object.values(P) as PermissionCode[];
const READ_ALL: PermissionCode[] = [
  P.SETTINGS_READ, P.AUDIT_READ, P.USERS_READ, P.ROLES_READ, P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.TAX_READ, P.NUMBERING_READ,
  P.INVENTORY_READ, P.INVENTORY_VALUATION,
];
/** Day-to-day store operations in assigned stores. */
const STORE_OPS: PermissionCode[] = [
  P.INVENTORY_READ, P.INVENTORY_RECEIVE, P.INVENTORY_ADJUST, P.INVENTORY_TRANSFER_REQUEST, P.INVENTORY_TRANSFER_DISPATCH,
  P.INVENTORY_TRANSFER_RECEIVE, P.INVENTORY_STOCKTAKE,
];

/** Default permission sets per built-in role. Editable at runtime. */
export const DEFAULT_ROLES: { code: string; name: string; description: string; permissions: PermissionCode[] }[] = [
  { code: RoleCodes.SYSTEM_ADMIN, name: 'System Admin', description: 'Full system administration', permissions: ALL },
  {
    code: RoleCodes.PROCUREMENT_OFFICER,
    name: 'Procurement Officer',
    description: 'Raises requisitions and purchase orders; maintains the catalog',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.INVENTORY_READ, P.INVENTORY_VALUATION],
  },
  {
    code: RoleCodes.PROCUREMENT_MANAGER,
    name: 'Procurement Manager / Approver',
    description: 'Approves procurement documents',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE],
  },
  {
    code: RoleCodes.STOREKEEPER,
    name: 'Storekeeper',
    description: 'Receives, stores and issues stock in assigned stores',
    permissions: [P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, ...STORE_OPS, P.INVENTORY_HANDLE_COLD_CHAIN],
  },
  {
    code: RoleCodes.PHARMACIST,
    name: 'Pharmacist',
    description: 'Manages pharmacy stock and formulary in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, P.CATALOG_MANAGE, ...STORE_OPS, P.INVENTORY_VALUATION,
      P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_OVERRIDE_FEFO,
      P.INVENTORY_HANDLE_CONTROLLED, P.INVENTORY_HANDLE_COLD_CHAIN,
    ],
  },
  {
    code: RoleCodes.PHARMACY_TECHNICIAN,
    name: 'Pharmacy Technician',
    description: 'Dispenses and handles pharmacy stock in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_TRANSFER_REQUEST, P.INVENTORY_TRANSFER_RECEIVE,
      P.INVENTORY_STOCKTAKE, P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED,
    ],
  },
  { code: RoleCodes.POS_CASHIER, name: 'POS Cashier', description: 'Point-of-sale operations', permissions: [P.CATALOG_READ, P.INVENTORY_READ] },
  {
    code: RoleCodes.QUALITY_OFFICER,
    name: 'Cold-chain / Quality Officer',
    description: 'Monitors cold chain, recalls and quality',
    permissions: [
      P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_BATCH_HOLD,
      P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED,
    ],
  },
  {
    code: RoleCodes.WARD_IN_CHARGE,
    name: 'Department / Ward In-charge',
    description: 'Requests stock for a department or ward',
    permissions: [P.ORG_READ, P.CATALOG_READ],
  },
  {
    code: RoleCodes.FINANCE,
    name: 'Finance / Accounts',
    description: 'Tax configuration, invoices and payments',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.TAX_READ, P.TAX_MANAGE, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_PERIOD_LOCK, P.INVENTORY_RECONCILE],
  },
  {
    code: RoleCodes.TENDER_COMMITTEE,
    name: 'Tender / Evaluation Committee Member',
    description: 'Evaluates tenders and quotations',
    permissions: [P.CATALOG_READ],
  },
  {
    code: RoleCodes.SUPPLY_CHAIN_MANAGER,
    name: 'Supply Chain Manager',
    description: 'Oversees stores, catalog and numbering',
    permissions: [
      P.ORG_READ, P.ORG_MANAGE, P.BINS_MANAGE, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT,
      P.TAX_READ, P.AUDIT_READ, P.NUMBERING_READ, P.NUMBERING_MANAGE, P.USERS_READ, ...STORE_OPS,
      P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_OVERRIDE_FEFO,
      P.INVENTORY_HANDLE_CONTROLLED, P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_BATCH_HOLD, P.INVENTORY_PERIOD_LOCK,
      P.INVENTORY_RECONCILE,
    ],
  },
  { code: RoleCodes.SUPPLIER, name: 'Supplier (portal)', description: 'External supplier portal user', permissions: [] },
  { code: RoleCodes.AUDITOR, name: 'Auditor (read-only)', description: 'Read-only access to all records', permissions: READ_ALL },
  { code: RoleCodes.HOSPITAL_MANAGEMENT, name: 'Hospital Management', description: 'Read-only oversight', permissions: READ_ALL },
];

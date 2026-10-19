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
  { key: 'mail.fromAddress', value: 'Procurement <procurement@hospital.example>', description: 'Sender of outgoing mail', isPublic: false },
  { key: 'purchasing.matchQtyTolerancePct', value: 0, description: 'Three-way match: % over received quantity tolerated', isPublic: false },
  { key: 'purchasing.matchPriceTolerancePct', value: 2, description: 'Three-way match: % price difference tolerated', isPublic: false },
  { key: 'purchasing.overReceiptTolerancePct', value: 0, description: '% over the ordered quantity a GRN may receive', isPublic: false },
  { key: 'purchasing.inspectionCommitteeMinMembers', value: 2, description: 'Inspection committee sign-offs needed to post a GRN', isPublic: false },
  { key: 'purchasing.costIncludesVat', value: true, description: 'Add VAT to stock cost on receipt. On by default: the hospital cannot claim input VAT, so VAT paid is part of item cost', isPublic: false },
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
  { documentType: DocumentType.RFQ, prefix: 'RFQ', format: '{PREFIX}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.SUPPLIER, prefix: 'SUP', format: '{PREFIX}{SEQ}', padding: 4, resetEachYear: false },
  { documentType: DocumentType.SUPPLIER_INVOICE, prefix: 'INV', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
  { documentType: DocumentType.RETURN_TO_SUPPLIER, prefix: 'RTS', format: '{PREFIX}/{STORE}/{FY}/{SEQ}', padding: 4, resetEachYear: true },
  { documentType: DocumentType.PAYMENT_VOUCHER, prefix: 'PV', format: '{PREFIX}/{FY}/{SEQ}', padding: 5, resetEachYear: true },
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
  P.INVENTORY_READ, P.INVENTORY_VALUATION, P.SUPPLIERS_READ, P.BUDGETS_READ, P.PURCHASING_READ,
];
const BUYING: PermissionCode[] = [P.SUPPLIERS_READ, P.SUPPLIERS_MANAGE, P.BUDGETS_READ, P.PURCHASING_READ, P.PURCHASING_RFQ, P.PURCHASING_PO];
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
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.INVENTORY_READ, P.INVENTORY_VALUATION,
      ...BUYING, P.PURCHASING_REQUISITION],
  },
  {
    code: RoleCodes.PROCUREMENT_MANAGER,
    name: 'Procurement Manager / Approver',
    description: 'Approves procurement documents',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.CATALOG_MANAGE, P.CATALOG_IMPORT, P.TAX_READ, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, ...BUYING],
  },
  {
    code: RoleCodes.STOREKEEPER,
    name: 'Storekeeper',
    description: 'Receives, stores and issues stock in assigned stores',
    permissions: [
      P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, ...STORE_OPS, P.INVENTORY_HANDLE_COLD_CHAIN, P.SUPPLIERS_READ, P.PURCHASING_READ,
      P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_EMERGENCY_RECEIPT,
    ],
  },
  {
    code: RoleCodes.PHARMACIST,
    name: 'Pharmacist',
    description: 'Manages pharmacy stock and formulary in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.BINS_MANAGE, P.CATALOG_READ, P.CATALOG_MANAGE, ...STORE_OPS, P.INVENTORY_VALUATION,
      P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_STOCKTAKE_APPROVE, P.INVENTORY_OVERRIDE_FEFO,
      P.INVENTORY_HANDLE_CONTROLLED, P.INVENTORY_HANDLE_COLD_CHAIN, P.SUPPLIERS_READ, P.PURCHASING_READ,
      P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_INSPECT,
    ],
  },
  {
    code: RoleCodes.PHARMACY_TECHNICIAN,
    name: 'Pharmacy Technician',
    description: 'Dispenses and handles pharmacy stock in assigned pharmacies',
    permissions: [
      P.ORG_READ, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_TRANSFER_REQUEST, P.INVENTORY_TRANSFER_RECEIVE,
      P.INVENTORY_STOCKTAKE, P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED, P.PURCHASING_READ,
    ],
  },
  { code: RoleCodes.POS_CASHIER, name: 'POS Cashier', description: 'Point-of-sale operations', permissions: [P.CATALOG_READ, P.INVENTORY_READ] },
  {
    code: RoleCodes.QUALITY_OFFICER,
    name: 'Cold-chain / Quality Officer',
    description: 'Monitors cold chain, recalls and quality',
    permissions: [
      P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.INVENTORY_READ, P.INVENTORY_BATCH_HOLD,
      P.INVENTORY_HANDLE_COLD_CHAIN, P.INVENTORY_HANDLE_CONTROLLED, P.SUPPLIERS_READ, P.PURCHASING_READ, P.PURCHASING_INSPECT,
    ],
  },
  {
    code: RoleCodes.WARD_IN_CHARGE,
    name: 'Department / Ward In-charge',
    description: 'Requests stock for a department or ward',
    permissions: [P.ORG_READ, P.CATALOG_READ, P.PURCHASING_READ, P.PURCHASING_REQUISITION],
  },
  {
    code: RoleCodes.FINANCE,
    name: 'Finance / Accounts',
    description: 'Tax configuration, invoices and payments',
    permissions: [P.ORG_READ, P.STORE_ALL, P.CATALOG_READ, P.TAX_READ, P.TAX_MANAGE, P.AUDIT_READ, P.NUMBERING_READ,
      P.INVENTORY_READ, P.INVENTORY_VALUATION, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_PERIOD_LOCK, P.INVENTORY_RECONCILE,
      P.SUPPLIERS_READ, P.SUPPLIERS_BANK, P.BUDGETS_READ, P.BUDGETS_MANAGE, P.PURCHASING_READ, P.PURCHASING_INVOICE, P.PURCHASING_PAYMENT],
  },
  {
    code: RoleCodes.TENDER_COMMITTEE,
    name: 'Tender / Evaluation Committee Member',
    description: 'Evaluates tenders and quotations',
    permissions: [P.CATALOG_READ, P.SUPPLIERS_READ, P.PURCHASING_READ, P.PURCHASING_INSPECT],
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
      P.INVENTORY_RECONCILE, ...BUYING, P.PURCHASING_REQUISITION, P.PURCHASING_RECEIVE, P.PURCHASING_INSPECT,
      P.PURCHASING_EMERGENCY_RECEIPT, P.APPROVALS_MANAGE,
    ],
  },
  { code: RoleCodes.SUPPLIER, name: 'Supplier (portal)', description: 'External supplier portal user', permissions: [] },
  { code: RoleCodes.AUDITOR, name: 'Auditor (read-only)', description: 'Read-only access to all records', permissions: READ_ALL },
  { code: RoleCodes.HOSPITAL_MANAGEMENT, name: 'Hospital Management', description: 'Read-only oversight', permissions: READ_ALL },
];

/**
 * Default approval workflows by amount band (KES, VAT inclusive). Bands are
 * [min, max). Edit them under Approvals → Workflows.
 */
export const DEFAULT_WORKFLOWS: {
  code: string;
  name: string;
  documentType: string;
  minAmount: number | null;
  maxAmount: number | null;
  itemCategoryCode?: string;
  priority?: number;
  steps: [name: string, roleCode: string][];
}[] = [
  { code: 'PR-1', name: 'Requisitions up to 100,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: null, maxAmount: 100_000, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PR-2', name: 'Requisitions 100,000 to 1,000,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: 100_000, maxAmount: 1_000_000, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER], ['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER]] },
  { code: 'PR-3', name: 'Requisitions over 1,000,000', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: 1_000_000, maxAmount: null, steps: [['Procurement review', RoleCodes.PROCUREMENT_MANAGER], ['Supply chain approval', RoleCodes.SUPPLY_CHAIN_MANAGER], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'PR-CD', name: 'Requisitions with CNS / controlled medicines', documentType: DocumentType.PURCHASE_REQUISITION, minAmount: null, maxAmount: null, itemCategoryCode: 'DRUG-CNS', steps: [['Pharmacist-in-charge', RoleCodes.PHARMACIST], ['Procurement review', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PO-1', name: 'Purchase orders up to 500,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: null, maxAmount: 500_000, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER]] },
  { code: 'PO-2', name: 'Purchase orders 500,000 to 5,000,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: 500_000, maxAmount: 5_000_000, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER], ['Finance approval', RoleCodes.FINANCE]] },
  { code: 'PO-3', name: 'Purchase orders over 5,000,000', documentType: DocumentType.PURCHASE_ORDER, minAmount: 5_000_000, maxAmount: null, steps: [['Procurement approval', RoleCodes.PROCUREMENT_MANAGER], ['Finance approval', RoleCodes.FINANCE], ['Management approval', RoleCodes.HOSPITAL_MANAGEMENT]] },
  { code: 'INV-1', name: 'Supplier invoices', documentType: DocumentType.SUPPLIER_INVOICE, minAmount: null, maxAmount: null, steps: [['Finance approval', RoleCodes.FINANCE]] },
];
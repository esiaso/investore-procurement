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
  INVENTORY_READ: 'inventory.read',
  /** See costs and stock values. */
  INVENTORY_VALUATION: 'inventory.valuation',
  /** Opening balances / temporary stock-in receipts. */
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_ADJUST_APPROVE: 'inventory.adjust_approve',
  INVENTORY_TRANSFER_REQUEST: 'inventory.transfer_request',
  INVENTORY_TRANSFER_DISPATCH: 'inventory.transfer_dispatch',
  INVENTORY_TRANSFER_RECEIVE: 'inventory.transfer_receive',
  INVENTORY_STOCKTAKE: 'inventory.stocktake',
  INVENTORY_STOCKTAKE_APPROVE: 'inventory.stocktake_approve',
  INVENTORY_OVERRIDE_FEFO: 'inventory.override_fefo',
  /** Move controlled drugs, and witness (second-sign) their movements. */
  INVENTORY_HANDLE_CONTROLLED: 'inventory.handle_controlled',
  INVENTORY_HANDLE_COLD_CHAIN: 'inventory.handle_cold_chain',
  INVENTORY_BATCH_HOLD: 'inventory.batch_hold',
  INVENTORY_PERIOD_LOCK: 'inventory.period_lock',
  INVENTORY_RECONCILE: 'inventory.reconcile',
  /** Raise internal (S11) requisitions for a department and return stock to the store. */
  INVENTORY_REQUISITION: 'inventory.requisition',
  /** Issue stock against approved internal requisitions. */
  INVENTORY_ISSUE: 'inventory.issue',
  /** Receive and post department returns. */
  INVENTORY_DEPT_RETURN: 'inventory.dept_return',
  /** Return stock to suppliers and record credit notes. */
  INVENTORY_SUPPLIER_RETURN: 'inventory.supplier_return',
  /** Departmental consumption reports (own department only without store.all). */
  INVENTORY_CONSUMPTION: 'inventory.consumption',
  /** Store item settings (min/max/reorder), reorder and expiry reports, draft requisitions from them. */
  INVENTORY_PLANNING: 'inventory.planning',
  /** Receive reorder, stock-out and expiry alerts for accessible stores. */
  INVENTORY_ALERTS: 'inventory.alerts',
  /** See and run background jobs. */
  JOBS_RUN: 'jobs.run',
  PATIENTS_READ: 'patients.read',
  PATIENTS_MANAGE: 'patients.manage',
  PHARMACY_READ: 'pharmacy.read',
  /** Enter prescriptions. */
  PHARMACY_PRESCRIPTION: 'pharmacy.prescription',
  /** Verify prescriptions and override interaction alerts (pharmacist). */
  PHARMACY_VERIFY: 'pharmacy.verify',
  PHARMACY_DISPENSE: 'pharmacy.dispense',
  /** Curate the drug interaction table. */
  PHARMACY_INTERACTIONS: 'pharmacy.interactions',
  BILLING_READ: 'billing.read',
  /** Issue sales invoices, take payments, raise credit notes. */
  BILLING_INVOICE: 'billing.invoice',
  /** Price lists, payers and payment modes. */
  BILLING_MANAGE: 'billing.manage',
  ETIMS_READ: 'etims.read',
  /** eTIMS configuration, code mapping, reprocessing and purchase confirmation. */
  ETIMS_MANAGE: 'etims.manage',
  /** Configure approval workflows and see everyone's delegations. */
  APPROVALS_MANAGE: 'approvals.manage',
  SUPPLIERS_READ: 'suppliers.read',
  SUPPLIERS_MANAGE: 'suppliers.manage',
  /** See full (decrypted) supplier bank details. */
  SUPPLIERS_BANK: 'suppliers.bank',
  BUDGETS_READ: 'budgets.read',
  BUDGETS_MANAGE: 'budgets.manage',
  PURCHASING_READ: 'purchasing.read',
  PURCHASING_REQUISITION: 'purchasing.requisition',
  PURCHASING_RFQ: 'purchasing.rfq',
  PURCHASING_PO: 'purchasing.po',
  PURCHASING_RECEIVE: 'purchasing.receive',
  /** Member of the goods inspection committee. */
  PURCHASING_INSPECT: 'purchasing.inspect',
  PURCHASING_EMERGENCY_RECEIPT: 'purchasing.emergency_receipt',
  PURCHASING_INVOICE: 'purchasing.invoice',
  PURCHASING_PAYMENT: 'purchasing.payment',
  FORECASTING_READ: 'forecasting.read',
  /** Run forecasts, adjustment factors, quantification, programmes and funding-source rules. */
  FORECASTING_MANAGE: 'forecasting.manage',
  PLANS_READ: 'plans.read',
  /** Prepare and revise a department's annual procurement plan. */
  PLANS_MANAGE: 'plans.manage',
  /** Consolidate departmental plans into the hospital plan. */
  PLANS_CONSOLIDATE: 'plans.consolidate',
  TENDERS_READ: 'tenders.read',
  /** Create, publish, record bids, open, recommend and award tenders. */
  TENDERS_MANAGE: 'tenders.manage',
  /** Evaluation committee member (declare conflicts, score bids). */
  TENDERS_EVALUATE: 'tenders.evaluate',
  CONTRACTS_READ: 'contracts.read',
  /** Sign contracts, securities, milestones, variations and call-off orders. */
  CONTRACTS_MANAGE: 'contracts.manage',
  /** Scorecards, corrective actions and suspension / blacklisting requests. */
  SUPPLIERS_PERFORMANCE: 'suppliers.performance',
  PROCUREMENT_KPIS: 'procurement.kpis',
  /** Supplier portal (users linked to a supplier). */
  PORTAL_ACCESS: 'portal.access',
  QUALITY_READ: 'quality.read',
  /** Place quality holds, log complaints, temperature readings and excursions. */
  QUALITY_MANAGE: 'quality.manage',
  /** Release or reject held stock (Quality Officer). */
  QUALITY_RELEASE: 'quality.release',
  /** Receive recall notices, trace and record recall returns. */
  RECALLS_MANAGE: 'recalls.manage',
  /** Raise disposals, sit on the disposal committee, record completion. */
  DISPOSALS_MANAGE: 'disposals.manage',
  /** Plan distribution runs, pick, pack, dispatch and record proof of delivery. */
  DISTRIBUTION_MANAGE: 'distribution.manage',
  /** Track inbound shipments against purchase orders. */
  SHIPMENTS_MANAGE: 'shipments.manage',
  ASSETS_READ: 'assets.read',
  /** Tag assets, move them between locations / custodians, log maintenance. */
  ASSETS_MANAGE: 'assets.manage',
  /** Certify completion of services and works against service POs. */
  SERVICES_CERTIFY: 'services.certify',
  /** Upload and download attachments on records the user can see. */
  FILES_UPLOAD: 'files.upload',
  /** HMIS link: encounters, message log and integration dashboard. */
  HMIS_READ: 'hmis.read',
  /** Configure the HMIS connection and code mappings; reprocess messages; import patients. */
  HMIS_MANAGE: 'hmis.manage',
  /** Charge ward / theatre consumables to an admitted patient's encounter. */
  PATIENTS_CHARGE: 'patients.charge',
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
  'inventory.read': 'View stock, batches and the item ledger',
  'inventory.valuation': 'View costs and stock values',
  'inventory.receive': 'Post opening balances and stock-in receipts',
  'inventory.adjust': 'Create stock adjustments',
  'inventory.adjust_approve': 'Approve stock adjustments',
  'inventory.transfer_request': 'Request inter-store transfers',
  'inventory.transfer_dispatch': 'Dispatch inter-store transfers',
  'inventory.transfer_receive': 'Receive inter-store transfers',
  'inventory.stocktake': 'Create and count stock takes',
  'inventory.stocktake_approve': 'Approve and post stock takes',
  'inventory.override_fefo': 'Override FEFO batch selection (with reason)',
  'inventory.handle_controlled': 'Move and witness controlled drugs',
  'inventory.handle_cold_chain': 'Move cold-chain items',
  'inventory.batch_hold': 'Quarantine, recall and release batches',
  'inventory.period_lock': 'Set store period lock dates',
  'inventory.reconcile': 'Run and repair ledger reconciliation',
  'inventory.requisition': 'Raise internal requisitions and department returns',
  'inventory.issue': 'Issue stock against internal requisitions',
  'inventory.dept_return': 'Receive and post department returns',
  'inventory.supplier_return': 'Return stock to suppliers and record credit notes',
  'inventory.consumption': 'View departmental consumption',
  'inventory.planning': 'Manage reorder settings; reorder and expiry reports and actions',
  'inventory.alerts': 'Receive reorder, stock-out and expiry alerts',
  'jobs.run': 'View and run background jobs',
  'patients.read': 'View cached patient records',
  'patients.manage': 'Create and edit cached patient records',
  'pharmacy.read': 'View prescriptions and dispenses',
  'pharmacy.prescription': 'Enter prescriptions',
  'pharmacy.verify': 'Verify prescriptions and override interaction alerts',
  'pharmacy.dispense': 'Dispense medicines',
  'pharmacy.interactions': 'Maintain the drug interaction table',
  'billing.read': 'View sales invoices, receipts and credit notes',
  'billing.invoice': 'Issue invoices, take payments and raise credit notes',
  'billing.manage': 'Manage price lists, payers and payment modes',
  'etims.read': 'View eTIMS status, transmissions and reports',
  'etims.manage': 'Configure eTIMS, map codes, reprocess and confirm purchases',
  'approvals.manage': 'Configure approval workflows and delegations',
  'suppliers.read': 'View suppliers',
  'suppliers.manage': 'Create and edit suppliers, documents and contract prices',
  'suppliers.bank': 'View supplier bank account details',
  'budgets.read': 'View budgets and commitments',
  'budgets.manage': 'Create and edit budgets',
  'purchasing.read': 'View requisitions, RFQs, purchase orders, GRNs and invoices',
  'purchasing.requisition': 'Raise purchase requisitions',
  'purchasing.rfq': 'Run RFQs, capture quotations and award',
  'purchasing.po': 'Create, amend, send and cancel purchase orders',
  'purchasing.receive': 'Receive goods (GRN)',
  'purchasing.inspect': 'Sign off goods inspection',
  'purchasing.emergency_receipt': 'Receive goods without a purchase order (emergency)',
  'purchasing.invoice': 'Capture and match supplier invoices',
  'purchasing.payment': 'Record payment vouchers',
  'forecasting.read': 'View forecasts, quantification, supply plans and donor stock',
  'forecasting.manage': 'Run forecasts; manage adjustment factors, programmes and funding-source rules',
  'plans.read': 'View annual procurement plans',
  'plans.manage': "Prepare and revise a department's annual procurement plan",
  'plans.consolidate': 'Consolidate departmental plans into the hospital plan',
  'tenders.read': 'View tenders',
  'tenders.manage': 'Create, publish, open, recommend and award tenders',
  'tenders.evaluate': 'Sit on tender evaluation committees and score bids',
  'contracts.read': 'View contracts and framework agreements',
  'contracts.manage': 'Sign contracts; securities, milestones, variations and call-off orders',
  'suppliers.performance': 'Supplier scorecards, corrective actions and sanction requests',
  'procurement.kpis': 'View procurement KPIs',
  'portal.access': 'Use the supplier portal (own supplier only)',
  'quality.read': 'View quality holds, cold chain, complaints and recalls',
  'quality.manage': 'Place quality holds; record temperatures, excursions and complaints',
  'quality.release': 'Release or reject held stock',
  'recalls.manage': 'Receive recalls, trace affected stock and patients, record returns',
  'disposals.manage': 'Raise disposals, sit on the disposal committee and record completion',
  'distribution.manage': 'Plan distribution runs; pick, pack, dispatch and record proof of delivery',
  'shipments.manage': 'Track inbound shipments against purchase orders',
  'assets.read': 'View the asset register',
  'assets.manage': 'Tag, move and maintain assets',
  'services.certify': 'Certify completion of services and works',
  'files.upload': 'Upload attachments to records',
  'hmis.read': 'View encounters, HMIS messages and the integration dashboard',
  'hmis.manage': 'Configure the HMIS connection and code mappings, reprocess messages, import patients',
  'patients.charge': 'Charge consumables used on a patient to their encounter',
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
  WARD_STAFF: 'WARD_STAFF',
  FINANCE: 'FINANCE',
  TENDER_COMMITTEE: 'TENDER_COMMITTEE',
  SUPPLY_CHAIN_MANAGER: 'SUPPLY_CHAIN_MANAGER',
  SUPPLIER: 'SUPPLIER',
  AUDITOR: 'AUDITOR',
  HOSPITAL_MANAGEMENT: 'HOSPITAL_MANAGEMENT',
} as const;

export type RoleCode = (typeof RoleCodes)[keyof typeof RoleCodes];

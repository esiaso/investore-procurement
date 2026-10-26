import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { loadEnv } from '../config/env';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  ApprovalStep,
  ApprovalWorkflow,
  DocumentLink,
  Notification,
  NotificationPreference,
} from '../modules/approvals/approvals.entities';
import { JobRun } from '../modules/jobs/jobs.entities';
import { StockAlert, StoreItemSetting } from '../modules/planning/planning.entities';
import { AuditSubscriber } from '../modules/audit/audit.subscriber';
import { Budget, BudgetEntry } from '../modules/budgets/budgets.entities';
import { EmailOutbox } from '../modules/mail/mail.entities';
import {
  GoodsReceivedNote,
  GrnLine,
  PaymentVoucher,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderVersion,
  PurchaseRequisition,
  PurchaseRequisitionLine,
  Quotation,
  QuotationLine,
  ReturnToSupplier,
  ReturnToSupplierLine,
  Rfq,
  RfqLine,
  SupplierInvoice,
  SupplierInvoiceLine,
} from '../modules/purchasing/purchasing.entities';
import {
  DepartmentReturn,
  DepartmentReturnLine,
  IssueVoucher,
  IssueVoucherLine,
  StoreRequisition,
  StoreRequisitionLine,
} from '../modules/stores/stores.entities';
import { ContractPrice, Supplier, SupplierContact, SupplierDocument } from '../modules/suppliers/suppliers.entities';
import { AuditLog } from '../modules/audit/audit-log.entity';
import { Generic, Item, ItemCategory, UnitConversion, UnitOfMeasure } from '../modules/catalog/catalog.entities';
import {
  AdjustmentReason,
  ReturnReason,
  StockAdjustment,
  StockAdjustmentLine,
  StockReceipt,
  StockReceiptLine,
  StockTake,
  StockTakeLine,
  StockTransfer,
  StockTransferAllocation,
  StockTransferLine,
} from '../modules/inventory/documents.entities';
import { Batch, ItemStoreCost, StockBalance, StockReservation, StockTransaction, StorePeriodLock } from '../modules/inventory/inventory.entities';
import { DocumentSequence, NumberingScheme } from '../modules/numbering/numbering.entities';
import { Bin, Department, Facility, Store } from '../modules/org/org.entities';
import { Permission, Role } from '../modules/rbac/rbac.entities';
import { SystemSetting } from '../modules/settings/system-setting.entity';
import { TaxCategory, TaxRate } from '../modules/tax/tax.entities';
import { User } from '../modules/users/user.entity';
import { Payer, PaymentMode, PriceList, PriceListItem, SalesInvoice, SalesInvoiceLine, SalesPayment } from '../modules/billing/billing.entities';
import {
  ApiClient,
  EtimsCode,
  EtimsCodeMapping,
  EtimsConfig,
  EtimsImportItem,
  EtimsItem,
  EtimsItemClass,
  EtimsOutbox,
  EtimsPurchase,
  EtimsTransmission,
} from '../modules/etims/etims.entities';
import {
  ClinicalAlert,
  Dispense,
  DispenseLine,
  DrugInteraction,
  InteractionOverride,
  Patient,
  Prescription,
  PrescriptionLine,
} from '../modules/pharmacy/pharmacy.entities';
import { DemandForecast, ForecastAccuracy, ForecastAdjustment, Programme, ProgrammeCommodity, Quantification } from '../modules/forecasting/forecasting.entities';
import { FundingSource } from '../modules/inventory/funding';
import { PROCUREMENT_ENTITIES } from '../modules/procurement/entities';
import { ASSET_ENTITIES } from '../modules/assets/assets.module';
import { Attachment } from '../modules/files/attachment.entity';
import { LOGISTICS_ENTITIES } from '../modules/logistics/logistics.module';
import { QUALITY_ENTITIES } from '../modules/quality/entities';
import { Encounter, HmisCodeMapping, HmisConnection, HmisMessage, PatientCharge } from '../modules/hmis/hmis.entities';
import { Customer, CustomerLedger, MpesaConfig, MpesaTransaction, PosEvent, PosPromotion, PosSale, PosShift, PosTerminal } from '../modules/pos/pos.entities';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export const ENTITIES = [
  AuditLog,
  SystemSetting,
  TaxCategory,
  TaxRate,
  NumberingScheme,
  DocumentSequence,
  Facility,
  Store,
  Bin,
  Department,
  Permission,
  Role,
  User,
  Generic,
  Item,
  ItemCategory,
  UnitOfMeasure,
  UnitConversion,
  Batch,
  StockBalance,
  StockTransaction,
  ItemStoreCost,
  StorePeriodLock,
  StockReservation,
  AdjustmentReason,
  ReturnReason,
  StockReceipt,
  StockReceiptLine,
  StockAdjustment,
  StockAdjustmentLine,
  StockTransfer,
  StockTransferLine,
  StockTransferAllocation,
  StockTake,
  StockTakeLine,
  ApprovalWorkflow,
  ApprovalStep,
  ApprovalRequest,
  ApprovalAction,
  ApprovalDelegation,
  Notification,
  DocumentLink,
  EmailOutbox,
  Supplier,
  SupplierContact,
  SupplierDocument,
  ContractPrice,
  Budget,
  BudgetEntry,
  PurchaseRequisition,
  PurchaseRequisitionLine,
  Rfq,
  RfqLine,
  Quotation,
  QuotationLine,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderVersion,
  GoodsReceivedNote,
  GrnLine,
  ReturnToSupplier,
  ReturnToSupplierLine,
  SupplierInvoice,
  SupplierInvoiceLine,
  PaymentVoucher,
  StoreRequisition,
  StoreRequisitionLine,
  IssueVoucher,
  IssueVoucherLine,
  DepartmentReturn,
  DepartmentReturnLine,
  NotificationPreference,
  JobRun,
  StoreItemSetting,
  StockAlert,
  PriceList,
  PriceListItem,
  Payer,
  PaymentMode,
  SalesInvoice,
  SalesInvoiceLine,
  SalesPayment,
  EtimsConfig,
  EtimsCode,
  EtimsItemClass,
  EtimsCodeMapping,
  EtimsItem,
  EtimsOutbox,
  EtimsTransmission,
  EtimsPurchase,
  EtimsImportItem,
  ApiClient,
  Patient,
  Prescription,
  PrescriptionLine,
  Dispense,
  DispenseLine,
  DrugInteraction,
  ClinicalAlert,
  InteractionOverride,
  FundingSource,
  ForecastAdjustment,
  DemandForecast,
  ForecastAccuracy,
  Programme,
  ProgrammeCommodity,
  Quantification,
  ...PROCUREMENT_ENTITIES,
  Attachment,
  ...QUALITY_ENTITIES,
  ...LOGISTICS_ENTITIES,
  ...ASSET_ENTITIES,
  HmisConnection,
  HmisCodeMapping,
  Encounter,
  HmisMessage,
  PatientCharge,
  PosTerminal,
  PosShift,
  PosSale,
  PosEvent,
  Customer,
  CustomerLedger,
  PosPromotion,
  MpesaConfig,
  MpesaTransaction,
];

export function typeOrmOptions(overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  const env = loadEnv();
  return {
    type: 'postgres',
    url: env.databaseUrl,
    entities: ENTITIES,
    subscribers: [AuditSubscriber],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'schema_migrations',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: env.dbLogging,
    extra: { max: 20, options: '-c timezone=UTC' },
    ...overrides,
  } as DataSourceOptions;
}

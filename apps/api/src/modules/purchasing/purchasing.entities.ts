import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import {
  EtimsStatus,
  GrnStatus,
  InvoiceStatus,
  MatchStatus,
  PurchaseOrderSource,
  PurchaseOrderStatus,
  RegularisationStatus,
  RequisitionPriority,
  RequisitionStatus,
  RfqStatus,
  SupplierReturnSource,
  SupplierReturnStatus,
} from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item, UnitOfMeasure } from '../catalog/catalog.entities';
import { Department, Store } from '../org/org.entities';
import { Supplier } from '../suppliers/suppliers.entities';

const RATE = { type: 'numeric', precision: 7, scale: 4, transformer: numericTransformer } as const;
const FACTOR = { type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer } as const;

// ------------------------------------------------------------------ requisitions

@Entity('purchase_requisition')
export class PurchaseRequisition extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  /** Store the goods are for. */
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  @Column({ type: 'enum', enum: RequisitionPriority, enumName: 'requisition_priority', default: RequisitionPriority.ROUTINE })
  priority: RequisitionPriority;

  @Column({ type: 'date', nullable: true })
  requiredBy: string | null;

  @Column({ type: 'varchar', length: 2000 })
  justification: string;

  @Column({ type: 'enum', enum: RequisitionStatus, enumName: 'requisition_status', default: RequisitionStatus.DRAFT })
  status: RequisitionStatus;

  @Column({ type: 'uuid' })
  requestedBy: string;

  @Column({ ...MONEY, default: 0 })
  estimatedTotal: number;

  /** Sourcing method (procurement.sourcingMethods), checked against the value bands on submission. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  sourcingMethod: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  sourcingJustification: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => PurchaseRequisitionLine, (l) => l.requisition, { cascade: true })
  lines?: PurchaseRequisitionLine[];
}

@Entity('purchase_requisition_line')
export class PurchaseRequisitionLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  requisitionId: string;

  @ManyToOne(() => PurchaseRequisition, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: PurchaseRequisition;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  /** Per base unit. */
  @Column(MONEY)
  estimatedUnitPrice: number;

  /** Base units already put on POs. */
  @Column({ ...QUANTITY, default: 0 })
  orderedQty: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

// ------------------------------------------------------------------ RFQs and quotations

@Entity('rfq')
export class Rfq extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid', nullable: true })
  requisitionId: string | null;

  @ManyToOne(() => PurchaseRequisition, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'requisition_id' })
  requisition?: PurchaseRequisition | null;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'date' })
  closingDate: string;

  @Column({ type: 'enum', enum: RfqStatus, enumName: 'rfq_status', default: RfqStatus.DRAFT })
  status: RfqStatus;

  /** Suppliers invited to quote. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  supplierIds: string[];

  @Column({ type: 'varchar', length: 2000, nullable: true })
  awardJustification: string | null;

  @OneToMany(() => RfqLine, (l) => l.rfq, { cascade: true })
  lines?: RfqLine[];

  @OneToMany(() => Quotation, (q) => q.rfq)
  quotations?: Quotation[];
}

@Entity('rfq_line')
export class RfqLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  rfqId: string;

  @ManyToOne(() => Rfq, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq?: Rfq;

  @Column({ type: 'uuid', nullable: true })
  requisitionLineId: string | null;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  /** Winning quotation line, once awarded. */
  @Column({ type: 'uuid', nullable: true })
  awardedQuotationLineId: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  awardJustification: string | null;
}

@Entity('quotation')
@Index(['rfqId', 'supplierId'], { unique: true })
export class Quotation extends AppBaseEntity {
  @Column({ type: 'uuid' })
  rfqId: string;

  @ManyToOne(() => Rfq, (r) => r.quotations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq?: Rfq;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'varchar', length: 60, nullable: true })
  supplierReference: string | null;

  @Column({ type: 'date', nullable: true })
  validUntil: string | null;

  @Column({ type: 'int', nullable: true })
  deliveryDays: number | null;

  /** Meets the RFQ requirements (registration, documents, specs). */
  @Column({ type: 'boolean', default: true })
  compliant: boolean;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  complianceNotes: string | null;

  @OneToMany(() => QuotationLine, (l) => l.quotation, { cascade: true })
  lines?: QuotationLine[];
}

@Entity('quotation_line')
@Index(['quotationId', 'rfqLineId'], { unique: true })
export class QuotationLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  quotationId: string;

  @ManyToOne(() => Quotation, (q) => q.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'quotation_id' })
  quotation?: Quotation;

  @Column({ type: 'uuid' })
  rfqLineId: string;

  @ManyToOne(() => RfqLine, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_line_id' })
  rfqLine?: RfqLine;

  /** Per base unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  @Column({ ...QUANTITY, nullable: true })
  quantityOffered: number | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  offeredBrand: string | null;
}

// ------------------------------------------------------------------ purchase orders

@Entity('purchase_order')
export class PurchaseOrder extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  /** Deliver to. */
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  @Column({ type: 'enum', enum: PurchaseOrderSource, enumName: 'purchase_order_source' })
  source: PurchaseOrderSource;

  @Column({ type: 'uuid', nullable: true })
  requisitionId: string | null;

  @Column({ type: 'uuid', nullable: true })
  rfqId: string | null;

  @Column({ type: 'enum', enum: PurchaseOrderStatus, enumName: 'purchase_order_status', default: PurchaseOrderStatus.DRAFT })
  status: PurchaseOrderStatus;

  @Column({ type: 'date' })
  orderDate: string;

  @Column({ type: 'date', nullable: true })
  expectedDelivery: string | null;

  @Column({ type: 'int', nullable: true })
  paymentTermsDays: number | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ ...MONEY, default: 0 })
  subtotal: number;

  @Column({ ...MONEY, default: 0 })
  taxTotal: number;

  @Column({ ...MONEY, default: 0 })
  total: number;

  /** Total committed against the budget at the last approval. */
  @Column({ ...MONEY, default: 0 })
  committedTotal: number;

  @Column({ type: 'uuid', nullable: true })
  createdByUser: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  cancellationReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  /** Call-off order against this contract / framework agreement. */
  @Column({ type: 'uuid', nullable: true })
  contractId: string | null;

  /** Supplier acknowledged the order (portal or recorded by staff). */
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  /** Latest delivery tracking stage (see purchase_order_delivery). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  deliveryStage: string | null;

  @OneToMany(() => PurchaseOrderLine, (l) => l.purchaseOrder, { cascade: true })
  lines?: PurchaseOrderLine[];
}

@Entity('purchase_order_line')
export class PurchaseOrderLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @ManyToOne(() => PurchaseOrder, (p) => p.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Ordering unit (e.g. BOX) and its size in base units. */
  @Column({ type: 'uuid' })
  uomId: string;

  @ManyToOne(() => UnitOfMeasure, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uom_id' })
  uom?: UnitOfMeasure;

  @Column(FACTOR)
  conversionFactor: number;

  /** In ordering units. */
  @Column(QUANTITY)
  quantity: number;

  /** Per ordering unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  @Column({ type: 'uuid' })
  taxCategoryId: string;

  @Column(RATE)
  taxRatePercent: number;

  @Column(MONEY)
  lineSubtotal: number;

  @Column(MONEY)
  lineTax: number;

  @Column(MONEY)
  lineTotal: number;

  /** Accepted base units received so far. */
  @Column({ ...QUANTITY, default: 0 })
  receivedBaseQty: number;

  @Column({ type: 'uuid', nullable: true })
  requisitionLineId: string | null;

  @Column({ type: 'uuid', nullable: true })
  rfqLineId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  contractLineId: string | null;
}

/** Snapshot of a PO at each version (amendments keep the history). */
@Entity('purchase_order_version')
@Index(['purchaseOrderId', 'version'], { unique: true })
export class PurchaseOrderVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  changeReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  changedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

// ------------------------------------------------------------------ goods received notes

@Entity('goods_received_note')
export class GoodsReceivedNote extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid', nullable: true })
  purchaseOrderId: string | null;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder | null;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: GrnStatus, enumName: 'grn_status', default: GrnStatus.DRAFT })
  status: GrnStatus;

  @Column({ type: 'date' })
  receivedDate: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  deliveryNoteNo: string | null;

  @Column({ type: 'uuid' })
  receivedBy: string;

  /** Received without a PO (emergency); must be regularised with a PO later. */
  @Column({ type: 'boolean', default: false })
  isEmergency: boolean;

  @Column({ type: 'enum', enum: RegularisationStatus, enumName: 'regularisation_status', default: RegularisationStatus.NOT_REQUIRED })
  regularisationStatus: RegularisationStatus;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  emergencyReason: string | null;

  /** Inspection committee members who signed off (distinct users). */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  inspectedBy: string[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  inspectionNotes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => GrnLine, (l) => l.grn, { cascade: true })
  lines?: GrnLine[];
}

@Entity('grn_line')
export class GrnLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  grnId: string;

  @ManyToOne(() => GoodsReceivedNote, (g) => g.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'grn_id' })
  grn?: GoodsReceivedNote;

  @Column({ type: 'uuid', nullable: true })
  poLineId: string | null;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'varchar', length: 60, nullable: true })
  batchNo: string | null;

  @Column({ type: 'date', nullable: true })
  manufactureDate: string | null;

  @Column({ type: 'date', nullable: true })
  expiryDate: string | null;

  @Column({ type: 'uuid' })
  uomId: string;

  @Column(FACTOR)
  conversionFactor: number;

  /** In the delivery unit. */
  @Column(QUANTITY)
  quantity: number;

  @Column(QUANTITY)
  receivedBaseQty: number;

  /** Set at inspection. */
  @Column({ ...QUANTITY, default: 0 })
  acceptedBaseQty: number;

  @Column({ ...QUANTITY, default: 0 })
  rejectedBaseQty: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  /** Per delivery unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  @Column(RATE)
  taxRatePercent: number;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;
}

/**
 * Goods going back to a supplier: stock from the store (posted out of stock on
 * dispatch) or goods rejected at GRN inspection (never entered stock). The note
 * doubles as the hospital's debit note; the supplier's credit note is recorded on it.
 */
@Entity('return_to_supplier')
@Index(['supplierId', 'status'])
export class ReturnToSupplier extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'enum', enum: SupplierReturnSource, enumName: 'supplier_return_source', default: SupplierReturnSource.GRN_REJECT })
  source: SupplierReturnSource;

  @Column({ type: 'enum', enum: SupplierReturnStatus, enumName: 'supplier_return_status', default: SupplierReturnStatus.DRAFT })
  status: SupplierReturnStatus;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  grnId: string | null;

  @ManyToOne(() => GoodsReceivedNote, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'grn_id' })
  grn?: GoodsReceivedNote | null;

  @Column({ type: 'uuid', nullable: true })
  purchaseOrderId: string | null;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder | null;

  @Column({ type: 'varchar', length: 40 })
  reasonCode: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  /** Value of the goods returned = amount to be credited (debit note value). */
  @Column({ ...MONEY, default: 0 })
  totalValue: number;

  @Column({ type: 'date', nullable: true })
  returnDate: string | null;

  @Column({ type: 'uuid', nullable: true })
  dispatchedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  witnessId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  creditNoteNo: string | null;

  @Column({ type: 'date', nullable: true })
  creditNoteDate: string | null;

  @Column({ ...MONEY, nullable: true })
  creditNoteAmount: number | null;

  @Column({ type: 'uuid', nullable: true })
  creditRecordedBy: string | null;

  @OneToMany(() => ReturnToSupplierLine, (l) => l.supplierReturn, { cascade: true })
  lines?: ReturnToSupplierLine[];
}

@Entity('return_to_supplier_line')
export class ReturnToSupplierLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  returnId: string;

  @ManyToOne(() => ReturnToSupplier, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'return_id' })
  supplierReturn?: ReturnToSupplier;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Stock returns: the batch leaving the store. GRN rejects: null (never booked in). */
  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  batchNo: string | null;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @Column({ type: 'uuid', nullable: true })
  grnLineId: string | null;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer, default: 0 })
  unitCost: number;

  @Column({ ...MONEY, default: 0 })
  value: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;
}

// ------------------------------------------------------------------ invoices and payments

@Entity('supplier_invoice')
@Index(['supplierId', 'supplierInvoiceNo'], { unique: true })
export class SupplierInvoice extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'varchar', length: 60 })
  supplierInvoiceNo: string;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder;

  @Column({ type: 'date' })
  invoiceDate: string;

  @Column({ type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ type: 'enum', enum: InvoiceStatus, enumName: 'invoice_status', default: InvoiceStatus.CAPTURED })
  status: InvoiceStatus;

  @Column({ type: 'enum', enum: MatchStatus, enumName: 'match_status', default: MatchStatus.NOT_MATCHED })
  matchStatus: MatchStatus;

  /** [{ poLineId, code, message }] from the last three-way match. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  variances: { poLineId: string; code: string; message: string }[];

  @Column({ type: 'enum', enum: EtimsStatus, enumName: 'etims_status', default: EtimsStatus.NOT_CHECKED })
  etimsStatus: EtimsStatus;

  /** KRA control unit invoice number, when known (verified in slice 6). */
  @Column({ type: 'varchar', length: 60, nullable: true })
  etimsInvoiceNo: string | null;

  @Column({ ...MONEY, default: 0 })
  subtotal: number;

  @Column({ ...MONEY, default: 0 })
  taxTotal: number;

  @Column({ ...MONEY, default: 0 })
  total: number;

  @Column({ type: 'uuid' })
  capturedBy: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => SupplierInvoiceLine, (l) => l.invoice, { cascade: true })
  lines?: SupplierInvoiceLine[];
}

@Entity('supplier_invoice_line')
export class SupplierInvoiceLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => SupplierInvoice, (i) => i.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: SupplierInvoice;

  @Column({ type: 'uuid' })
  poLineId: string;

  @ManyToOne(() => PurchaseOrderLine, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'po_line_id' })
  poLine?: PurchaseOrderLine;

  /** In the PO line's ordering unit. */
  @Column(QUANTITY)
  quantity: number;

  /** Per ordering unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  @Column(MONEY)
  taxAmount: number;

  @Column(MONEY)
  lineTotal: number;
}

/** Simple payment record for now (full payments/finance integration later). */
@Entity('payment_voucher')
export class PaymentVoucher extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => SupplierInvoice, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: SupplierInvoice;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'date' })
  paidOn: string;

  /** Bank / M-Pesa / cheque reference. */
  @Column({ type: 'varchar', length: 100 })
  paymentReference: string;

  @Column({ type: 'varchar', length: 40 })
  method: string;
}

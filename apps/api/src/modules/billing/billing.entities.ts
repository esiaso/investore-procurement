import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { EtimsSyncStatus, PayerType, PriceListType, SalesDocType, SalesInvoiceStatus, SalesSource } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Store } from '../org/org.entities';

const RATE = { type: 'numeric', precision: 7, scale: 4, transformer: numericTransformer } as const;

/** Selling prices (VAT inclusive per base unit). Items without an explicit price fall back to the item price ± adjustment. */
@Entity('price_list')
export class PriceList extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: PriceListType, enumName: 'price_list_type' })
  type: PriceListType;

  /** Applied to the item's base price when the list has no explicit price (e.g. -10 for staff). */
  @Column({ ...RATE, default: 0 })
  adjustPercent: number;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

@Entity('price_list_item')
@Index(['priceListId', 'itemId'], { unique: true })
export class PriceListItem extends AppBaseEntity {
  @Column({ type: 'uuid' })
  priceListId: string;

  @ManyToOne(() => PriceList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'price_list_id' })
  priceList?: PriceList;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** VAT inclusive, per base unit. */
  @Column(MONEY)
  price: number;
}

/** Insurer or corporate client paying for patients; the patient pays the co-pay. */
@Entity('payer')
export class Payer extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: PayerType, enumName: 'payer_type' })
  type: PayerType;

  @Column({ type: 'varchar', length: 11, nullable: true })
  kraPin: string | null;

  @Column({ type: 'uuid', nullable: true })
  priceListId: string | null;

  @ManyToOne(() => PriceList, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'price_list_id' })
  priceList?: PriceList | null;

  /** Share of each invoice the patient pays (0–100). */
  @Column({ ...RATE, default: 0 })
  coPayPercent: number;

  /** eTIMS insurance company code (isrccCd), when the payer is an insurer. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  etimsInsuranceCode: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** How a payment is made, and its eTIMS payment type code (code class 07). */
@Entity('payment_mode')
export class PaymentMode extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 5 })
  etimsPaymentTypeCode: string;

  /** M-Pesa / card slip / cheque number required. */
  @Column({ type: 'boolean', default: false })
  requiresReference: boolean;

  /** Settled later by a payer or the patient (insurance, corporate, patient credit). */
  @Column({ type: 'boolean', default: false })
  isCredit: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/**
 * A tax invoice or a credit note (docType). Issued documents are immutable
 * (enforced by a trigger); corrections go through credit notes.
 */
@Entity('sales_invoice')
@Index(['storeId', 'createdAt'])
@Index(['etimsStatus'])
@Index(['source', 'sourceId'])
export class SalesInvoice extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'enum', enum: SalesDocType, enumName: 'sales_doc_type', default: SalesDocType.INVOICE })
  docType: SalesDocType;

  @Column({ type: 'uuid', nullable: true })
  originalInvoiceId: string | null;

  @ManyToOne(() => SalesInvoice, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'original_invoice_id' })
  originalInvoice?: SalesInvoice | null;

  /** eTIMS credit note reason (code class 32). */
  @Column({ type: 'varchar', length: 5, nullable: true })
  creditReasonCode: string | null;

  @Column({ type: 'enum', enum: SalesInvoiceStatus, enumName: 'sales_invoice_status', default: SalesInvoiceStatus.ISSUED })
  status: SalesInvoiceStatus;

  @Column({ type: 'enum', enum: SalesSource, enumName: 'sales_source' })
  source: SalesSource;

  @Column({ type: 'uuid', nullable: true })
  sourceId: string | null;

  /** Caller's idempotency key (e.g. HMIS charge id). */
  @Index({ unique: true, where: '"external_ref" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  externalRef: string | null;

  /** Selling outlet. */
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  patientId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  customerName: string | null;

  @Column({ type: 'varchar', length: 11, nullable: true })
  customerPin: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  customerPhone: string | null;

  @Column({ type: 'uuid', nullable: true })
  payerId: string | null;

  @ManyToOne(() => Payer, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'payer_id' })
  payer?: Payer | null;

  @Column({ type: 'uuid', nullable: true })
  priceListId: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  issuedAt: Date;

  /** Taxable (VAT-inclusive) and tax amounts per eTIMS tax type A–E: { A: { taxable, tax, rate } … }. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  taxSummary: Record<string, { taxable: number; tax: number; rate: number }>;

  @Column({ ...MONEY, default: 0 })
  totalNet: number;

  @Column({ ...MONEY, default: 0 })
  totalTax: number;

  /** VAT inclusive. */
  @Column({ ...MONEY, default: 0 })
  totalAmount: number;

  @Column({ ...MONEY, default: 0 })
  discountAmount: number;

  @Column({ ...MONEY, default: 0 })
  payerAmount: number;

  @Column({ ...MONEY, default: 0 })
  patientAmount: number;

  @Column({ ...MONEY, default: 0 })
  paidAmount: number;

  // ---- eTIMS
  @Column({ type: 'enum', enum: EtimsSyncStatus, enumName: 'etims_sync_status', default: EtimsSyncStatus.PENDING })
  etimsStatus: EtimsSyncStatus;

  /** Sequential eTIMS invoice number (invcNo) at the outlet's control unit. */
  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  etimsInvoiceNo: number | null;

  /** CU invoice number shown on receipts: CU ID / receipt number. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  cuInvoiceNo: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  cuId: string | null;

  @Column({ type: 'int', nullable: true })
  rcptNo: number | null;

  @Column({ type: 'int', nullable: true })
  totRcptNo: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  intrlData: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rcptSign: string | null;

  @Column({ type: 'varchar', length: 14, nullable: true })
  sdcDateTime: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  etimsError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  etimsAcceptedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => SalesInvoiceLine, (l) => l.invoice, { cascade: true })
  lines?: SalesInvoiceLine[];

  @OneToMany(() => SalesPayment, (p) => p.invoice, { cascade: true })
  payments?: SalesPayment[];
}

@Entity('sales_invoice_line')
@Index(['invoiceId'])
export class SalesInvoiceLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => SalesInvoice, (i) => i.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: SalesInvoice;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'varchar', length: 200 })
  description: string;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  /** VAT inclusive per base unit, before discount. */
  @Column(MONEY)
  unitPrice: number;

  @Column({ ...RATE, default: 0 })
  discountPercent: number;

  @Column({ ...MONEY, default: 0 })
  discountAmount: number;

  @Column({ type: 'uuid' })
  taxCategoryId: string;

  /** eTIMS tax type (A exempt, B 16%, C zero-rated, D non-VAT, E 8%). */
  @Column({ type: 'varchar', length: 5 })
  taxTypeCode: string;

  @Column(RATE)
  taxRatePercent: number;

  /** VAT inclusive after discount (eTIMS taxblAmt). */
  @Column(MONEY)
  grossAmount: number;

  @Column(MONEY)
  taxAmount: number;

  @Column(MONEY)
  netAmount: number;

  @Column({ ...MONEY, default: 0 })
  payerShare: number;

  @Column({ ...MONEY, default: 0 })
  patientShare: number;

  /** For credit notes: the invoice line credited. */
  @Column({ type: 'uuid', nullable: true })
  originalLineId: string | null;

  /** Dispense line / batch traceability. */
  @Column({ type: 'uuid', nullable: true })
  sourceLineId: string | null;

  /** Stock taken for this line (OTC / consumables): [{ batchId, binId, quantity, unitCost }]. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  allocations: { batchId: string; binId: string | null; quantity: number; unitCost: number }[];
}

@Entity('sales_payment')
@Index(['invoiceId'])
export class SalesPayment extends AppBaseEntity {
  @Column({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => SalesInvoice, (i) => i.payments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: SalesInvoice;

  @Column({ type: 'varchar', length: 20 })
  modeCode: string;

  @Column({ type: 'varchar', length: 5 })
  etimsPaymentTypeCode: string;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'uuid', nullable: true })
  payerId: string | null;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CustomerLedgerType, MpesaEnvironment, MpesaMethod, MpesaStatus, PosEventType, PosSaleStatus, PosShiftStatus, VarianceStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer } from '../../common/entities/transformers';
import { PriceList, SalesInvoice } from '../billing/billing.entities';
import { Item, ItemCategory } from '../catalog/catalog.entities';
import { Store } from '../org/org.entities';

/** A till: one per counter, selling from a store with a default price list. */
@Entity('pos_terminal')
export class PosTerminal extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid', nullable: true })
  defaultPriceListId: string | null;

  @ManyToOne(() => PriceList, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'default_price_list_id' })
  defaultPriceList?: PriceList | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;
}

/**
 * A cashier's shift on a till: opening float, sales, cash-up (Z report).
 * A variance outside pos.varianceTolerance waits for a supervisor.
 */
@Entity('pos_shift')
@Index(['terminalId', 'status'])
@Index(['cashierId', 'status'])
export class PosShift extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  terminalId: string;

  @ManyToOne(() => PosTerminal, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'terminal_id' })
  terminal?: PosTerminal;

  @Column({ type: 'uuid' })
  storeId: string;

  @Column({ type: 'uuid' })
  cashierId: string;

  @Column({ type: 'enum', enum: PosShiftStatus, enumName: 'pos_shift_status', default: PosShiftStatus.OPEN })
  status: PosShiftStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  openedAt: Date;

  @Column(MONEY)
  openingFloat: number;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ ...MONEY, nullable: true })
  countedCash: number | null;

  /** Notes and coins counted (denomination → count), optional. */
  @Column({ type: 'jsonb', nullable: true })
  denominations: Record<string, number> | null;

  @Column({ ...MONEY, nullable: true })
  expectedCash: number | null;

  @Column({ ...MONEY, nullable: true })
  variance: number | null;

  @Column({ type: 'enum', enum: VarianceStatus, enumName: 'variance_status', default: VarianceStatus.NONE })
  varianceStatus: VarianceStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  closeNote: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;

  /** Z report as at closing (totals by payment mode, counts, voids, refunds, discounts). */
  @Column({ type: 'jsonb', nullable: true })
  zReport: Record<string, unknown> | null;
}

/** A till sale: the tax invoice (eTIMS) plus who, when, approvals and offline origin. */
@Entity('pos_sale')
@Index(['shiftId'])
@Index(['customerId'])
export class PosSale extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  invoiceId: string;

  @ManyToOne(() => SalesInvoice, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: SalesInvoice;

  /** Client-generated id: a sale is recorded once however often it is sent (offline sync). */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  clientRef: string;

  @Column({ type: 'uuid' })
  shiftId: string;

  @ManyToOne(() => PosShift, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'shift_id' })
  shift?: PosShift;

  @Column({ type: 'uuid' })
  terminalId: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @Column({ type: 'uuid' })
  cashierId: string;

  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  @ManyToOne('Customer', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'customer_id' })
  customer?: Customer | null;

  @Column({ type: 'enum', enum: PosSaleStatus, enumName: 'pos_sale_status', default: PosSaleStatus.COMPLETED })
  status: PosSaleStatus;

  /** Made at the till while offline; soldAt is the till's clock. */
  @Column({ type: 'boolean', default: false })
  offline: boolean;

  @Column({ type: 'timestamptz' })
  soldAt: Date;

  @Column(MONEY)
  total: number;

  @Column({ ...MONEY, default: 0 })
  discountAmount: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  prescriptionRef: string | null;

  /** Pharmacist who approved pharmacy-only / prescription-only items or an interaction. */
  @Column({ type: 'uuid', nullable: true })
  pharmacistId: string | null;

  /** Supervisor who authorised a discount above the cashier's limit. */
  @Column({ type: 'uuid', nullable: true })
  overrideBy: string | null;

  @Column({ type: 'int', default: 0 })
  pointsEarned: number;

  @Column({ type: 'int', default: 0 })
  pointsRedeemed: number;
}

/** Every void, refund, override and approval at the till. Append-only. */
@Entity('pos_event')
@Index(['shiftId'])
@Index(['at'])
export class PosEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: PosEventType, enumName: 'pos_event_type' })
  type: PosEventType;

  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  @Column({ type: 'uuid', nullable: true })
  terminalId: string | null;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  approvedBy: string | null;

  /** Money effect (refund amount, discount given); payment mode in details. */
  @Column({ ...MONEY, nullable: true })
  amount: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  details: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

/** Walk-in customer (optional): price list, credit account, loyalty points. */
@Entity('customer')
export class Customer extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Index({ unique: true, where: '"phone" IS NOT NULL' })
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 11, nullable: true })
  kraPin: string | null;

  @Column({ type: 'uuid', nullable: true })
  priceListId: string | null;

  @ManyToOne(() => PriceList, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'price_list_id' })
  priceList?: PriceList | null;

  /** May buy on account up to the credit limit. */
  @Column({ type: 'boolean', default: false })
  creditAllowed: boolean;

  @Column({ ...MONEY, default: 0 })
  creditLimit: number;

  @Column({ type: 'int', default: 0 })
  loyaltyPoints: number;

  /** Optional link to the patient record (allergies / history for the checks at the till). */
  @Column({ type: 'uuid', nullable: true })
  patientId: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Customer account: sales on credit (+), payments and refunds (−). Balance = sum. */
@Entity('customer_ledger')
@Index(['customerId', 'at'])
export class CustomerLedger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  customerId: string;

  @Column({ type: 'enum', enum: CustomerLedgerType, enumName: 'customer_ledger_type' })
  type: CustomerLedgerType;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'uuid', nullable: true })
  invoiceId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  /** How a payment on account was paid (CASH, MPESA, CARD). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  modeCode: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

/** Automatic discount on an item or a category for a period (optional minimum quantity). */
@Entity('pos_promotion')
export class PosPromotion extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => ItemCategory, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'category_id' })
  category?: ItemCategory | null;

  @Column({ type: 'numeric', precision: 7, scale: 4, transformer: numericTransformer })
  discountPercent: number;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 1, transformer: numericTransformer })
  minQty: number;

  @Column({ type: 'date' })
  startsOn: string;

  @Column({ type: 'date' })
  endsOn: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Daraja (Safaricom) settings for the shortcode; secrets encrypted, never returned. */
@Entity('mpesa_config')
export class MpesaConfig extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'enum', enum: MpesaEnvironment, enumName: 'mpesa_environment' })
  environment: MpesaEnvironment;

  /** Business shortcode (paybill, or the head office of a till). */
  @Column({ type: 'varchar', length: 20 })
  shortcode: string;

  /** CustomerPayBillOnline (paybill) or CustomerBuyGoodsOnline (till). */
  @Column({ type: 'varchar', length: 40, default: 'CustomerPayBillOnline' })
  transactionType: string;

  /** PartyB: the till number for buy goods; the shortcode for paybill. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  partyB: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  consumerKeyEnc: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  consumerSecretEnc: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  passkeyEnc: string | null;

  /** Public base URL Safaricom calls back (…/api/v1/callbacks/mpesa/…). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  callbackBaseUrl: string | null;

  /** Secret in the callback path (Daraja callbacks carry no credentials). */
  @Column({ type: 'varchar', length: 100, select: false })
  callbackToken: string;

  /** Daraja base URL (sandbox / production); empty for the in-process mock. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  apiBaseUrl: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/**
 * An M-Pesa payment: an STK push started at the till, a C2B confirmation
 * received from Safaricom, or a code typed by the cashier. A transaction pays
 * one sale (usedAt / saleId); the receipt number is unique.
 */
@Entity('mpesa_transaction')
@Index(['status', 'createdAt'])
export class MpesaTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: MpesaMethod, enumName: 'mpesa_method' })
  method: MpesaMethod;

  @Column({ type: 'enum', enum: MpesaStatus, enumName: 'mpesa_status', default: MpesaStatus.PENDING })
  status: MpesaStatus;

  @Column({ type: 'uuid', nullable: true })
  terminalId: string | null;

  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'varchar', length: 15, nullable: true })
  phone: string | null;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'varchar', length: 40, nullable: true })
  accountRef: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  merchantRequestId: string | null;

  @Index({ unique: true, where: '"checkout_request_id" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  checkoutRequestId: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  resultCode: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  resultDesc: string | null;

  @Index({ unique: true, where: '"receipt_no" IS NOT NULL' })
  @Column({ type: 'varchar', length: 20, nullable: true })
  receiptNo: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  transactionDate: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  payerName: string | null;

  /** False for a typed code with no matching confirmation (checked at cash-up). */
  @Column({ type: 'boolean', default: true })
  verified: boolean;

  @Column({ type: 'jsonb', nullable: true })
  raw: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

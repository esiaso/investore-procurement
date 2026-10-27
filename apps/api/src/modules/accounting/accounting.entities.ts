import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AccountingProvider, AccountMappingKind, ExternalEntity, PostingDocType, PostingStatus, QboEnvironment } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY } from '../../common/entities/transformers';

/**
 * The QuickBooks Online company (one). OAuth 2.0 tokens are encrypted and
 * refreshed before use; the books closing date blocks posting into closed
 * periods.
 */
@Entity('accounting_connection')
export class AccountingConnection extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'enum', enum: AccountingProvider, enumName: 'accounting_provider' })
  provider: AccountingProvider;

  @Column({ type: 'enum', enum: QboEnvironment, enumName: 'qbo_environment', default: QboEnvironment.SANDBOX })
  environment: QboEnvironment;

  @Column({ type: 'varchar', length: 100, nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  clientSecretEnc: string | null;

  /** Must match the redirect URI registered with Intuit (…/api/v1/callbacks/quickbooks). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  redirectUri: string | null;

  /** QuickBooks company id. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  realmId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  companyName: string | null;

  @Column({ type: 'varchar', length: 4000, nullable: true, select: false })
  accessTokenEnc: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  accessExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, select: false })
  refreshTokenEnc: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refreshExpiresAt: Date | null;

  /** CSRF state of an OAuth authorisation in progress. */
  @Column({ type: 'varchar', length: 100, nullable: true, select: false })
  oauthState: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  connectedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  connectedBy: string | null;

  /** Books closed up to this date (QuickBooks preference, or set here): nothing is posted on or before it. */
  @Column({ type: 'date', nullable: true })
  closingDate: string | null;

  /** Inventory journals start with this date (go-live); earlier stock history is not journaled. */
  @Column({ type: 'date', nullable: true })
  journalsFrom: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Local key → QuickBooks account, class or tax code (by kind). */
@Entity('account_mapping')
@Index(['kind', 'localKey'], { unique: true })
export class AccountMapping extends AppBaseEntity {
  @Column({ type: 'enum', enum: AccountMappingKind, enumName: 'account_mapping_kind' })
  kind: AccountMappingKind;

  /** Category / store / department / tax category / payment mode code, or a SYSTEM key. */
  @Column({ type: 'varchar', length: 60 })
  localKey: string;

  /** QuickBooks id. */
  @Column({ type: 'varchar', length: 40 })
  externalId: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  externalName: string | null;
}

/** A local supplier, payer / customer or item and its QuickBooks counterpart. */
@Entity('accounting_external_ref')
@Index(['entity', 'localKey'], { unique: true })
export class ExternalRef extends AppBaseEntity {
  @Column({ type: 'enum', enum: ExternalEntity, enumName: 'external_entity' })
  entity: ExternalEntity;

  /** Local id, or a key such as "category:<id>" / "walk-in". */
  @Column({ type: 'varchar', length: 100 })
  localKey: string;

  @Column({ type: 'varchar', length: 40 })
  externalId: string;

  @Column({ type: 'varchar', length: 200 })
  displayName: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  syncedAt: Date;
}

/**
 * One local document as a QuickBooks transaction. Unique per (docType, local
 * document): a document is posted once. The QuickBooks request id is the
 * posting id, so a retried request is not duplicated by QuickBooks either.
 */
@Entity('accounting_posting')
@Index(['docType', 'localDocId'], { unique: true })
@Index(['status', 'nextAttemptAt'])
@Index(['txnDate'])
export class AccountingPosting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: PostingDocType, enumName: 'posting_doc_type' })
  docType: PostingDocType;

  /** SUPPLIER_INVOICE, PAYMENT_VOUCHER, SUPPLIER_RETURN, SALES_INVOICE, SALES_PAYMENT, CREDIT_NOTE, PAYER_SETTLEMENT, ACCOUNT_PAYMENT, INVENTORY_PERIOD. */
  @Column({ type: 'varchar', length: 30 })
  localDocType: string;

  /** Document id; for journals the period key (e.g. "2026-10"). */
  @Column({ type: 'varchar', length: 60 })
  localDocId: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  localDocNo: string | null;

  @Column({ type: 'date' })
  txnDate: string;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'enum', enum: PostingStatus, enumName: 'posting_status' })
  status: PostingStatus;

  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;

  /** Local view of the entries: account → debit (+) / credit (−), for reconciliation. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  entries: { account: string; amount: number; classId?: string | null }[];

  /** QuickBooks entity body (references resolved at send time are marked {"$ref": …}). */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  externalId: string | null;

  /** QuickBooks SyncToken of the posted entity (needed to update it). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  syncToken: string | null;

  /** Source version posted (purchase orders are versioned by amendments). */
  @Column({ type: 'int', nullable: true })
  localVersion: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  postedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** A preview of what will be posted for a period; posting it sends its READY documents. */
@Entity('accounting_batch')
export class AccountingBatch extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'date' })
  toDate: string;

  @Column({ type: 'varchar', length: 200 })
  kinds: string;

  @Column({ type: 'varchar', length: 20, default: 'PREVIEW' })
  status: string;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;
}

/** Money received from an insurer / corporate payer against its invoices (claims settled). */
@Entity('payer_settlement')
export class PayerSettlement extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  payerId: string;

  @Column({ type: 'date' })
  receivedOn: string;

  @Column(MONEY)
  amount: number;

  /** Payment mode the money came by (bank account mapping). */
  @Column({ type: 'varchar', length: 20 })
  modeCode: string;

  @Column({ type: 'varchar', length: 100 })
  reference: string;

  /** Invoices paid: [{invoiceId, amount}]. */
  @Column({ type: 'jsonb' })
  allocations: { invoiceId: string; amount: number }[];

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

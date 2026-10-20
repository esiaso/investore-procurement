import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { EtimsAdapterKind, EtimsOutboxKind, EtimsPurchaseStatus, EtimsSyncStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Store } from '../org/org.entities';

/** One control unit (OSCU/VSCU device) per selling outlet. */
@Entity('etims_config')
export class EtimsConfig extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: EtimsAdapterKind, enumName: 'etims_adapter_kind' })
  adapter: EtimsAdapterKind;

  /** OSCU: KRA eTIMS API URL; VSCU: the hospital's VSCU server; MOCK: mock-etims URL or empty for in-process. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  baseUrl: string | null;

  /** Taxpayer PIN (tin). */
  @Column({ type: 'varchar', length: 11 })
  kraPin: string;

  /** Branch id (bhfId), "00" = head office. */
  @Column({ type: 'varchar', length: 2, default: '00' })
  branchId: string;

  @Column({ type: 'varchar', length: 100 })
  deviceSerial: string;

  /** Communication key from initialisation, AES-GCM encrypted (DATA_ENCRYPTION_KEY). */
  @Column({ type: 'varchar', length: 600, nullable: true, select: false })
  cmcKeyEnc: string | null;

  /** Control unit id (sdcId), e.g. KRACU0100000001. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  cuId: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mrcNo: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  initialisedAt: Date | null;

  /** Next invcNo / sarNo / item sequence (allocated in the issuing transaction). */
  @Column({ type: 'bigint', default: 1, transformer: numericTransformer })
  nextInvoiceNo: number;

  @Column({ type: 'bigint', default: 1, transformer: numericTransformer })
  nextSarNo: number;

  @Column({ type: 'bigint', default: 1, transformer: numericTransformer })
  nextItemSeq: number;

  @Column({ type: 'bigint', default: 1, transformer: numericTransformer })
  nextPurchaseNo: number;

  /** Why stock reporting is paused (e.g. an unmapped item), if it is. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  stockReportError: string | null;

  /** lastReqDt per sync kind: { codes, itemClasses, purchases, imports }. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  lastRequest: Record<string, string>;

  /** Highest stock_transaction id already reported as stock in/out. */
  @Column({ type: 'bigint', default: 0, transformer: numericTransformer })
  lastStockTxnId: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Standard codes from selectCodeList (cdCls + cd). */
@Entity('etims_code')
export class EtimsCode {
  @PrimaryColumn({ type: 'varchar', length: 2 })
  cdCls: string;

  @PrimaryColumn({ type: 'varchar', length: 10 })
  cd: string;

  @Column({ type: 'varchar', length: 200 })
  cdNm: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  cdClsNm: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  userDfnCd1: string | null;

  @Column({ type: 'boolean', default: true })
  useYn: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  syncedAt: Date;
}

/** Item classification tree from selectItemClsList. */
@Entity('etims_item_class')
export class EtimsItemClass {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  itemClsCd: string;

  @Column({ type: 'varchar', length: 300 })
  itemClsNm: string;

  @Column({ type: 'int', nullable: true })
  itemClsLvl: number | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  taxTyCd: string | null;

  @Column({ type: 'boolean', default: true })
  useYn: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  syncedAt: Date;
}

/**
 * Local value → eTIMS code. kind: TAX_CATEGORY (tax category code → A–E),
 * QTY_UNIT and PACKAGING_UNIT (unit of measure code → class 10 / 17),
 * ITEM_CLASS (item category code or item code → itemClsCd), COUNTRY.
 * Item-level rows (localKey = item code) win over category rows.
 */
@Entity('etims_code_mapping')
@Index(['kind', 'localKey'], { unique: true })
export class EtimsCodeMapping extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 })
  kind: string;

  @Column({ type: 'varchar', length: 60 })
  localKey: string;

  @Column({ type: 'varchar', length: 20 })
  etimsCode: string;
}

/** An item registered (saveItem) with a control unit. */
@Entity('etims_item')
@Index(['configId', 'itemId'], { unique: true })
export class EtimsItem extends AppBaseEntity {
  @Column({ type: 'uuid' })
  configId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Index()
  @Column({ type: 'varchar', length: 20 })
  itemCd: string;

  @Column({ type: 'varchar', length: 10 })
  itemClsCd: string;

  @Column({ type: 'varchar', length: 5 })
  pkgUnitCd: string;

  @Column({ type: 'varchar', length: 5 })
  qtyUnitCd: string;

  @Column({ type: 'varchar', length: 5 })
  taxTyCd: string;

  @Column({ type: 'enum', enum: EtimsSyncStatus, enumName: 'etims_sync_status', default: EtimsSyncStatus.PENDING })
  status: EtimsSyncStatus;
}

/**
 * Transactional outbox: written in the same transaction as the document, sent
 * by the eTIMS dispatcher with retries. The idempotency key makes every
 * document go out exactly once; dependsOn holds outbox ids that must be
 * accepted first (item registration before sale, sale before stock out).
 */
@Entity('etims_outbox')
@Index(['status', 'nextAttemptAt'])
@Index(['docType', 'docId'])
export class EtimsOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  configId: string;

  @Column({ type: 'enum', enum: EtimsOutboxKind, enumName: 'etims_outbox_kind' })
  kind: EtimsOutboxKind;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 200 })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 30 })
  docType: string;

  @Column({ type: 'uuid', nullable: true })
  docId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  docNo: string | null;

  /** Request body without credentials (tin/bhfId/cmcKey are added at send time). */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  dependsOn: string[];

  @Column({ type: 'enum', enum: EtimsSyncStatus, enumName: 'etims_sync_status', default: EtimsSyncStatus.PENDING })
  status: EtimsSyncStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', length: 10, nullable: true })
  resultCd: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  resultMsg: string | null;

  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  /** Finance was alerted that this is overdue. */
  @Column({ type: 'timestamptz', nullable: true })
  alertedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;
}

/** Every HTTP exchange with the control unit (credentials masked). */
@Entity('etims_transmission')
@Index(['outboxId'])
@Index(['at'])
export class EtimsTransmission {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', nullable: true })
  outboxId: string | null;

  @Column({ type: 'uuid' })
  configId: string;

  @Column({ type: 'varchar', length: 40 })
  operation: string;

  @Column({ type: 'varchar', length: 400 })
  url: string;

  @Column({ type: 'jsonb' })
  request: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  httpStatus: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  resultCd: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'int' })
  durationMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

/** A supplier's sale to the hospital as recorded on eTIMS (selectTrnsPurchaseSalesList). */
@Entity('etims_purchase')
@Index(['spplrTin', 'spplrInvcNo', 'configId'], { unique: true })
export class EtimsPurchase extends AppBaseEntity {
  @Column({ type: 'uuid' })
  configId: string;

  @Column({ type: 'varchar', length: 11 })
  spplrTin: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  spplrNm: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  spplrBhfId: string | null;

  @Column({ type: 'varchar', length: 40 })
  spplrInvcNo: string;

  @Column({ type: 'varchar', length: 8, nullable: true })
  salesDt: string | null;

  @Column({ ...MONEY, default: 0 })
  totTaxblAmt: number;

  @Column({ ...MONEY, default: 0 })
  totTaxAmt: number;

  @Column({ ...MONEY, default: 0 })
  totAmt: number;

  /** taxblAmtA..E / taxAmtA..E as sent by eTIMS. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  taxBreakdown: Record<string, number>;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  items: Record<string, unknown>[];

  @Column({ type: 'enum', enum: EtimsPurchaseStatus, enumName: 'etims_purchase_status', default: EtimsPurchaseStatus.RECEIVED })
  status: EtimsPurchaseStatus;

  /** Local supplier invoice it was matched to. */
  @Column({ type: 'uuid', nullable: true })
  supplierInvoiceId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;
}

/** Imported goods declared under the hospital's PIN (selectImportItemList). */
@Entity('etims_import_item')
@Index(['configId', 'taskCd', 'itemSeq'], { unique: true })
export class EtimsImportItem extends AppBaseEntity {
  @Column({ type: 'uuid' })
  configId: string;

  @Column({ type: 'varchar', length: 50 })
  taskCd: string;

  @Column({ type: 'varchar', length: 8, nullable: true })
  dclDe: string | null;

  @Column({ type: 'int' })
  itemSeq: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  dclNo: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  hsCd: string | null;

  @Column({ type: 'varchar', length: 300 })
  itemNm: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  raw: Record<string, unknown>;

  /** 1 unsent, 2 waiting, 3 approved, 4 cancelled. */
  @Column({ type: 'varchar', length: 2, default: '2' })
  imptItemSttsCd: string;

  /** Local item it was linked to. */
  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;
}

/** Machine clients (e.g. the HMIS) allowed to call the issue-invoice API with an API key. */
@Entity('api_client')
export class ApiClient extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  name: string;

  /** First 8 characters of the key, to find it. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 8 })
  keyPrefix: string;

  /** SHA-256 of the key (keys are 256-bit random, so a slow hash adds nothing). */
  @Column({ type: 'varchar', length: 255, select: false })
  keyHash: string;

  @Column({ type: 'text', array: true, default: () => `'{}'` })
  scopes: string[];

  /** Acts as this user (audit trail, permissions). */
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

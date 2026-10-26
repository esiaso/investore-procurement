import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import {
  EncounterClass,
  EncounterStatus,
  HmisAdapterKind,
  HmisBillingMode,
  HmisDirection,
  HmisMappingKind,
  HmisMessageStatus,
  HmisMessageType,
  PatientChargeSource,
  PatientChargeStatus,
} from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, QUANTITY } from '../../common/entities/transformers';
import { Payer } from '../billing/billing.entities';
import { Item } from '../catalog/catalog.entities';
import { Department, Store } from '../org/org.entities';
import { Patient } from '../pharmacy/pharmacy.entities';

/**
 * The hospital's HMIS/EMR. One active connection: how to reach it (FHIR R4,
 * the generic REST contract, or the mock), its credentials (encrypted) and
 * who bills patient charges.
 */
@Entity('hmis_connection')
export class HmisConnection extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: HmisAdapterKind, enumName: 'hmis_adapter_kind' })
  adapter: HmisAdapterKind;

  /** FHIR base (e.g. https://hmis/fhir) or REST base. Empty for the in-process mock. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  baseUrl: string | null;

  /** Bearer token / API key for the HMIS, encrypted (DATA_ENCRYPTION_KEY). Never returned. */
  @Column({ type: 'varchar', length: 1000, nullable: true, select: false })
  authTokenEnc: string | null;

  /** Header carrying the token: "Authorization" (sent as Bearer) or e.g. "x-api-key". */
  @Column({ type: 'varchar', length: 60, default: 'Authorization' })
  authHeader: string;

  /** Patient.identifier system holding the hospital number. */
  @Column({ type: 'varchar', length: 200, default: 'urn:sil:hospital-no' })
  hospitalNoSystem: string;

  @Column({ type: 'enum', enum: HmisBillingMode, enumName: 'hmis_billing_mode', default: HmisBillingMode.LOCAL })
  billingMode: HmisBillingMode;

  /** Send MedicationDispense records back to the HMIS. */
  @Column({ type: 'boolean', default: true })
  sendDispenses: boolean;

  /** Poll the HMIS for new medication orders (job hmis.poll); off when the HMIS pushes. */
  @Column({ type: 'boolean', default: true })
  pollOrders: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastPolledAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastPollError: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** HMIS code → local record (drug → generic or item, location → store, ward → department, payer → payer). */
@Entity('hmis_code_mapping')
@Index(['kind', 'externalCode'], { unique: true })
export class HmisCodeMapping extends AppBaseEntity {
  @Column({ type: 'enum', enum: HmisMappingKind, enumName: 'hmis_mapping_kind' })
  kind: HmisMappingKind;

  /** Code as sent by the HMIS (without the coding system). */
  @Column({ type: 'varchar', length: 100 })
  externalCode: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  externalDisplay: string | null;

  /** generic, item, store, department or payer id, by kind. */
  @Column({ type: 'uuid' })
  localId: string;

  /** DRUG only: the local id is a brand item (prescribed brand) rather than a generic. */
  @Column({ type: 'boolean', default: false })
  isItem: boolean;
}

/**
 * A visit or admission, cached from the HMIS (the HMIS stays the master).
 * Ward and bed for inpatients; the payer for this visit.
 */
@Entity('encounter')
@Index(['patientId', 'status'])
@Index(['departmentId', 'status'])
export class Encounter extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  externalId: string;

  @Column({ type: 'uuid' })
  patientId: string;

  @ManyToOne(() => Patient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patient_id' })
  patient?: Patient;

  @Column({ type: 'enum', enum: EncounterClass, enumName: 'encounter_class' })
  class: EncounterClass;

  @Column({ type: 'enum', enum: EncounterStatus, enumName: 'encounter_status', default: EncounterStatus.ACTIVE })
  status: EncounterStatus;

  /** Ward (mapped from the HMIS ward code). */
  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  wardCode: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  bed: string | null;

  /** Payer for this visit; null = cash. */
  @Column({ type: 'uuid', nullable: true })
  payerId: string | null;

  @ManyToOne(() => Payer, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'payer_id' })
  payer?: Payer | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  memberNo: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  attending: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  syncedAt: Date;
}

/**
 * Every message in and out of the HMIS. Inbound: the resource as received,
 * once per resource version (idempotency key). Outbound: a transactional
 * outbox (written with the dispense or charge, sent by hmis.dispatch with
 * back-off), with the request as rendered for the adapter and the response.
 */
@Entity('hmis_message')
@Index(['status', 'nextAttemptAt'])
@Index(['localDocType', 'localDocId'])
@Index(['createdAt'])
export class HmisMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: HmisDirection, enumName: 'hmis_direction' })
  direction: HmisDirection;

  @Column({ type: 'enum', enum: HmisMessageType, enumName: 'hmis_message_type' })
  type: HmisMessageType;

  @Column({ type: 'enum', enum: HmisMessageStatus, enumName: 'hmis_message_status', default: HmisMessageStatus.PENDING })
  status: HmisMessageStatus;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 300 })
  idempotencyKey: string;

  /** HMIS resource id (inbound: the resource; outbound: assigned by the HMIS once accepted). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  externalId: string | null;

  /** How an inbound message arrived: WEBHOOK, POLL, IMPORT. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  via: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  localDocType: string | null;

  @Column({ type: 'uuid', nullable: true })
  localDocId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  localDocNo: string | null;

  @Column({ type: 'uuid', nullable: true })
  patientId: string | null;

  @Column({ type: 'uuid', nullable: true })
  encounterId: string | null;

  /** Inbound: the resource as received. Outbound: the neutral payload the adapter renders. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** Outbound: the request last sent (FHIR resource or REST body). */
  @Column({ type: 'jsonb', nullable: true })
  request: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  httpStatus: number | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  /** Repeats of the same inbound version that were ignored. */
  @Column({ type: 'int', default: 0 })
  duplicates: number;

  /** Users with hmis.manage were alerted that this is stuck. */
  @Column({ type: 'timestamptz', nullable: true })
  alertedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}

/**
 * A charge to a patient's encounter (dispense, consumables issued against the
 * encounter, ward-stock consumption). Billed here (a sales invoice) or posted
 * to the HMIS bill (outbound CHARGE message). The unique source key means a
 * line is charged once; returns are negative charges pointing at the original.
 */
@Entity('patient_charge')
@Index(['encounterId'])
@Index(['patientId'])
@Index(['source', 'sourceId', 'sourceLineId'], { unique: true, where: '"reverses_id" IS NULL' })
export class PatientCharge extends AppBaseEntity {
  @Column({ type: 'uuid' })
  patientId: string;

  @ManyToOne(() => Patient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patient_id' })
  patient?: Patient;

  @Column({ type: 'uuid', nullable: true })
  encounterId: string | null;

  @ManyToOne(() => Encounter, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'encounter_id' })
  encounter?: Encounter | null;

  @Column({ type: 'enum', enum: PatientChargeSource, enumName: 'patient_charge_source' })
  source: PatientChargeSource;

  /** Dispense, issue voucher or ward-consumption batch id. */
  @Column({ type: 'uuid' })
  sourceId: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  sourceNo: string | null;

  /** Prescription line, issue line or consumption line id. */
  @Column({ type: 'uuid' })
  sourceLineId: string;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'store_id' })
  store?: Store | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'varchar', length: 200 })
  description: string;

  /** Negative on a reversal. */
  @Column(QUANTITY)
  quantity: number;

  /** VAT inclusive, from the payer's price list. */
  @Column(MONEY)
  unitPrice: number;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'enum', enum: PatientChargeStatus, enumName: 'patient_charge_status' })
  status: PatientChargeStatus;

  /** Billed here: the sales invoice. */
  @Column({ type: 'uuid', nullable: true })
  invoiceId: string | null;

  /** Posted to the HMIS: the outbound message and the HMIS charge id. */
  @Column({ type: 'uuid', nullable: true })
  messageId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  externalId: string | null;

  /** A reversal (return / correction) of this charge. */
  @Column({ type: 'uuid', nullable: true })
  reversesId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;
}

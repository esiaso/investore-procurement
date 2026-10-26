import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ClinicalAlertType, HmisBillingMode, InteractionSeverity, PrescriptionStatus, Sex, SupplyMode } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Payer } from '../billing/billing.entities';
import { Generic, Item } from '../catalog/catalog.entities';
import type { Encounter } from '../hmis/hmis.entities';
import { Batch } from '../inventory/inventory.entities';
import { Store } from '../org/org.entities';

/**
 * Minimal cached patient record (no full register: the HMIS owns patients
 * and they are synchronised from it). Allergies are substance or class names.
 */
@Entity('patient')
export class Patient extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  hospitalNo: string;

  @Index()
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ type: 'enum', enum: Sex, enumName: 'sex', nullable: true })
  sex: Sex | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, nullable: true, transformer: numericTransformer })
  weightKg: number | null;

  @Column({ type: 'boolean', default: false })
  isPregnant: boolean;

  @Column({ type: 'uuid', nullable: true })
  payerId: string | null;

  @ManyToOne(() => Payer, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'payer_id' })
  payer?: Payer | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  memberNo: string | null;

  /** e.g. ["penicillins", "sulfonamides", "ibuprofen"] */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  allergies: string[];

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 11, nullable: true })
  kraPin: string | null;

  /** HMIS patient id; null for a patient entered here (walk-in, no HMIS). */
  @Index({ unique: true, where: '"external_id" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  externalId: string | null;

  /** Last refreshed from the HMIS. */
  @Column({ type: 'timestamptz', nullable: true })
  syncedAt: Date | null;
}

@Entity('prescription')
@Index(['storeId', 'status'])
@Index(['patientId'])
export class Prescription extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  patientId: string;

  @ManyToOne(() => Patient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patient_id' })
  patient?: Patient;

  /** Dispensing outlet (worklist). */
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'varchar', length: 200 })
  prescriber: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  prescriberRegNo: string | null;

  /** Encounter / visit reference from the HMIS. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  encounterRef: string | null;

  /** The HMIS visit or admission (orders received from the HMIS). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  encounterId: string | null;

  @ManyToOne('Encounter', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'encounter_id' })
  encounter?: Encounter | null;

  /** Outpatient supply, or daily / unit-dose supply to an admitted patient (ward supply list). */
  @Column({ type: 'enum', enum: SupplyMode, enumName: 'supply_mode', default: SupplyMode.STANDARD })
  supplyMode: SupplyMode;

  /** HMIS order id (idempotency for API-created prescriptions). */
  @Index({ unique: true, where: '"external_ref" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  externalRef: string | null;

  @Column({ type: 'enum', enum: PrescriptionStatus, enumName: 'prescription_status', default: PrescriptionStatus.RECEIVED })
  status: PrescriptionStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  verifiedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstDispensedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => PrescriptionLine, (l) => l.prescription, { cascade: true })
  lines?: PrescriptionLine[];
}

/** Ordered at generic level; the pharmacist picks the brand at dispensing. */
@Entity('prescription_line')
export class PrescriptionLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  prescriptionId: string;

  @ManyToOne(() => Prescription, (p) => p.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'prescription_id' })
  prescription?: Prescription;

  @Column({ type: 'int' })
  lineNo: number;

  @Column({ type: 'uuid' })
  genericId: string;

  @ManyToOne(() => Generic, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'generic_id' })
  generic?: Generic;

  /** Brand asked for by the prescriber (optional). */
  @Column({ type: 'uuid', nullable: true })
  preferredItemId: string | null;

  @Column({ type: 'varchar', length: 100 })
  dose: string;

  @Column({ type: 'varchar', length: 60 })
  frequency: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  duration: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  route: string | null;

  /** Base units. */
  @Column(QUANTITY)
  quantity: number;

  @Column({ ...QUANTITY, default: 0 })
  dispensedQty: number;

  /** Not to be dispensed (e.g. stopped, patient declined). */
  @Column({ ...QUANTITY, default: 0 })
  cancelledQty: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  instructions: string | null;

  /** HMIS order (MedicationRequest) id for this line. */
  @Index({ unique: true, where: '"external_ref" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  externalRef: string | null;

  /** Drug code the HMIS ordered (sent back on the dispense record). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  hmisDrugCode: string | null;

  /** Daily / unit-dose supply: base units per day. */
  @Column({ ...QUANTITY, nullable: true })
  dailyQuantity: number | null;
}

@Entity('dispense')
@Index(['prescriptionId'])
export class Dispense extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  prescriptionId: string;

  @ManyToOne(() => Prescription, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'prescription_id' })
  prescription?: Prescription;

  @Column({ type: 'uuid' })
  patientId: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @Column({ type: 'uuid' })
  dispensedBy: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  dispensedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  witnessId: string | null;

  @Column({ type: 'uuid', nullable: true })
  invoiceId: string | null;

  /** LOCAL: invoiced here; HMIS: charged to the patient's HMIS bill (no local invoice). */
  @Column({ type: 'enum', enum: HmisBillingMode, enumName: 'hmis_billing_mode', default: HmisBillingMode.LOCAL })
  billingMode: HmisBillingMode;

  @Column({ type: 'varchar', length: 500, nullable: true })
  fefoOverrideReason: string | null;

  @OneToMany(() => DispenseLine, (l) => l.dispense, { cascade: true })
  lines?: DispenseLine[];
}

/** Exactly which batch (and brand) went to which patient. */
@Entity('dispense_line')
@Index(['batchId'])
export class DispenseLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  dispenseId: string;

  @ManyToOne(() => Dispense, (d) => d.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dispense_id' })
  dispense?: Dispense;

  @Column({ type: 'uuid' })
  prescriptionLineId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Another brand of the same generic was given. */
  @Column({ type: 'boolean', default: false })
  substituted: boolean;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @Column(QUANTITY)
  quantity: number;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  unitCost: number;

  @Column({ ...QUANTITY, default: 0 })
  returnedQty: number;
}

/**
 * Curated interaction pairs at substance (INN) level. `source` DEMO marks the
 * illustrative starter set — not a clinical reference.
 */
@Entity('drug_interaction')
@Index(['innA', 'innB'], { unique: true })
export class DrugInteraction extends AppBaseEntity {
  /** Lower-case INN or therapeutic class ("class:nsaid"), stored with innA < innB. */
  @Column({ type: 'varchar', length: 200 })
  innA: string;

  @Column({ type: 'varchar', length: 200 })
  innB: string;

  @Column({ type: 'enum', enum: InteractionSeverity, enumName: 'interaction_severity' })
  severity: InteractionSeverity;

  @Column({ type: 'varchar', length: 1000 })
  mechanism: string;

  @Column({ type: 'varchar', length: 1000 })
  management: string;

  @Column({ type: 'varchar', length: 20, default: 'LOCAL' })
  source: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** A check result on a prescription (interaction, allergy, duplicate therapy, age, pregnancy). */
@Entity('clinical_alert')
@Index(['prescriptionId'])
@Index(['createdAt'])
export class ClinicalAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  prescriptionId: string;

  @Column({ type: 'uuid' })
  patientId: string;

  @Column({ type: 'enum', enum: ClinicalAlertType, enumName: 'clinical_alert_type' })
  type: ClinicalAlertType;

  @Column({ type: 'enum', enum: InteractionSeverity, enumName: 'interaction_severity' })
  severity: InteractionSeverity;

  /** Same check on the same lines is raised once. */
  @Column({ type: 'varchar', length: 300 })
  fingerprint: string;

  @Column({ type: 'varchar', length: 1000 })
  message: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  management: string | null;

  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  lineIds: string[];

  @Column({ type: 'boolean' })
  blocking: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** A pharmacist's decision to proceed despite a blocking alert. */
@Entity('interaction_override')
@Index(['alertId'], { unique: true })
export class InteractionOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  alertId: string;

  @ManyToOne(() => ClinicalAlert, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'alert_id' })
  alert?: ClinicalAlert;

  @Column({ type: 'uuid' })
  prescriptionId: string;

  @Column({ type: 'uuid' })
  pharmacistId: string;

  @Column({ type: 'varchar', length: 1000 })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

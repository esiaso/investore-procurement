import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { ComplaintCategory, ComplaintStatus, ExcursionStatus, HoldReason, HoldStatus, ReadingSource, RecallClass, RecallReturnSource, RecallSource, RecallStatus, StorageUnitType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { Item } from '../catalog/catalog.entities';
import { Batch } from '../inventory/inventory.entities';
import { Store } from '../org/org.entities';
import { Supplier } from '../suppliers/suppliers.entities';

const num = { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/**
 * Stock held pending inspection, a quality investigation, a recall or a
 * temperature excursion. While any hold on a batch is open the batch cannot
 * be issued, dispensed, sold or transferred. Released or rejected by a user
 * with quality.release; a rejection raises a disposal.
 */
@Entity('quality_hold')
@Index(['batchId', 'status'])
export class QualityHold extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch)
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  /** Store where the problem was found (null = every store). The batch is held everywhere. */
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store?: Store | null;

  @Column({ type: 'enum', enum: HoldReason, enumName: 'hold_reason' })
  reason: HoldReason;

  @Column({ type: 'varchar', length: 1000 })
  details: string;

  /** What raised it: RECALL, EXCURSION, COMPLAINT, GRN or MANUAL, and its id. */
  @Column({ type: 'varchar', length: 20 })
  sourceType: string;

  @Column({ type: 'uuid', nullable: true })
  sourceId: string | null;

  /** On hand (all stores) when the hold was placed. */
  @Column({ type: 'numeric', precision: 18, scale: 4, transformer: num })
  quantityAtHold: number;

  @Column({ type: 'enum', enum: HoldStatus, enumName: 'hold_status', default: HoldStatus.OPEN })
  status: HoldStatus;

  @Column({ type: 'uuid', nullable: true })
  placedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionNote: string | null;

  /** Disposal raised when the stock was rejected. */
  @Column({ type: 'uuid', nullable: true })
  disposalId: string | null;
}

/** A fridge, freezer or cold room (or a monitored ambient store), optionally mapped to bins. */
@Entity('storage_unit')
export class StorageUnit extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: StorageUnitType, enumName: 'storage_unit_type' })
  type: StorageUnitType;

  /** Bins inside the unit; empty = the whole store's cold-chain stock is affected by an excursion. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  binIds: string[];

  /** Data logger serial, for CSV imports. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  loggerSerial: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

@Entity('temperature_reading')
@Index(['unitId', 'recordedAt'])
export class TemperatureReading extends AppBaseEntity {
  @Column({ type: 'uuid' })
  unitId: string;

  @ManyToOne(() => StorageUnit)
  @JoinColumn({ name: 'unit_id' })
  unit?: StorageUnit;

  @Column({ type: 'timestamptz' })
  recordedAt: Date;

  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: num })
  temperatureC: number;

  @Column({ type: 'enum', enum: ReadingSource, enumName: 'reading_source' })
  source: ReadingSource;

  @Column({ type: 'boolean' })
  inRange: boolean;

  @Column({ type: 'uuid', nullable: true })
  recordedBy: string | null;

  /** Readings taken on receipt. */
  @Column({ type: 'uuid', nullable: true })
  grnId: string | null;

  @Column({ type: 'uuid', nullable: true })
  excursionId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;
}

@Entity('temperature_excursion')
export class TemperatureExcursion extends AppBaseEntity {
  @Column({ type: 'uuid' })
  unitId: string;

  @ManyToOne(() => StorageUnit)
  @JoinColumn({ name: 'unit_id' })
  unit?: StorageUnit;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: num })
  minTemperatureC: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: num })
  maxTemperatureC: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: num })
  rangeMin: number;

  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: num })
  rangeMax: number;

  @Column({ type: 'enum', enum: ExcursionStatus, enumName: 'excursion_status', default: ExcursionStatus.OPEN })
  status: ExcursionStatus;

  /** Holds placed on the batches in the unit. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  holdIds: string[];

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reviewNote: string | null;
}

/**
 * Product quality complaint (and suspected adverse reaction), with the fields
 * the Pharmacy and Poisons Board's quality / pharmacovigilance reports ask for.
 */
@Entity('quality_complaint')
export class QualityComplaint extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;

  @ManyToOne(() => Batch)
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch | null;

  @Column({ type: 'uuid', nullable: true })
  supplierId: string | null;

  @ManyToOne(() => Supplier)
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier | null;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'enum', enum: ComplaintCategory, enumName: 'complaint_category' })
  category: ComplaintCategory;

  @Column({ type: 'varchar', length: 4000 })
  description: string;

  @Column({ type: 'varchar', length: 200 })
  reportedByName: string;

  @Column({ type: 'date' })
  reportedOn: string;

  /** Patient affected (adverse reaction / product failure in use). */
  @Column({ type: 'uuid', nullable: true })
  patientId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'MODERATE' })
  severity: string;

  @Column({ type: 'boolean', default: false })
  sampleRetained: boolean;

  /** PPB: report type (PQM = poor-quality medicinal product, ADR = adverse drug reaction), reference and date sent. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  ppbReportType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ppbReference: string | null;

  @Column({ type: 'date', nullable: true })
  reportedToPpbOn: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  investigation: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  outcome: string | null;

  @Column({ type: 'enum', enum: ComplaintStatus, enumName: 'complaint_status', default: ComplaintStatus.OPEN })
  status: ComplaintStatus;

  @Column({ type: 'uuid', nullable: true })
  holdId: string | null;
}

/** Recall notice (PPB, supplier, manufacturer or internal) for batches of an item. */
@Entity('recall')
export class Recall extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'enum', enum: RecallSource, enumName: 'recall_source' })
  source: RecallSource;

  @Column({ type: 'varchar', length: 100, nullable: true })
  noticeReference: string | null;

  @Column({ type: 'date' })
  noticeDate: string;

  @Column({ type: 'enum', enum: RecallClass, enumName: 'recall_class' })
  classification: RecallClass;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Batch numbers named in the notice (all batches when empty). */
  @Column({ type: 'varchar', array: true, default: () => `'{}'` })
  batchNos: string[];

  /** Batches matched in our stock. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  batchIds: string[];

  @Column({ type: 'varchar', length: 2000 })
  reason: string;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  instructions: string | null;

  /** Patients must be contacted (class I, or as instructed). */
  @Column({ type: 'boolean', default: false })
  patientLevel: boolean;

  @Column({ type: 'enum', enum: RecallStatus, enumName: 'recall_status', default: RecallStatus.OPEN })
  status: RecallStatus;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  outcome: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @OneToMany(() => RecallReturn, (r) => r.recall)
  returns?: RecallReturn[];
}

/** Stock recovered for a recall (from a store, a department or a patient) and what happened to it. */
@Entity('recall_return')
export class RecallReturn extends AppBaseEntity {
  @Column({ type: 'uuid' })
  recallId: string;

  @ManyToOne(() => Recall, (r) => r.returns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recall_id' })
  recall?: Recall;

  @Column({ type: 'uuid' })
  batchId: string;

  @Column({ type: 'enum', enum: RecallReturnSource, enumName: 'recall_return_source' })
  source: RecallReturnSource;

  /** Department, patient or store it came from. */
  @Column({ type: 'uuid', nullable: true })
  fromId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  fromName: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 4, transformer: num })
  quantity: number;

  /** Store the returned stock was put into (posted as a return, still on recall hold); null = not put back into stock. */
  @Column({ type: 'uuid', nullable: true })
  intoStoreId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  outcome: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'date' })
  returnedOn: string;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ForecastMethod, QuantificationMethod } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Store } from '../org/org.entities';

const FACTOR = { type: 'numeric', precision: 9, scale: 4, transformer: numericTransformer } as const;

/**
 * Manual change to the forecast (morbidity trend, a new service or programme,
 * an outbreak): forecast × factor for the months in [fromMonth, toMonth].
 * Scope: an item, or a whole category; one store or all (null).
 */
@Entity('forecast_adjustment')
@Index(['itemId'])
export class ForecastAdjustment extends AppBaseEntity {
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  /** e.g. MORBIDITY, NEW_SERVICE, PROGRAMME, OUTBREAK, OTHER (free code). */
  @Column({ type: 'varchar', length: 40 })
  reasonCode: string;

  @Column({ type: 'varchar', length: 500 })
  description: string;

  /** 1.25 = +25 %. */
  @Column(FACTOR)
  factor: number;

  /** YYYY-MM, inclusive. */
  @Column({ type: 'varchar', length: 7 })
  fromMonth: string;

  @Column({ type: 'varchar', length: 7, nullable: true })
  toMonth: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** One forecast of one item at one store (the latest per pair is current). */
@Entity('demand_forecast')
@Index(['storeId', 'itemId', 'generatedAt'])
@Index(['isCurrent'])
export class DemandForecast {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'enum', enum: ForecastMethod, enumName: 'forecast_method' })
  method: ForecastMethod;

  /** First forecast month (YYYY-MM). */
  @Column({ type: 'varchar', length: 7 })
  startMonth: string;

  /** Monthly history used (oldest first). */
  @Column({ type: 'jsonb' })
  history: number[];

  /** Forecaster output per month. */
  @Column({ type: 'jsonb' })
  baseline: number[];

  /** After adjustment factors. */
  @Column({ type: 'jsonb' })
  adjusted: number[];

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  adjustments: { id: string; reasonCode: string; factor: number; months: string[] }[];

  /** Back-tested MAPE of the chosen method (%). */
  @Column({ type: 'numeric', precision: 9, scale: 2, nullable: true, transformer: numericTransformer })
  backtestMape: number | null;

  /** Available + on order + in transit at the time. */
  @Column(QUANTITY)
  position: number;

  @Column(QUANTITY)
  demandOverCover: number;

  @Column(QUANTITY)
  safetyStock: number;

  @Column(QUANTITY)
  suggestedQty: number;

  @Column({ type: 'boolean', default: true })
  isCurrent: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  generatedAt: Date;
}

/** Forecast vs actual consumption for a completed month (for MAPE tracking). */
@Entity('forecast_accuracy')
@Index(['storeId', 'itemId', 'month'], { unique: true })
export class ForecastAccuracy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @Column({ type: 'varchar', length: 7 })
  month: string;

  @Column({ type: 'uuid' })
  forecastId: string;

  @Column({ type: 'enum', enum: ForecastMethod, enumName: 'forecast_method' })
  method: ForecastMethod;

  @Column(QUANTITY)
  forecastQty: number;

  @Column(QUANTITY)
  actualQty: number;

  /** |actual − forecast| / actual × 100; null when actual is 0. */
  @Column({ type: 'numeric', precision: 9, scale: 2, nullable: true, transformer: numericTransformer })
  ape: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  computedAt: Date;
}

/** A health programme whose commodities are quantified (e.g. HIV, TB, malaria, family planning). */
@Entity('programme')
export class Programme extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => ProgrammeCommodity, (c) => c.programme, { cascade: true })
  commodities?: ProgrammeCommodity[];
}

/** Treatment protocol per commodity: units per patient per month. */
@Entity('programme_commodity')
@Index(['programmeId', 'itemId'], { unique: true })
export class ProgrammeCommodity extends AppBaseEntity {
  @Column({ type: 'uuid' })
  programmeId: string;

  @ManyToOne(() => Programme, (p) => p.commodities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'programme_id' })
  programme?: Programme;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Base units per patient per month under the protocol. */
  @Column(QUANTITY)
  unitsPerPatientMonth: number;

  /** Share of the target population on this commodity (regimen split), %. */
  @Column({ type: 'numeric', precision: 7, scale: 2, default: 100, transformer: numericTransformer })
  regimenSharePercent: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  protocolNotes: string | null;
}

/** A quantification exercise: morbidity-based need vs consumption-based need. */
@Entity('quantification')
export class Quantification extends AppBaseEntity {
  @Column({ type: 'uuid' })
  programmeId: string;

  @ManyToOne(() => Programme, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'programme_id' })
  programme?: Programme;

  /** Store whose consumption is used (null = all stores). */
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'int' })
  periodMonths: number;

  @Column({ type: 'int' })
  targetPopulation: number;

  /** % of the target population expected to be treated. */
  @Column({ type: 'numeric', precision: 7, scale: 2, transformer: numericTransformer })
  coveragePercent: number;

  @Column({ type: 'numeric', precision: 7, scale: 2, default: 0, transformer: numericTransformer })
  wastagePercent: number;

  /** Method used for the final quantity (per line overrides allowed). */
  @Column({ type: 'enum', enum: QuantificationMethod, enumName: 'quantification_method', default: QuantificationMethod.MORBIDITY })
  method: QuantificationMethod;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  lines: {
    itemId: string;
    itemCode: string;
    itemName: string;
    morbidityQty: number;
    consumptionQty: number;
    amc: number;
    differencePercent: number | null;
    available: number;
    finalQty: number;
    toProcure: number;
  }[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;
}

import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { ControlledSchedule, SalesClass, type AttributeDefinition } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer, QUANTITY } from '../../common/entities/transformers';
import { TaxCategory } from '../tax/tax.entities';

/** International Non-proprietary Name + strength + form + route. */
@Entity('generic')
@Index('ix_generic_inn_trgm', { synchronize: false }) // GIN trigram index, created in a migration
@Index('uq_generic_identity', ['innName', 'strength', 'dosageForm', 'route'], { unique: true })
export class Generic extends AppBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 200 })
  innName: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  strength: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  dosageForm: string;

  @Column({ type: 'varchar', length: 60, default: '' })
  route: string;

  @Index()
  @Column({ type: 'varchar', length: 10, nullable: true })
  atcCode: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  therapeuticClass: string | null;

  /** On the Kenya Essential Medicines List. */
  @Column({ type: 'boolean', default: false })
  isKeml: boolean;

  @Column({ type: 'enum', enum: ControlledSchedule, enumName: 'controlled_schedule', default: ControlledSchedule.NONE })
  controlledSchedule: ControlledSchedule;

  @Column({ type: 'varchar', length: 500, nullable: true })
  storageRequirements: string | null;

  @Column({ type: 'text', nullable: true })
  pregnancyNotes: string | null;

  @Column({ type: 'text', nullable: true })
  lactationNotes: string | null;

  /** Dispensing checks: contraindicated in pregnancy. */
  @Column({ type: 'boolean', default: false })
  pregnancyContraindicated: boolean;

  /** Dispensing checks: youngest patient age in years (null = no limit). */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, transformer: numericTransformer })
  minAgeYears: number | null;

  /** Over-the-counter limit per sale, in base units, across its brands (e.g. paracetamol, codeine products). */
  @Column({ ...QUANTITY, nullable: true })
  maxQtyPerSale: number | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => Item, (i) => i.generic)
  items?: Item[];
}

@Entity('item_category')
export class ItemCategory extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => ItemCategory, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent?: ItemCategory | null;

  /** Drug categories require a generic on each item. */
  @Column({ type: 'boolean', default: false })
  isDrug: boolean;

  /** Category-specific attribute definitions for non-drug items. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  attributeSchema: AttributeDefinition[];

  /** Near-expiry alert horizons in days for items in this category; null = setting inventory.expiryWarningDays. */
  @Column({ type: 'int', array: true, nullable: true })
  expiryAlertDays: number[] | null;
}

@Entity('unit_of_measure')
export class UnitOfMeasure extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** A brand / SKU. One generic has many items. Quantities are in baseUom. */
@Entity('item')
@Check(`"unit_price" >= 0`)
// GIN trigram indexes, created in a migration
@Index('ix_item_name_trgm', { synchronize: false })
@Index('ix_item_brand_trgm', { synchronize: false })
export class Item extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  genericId: string | null;

  @ManyToOne(() => Generic, (g) => g.items, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'generic_id' })
  generic?: Generic | null;

  @Column({ type: 'uuid' })
  categoryId: string;

  @ManyToOne(() => ItemCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: ItemCategory;

  @Index()
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  brandName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  manufacturer: string | null;

  /** Pharmacy and Poisons Board registration number. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  ppbRegNo: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  packSize: string | null;

  @Index({ unique: true, where: '"gtin" IS NOT NULL' })
  @Column({ type: 'varchar', length: 14, nullable: true })
  gtin: string | null;

  @Index()
  @Column({ type: 'varchar', length: 60, nullable: true })
  barcode: string | null;

  @Column({ type: 'uuid' })
  baseUomId: string;

  @ManyToOne(() => UnitOfMeasure, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'base_uom_id' })
  baseUom?: UnitOfMeasure;

  /** Selling price per base unit, VAT exclusive. */
  @Column(MONEY)
  unitPrice: number;

  @Column({ type: 'enum', enum: SalesClass, enumName: 'sales_class', nullable: true })
  salesClass: SalesClass | null;

  @Column({ type: 'uuid' })
  taxCategoryId: string;

  @ManyToOne(() => TaxCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tax_category_id' })
  taxCategory?: TaxCategory;

  @Column({ type: 'boolean', default: false })
  isFormulary: boolean;

  @Column({ type: 'boolean', default: true })
  isBatchTracked: boolean;

  @Column({ type: 'boolean', default: false })
  isColdChain: boolean;

  @Column({ type: 'boolean', default: false })
  isControlled: boolean;

  @Column({ ...QUANTITY, nullable: true })
  reorderLevel: number | null;

  /** Values for the category's attributeSchema. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  attributes: Record<string, string | number | boolean | null>;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => UnitConversion, (c) => c.item)
  conversions?: UnitConversion[];
}

/**
 * 1 fromUom = factor × toUom. Item-specific when itemId is set
 * (box→strip→tablet), otherwise global (e.g. L→mL).
 */
@Entity('unit_conversion')
@Index('uq_unit_conversion_item', ['itemId', 'fromUomId', 'toUomId'], { unique: true, where: '"item_id" IS NOT NULL' })
@Index('uq_unit_conversion_global', ['fromUomId', 'toUomId'], { unique: true, where: '"item_id" IS NULL' })
@Check(`"factor" > 0`)
@Check(`"from_uom_id" <> "to_uom_id"`)
export class UnitConversion extends AppBaseEntity {
  @Column({ type: 'uuid', nullable: true })
  itemId: string | null;

  @ManyToOne(() => Item, (i) => i.conversions, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'item_id' })
  item?: Item | null;

  @Column({ type: 'uuid' })
  fromUomId: string;

  @ManyToOne(() => UnitOfMeasure, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_uom_id' })
  fromUom?: UnitOfMeasure;

  @Column({ type: 'uuid' })
  toUomId: string;

  @ManyToOne(() => UnitOfMeasure, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_uom_id' })
  toUom?: UnitOfMeasure;

  @Column(QUANTITY)
  factor: number;
}

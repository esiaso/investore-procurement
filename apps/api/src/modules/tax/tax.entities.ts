import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { TaxTreatment } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { numericTransformer } from '../../common/entities/transformers';

@Entity('tax_category')
export class TaxCategory extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: TaxTreatment, enumName: 'tax_treatment' })
  treatment: TaxTreatment;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => TaxRate, (r) => r.taxCategory)
  rates?: TaxRate[];
}

/** A rate applies from effectiveFrom (inclusive) to effectiveTo (inclusive, open if null). */
@Entity('tax_rate')
@Index(['taxCategoryId', 'effectiveFrom'], { unique: true })
@Check(`"effective_to" IS NULL OR "effective_to" >= "effective_from"`)
@Check(`"rate_percent" >= 0 AND "rate_percent" <= 100`)
export class TaxRate extends AppBaseEntity {
  @Column({ type: 'uuid' })
  taxCategoryId: string;

  @ManyToOne(() => TaxCategory, (c) => c.rates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tax_category_id' })
  taxCategory?: TaxCategory;

  @Column({ type: 'numeric', precision: 7, scale: 4, transformer: numericTransformer })
  ratePercent: number;

  @Column({ type: 'date' })
  effectiveFrom: string;

  @Column({ type: 'date', nullable: true })
  effectiveTo: string | null;
}

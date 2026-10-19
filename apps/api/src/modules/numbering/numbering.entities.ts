import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { Store } from '../org/org.entities';

/**
 * How numbers for a document type are formatted, optionally per store.
 * Tokens: {PREFIX} {STORE} {FY} {YYYY} {MM} {SEQ}.
 */
@Entity('numbering_scheme')
@Index('uq_numbering_scheme_type_store', ['documentType', 'storeId'], { unique: true, where: '"store_id" IS NOT NULL' })
@Index('uq_numbering_scheme_type_default', ['documentType'], { unique: true, where: '"store_id" IS NULL' })
export class NumberingScheme extends AppBaseEntity {
  @Column({ type: 'varchar', length: 20 })
  documentType: string;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'store_id' })
  store?: Store | null;

  @Column({ type: 'varchar', length: 20 })
  prefix: string;

  @Column({ type: 'varchar', length: 100 })
  format: string;

  @Column({ type: 'int' })
  padding: number;

  /** Restart the counter each financial year. */
  @Column({ type: 'boolean' })
  resetEachYear: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** One counter row per scheme and financial year; locked with SELECT … FOR UPDATE. */
@Entity('document_sequence')
@Index(['schemeId', 'period'], { unique: true })
export class DocumentSequence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  schemeId: string;

  @ManyToOne(() => NumberingScheme, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheme_id' })
  scheme?: NumberingScheme;

  /** Financial-year label, or "ALL" when the scheme never resets. */
  @Column({ type: 'varchar', length: 20 })
  period: string;

  @Column({ type: 'bigint' })
  nextValue: string;
}

import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { GlAccountType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer } from '../../common/entities/transformers';
import { Department } from '../org/org.entities';

/**
 * Chart of accounts used to code non-stock purchases, petty cash and payments.
 * Usually imported from QuickBooks (qboAccountId set) and kept in step there.
 */
@Entity('gl_account')
export class GlAccount extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: GlAccountType, enumName: 'gl_account_type' })
  type: GlAccountType;

  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** QuickBooks account id when imported from / mapped to QuickBooks. */
  @Index()
  @Column({ type: 'varchar', length: 40, nullable: true })
  qboAccountId: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Optional project / programme a requisition or payment is charged to. */
@Entity('project')
export class Project extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  @Column({ type: 'date', nullable: true })
  startsOn: string | null;

  @Column({ type: 'date', nullable: true })
  endsOn: string | null;

  @Column({ ...MONEY, nullable: true })
  budget: number | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Currencies documents may be in; the base currency (locale.currency) has rate 1. */
@Entity('currency')
export class Currency extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'char', length: 3 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Base-currency value of one unit of `currencyCode` from `rateDate` (until the next rate). */
@Entity('exchange_rate')
@Index(['currencyCode', 'rateDate'], { unique: true })
export class ExchangeRate extends AppBaseEntity {
  @Column({ type: 'char', length: 3 })
  currencyCode: string;

  @Column({ type: 'date' })
  rateDate: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: numericTransformer })
  rate: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  source: string | null;
}

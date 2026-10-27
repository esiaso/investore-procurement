import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ReportFormat, ReportFrequency, ReportPeriod } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';

/** A report emailed on a schedule, run with its owner's permissions and store scope. */
@Entity('report_schedule')
@Index(['isActive', 'nextRunAt'])
export class ReportSchedule extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  reportKey: string;

  /** Filters other than the period (store, category, groupBy…). */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  filters: Record<string, unknown>;

  /** Period resolved at each run (reports without dates ignore it). */
  @Column({ type: 'enum', enum: ReportPeriod, enumName: 'report_period', default: ReportPeriod.LAST_7_DAYS })
  period: ReportPeriod;

  @Column({ type: 'enum', enum: ReportFormat, enumName: 'report_format', default: ReportFormat.XLSX })
  format: ReportFormat;

  @Column({ type: 'enum', enum: ReportFrequency, enumName: 'report_frequency' })
  frequency: ReportFrequency;

  /** Local hour (locale.timezone) the report is sent. */
  @Column({ type: 'smallint', default: 7 })
  hour: number;

  /** WEEKLY: ISO weekday 1 (Monday) – 7. */
  @Column({ type: 'smallint', nullable: true })
  weekday: number | null;

  /** MONTHLY: day of the month 1 – 28. */
  @Column({ type: 'smallint', nullable: true })
  monthDay: number | null;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  recipients: string[];

  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz' })
  nextRunAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;
}

/** One export or scheduled run: what was asked for (the email attachment is rendered from it). */
@Entity('report_run')
@Index(['reportKey', 'createdAt'])
export class ReportRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60 })
  reportKey: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  filters: Record<string, unknown>;

  @Column({ type: 'enum', enum: ReportFormat, enumName: 'report_format' })
  format: ReportFormat;

  /** Stores the run may see (null = all). */
  @Column({ type: 'jsonb', nullable: true })
  storeScope: string[] | null;

  @Column({ type: 'uuid', nullable: true })
  scheduleId: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'int', nullable: true })
  rowCount: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

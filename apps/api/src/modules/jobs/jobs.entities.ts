import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { JobRunStatus } from '@sil/shared';

/** One execution of a background job (scheduled, manual or triggered by an event). */
@Entity('job_run')
@Index(['name', 'startedAt'])
export class JobRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'enum', enum: JobRunStatus, enumName: 'job_run_status' })
  status: JobRunStatus;

  /** schedule | manual | event */
  @Column({ type: 'varchar', length: 20 })
  trigger: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  params: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  error: string | null;

  /** User who ran it by hand. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

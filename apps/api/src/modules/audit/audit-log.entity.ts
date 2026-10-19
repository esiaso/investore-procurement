import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// `any` values keep TypeORM's deep-partial insert typing happy for free-form JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

/**
 * Append-only: a database trigger rejects UPDATE, DELETE and TRUNCATE
 * (see the init migration).
 */
@Entity('audit_log')
@Index(['entityType', 'entityId'])
@Index(['occurredAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  userId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;

  @Column({ type: 'uuid', nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 30 })
  action: string;

  @Column({ type: 'varchar', length: 100 })
  entityType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: JsonObject | null;

  @Column({ type: 'jsonb', nullable: true })
  after: JsonObject | null;
}

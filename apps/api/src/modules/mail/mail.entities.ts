import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EmailStatus } from '@sil/shared';

/**
 * Transactional outbox: written in the same transaction as the business
 * change, sent later by the poller (so no mail goes out for rolled-back work).
 */
@Entity('email_outbox')
@Index(['status', 'nextAttemptAt'])
export class EmailOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 300 })
  toAddress: string;

  @Column({ type: 'varchar', length: 300 })
  subject: string;

  @Column({ type: 'text' })
  bodyText: string;

  /** Rendered at send time, e.g. { kind: 'PO_PDF', id } . */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  attachments: { kind: string; id: string; filename: string }[];

  @Column({ type: 'enum', enum: EmailStatus, enumName: 'email_status', default: EmailStatus.QUEUED })
  status: EmailStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  sourceDocType: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceDocId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

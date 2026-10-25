import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { DisposalMethod, DisposalStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { Item } from '../catalog/catalog.entities';
import { Batch } from '../inventory/inventory.entities';
import { Bin, Store } from '../org/org.entities';

const num = { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/**
 * Disposal of expired, obsolete, rejected or recalled stock: a committee
 * recommends the method, the disposal is approved (workflow), the stock is
 * written off on approval, and completion (who disposed of it, where, how)
 * produces the certificate stored with the record.
 */
@Entity('disposal')
export class Disposal extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'enum', enum: DisposalMethod, enumName: 'disposal_method' })
  method: DisposalMethod;

  @Column({ type: 'varchar', length: 1000 })
  reason: string;

  /** Buyer, receiving facility, supplier or licensed waste handler. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  recipient: string | null;

  @Column({ type: 'enum', enum: DisposalStatus, enumName: 'disposal_status', default: DisposalStatus.DRAFT })
  status: DisposalStatus;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0, transformer: num })
  totalValue: number;

  /** PPADA rule set: public notice / tender for a sale, reference of the board's approval. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  publicNoticeRef: string | null;

  /** Quality holds that led to this disposal. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  holdIds: string[];

  @Column({ type: 'uuid', nullable: true })
  submittedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @Column({ type: 'date', nullable: true })
  completedOn: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  place: string | null;

  /** Disposal agent / waste handler and their waste-transfer note. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  agent: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  wasteTransferNote: string | null;

  /** Proceeds of a sale. */
  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: num })
  proceeds: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;

  @OneToMany(() => DisposalLine, (l) => l.disposal, { cascade: true })
  lines?: DisposalLine[];

  @OneToMany(() => DisposalMember, (l) => l.disposal, { cascade: true })
  members?: DisposalMember[];
}

@Entity('disposal_line')
export class DisposalLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  disposalId: string;

  @ManyToOne(() => Disposal, (d) => d.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'disposal_id' })
  disposal?: Disposal;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch)
  @JoinColumn({ name: 'batch_id' })
  batch?: Batch;

  @Column({ type: 'uuid', nullable: true })
  binId: string | null;

  @ManyToOne(() => Bin)
  @JoinColumn({ name: 'bin_id' })
  bin?: Bin | null;

  @Column({ type: 'numeric', precision: 18, scale: 4, transformer: num })
  quantity: number;

  /** Estimate when raised; the posted cost after approval. */
  @Column({ type: 'numeric', precision: 18, scale: 6, transformer: num })
  unitCost: number;
}

/** Disposal committee member and their sign-off of the recommendation. */
@Entity('disposal_member')
export class DisposalMember extends AppBaseEntity {
  @Column({ type: 'uuid' })
  disposalId: string;

  @ManyToOne(() => Disposal, (d) => d.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'disposal_id' })
  disposal?: Disposal;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 20 })
  role: string;

  @Column({ type: 'timestamptz', nullable: true })
  signedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment: string | null;
}

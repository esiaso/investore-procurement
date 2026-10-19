import { Column, Entity, Index, JoinColumn, JoinTable, ManyToMany, ManyToOne } from 'typeorm';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { Department, Store } from '../org/org.entities';
import { Role } from '../rbac/rbac.entities';

@Entity('app_user')
export class User extends AppBaseEntity {
  /** Stored lowercase. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  username: string;

  @Column({ type: 'varchar', length: 200 })
  fullName: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  /** Argon2id hash. */
  @Column({ type: 'varchar', length: 255, select: false })
  passwordHash: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  mustChangePassword: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  /** AES-256-GCM encrypted TOTP secret. */
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  totpSecretEnc: string | null;

  @Column({ type: 'boolean', default: false })
  totpEnabled: boolean;

  @Column({ type: 'int', default: 0 })
  failedLoginCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  @ManyToMany(() => Role)
  @JoinTable({
    name: 'user_role',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  roles?: Role[];

  /** Stores the user works in (data scope unless they hold store.all). */
  @ManyToMany(() => Store)
  @JoinTable({
    name: 'user_store',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'store_id', referencedColumnName: 'id' },
  })
  stores?: Store[];
}

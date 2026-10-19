import { Column, Entity, Index, JoinTable, ManyToMany, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/entities/base.entity';

@Entity('permission')
export class Permission {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 300 })
  description: string;
}

@Entity('role')
export class Role extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** Seeded roles cannot be deleted (their permissions remain editable). */
  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @ManyToMany(() => Permission)
  @JoinTable({
    name: 'role_permission',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_code', referencedColumnName: 'code' },
  })
  permissions?: Permission[];
}

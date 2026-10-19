import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { ServicePoint, StoreType } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';

@Entity('facility')
export class Facility extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  kraPin: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** A stock-holding location: main store, main pharmacy, satellite pharmacies… */
@Entity('store')
export class Store extends AppBaseEntity {
  @Column({ type: 'uuid' })
  facilityId: string;

  @ManyToOne(() => Facility, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'facility_id' })
  facility?: Facility;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: StoreType, enumName: 'store_type' })
  type: StoreType;

  @Column({ type: 'enum', enum: ServicePoint, enumName: 'service_point', nullable: true })
  servicePoint: ServicePoint | null;

  /** Store that normally replenishes this one. */
  @Column({ type: 'uuid', nullable: true })
  parentStoreId: string | null;

  @ManyToOne(() => Store, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'parent_store_id' })
  parentStore?: Store | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => Bin, (b) => b.store)
  bins?: Bin[];
}

@Entity('bin')
@Index(['storeId', 'code'], { unique: true })
export class Bin extends AppBaseEntity {
  @Column({ type: 'uuid' })
  storeId: string;

  @ManyToOne(() => Store, (s) => s.bins, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id' })
  store?: Store;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  zone: string | null;

  /** Stock here (damaged/expired returns) is never picked, issued or transferred. */
  @Column({ type: 'boolean', default: false })
  isQuarantine: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** Department doubling as a cost centre for charging issues and budgets. */
@Entity('department')
export class Department extends AppBaseEntity {
  @Column({ type: 'uuid' })
  facilityId: string;

  @ManyToOne(() => Facility, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'facility_id' })
  facility?: Facility;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  costCentreCode: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { AssetStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { Item } from '../catalog/catalog.entities';
import { Department, Store } from '../org/org.entities';
import { Supplier } from '../suppliers/suppliers.entities';

const num = { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/** Fixed asset (equipment) tagged on receipt. Location, custodian, warranty and maintenance dates; no depreciation. */
@Entity('asset')
@Index(['nextMaintenanceOn'])
@Index(['warrantyEndsOn'])
export class Asset extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  tagNo: string;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item)
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  serialNo: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model: string | null;

  @Column({ type: 'uuid', nullable: true })
  grnId: string | null;

  @Column({ type: 'uuid', nullable: true })
  grnLineId: string | null;

  @Column({ type: 'uuid', nullable: true })
  supplierId: string | null;

  @ManyToOne(() => Supplier)
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier | null;

  @Column({ type: 'date' })
  acquiredOn: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0, transformer: num })
  cost: number;

  /** Where it is: a store (in stores) or a department, plus a free-text room / location. */
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store?: Store | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department)
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  location: string | null;

  @Column({ type: 'uuid', nullable: true })
  custodianUserId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  custodianName: string | null;

  @Column({ type: 'date', nullable: true })
  warrantyEndsOn: string | null;

  @Column({ type: 'int', nullable: true })
  maintenanceIntervalMonths: number | null;

  @Column({ type: 'date', nullable: true })
  lastMaintenanceOn: string | null;

  @Column({ type: 'date', nullable: true })
  nextMaintenanceOn: string | null;

  @Column({ type: 'enum', enum: AssetStatus, enumName: 'asset_status', default: AssetStatus.ACTIVE })
  status: AssetStatus;

  /** Dates already alerted (so each due date is alerted once). */
  @Column({ type: 'date', nullable: true })
  warrantyAlertedFor: string | null;

  @Column({ type: 'date', nullable: true })
  maintenanceAlertedFor: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;
}

/** Location / custodian history. */
@Entity('asset_movement')
@Index(['assetId'])
export class AssetMovement extends AppBaseEntity {
  @Column({ type: 'uuid' })
  assetId: string;

  @Column({ type: 'date' })
  movedOn: string;

  @Column({ type: 'jsonb' })
  fromLocation: { storeId: string | null; departmentId: string | null; location: string | null; custodianUserId: string | null; custodianName: string | null };

  @Column({ type: 'jsonb' })
  toLocation: { storeId: string | null; departmentId: string | null; location: string | null; custodianUserId: string | null; custodianName: string | null };

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'uuid', nullable: true })
  movedBy: string | null;
}

@Entity('asset_maintenance')
@Index(['assetId'])
export class AssetMaintenance extends AppBaseEntity {
  @Column({ type: 'uuid' })
  assetId: string;

  @Column({ type: 'date' })
  performedOn: string;

  @Column({ type: 'varchar', length: 20 })
  kind: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  performedBy: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: num })
  cost: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'date', nullable: true })
  nextDueOn: string | null;
}

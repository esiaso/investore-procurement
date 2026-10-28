import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { CertificateStatus, DistributionRunStatus, ShipmentStatus, StopStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { StockTransfer } from '../inventory/documents.entities';
import { Store } from '../org/org.entities';
import { PurchaseOrder } from '../purchasing/purchasing.entities';
import { Supplier } from '../suppliers/suppliers.entities';

const num = { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) };

/** A regular delivery round from the main store to satellite stores, in stop order. */
@Entity('delivery_route')
export class DeliveryRoute extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'uuid' })
  fromStoreId: string;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'from_store_id' })
  fromStore?: Store;

  /** Destination stores in delivery order. */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  stopStoreIds: string[];

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/**
 * One delivery run: the transfer requests it carries are picked (FEFO
 * picking list), packed, dispatched together (dispatch note) and delivered
 * stop by stop; proof of delivery posts the transfer receipt.
 */
@Entity('distribution_run')
export class DistributionRun extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid', nullable: true })
  routeId: string | null;

  @ManyToOne(() => DeliveryRoute)
  @JoinColumn({ name: 'route_id' })
  route?: DeliveryRoute | null;

  @Column({ type: 'uuid' })
  fromStoreId: string;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'from_store_id' })
  fromStore?: Store;

  @Column({ type: 'date' })
  runDate: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  vehicle: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  driver: string | null;

  @Column({ type: 'enum', enum: DistributionRunStatus, enumName: 'distribution_run_status', default: DistributionRunStatus.PLANNED })
  status: DistributionRunStatus;

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  dispatchedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => DistributionStop, (s) => s.run, { cascade: true })
  stops?: DistributionStop[];
}

export interface StopPick {
  lineId: string;
  batchId: string;
  binId: string | null;
  quantity: number;
}

@Entity('distribution_stop')
@Index(['transferId'], { unique: true })
export class DistributionStop extends AppBaseEntity {
  @Column({ type: 'uuid' })
  runId: string;

  @ManyToOne(() => DistributionRun, (r) => r.stops, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: DistributionRun;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'uuid' })
  transferId: string;

  @ManyToOne(() => StockTransfer)
  @JoinColumn({ name: 'transfer_id' })
  transfer?: StockTransfer;

  @Column({ type: 'uuid' })
  toStoreId: string;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'to_store_id' })
  toStore?: Store;

  @Column({ type: 'enum', enum: StopStatus, enumName: 'stop_status', default: StopStatus.PENDING })
  status: StopStatus;

  /** Confirmed picks (batch / bin / quantity per transfer line). */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  picks: StopPick[];

  @Column({ type: 'uuid', nullable: true })
  pickedBy: string | null;

  @Column({ type: 'int', default: 0 })
  packages: number;

  @Column({ type: 'uuid', nullable: true })
  packedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  packedAt: Date | null;

  /** Proof of delivery. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  receivedByName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  signatureName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  podRecordedBy: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  discrepancies: { allocationId: string; item: string; batchNo: string; dispatched: number; received: number; reasonCode: string | null; notes: string | null }[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  podNotes: string | null;
}

/** Advance notice of a delivery against a purchase order (dates, carrier, partial quantities). */
@Entity('inbound_shipment')
export class InboundShipment extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @ManyToOne(() => PurchaseOrder)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier)
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'date', nullable: true })
  shippedOn: string | null;

  @Column({ type: 'date' })
  expectedOn: string;

  /** Earlier expected dates, newest last: [{ date, reason, at }]. */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  expectedHistory: { date: string; reason: string | null; at: string }[];

  @Column({ type: 'varchar', length: 200, nullable: true })
  carrier: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  trackingRef: string | null;

  @Column({ type: 'enum', enum: ShipmentStatus, enumName: 'shipment_status', default: ShipmentStatus.EXPECTED })
  status: ShipmentStatus;

  @Column({ type: 'date', nullable: true })
  delayNotifiedFor: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @OneToMany(() => InboundShipmentLine, (l) => l.shipment, { cascade: true })
  lines?: InboundShipmentLine[];
}

@Entity('inbound_shipment_line')
export class InboundShipmentLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  shipmentId: string;

  @ManyToOne(() => InboundShipment, (s) => s.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id' })
  shipment?: InboundShipment;

  @Column({ type: 'uuid' })
  poLineId: string;

  /** Base units on this shipment. */
  @Column({ type: 'numeric', precision: 18, scale: 4, transformer: num })
  quantity: number;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0, transformer: num })
  receivedQty: number;
}

/**
 * Service / works completion certificate: confirms what a service PO
 * delivered (instead of a GRN) and counts as received in the three-way match.
 */
@Entity('service_certificate')
@Index(['purchaseOrderId'])
export class ServiceCertificate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  number: string;

  @Column({ type: 'uuid' })
  purchaseOrderId: string;

  @ManyToOne(() => PurchaseOrder)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier)
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'date', nullable: true })
  periodFrom: string | null;

  @Column({ type: 'date' })
  periodTo: string;

  @Column({ type: 'enum', enum: CertificateStatus, enumName: 'certificate_status', default: CertificateStatus.DRAFT })
  status: CertificateStatus;

  /** 1–5 rating of the work (feeds supplier performance). */
  @Column({ type: 'int', nullable: true })
  qualityRating: number | null;

  @Column({ type: 'varchar', length: 2000 })
  workDone: string;

  @Column({ type: 'uuid' })
  certifiedBy: string;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  /** Requester / requesting department member who signed the acceptance (non-stock orders from staff requisitions). */
  @Column({ type: 'uuid', nullable: true })
  acceptedBy: string | null;

  /** Why the requesting department refused it. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  rejectionReason: string | null;

  @OneToMany(() => ServiceCertificateLine, (l) => l.certificate, { cascade: true })
  lines?: ServiceCertificateLine[];
}

@Entity('service_certificate_line')
@Index(['poLineId'])
@Index(['certificateId'])
export class ServiceCertificateLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  certificateId: string;

  @ManyToOne(() => ServiceCertificate, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'certificate_id' })
  certificate?: ServiceCertificate;

  @Column({ type: 'uuid' })
  poLineId: string;

  /** Accepted, in the PO line's ordering unit (e.g. 1 visit, 3 months, 100%). */
  @Column({ type: 'numeric', precision: 18, scale: 4, transformer: num })
  quantity: number;

  /** Delivered but refused (not counted as received). */
  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0, transformer: num })
  rejectedQty: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  remarks: string | null;
}

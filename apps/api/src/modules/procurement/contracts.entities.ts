import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { ContractStatus, ContractType, VariationStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, QUANTITY } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';
import { Supplier } from '../suppliers/suppliers.entities';

/**
 * Contract or framework agreement with agreed prices per item. Call-off orders
 * against it become purchase orders; the remaining balance per line is the
 * contract quantity less what POs (not cancelled or rejected) have called off.
 */
@Entity('contract')
@Index(['supplierId', 'status'])
export class Contract extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid', nullable: true })
  tenderId: string | null;

  @Column({ type: 'enum', enum: ContractType, enumName: 'contract_type' })
  type: ContractType;

  @Column({ type: 'enum', enum: ContractStatus, enumName: 'contract_status', default: ContractStatus.DRAFT })
  status: ContractStatus;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  /** Ceiling (framework) or contract value, excl. VAT. */
  @Column(MONEY)
  value: number;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  deliveryTerms: string | null;

  @Column({ type: 'int', nullable: true })
  paymentTermsDays: number | null;

  /** Default delivery lead time for call-offs. */
  @Column({ type: 'int', nullable: true })
  leadTimeDays: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  signedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  signedBy: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  supplierSignatory: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  terminationReason: string | null;

  /** Days-before-end thresholds already alerted (contracts.expiryAlertDays). */
  @Column({ type: 'int', array: true, default: () => `'{}'` })
  alertedDays: number[];

  @OneToMany(() => ContractLine, (l) => l.contract, { cascade: true })
  lines?: ContractLine[];
}

@Entity('contract_line')
@Index(['contractId', 'itemId'], { unique: true })
export class ContractLine extends AppBaseEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contract_id' })
  contract?: Contract;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  /** Agreed price per base unit, excl. VAT. */
  @Column(MONEY)
  unitPrice: number;

  /** Contracted / maximum quantity in base units; null = no quantity cap (price agreement only). */
  @Column({ ...QUANTITY, nullable: true })
  quantity: number | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  brand: string | null;
}

@Entity('performance_security')
@Index(['expiresOn'])
export class PerformanceSecurity extends AppBaseEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contract_id' })
  contract?: Contract;

  /** e.g. BANK_GUARANTEE, INSURANCE_BOND. */
  @Column({ type: 'varchar', length: 40 })
  securityType: string;

  @Column({ type: 'varchar', length: 100 })
  reference: string;

  @Column({ type: 'varchar', length: 200 })
  issuer: string;

  @Column(MONEY)
  amount: number;

  @Column({ type: 'date' })
  expiresOn: string;

  @Column({ type: 'date', nullable: true })
  releasedOn: string | null;

  @Column({ type: 'int', array: true, default: () => `'{}'` })
  alertedDays: number[];
}

@Entity('contract_milestone')
@Index(['contractId'])
export class ContractMilestone extends AppBaseEntity {
  @Column({ type: 'uuid' })
  contractId: string;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  @Column({ type: 'date' })
  dueDate: string;

  @Column({ type: 'date', nullable: true })
  completedOn: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;
}

/** Change to price, quantity, end date or value; applied when approved. */
@Entity('contract_variation')
@Index(['contractId'])
export class ContractVariation extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  number: string;

  @Column({ type: 'uuid' })
  contractId: string;

  @ManyToOne(() => Contract, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contract_id' })
  contract?: Contract;

  @Column({ type: 'varchar', length: 2000 })
  reason: string;

  @Column({ type: 'jsonb' })
  changes: {
    endDate?: string;
    value?: number;
    lines?: { contractLineId?: string; itemId?: string; unitPrice?: number; quantity?: number | null }[];
  };

  /** Value change (for the approval band). */
  @Column(MONEY)
  valueChange: number;

  @Column({ type: 'enum', enum: VariationStatus, enumName: 'variation_status', default: VariationStatus.DRAFT })
  status: VariationStatus;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastComment: string | null;
}

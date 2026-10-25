import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { AgpoCategory, NationalAgency, PrequalificationStatus, SupplierStatus } from '@sil/shared';
import { AppBaseEntity } from '../../common/entities/base.entity';
import { MONEY, numericTransformer } from '../../common/entities/transformers';
import { Item } from '../catalog/catalog.entities';

@Entity('supplier')
export class Supplier extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Index()
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 11 })
  kraPin: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string | null;

  @Column({ type: 'int', default: 30 })
  paymentTermsDays: number;

  @Column({ type: 'enum', enum: SupplierStatus, enumName: 'supplier_status', default: SupplierStatus.ACTIVE })
  status: SupplierStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  statusReason: string | null;

  @Column({ type: 'enum', enum: PrequalificationStatus, enumName: 'prequalification_status', default: PrequalificationStatus.NOT_PREQUALIFIED })
  prequalificationStatus: PrequalificationStatus;

  @Column({ type: 'date', nullable: true })
  prequalifiedUntil: string | null;

  /** Item categories the supplier is approved to supply. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  categoryIds: string[];

  @Column({ type: 'varchar', length: 100, nullable: true })
  bankName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  bankBranch: string | null;

  /** AES-256-GCM encrypted account number; never returned unless permitted. */
  @Column({ type: 'varchar', length: 300, nullable: true, select: false })
  bankAccountEnc: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  bankAccountMasked: string | null;

  /** Average days from PO sent to first GRN (job suppliers.leadtimes); default delivery date on new POs. */
  @Column({ type: 'int', nullable: true })
  observedLeadTimeDays: number | null;

  // Performance, recomputed from posted GRNs.
  @Column({ type: 'numeric', precision: 7, scale: 4, nullable: true, transformer: numericTransformer })
  onTimeDeliveryRate: number | null;

  @Column({ type: 'numeric', precision: 7, scale: 4, nullable: true, transformer: numericTransformer })
  qualityRejectRate: number | null;

  @Column({ type: 'numeric', precision: 9, scale: 4, nullable: true, transformer: numericTransformer })
  avgPriceVariancePct: number | null;

  @Column({ type: 'int', default: 0 })
  grnCount: number;

  /** KEMSA / MEDS: national agency with order templates and order cycles. */
  @Column({ type: 'enum', enum: NationalAgency, enumName: 'national_agency', nullable: true })
  nationalAgency: NationalAgency | null;

  /** Optional PPADA rule set: AGPO category and certificate. */
  @Column({ type: 'enum', enum: AgpoCategory, enumName: 'agpo_category', nullable: true })
  agpoCategory: AgpoCategory | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  agpoCertificateNo: string | null;

  @Column({ type: 'date', nullable: true })
  agpoValidUntil: string | null;

  @OneToMany(() => SupplierContact, (c) => c.supplier, { cascade: true })
  contacts?: SupplierContact[];

  @OneToMany(() => SupplierDocument, (d) => d.supplier)
  documents?: SupplierDocument[];
}

@Entity('supplier_contact')
export class SupplierContact extends AppBaseEntity {
  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, (s) => s.contacts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  role: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;
}

/** Licences and certificates (metadata; file storage arrives with MinIO). */
@Entity('supplier_document')
@Index(['expiresOn'])
export class SupplierDocument extends AppBaseEntity {
  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, (s) => s.documents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  /** e.g. PPB_LICENCE, BUSINESS_PERMIT, TAX_COMPLIANCE, CR12. */
  @Column({ type: 'varchar', length: 40 })
  documentType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'date', nullable: true })
  issuedOn: string | null;

  @Column({ type: 'date', nullable: true })
  expiresOn: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;
}

/** Agreed price per base unit (simple contract price list; full contracts in slice 7). */
@Entity('contract_price')
@Index(['supplierId', 'itemId', 'validFrom'], { unique: true })
@Check(`"valid_to" IS NULL OR "valid_to" >= "valid_from"`)
export class ContractPrice extends AppBaseEntity {
  @Column({ type: 'uuid' })
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'uuid' })
  itemId: string;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_id' })
  item?: Item;

  @Column(MONEY)
  unitPrice: number;

  @Column({ type: 'date' })
  validFrom: string;

  @Column({ type: 'date', nullable: true })
  validTo: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  contractRef: string | null;
}

import { Column, Entity, Index } from 'typeorm';
import { AppBaseEntity } from '../../common/entities/base.entity';

/**
 * A donor / programme funding source. Batches carry its code
 * (batch.funding_source); the rules below restrict what that stock may be
 * used for. No row for a code = no restriction.
 */
@Entity('funding_source')
export class FundingSource extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  donor: string | null;

  /** Programme (quantification) the stock belongs to. */
  @Column({ type: 'uuid', nullable: true })
  programmeId: string | null;

  /** Donated stock is usually free to the patient: false blocks sales and dispensing on invoice. */
  @Column({ type: 'boolean', default: true })
  allowSale: boolean;

  /** Stores that may hold and use the stock (empty = any). */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  allowedStoreIds: string[];

  /** Departments it may be issued to (empty = any). */
  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  allowedDepartmentIds: string[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** What the stock is being taken for. */
export type FundingUse =
  | { purpose: 'SALE'; storeId: string }
  | { purpose: 'ISSUE'; departmentId: string | null }
  | { purpose: 'TRANSFER'; toStoreId: string };

/**
 * SQL condition (alias b = batch) that is true when the batch may be used for
 * `use`. Parameters are appended to `params`.
 */
export function fundingAllowedSql(use: FundingUse | undefined, params: unknown[]): string {
  if (!use) return 'true';
  if (use.purpose === 'SALE') {
    params.push(use.storeId);
    const p = `$${params.length}`;
    return `NOT EXISTS (SELECT 1 FROM funding_source fs WHERE fs.code = b.funding_source AND fs.is_active
              AND (NOT fs.allow_sale OR (cardinality(fs.allowed_store_ids) > 0 AND NOT ${p}::uuid = ANY(fs.allowed_store_ids))))`;
  }
  if (use.purpose === 'ISSUE') {
    if (!use.departmentId) return 'true';
    params.push(use.departmentId);
    const p = `$${params.length}`;
    return `NOT EXISTS (SELECT 1 FROM funding_source fs WHERE fs.code = b.funding_source AND fs.is_active
              AND cardinality(fs.allowed_department_ids) > 0 AND NOT ${p}::uuid = ANY(fs.allowed_department_ids))`;
  }
  params.push(use.toStoreId);
  const p = `$${params.length}`;
  return `NOT EXISTS (SELECT 1 FROM funding_source fs WHERE fs.code = b.funding_source AND fs.is_active
            AND cardinality(fs.allowed_store_ids) > 0 AND NOT ${p}::uuid = ANY(fs.allowed_store_ids))`;
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction, BatchHoldStatus, Paginated, Permissions, SessionUser, ValuationMethod } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import { selectBatches } from './fefo';
import { Batch, StorePeriodLock } from './inventory.entities';
import {
  BatchQueryDto,
  FefoQueryDto,
  LedgerQueryDto,
  PeriodLockDto,
  SetHoldDto,
  StockQueryDto,
  ValuationQueryDto,
  WitnessDto,
} from './inventory.dto';
import { PostingContext } from './posting';

/** Collects positional SQL parameters. */
class Sql {
  readonly params: unknown[] = [];
  readonly where: string[] = [];
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  and(clause: string): void {
    this.where.push(clause);
  }
  get whereSql(): string {
    return this.where.length ? `WHERE ${this.where.join(' AND ')}` : '';
  }
}

export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class InventoryService {
  constructor(
    @InjectDataSource() readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ posting helpers

  async postingContext(
    actor: SessionUser,
    doc: { type: string; id?: string | null; number?: string | null },
    effectiveDate?: string,
    secondSignerId?: string | null,
    manager?: EntityManager,
  ): Promise<PostingContext> {
    return {
      sourceDocType: doc.type,
      sourceDocId: doc.id ?? null,
      sourceDocNo: doc.number ?? null,
      effectiveDate: effectiveDate ?? (await this.settings.today(manager)),
      userId: actor.id,
      permissions: new Set(actor.permissions),
      secondSignerId: secondSignerId ?? null,
      valuationMethod: await this.settings.get('inventory.valuationMethod', manager),
    };
  }

  async anyControlled(manager: EntityManager, itemIds: string[]): Promise<boolean> {
    const [r] = await manager.query(`SELECT bool_or(is_controlled) AS c FROM item WHERE id = ANY($1::uuid[])`, [itemIds]);
    return !!r?.c;
  }

  /**
   * Verifies the second signatory of a controlled-drug movement: an active,
   * different user holding inventory.handle_controlled who entered their own
   * password. Returns their id.
   */
  async verifyWitness(witness: WitnessDto | undefined, actor: SessionUser): Promise<string> {
    if (!witness) {
      throw new BadRequestException({ message: 'Controlled drugs need a second person to sign off', code: 'SECOND_SIGNATURE_REQUIRED' });
    }
    const user = await this.users.findWithSecretsByUsername(witness.username);
    const ok = await this.passwords.verify(user?.passwordHash, witness.password);
    if (!user || !ok || !user.isActive) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user?.id ?? null,
        after: { username: witness.username, reason: 'witness_signoff_failed' },
      });
      throw new BadRequestException({ message: 'Witness username or password is incorrect', code: 'WITNESS_INVALID' });
    }
    if (user.id === actor.id) {
      throw new BadRequestException({ message: 'The witness must be a different user', code: 'SECOND_SIGNATURE_REQUIRED' });
    }
    const session = await this.users.findForSession(user.id);
    if (!session?.permissions.includes(Permissions.INVENTORY_HANDLE_CONTROLLED)) {
      throw new ForbiddenException('The witness is not authorised to sign for controlled drugs');
    }
    return user.id;
  }

  // ------------------------------------------------------------------ stock on hand

  async stockOnHand(query: StockQueryDto, actor: SessionUser): Promise<Paginated<Record<string, unknown>>> {
    const method = await this.settings.get('inventory.valuationMethod');
    const today = await this.settings.today();
    const showValue = actor.permissions.includes(Permissions.INVENTORY_VALUATION);
    const q = new Sql();
    q.and(`(sb.on_hand <> 0 OR sb.in_transit <> 0)`);
    const scope = StoreScope.current();
    if (scope !== null) q.and(`sb.store_id = ANY(${q.p(scope)}::uuid[])`);
    if (query.storeId) q.and(`sb.store_id = ${q.p(query.storeId)}`);
    if (query.binId) q.and(`sb.bin_id = ${q.p(query.binId)}`);
    if (query.itemId) q.and(`sb.item_id = ${q.p(query.itemId)}`);
    if (query.batchId) q.and(`sb.batch_id = ${q.p(query.batchId)}`);
    if (query.genericId) q.and(`i.generic_id = ${q.p(query.genericId)}`);
    if (query.categoryId) q.and(`i.category_id = ${q.p(query.categoryId)}`);
    if (query.holdStatus) q.and(`b.hold_status = ${q.p(query.holdStatus)}`);
    if (query.expired) q.and(`b.expiry_date <= ${q.p(today)}::date`);
    if (query.expiringWithinDays !== undefined) q.and(`b.expiry_date <= ${q.p(addDays(today, query.expiringWithinDays))}::date`);
    if (query.search) {
      const term = q.p(`%${query.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const exact = q.p(query.search.trim());
      q.and(`(i.name ILIKE ${term} OR i.code ILIKE ${term} OR i.gtin = ${exact} OR i.barcode = ${exact} OR b.batch_no ILIKE ${term} OR g.inn_name ILIKE ${term})`);
    }
    const unitCost = method === ValuationMethod.FIFO ? 'b.unit_cost' : 'COALESCE(c.avg_cost, b.unit_cost)';
    const from = `
      FROM stock_balance sb
      JOIN store s ON s.id = sb.store_id
      JOIN item i ON i.id = sb.item_id
      JOIN batch b ON b.id = sb.batch_id
      JOIN unit_of_measure u ON u.id = i.base_uom_id
      LEFT JOIN generic g ON g.id = i.generic_id
      LEFT JOIN bin bn ON bn.id = sb.bin_id
      LEFT JOIN item_store_cost c ON c.store_id = sb.store_id AND c.item_id = sb.item_id
      ${q.whereSql}`;
    // WHERE params are shared by the data and count queries; extra params follow them.
    const whereParams = [...q.params];
    const extra: unknown[] = [];
    const px = (v: unknown) => {
      extra.push(v);
      return `$${whereParams.length + extra.length}`;
    };

    let sql: string;
    let countSql: string;
    if (query.groupBy === 'item') {
      const todayParam = px(today);
      const limit = px(query.pageSize);
      const offset = px((query.page - 1) * query.pageSize);
      sql = `
        SELECT sb.store_id AS "storeId", s.code AS "storeCode", s.name AS "storeName",
               sb.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName", g.inn_name AS "genericName", u.code AS "uom",
               i.is_controlled AS "isControlled", i.is_cold_chain AS "isColdChain", i.reorder_level::float AS "reorderLevel",
               SUM(sb.on_hand)::float AS "onHand", SUM(sb.reserved)::float AS "reserved", SUM(sb.in_transit)::float AS "inTransit",
               COALESCE(SUM(sb.on_hand - sb.reserved) FILTER (WHERE b.hold_status = 'NONE' AND (b.expiry_date IS NULL OR b.expiry_date > ${todayParam}::date)), 0)::float AS "usable",
               COUNT(DISTINCT sb.batch_id)::int AS "batches",
               to_char(MIN(b.expiry_date) FILTER (WHERE sb.on_hand > 0), 'YYYY-MM-DD') AS "nearestExpiry",
               ${showValue ? `SUM((sb.on_hand + sb.in_transit) * ${unitCost})::float` : 'NULL'} AS "value"
        ${from}
        GROUP BY sb.store_id, s.code, s.name, sb.item_id, i.code, i.name, g.inn_name, u.code, i.is_controlled, i.is_cold_chain, i.reorder_level
        ORDER BY i.name, s.name
        LIMIT ${limit} OFFSET ${offset}`;
      countSql = `SELECT COUNT(*)::int AS n FROM (SELECT 1 ${from} GROUP BY sb.store_id, sb.item_id) x`;
    } else {
      const limit = px(query.pageSize);
      const offset = px((query.page - 1) * query.pageSize);
      sql = `
        SELECT sb.id, sb.store_id AS "storeId", s.code AS "storeCode", s.name AS "storeName",
               sb.bin_id AS "binId", bn.code AS "binCode",
               sb.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName", g.inn_name AS "genericName", u.code AS "uom",
               i.is_controlled AS "isControlled", i.is_cold_chain AS "isColdChain",
               sb.batch_id AS "batchId", b.batch_no AS "batchNo", to_char(b.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
               b.hold_status AS "holdStatus",
               sb.on_hand::float AS "onHand", sb.reserved::float AS "reserved", sb.in_transit::float AS "inTransit",
               ${showValue ? `${unitCost}::float` : 'NULL'} AS "unitCost",
               ${showValue ? `((sb.on_hand + sb.in_transit) * ${unitCost})::float` : 'NULL'} AS "value"
        ${from}
        ORDER BY i.name, s.name, b.expiry_date NULLS LAST, b.batch_no
        LIMIT ${limit} OFFSET ${offset}`;
      countSql = `SELECT COUNT(*)::int AS n ${from}`;
    }
    const [rows, [{ n }]] = await Promise.all([
      this.dataSource.query(sql, [...whereParams, ...extra]),
      this.dataSource.query(countSql, whereParams),
    ]);
    return { items: rows, total: n, page: query.page, pageSize: query.pageSize };
  }

  /** Bin card: ledger rows for an item in a store with a running balance. */
  async itemLedger(query: LedgerQueryDto): Promise<Paginated<Record<string, unknown>> & { openingBalance: number }> {
    StoreScope.assert(query.storeId);
    const q = new Sql();
    q.and(`t.store_id = ${q.p(query.storeId)}`);
    q.and(`t.item_id = ${q.p(query.itemId)}`);
    if (query.batchId) q.and(`t.batch_id = ${q.p(query.batchId)}`);
    const baseWhere = [...q.where];
    const baseParams = [...q.params];
    if (query.from) q.and(`t.effective_date >= ${q.p(query.from)}::date`);
    if (query.to) q.and(`t.effective_date <= ${q.p(query.to)}::date`);

    let opening = 0;
    if (query.from) {
      const [r] = await this.dataSource.query(
        `SELECT COALESCE(SUM(t.quantity), 0)::float AS q FROM stock_transaction t WHERE ${baseWhere.join(' AND ')} AND t.effective_date < $${baseParams.length + 1}::date`,
        [...baseParams, query.from],
      );
      opening = r.q;
    }
    const limit = q.p(query.pageSize);
    const offset = q.p((query.page - 1) * query.pageSize);
    const rows = await this.dataSource.query(
      `SELECT t.id, t.txn_type AS "txnType", to_char(t.effective_date, 'YYYY-MM-DD') AS "effectiveDate", t.posted_at AS "postedAt",
              t.source_doc_type AS "sourceDocType", t.source_doc_no AS "sourceDocNo", t.source_doc_id AS "sourceDocId",
              t.batch_id AS "batchId", b.batch_no AS "batchNo", t.bin_id AS "binId", bn.code AS "binCode",
              t.quantity::float AS "quantity", t.in_transit_delta::float AS "inTransitDelta", t.unit_cost::float AS "unitCost",
              t.value_delta::float AS "valueDelta", t.reason_code AS "reasonCode", t.fefo_override_reason AS "fefoOverrideReason",
              cs.name AS "counterpartStore", u.username AS "user", w.username AS "secondSigner",
              (${opening} + SUM(t.quantity) OVER (ORDER BY t.posted_at, t.id))::float AS "balance"
         FROM stock_transaction t
         JOIN batch b ON b.id = t.batch_id
         LEFT JOIN bin bn ON bn.id = t.bin_id
         LEFT JOIN store cs ON cs.id = t.counterpart_store_id
         LEFT JOIN app_user u ON u.id = t.user_id
         LEFT JOIN app_user w ON w.id = t.second_signer_id
         ${q.whereSql}
        ORDER BY t.posted_at, t.id
        LIMIT ${limit} OFFSET ${offset}`,
      q.params,
    );
    const [{ n }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM stock_transaction t ${q.whereSql}`,
      q.params.slice(0, -2),
    );
    return { items: rows, total: n, page: query.page, pageSize: query.pageSize, openingBalance: opening };
  }

  /** Stock value as at a date: Σ ledger value up to that date (on hand + in transit). */
  async valuation(query: ValuationQueryDto) {
    const asOf = query.asOf ?? (await this.settings.today());
    const q = new Sql();
    q.and(`t.effective_date <= ${q.p(asOf)}::date`);
    const scope = StoreScope.current();
    if (scope !== null) q.and(`t.store_id = ANY(${q.p(scope)}::uuid[])`);
    if (query.storeId) q.and(`t.store_id = ${q.p(query.storeId)}`);
    if (query.categoryId) q.and(`i.category_id = ${q.p(query.categoryId)}`);
    const groupBy = query.groupBy ?? 'store';
    const dims =
      groupBy === 'category'
        ? { select: `c.id AS "categoryId", c.code AS "categoryCode", c.name AS "categoryName"`, group: 'c.id, c.code, c.name', order: 'c.name' }
        : groupBy === 'item'
          ? { select: `i.id AS "itemId", i.code AS "itemCode", i.name AS "itemName"`, group: 'i.id, i.code, i.name', order: 'i.name' }
          : { select: `s.id AS "storeId", s.code AS "storeCode", s.name AS "storeName"`, group: 's.id, s.code, s.name', order: 's.name' };
    const rows = await this.dataSource.query(
      `SELECT ${dims.select},
              SUM(t.quantity + t.in_transit_delta)::float AS "quantity",
              ROUND(SUM(t.value_delta), 2)::float AS "value"
         FROM stock_transaction t
         JOIN item i ON i.id = t.item_id
         JOIN item_category c ON c.id = i.category_id
         JOIN store s ON s.id = t.store_id
         ${q.whereSql}
        GROUP BY ${dims.group}
        HAVING SUM(t.value_delta) <> 0 OR SUM(t.quantity + t.in_transit_delta) <> 0
        ORDER BY ${dims.order}`,
      q.params,
    );
    const total = Math.round(rows.reduce((s: number, r: { value: number }) => s + r.value, 0) * 100) / 100;
    return {
      asOf,
      method: await this.settings.get('inventory.valuationMethod'),
      currency: await this.settings.get('locale.currency'),
      groupBy,
      rows,
      total,
    };
  }

  async fefo(query: FefoQueryDto) {
    StoreScope.assert(query.storeId);
    const asOf = query.asOf ?? (await this.settings.today());
    return selectBatches(this.dataSource.manager, query.itemId, query.storeId, query.quantity, asOf);
  }

  // ------------------------------------------------------------------ batches

  async listBatches(query: BatchQueryDto): Promise<Paginated<Batch>> {
    const qb = this.dataSource
      .getRepository(Batch)
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.item', 'item')
      .orderBy('b.expiryDate', 'ASC', 'NULLS LAST');
    if (query.itemId) qb.andWhere('b.item_id = :itemId', { itemId: query.itemId });
    if (query.holdStatus) qb.andWhere('b.hold_status = :hs', { hs: query.holdStatus });
    if (query.search) qb.andWhere('(b.batch_no ILIKE :q OR item.name ILIKE :q)', { q: `%${query.search}%` });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Quarantine / recall / release a batch (audited through the entity subscriber). */
  async setHold(batchId: string, dto: SetHoldDto): Promise<Batch> {
    const repo = this.dataSource.getRepository(Batch);
    const batch = await repo.findOneBy({ id: batchId });
    if (!batch) throw new NotFoundException('Batch not found');
    if (dto.holdStatus !== BatchHoldStatus.NONE && !dto.reason) throw new BadRequestException('A reason is required');
    batch.holdStatus = dto.holdStatus;
    batch.holdReason = dto.holdStatus === BatchHoldStatus.NONE ? null : (dto.reason ?? null);
    return repo.save(batch);
  }

  // ------------------------------------------------------------------ period locks

  listPeriodLocks(): Promise<StorePeriodLock[]> {
    return this.dataSource.getRepository(StorePeriodLock).find({ relations: { store: true } });
  }

  async setPeriodLock(dto: PeriodLockDto): Promise<StorePeriodLock> {
    StoreScope.assert(dto.storeId);
    const repo = this.dataSource.getRepository(StorePeriodLock);
    const existing = await repo.findOneBy({ storeId: dto.storeId });
    if (existing) {
      existing.lockedUntil = dto.lockedUntil;
      return repo.save(existing);
    }
    return repo.save(repo.create(dto));
  }

  // ------------------------------------------------------------------ reconciliation

  /** Compares balances with the ledger; with repair=true, rewrites drifted balances from the ledger. */
  async reconcile(storeId: string | undefined, repair: boolean) {
    return this.dataSource.transaction(async (m) => {
      if (repair) await m.query(`LOCK TABLE stock_balance IN SHARE ROW EXCLUSIVE MODE`);
      const drift: {
        store_id: string;
        bin_id: string | null;
        item_id: string;
        batch_id: string;
        on_hand: number;
        ledger_on_hand: number;
        in_transit: number;
        ledger_in_transit: number;
      }[] = await m.query(
        `WITH l AS (
           SELECT store_id, bin_id, item_id, batch_id, SUM(quantity) AS q, SUM(in_transit_delta) AS t
             FROM stock_transaction ${storeId ? 'WHERE store_id = $1' : ''}
            GROUP BY store_id, bin_id, item_id, batch_id
         ), b AS (
           SELECT * FROM stock_balance ${storeId ? 'WHERE store_id = $1' : ''}
         )
         SELECT COALESCE(b.store_id, l.store_id) AS store_id, COALESCE(b.bin_id, l.bin_id) AS bin_id,
                COALESCE(b.item_id, l.item_id) AS item_id, COALESCE(b.batch_id, l.batch_id) AS batch_id,
                COALESCE(b.on_hand, 0)::float AS on_hand, COALESCE(l.q, 0)::float AS ledger_on_hand,
                COALESCE(b.in_transit, 0)::float AS in_transit, COALESCE(l.t, 0)::float AS ledger_in_transit
           FROM b FULL JOIN l ON l.store_id = b.store_id AND l.bin_id IS NOT DISTINCT FROM b.bin_id AND l.batch_id = b.batch_id
          WHERE COALESCE(b.on_hand, 0) <> COALESCE(l.q, 0) OR COALESCE(b.in_transit, 0) <> COALESCE(l.t, 0)`,
        storeId ? [storeId] : [],
      );
      const [{ checked }] = await m.query(
        `SELECT COUNT(*)::int AS checked FROM stock_balance ${storeId ? 'WHERE store_id = $1' : ''}`,
        storeId ? [storeId] : [],
      );
      if (repair && drift.length) {
        for (const d of drift) {
          await m.query(
            `INSERT INTO stock_balance (store_id, bin_id, item_id, batch_id, on_hand, in_transit) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ON CONSTRAINT uq_stock_balance_location DO UPDATE SET on_hand = EXCLUDED.on_hand, in_transit = EXCLUDED.in_transit, updated_at = now()`,
            [d.store_id, d.bin_id, d.item_id, d.batch_id, d.ledger_on_hand, d.ledger_in_transit],
          );
        }
        await this.audit.record(
          { action: AuditAction.UPDATE, entityType: 'StockBalance', entityId: null, before: { drift }, after: { repaired: drift.length } },
          m,
        );
      }
      return { checked, driftCount: drift.length, repaired: repair ? drift.length : 0, drift };
    });
  }
}

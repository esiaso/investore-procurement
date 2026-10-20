import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DocumentType, Paginated, SupplierStatus } from '@sil/shared';
import { decryptField, encryptField, mask } from '../../common/crypto';
import { likeTerm } from '../../common/pagination';
import { loadEnv } from '../../config/env';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import {
  ContractPriceDto,
  ContractPriceQueryDto,
  CreateSupplierDto,
  SupplierDocumentDto,
  SupplierQueryDto,
  SupplierStatusDto,
  UpdateSupplierDto,
} from './suppliers.dto';
import { ContractPrice, Supplier, SupplierContact, SupplierDocument } from './suppliers.entities';

@Injectable()
export class SuppliersService {
  private readonly key = loadEnv().dataEncryptionKey;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  async list(query: SupplierQueryDto): Promise<Paginated<Supplier>> {
    const qb = this.ds.getRepository(Supplier).createQueryBuilder('s').orderBy('s.name', 'ASC');
    if (query.search) qb.andWhere('(s.name ILIKE :q OR s.code ILIKE :q OR s.kra_pin ILIKE :q)', { q: likeTerm(query.search) });
    if (query.status) qb.andWhere('s.status = :st', { st: query.status });
    if (query.categoryId) qb.andWhere(':cat = ANY(s.category_ids)', { cat: query.categoryId });
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string, withBank = false): Promise<Supplier & { bankAccountNo?: string | null; expiringDocuments?: number }> {
    const qb = this.ds
      .getRepository(Supplier)
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.contacts', 'c')
      .leftJoinAndSelect('s.documents', 'd')
      .where('s.id = :id', { id });
    if (withBank) qb.addSelect('s.bankAccountEnc');
    const s = await qb.getOne();
    if (!s) throw new NotFoundException('Supplier not found');
    const { bankAccountEnc, ...rest } = s;
    return { ...rest, ...(withBank ? { bankAccountNo: bankAccountEnc ? decryptField(this.key, bankAccountEnc) : null } : {}) } as Supplier;
  }

  private applyBank(s: Supplier, accountNo: string | null | undefined): void {
    if (accountNo === undefined) return;
    s.bankAccountEnc = accountNo ? encryptField(this.key, accountNo.replace(/\s/g, '')) : null;
    s.bankAccountMasked = accountNo ? mask(accountNo) : null;
  }

  async create(dto: CreateSupplierDto): Promise<Supplier> {
    const id = await this.ds.transaction(async (m) => {
      const { contacts, bankAccountNo, ...rest } = dto;
      const s = m.create(Supplier, {
        ...rest,
        code: dto.code || (await this.numbering.next(DocumentType.SUPPLIER, { manager: m })),
        categoryIds: dto.categoryIds ?? [],
        contacts: (contacts ?? []).map((c) => m.create(SupplierContact, c)),
      });
      this.applyBank(s, bankAccountNo);
      return (await m.save(s)).id;
    });
    return this.get(id);
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<Supplier> {
    await this.ds.transaction(async (m) => {
      const s = await m.getRepository(Supplier).createQueryBuilder('s').addSelect('s.bankAccountEnc').where('s.id = :id', { id }).getOne();
      if (!s) throw new NotFoundException('Supplier not found');
      const { contacts, bankAccountNo, code: _code, ...rest } = dto;
      Object.assign(s, rest);
      this.applyBank(s, bankAccountNo);
      await m.save(s);
      if (contacts) {
        await m.delete(SupplierContact, { supplierId: id });
        await m.save(contacts.map((c) => m.create(SupplierContact, { ...c, supplierId: id })));
      }
    });
    return this.get(id);
  }

  async setStatus(id: string, dto: SupplierStatusDto): Promise<Supplier> {
    const repo = this.ds.getRepository(Supplier);
    const s = await repo.findOneBy({ id });
    if (!s) throw new NotFoundException('Supplier not found');
    if (dto.status !== SupplierStatus.ACTIVE && !dto.reason) throw new BadRequestException('A reason is required');
    s.status = dto.status;
    s.statusReason = dto.reason ?? null;
    await repo.save(s);
    return this.get(id);
  }

  async addDocument(supplierId: string, dto: SupplierDocumentDto): Promise<SupplierDocument> {
    await this.get(supplierId);
    const repo = this.ds.getRepository(SupplierDocument);
    return repo.save(repo.create({ ...dto, supplierId }));
  }

  async removeDocument(supplierId: string, docId: string): Promise<void> {
    const repo = this.ds.getRepository(SupplierDocument);
    const d = await repo.findOneBy({ id: docId, supplierId });
    if (!d) throw new NotFoundException('Document not found');
    await repo.remove(d);
  }

  /** Documents expiring within N days (or already expired), for alerts. */
  async expiringDocuments(days: number) {
    const today = await this.settings.today();
    return this.ds.query(
      `SELECT d.id, d.document_type AS "documentType", d.reference, to_char(d.expires_on, 'YYYY-MM-DD') AS "expiresOn",
              s.id AS "supplierId", s.name AS "supplierName"
         FROM supplier_document d JOIN supplier s ON s.id = d.supplier_id
        WHERE d.expires_on IS NOT NULL AND d.expires_on <= ($1::date + $2::int)
        ORDER BY d.expires_on`,
      [today, days],
    );
  }

  /**
   * Suppliers may be ordered from only when active and (if prequalification is
   * set) prequalified and not expired. Returns the reasons when not.
   */
  async eligibility(m: EntityManager, supplierId: string, onDate: string): Promise<string[]> {
    const s = await m.findOneBy(Supplier, { id: supplierId });
    if (!s) throw new NotFoundException('Supplier not found');
    const problems: string[] = [];
    if (s.status !== SupplierStatus.ACTIVE) problems.push(`Supplier is ${s.status.toLowerCase()}${s.statusReason ? `: ${s.statusReason}` : ''}`);
    if (s.prequalifiedUntil && s.prequalifiedUntil < onDate) problems.push(`Prequalification expired on ${s.prequalifiedUntil}`);
    return problems;
  }

  // ------------------------------------------------------------------ contract prices

  listPrices(query: ContractPriceQueryDto) {
    const qb = this.ds
      .getRepository(ContractPrice)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.item', 'item')
      .leftJoinAndSelect('p.supplier', 'supplier')
      .orderBy('item.name', 'ASC')
      .addOrderBy('p.validFrom', 'DESC');
    if (query.supplierId) qb.andWhere('p.supplier_id = :s', { s: query.supplierId });
    if (query.itemId) qb.andWhere('p.item_id = :i', { i: query.itemId });
    if (query.on) qb.andWhere('p.valid_from <= :on AND (p.valid_to IS NULL OR p.valid_to >= :on)', { on: query.on });
    return qb.getMany();
  }

  async addPrice(supplierId: string, dto: ContractPriceDto): Promise<ContractPrice> {
    await this.get(supplierId);
    const repo = this.ds.getRepository(ContractPrice);
    const overlap = await repo
      .createQueryBuilder('p')
      .where('p.supplier_id = :s AND p.item_id = :i', { s: supplierId, i: dto.itemId })
      .andWhere('(p.valid_to IS NULL OR p.valid_to >= :from)', { from: dto.validFrom })
      .andWhere(dto.validTo ? 'p.valid_from <= :to' : '1=1', { to: dto.validTo })
      .getOne();
    if (overlap) throw new BadRequestException(`Overlaps the contract price valid from ${overlap.validFrom}`);
    return repo.save(repo.create({ ...dto, supplierId, validTo: dto.validTo ?? null, contractRef: dto.contractRef ?? null }));
  }

  /**
   * Contract price in force for supplier × item on a date: an active contract or
   * framework agreement (slice 7) first, then the simple contract price list.
   */
  async priceOn(m: EntityManager, supplierId: string, itemId: string, on: string): Promise<{ unitPrice: number; contractRef: string | null; contractLineId: string | null } | null> {
    const [line] = await m.query(
      `SELECT cl.id, cl.unit_price::float AS unit_price, c.number FROM contract_line cl JOIN contract c ON c.id = cl.contract_id
        WHERE c.supplier_id = $1 AND cl.item_id = $2 AND c.status = 'ACTIVE' AND c.start_date <= $3 AND c.end_date >= $3
        ORDER BY c.end_date DESC LIMIT 1`,
      [supplierId, itemId, on],
    );
    if (line) return { unitPrice: line.unit_price, contractRef: line.number, contractLineId: line.id };
    const p = await m
      .getRepository(ContractPrice)
      .createQueryBuilder('p')
      .where('p.supplier_id = :s AND p.item_id = :i', { s: supplierId, i: itemId })
      .andWhere('p.valid_from <= :on AND (p.valid_to IS NULL OR p.valid_to >= :on)', { on })
      .getOne();
    return p ? { unitPrice: p.unitPrice, contractRef: p.contractRef, contractLineId: null } : null;
  }

  /** Performance figures are computed by purchasing from posted GRNs. */
  async updatePerformance(
    m: EntityManager,
    supplierId: string,
    stats: { grnCount: number; onTimeDeliveryRate: number | null; qualityRejectRate: number | null; avgPriceVariancePct: number | null },
  ): Promise<void> {
    const s = await m.findOneBy(Supplier, { id: supplierId });
    if (!s) return;
    Object.assign(s, stats);
    await m.save(s);
  }
}
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CustomerLedgerType, DocumentType, Paginated, Permissions, PosEventType, PosShiftStatus, SessionUser } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import { round2 } from '../billing/tax-calc';
import { NumberingService } from '../numbering/numbering.service';
import { AccountPaymentDto, CustomerDto, CustomerQueryDto, PromotionDto, TerminalDto } from './pos.dto';
import { Customer, CustomerLedger, PosEvent, PosPromotion, PosShift, PosTerminal } from './pos.entities';

/** Tills, promotions, customers and customer accounts. */
@Injectable()
export class PosAdminService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
  ) {}

  // ------------------------------------------------------------------ tills

  terminals() {
    const qb = this.ds.getRepository(PosTerminal).createQueryBuilder('t').leftJoinAndSelect('t.store', 'store').leftJoinAndSelect('t.defaultPriceList', 'priceList').orderBy('t.code');
    StoreScope.apply(qb, 't.store_id');
    return qb.getMany();
  }

  async saveTerminal(id: string | null, dto: TerminalDto) {
    const repo = this.ds.getRepository(PosTerminal);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Till not found');
    const [store] = await this.ds.query(`SELECT id FROM store WHERE id = $1 AND is_active`, [dto.storeId]);
    if (!store) throw new BadRequestException('Store not found');
    Object.assign(row, { code: dto.code, name: dto.name, storeId: dto.storeId, defaultPriceListId: dto.defaultPriceListId ?? null, isActive: dto.isActive ?? true });
    return repo.save(row);
  }

  // ------------------------------------------------------------------ promotions

  promotions() {
    return this.ds.getRepository(PosPromotion).find({ relations: { item: true, category: true }, order: { startsOn: 'DESC' } });
  }

  async savePromotion(id: string | null, dto: PromotionDto) {
    if (!dto.itemId === !dto.categoryId) throw new BadRequestException('A promotion is for one item or one category');
    if (dto.endsOn < dto.startsOn) throw new BadRequestException('The promotion ends before it starts');
    const repo = this.ds.getRepository(PosPromotion);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Promotion not found');
    Object.assign(row, { ...dto, itemId: dto.itemId ?? null, categoryId: dto.categoryId ?? null, minQty: dto.minQty ?? 1, isActive: dto.isActive ?? true });
    return repo.save(row);
  }

  // ------------------------------------------------------------------ customers

  async customers(q: CustomerQueryDto): Promise<Paginated<Customer & { balance: number }>> {
    const qb = this.ds.getRepository(Customer).createQueryBuilder('c').leftJoinAndSelect('c.priceList', 'priceList').orderBy('c.name');
    if (q.search) qb.andWhere('(c.name ILIKE :q OR c.phone ILIKE :q OR c.code ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb
      .skip((q.page - 1) * q.pageSize)
      .take(q.pageSize)
      .getManyAndCount();
    const balances: { customer_id: string; balance: number }[] = items.length
      ? await this.ds.query(`SELECT customer_id, SUM(amount)::float AS balance FROM customer_ledger WHERE customer_id = ANY($1::uuid[]) GROUP BY customer_id`, [items.map((i) => i.id)])
      : [];
    return { items: items.map((c) => ({ ...c, balance: balances.find((b) => b.customer_id === c.id)?.balance ?? 0 })), total, page: q.page, pageSize: q.pageSize };
  }

  async saveCustomer(id: string | null, dto: CustomerDto, actor: SessionUser) {
    const repo = this.ds.getRepository(Customer);
    const row = id ? await repo.findOneBy({ id }) : repo.create({ code: await this.numbering.next(DocumentType.CUSTOMER) });
    if (!row) throw new NotFoundException('Customer not found');
    // Credit terms are set by managers; cashiers capture contact details.
    const credit = dto.creditAllowed !== undefined || dto.creditLimit !== undefined;
    if (credit && !actor.permissions.includes(Permissions.POS_MANAGE)) throw new BadRequestException('Credit terms are set by a manager');
    const phone = dto.phone?.trim() || null;
    if (phone) {
      const other = await repo.findOneBy({ phone });
      if (other && other.id !== row.id) throw new ConflictException(`${phone} belongs to ${other.name} (${other.code})`);
    }
    Object.assign(row, {
      name: dto.name,
      phone,
      kraPin: dto.kraPin ?? row.kraPin ?? null,
      priceListId: dto.priceListId ?? row.priceListId ?? null,
      patientId: dto.patientId ?? row.patientId ?? null,
      isActive: dto.isActive ?? row.isActive ?? true,
      ...(credit ? { creditAllowed: dto.creditAllowed ?? row.creditAllowed, creditLimit: dto.creditLimit ?? row.creditLimit } : {}),
    });
    return repo.save(row);
  }

  /** Account statement: entries with running balance. */
  async statement(id: string) {
    const c = await this.ds.getRepository(Customer).findOne({ where: { id }, relations: { priceList: true } });
    if (!c) throw new NotFoundException('Customer not found');
    const entries: { id: string; type: string; amount: number; reference: string | null; at: Date; balance: number }[] = await this.ds.query(
      `SELECT id, type, amount::float, reference, at, SUM(amount) OVER (ORDER BY at, id)::float AS balance FROM customer_ledger WHERE customer_id = $1 ORDER BY at, id`,
      [id],
    );
    return { customer: c, balance: entries.at(-1)?.balance ?? 0, entries };
  }

  /** Payment on account (cash taken at a till counts in that shift). */
  async accountPayment(id: string, dto: AccountPaymentDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const c = await m.findOne(Customer, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw new NotFoundException('Customer not found');
      const [{ balance }] = await m.query(`SELECT COALESCE(SUM(amount), 0)::float AS balance FROM customer_ledger WHERE customer_id = $1`, [id]);
      if (dto.amount > balance + 0.001) throw new BadRequestException(`${c.name} owes ${round2(balance)}`);
      if (dto.modeCode !== 'CASH' && !dto.reference?.trim()) throw new BadRequestException('Give the M-Pesa code or card slip number');
      await m.save(m.create(CustomerLedger, { customerId: id, type: CustomerLedgerType.PAYMENT, amount: -dto.amount, reference: dto.reference?.trim() || dto.modeCode, userId: actor.id }));
      const shift = dto.terminalId ? await m.findOneBy(PosShift, { terminalId: dto.terminalId, cashierId: actor.id, status: PosShiftStatus.OPEN }) : null;
      if (dto.terminalId && !shift) throw new ConflictException('Open a shift on this till to take the payment');
      await m.save(m.create(PosEvent, { type: PosEventType.ACCOUNT_PAYMENT, shiftId: shift?.id ?? null, terminalId: dto.terminalId ?? null, userId: actor.id, amount: dto.amount, reason: c.code, details: { modeCode: dto.modeCode, customerId: id, reference: dto.reference ?? null } }));
    });
    return this.statement(id);
  }
}

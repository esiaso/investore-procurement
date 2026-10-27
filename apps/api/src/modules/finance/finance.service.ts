import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import { GlAccountType, Paginated } from '@sil/shared';
import { likeTerm } from '../../common/pagination';
import { AccountingService } from '../accounting/accounting.service';
import { SettingsService } from '../settings/settings.service';
import { CurrencyDto, ExchangeRateDto, GlAccountDto, GlAccountQueryDto, ProjectDto } from './finance.dto';
import { Currency, ExchangeRate, GlAccount, Project } from './finance.entities';

/** QuickBooks AccountType → local type. */
const QBO_TYPES: Record<string, GlAccountType> = {
  Expense: GlAccountType.EXPENSE,
  'Other Expense': GlAccountType.EXPENSE,
  'Cost of Goods Sold': GlAccountType.COST_OF_SALES,
  'Fixed Asset': GlAccountType.ASSET,
  'Other Asset': GlAccountType.ASSET,
  'Other Current Asset': GlAccountType.ASSET,
  'Accounts Receivable': GlAccountType.ASSET,
  Bank: GlAccountType.BANK,
  'Accounts Payable': GlAccountType.LIABILITY,
  'Credit Card': GlAccountType.LIABILITY,
  'Other Current Liability': GlAccountType.LIABILITY,
  'Long Term Liability': GlAccountType.LIABILITY,
  Equity: GlAccountType.EQUITY,
  Income: GlAccountType.INCOME,
  'Other Income': GlAccountType.INCOME,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Chart of accounts, projects, currencies and exchange rates. */
@Injectable()
export class FinanceService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly accounting: AccountingService,
  ) {}

  // ------------------------------------------------------------------ GL accounts

  async glAccounts(q: GlAccountQueryDto): Promise<Paginated<GlAccount>> {
    const qb = this.ds.getRepository(GlAccount).createQueryBuilder('a').orderBy('a.code');
    if (q.type) qb.andWhere('a.type = :t', { t: q.type });
    if (q.active !== undefined) qb.andWhere('a.is_active = :a', { a: q.active });
    if (q.search) qb.andWhere('(a.code ILIKE :q OR a.name ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async saveGlAccount(id: string | null, dto: GlAccountDto) {
    const repo = this.ds.getRepository(GlAccount);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('GL account not found');
    const clash = await repo.findOneBy({ code: dto.code });
    if (clash && clash.id !== row.id) throw new ConflictException(`GL account ${dto.code} exists`);
    if (dto.parentId && dto.parentId === row.id) throw new BadRequestException('An account cannot be its own parent');
    Object.assign(row, { ...dto, parentId: dto.parentId ?? null, description: dto.description ?? null, qboAccountId: dto.qboAccountId ?? null, isActive: dto.isActive ?? true });
    return repo.save(row);
  }

  /** An active GL account (for coding documents). */
  async assertGlAccount(m: EntityManager, id: string): Promise<GlAccount> {
    const a = await m.findOneBy(GlAccount, { id });
    if (!a || !a.isActive) throw new BadRequestException('GL account not found or inactive');
    return a;
  }

  /**
   * Imports the chart of accounts from the connected QuickBooks company: new
   * accounts are added, names and types of known ones refreshed (code = the
   * QuickBooks account number, else its id).
   */
  async importFromQuickBooks() {
    const { accounts } = await this.accounting.lists();
    const repo = this.ds.getRepository(GlAccount);
    let added = 0;
    let updated = 0;
    for (const a of accounts as { id: string; name: string; AccountType?: string; AcctNum?: string }[]) {
      const type = QBO_TYPES[a.AccountType ?? ''] ?? GlAccountType.EXPENSE;
      const existing = (await repo.findOneBy({ qboAccountId: a.id })) ?? (await repo.findOneBy({ code: a.AcctNum ?? `QB-${a.id}`, qboAccountId: IsNull() }));
      if (existing) {
        Object.assign(existing, { name: a.name, type, qboAccountId: a.id });
        await repo.save(existing);
        updated++;
      } else {
        await repo.save(repo.create({ code: a.AcctNum ?? `QB-${a.id}`, name: a.name, type, qboAccountId: a.id, isActive: true }));
        added++;
      }
    }
    const linked = await repo.count({ where: { qboAccountId: Not(IsNull()) } });
    return { added, updated, linked };
  }

  // ------------------------------------------------------------------ projects

  projects(activeOnly = false) {
    return this.ds.getRepository(Project).find({ where: activeOnly ? { isActive: true } : {}, relations: { department: true }, order: { code: 'ASC' } });
  }

  async saveProject(id: string | null, dto: ProjectDto) {
    const repo = this.ds.getRepository(Project);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Project not found');
    const clash = await repo.findOneBy({ code: dto.code });
    if (clash && clash.id !== row.id) throw new ConflictException(`Project ${dto.code} exists`);
    if (dto.startsOn && dto.endsOn && dto.endsOn < dto.startsOn) throw new BadRequestException('The project ends before it starts');
    Object.assign(row, { ...dto, departmentId: dto.departmentId ?? null, startsOn: dto.startsOn ?? null, endsOn: dto.endsOn ?? null, budget: dto.budget ?? null, isActive: dto.isActive ?? true });
    return repo.save(row);
  }

  async assertProject(m: EntityManager, id: string, onDate: string): Promise<Project> {
    const p = await m.findOneBy(Project, { id });
    if (!p || !p.isActive) throw new BadRequestException('Project not found or inactive');
    if ((p.startsOn && onDate < p.startsOn) || (p.endsOn && onDate > p.endsOn)) throw new BadRequestException(`Project ${p.code} is not open on ${onDate}`);
    return p;
  }

  // ------------------------------------------------------------------ currencies and rates

  async currencies() {
    const base = await this.settings.get('locale.currency');
    const rows = await this.ds.getRepository(Currency).find({ order: { code: 'ASC' } });
    const latest: { currency_code: string; rate: number; rate_date: string }[] = await this.ds.query(
      `SELECT DISTINCT ON (currency_code) currency_code, rate::float, rate_date::text FROM exchange_rate ORDER BY currency_code, rate_date DESC`,
    );
    return rows.map((c) => ({ ...c, isBase: c.code === base, latestRate: c.code === base ? 1 : (latest.find((l) => l.currency_code === c.code) ?? null) }));
  }

  async saveCurrency(dto: CurrencyDto) {
    const repo = this.ds.getRepository(Currency);
    const row = (await repo.findOneBy({ code: dto.code })) ?? repo.create({ code: dto.code });
    Object.assign(row, { name: dto.name, isActive: dto.isActive ?? true });
    return repo.save(row);
  }

  rates(currency?: string) {
    return this.ds.getRepository(ExchangeRate).find({ where: currency ? { currencyCode: currency } : {}, order: { rateDate: 'DESC', currencyCode: 'ASC' }, take: 500 });
  }

  async saveRate(dto: ExchangeRateDto) {
    const base = await this.settings.get('locale.currency');
    if (dto.currencyCode === base) throw new BadRequestException(`${base} is the base currency (rate 1)`);
    const cur = await this.ds.getRepository(Currency).findOneBy({ code: dto.currencyCode });
    if (!cur?.isActive) throw new BadRequestException(`Currency ${dto.currencyCode} is not set up`);
    const repo = this.ds.getRepository(ExchangeRate);
    const row = (await repo.findOneBy({ currencyCode: dto.currencyCode, rateDate: dto.rateDate })) ?? repo.create({ currencyCode: dto.currencyCode, rateDate: dto.rateDate });
    Object.assign(row, { rate: dto.rate, source: dto.source ?? null });
    return repo.save(row);
  }

  /** Base-currency value of one unit on a date: the latest rate on or before it. */
  async rateOn(m: EntityManager, currency: string, date: string): Promise<number> {
    const base = await this.settings.get('locale.currency', m);
    if (currency === base) return 1;
    const [r] = await m.query(`SELECT rate::float FROM exchange_rate WHERE currency_code = $1 AND rate_date <= $2::date ORDER BY rate_date DESC LIMIT 1`, [currency, date]);
    if (!r) throw new BadRequestException({ code: 'NO_EXCHANGE_RATE', message: `No ${currency} exchange rate on or before ${date}` });
    return r.rate;
  }

  async toBase(m: EntityManager, amount: number, currency: string, date: string): Promise<{ amount: number; rate: number }> {
    const rate = await this.rateOn(m, currency, date);
    return { amount: round2(amount * rate), rate };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { BudgetEnforcement, BudgetEntryType } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { financialYearOf } from '../numbering/financial-year';
import { SettingsService } from '../settings/settings.service';
import { Budget, BudgetEntry } from './budgets.entities';

export interface BudgetPosition {
  id: string;
  departmentId: string;
  departmentName: string;
  voteHead: string;
  financialYear: string;
  amount: number;
  committed: number;
  actual: number;
  available: number;
  enforcement: BudgetEnforcement;
}

export interface BudgetCheck {
  ok: boolean;
  /** True when over budget and enforcement is BLOCK. */
  blocked: boolean;
  available: number;
  message: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class BudgetsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async currentFinancialYear(m?: EntityManager): Promise<string> {
    const today = await this.settings.today(m);
    return financialYearOf(today, await this.settings.get('finance.fyStartMonth', m)).label;
  }

  async positions(filter: { departmentId?: string; financialYear?: string } = {}, m?: EntityManager): Promise<BudgetPosition[]> {
    const params: unknown[] = [];
    const where: string[] = ['b.is_active'];
    if (filter.departmentId) where.push(`b.department_id = $${params.push(filter.departmentId)}`);
    if (filter.financialYear) where.push(`b.financial_year = $${params.push(filter.financialYear)}`);
    return (m ?? this.ds.manager).query(
      `SELECT b.id, b.department_id AS "departmentId", d.name AS "departmentName", b.vote_head AS "voteHead",
              b.description, b.financial_year AS "financialYear", b.amount::float AS amount, b.enforcement,
              COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type IN ('COMMITMENT', 'RELEASE')), 0)::float AS committed,
              COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'ACTUAL'), 0)::float AS actual,
              (b.amount - COALESCE(SUM(e.amount), 0))::float AS available
         FROM budget b JOIN department d ON d.id = b.department_id
         LEFT JOIN budget_entry e ON e.budget_id = b.id
        WHERE ${where.join(' AND ')}
        GROUP BY b.id, d.name
        ORDER BY d.name, b.vote_head`,
      params,
    );
  }

  async position(budgetId: string, m?: EntityManager): Promise<BudgetPosition> {
    const [p] = (await this.positions({}, m)).filter((x) => x.id === budgetId);
    if (!p) throw new NotFoundException('Budget not found or inactive');
    return p;
  }

  /** Whether `amount` more can be committed. */
  async check(m: EntityManager, budgetId: string, amount: number): Promise<BudgetCheck> {
    // Serialise checks on the same budget so two approvals cannot both use the last shilling.
    await m.query(`SELECT id FROM budget WHERE id = $1 FOR UPDATE`, [budgetId]);
    const p = await this.position(budgetId, m);
    if (amount <= p.available) return { ok: true, blocked: false, available: p.available, message: null };
    const message = `Exceeds budget ${p.voteHead} (${p.departmentName}, FY ${p.financialYear}): available ${round2(p.available)}, needed ${round2(amount)}`;
    return { ok: false, blocked: p.enforcement === BudgetEnforcement.BLOCK, available: p.available, message };
  }

  async entry(m: EntityManager, budgetId: string, type: BudgetEntryType, amount: number, doc: { type: string; id: string; no: string }): Promise<void> {
    if (round2(amount) === 0) return;
    await m.getRepository(BudgetEntry).insert({
      budgetId,
      entryType: type,
      amount: round2(amount),
      sourceDocType: doc.type,
      sourceDocId: doc.id,
      sourceDocNo: doc.no,
      userId: RequestContext.get()?.userId ?? null,
    });
  }

  /** Commitment still open for a document (Σ commitment + releases). */
  async openCommitment(m: EntityManager, budgetId: string, docType: string, docId: string): Promise<number> {
    const [r] = await m.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS open FROM budget_entry
        WHERE budget_id = $1 AND source_doc_type = $2 AND source_doc_id = $3 AND entry_type IN ('COMMITMENT', 'RELEASE')`,
      [budgetId, docType, docId],
    );
    return r.open;
  }

  entries(budgetId: string) {
    return this.ds.getRepository(BudgetEntry).find({ where: { budgetId }, order: { postedAt: 'DESC' }, take: 500 });
  }

  async create(dto: Partial<Budget>): Promise<Budget> {
    if (!dto.financialYear) dto.financialYear = await this.currentFinancialYear();
    const repo = this.ds.getRepository(Budget);
    return repo.save(repo.create(dto));
  }

  async update(id: string, dto: Partial<Budget>): Promise<Budget> {
    const repo = this.ds.getRepository(Budget);
    const b = await repo.findOneBy({ id });
    if (!b) throw new NotFoundException('Budget not found');
    if (dto.amount !== undefined) {
      const p = await this.position(id);
      if (dto.amount < p.committed + p.actual) throw new BadRequestException('Amount is below what is already committed and spent');
    }
    const { departmentId: _d, financialYear: _f, voteHead: _v, ...rest } = dto;
    return repo.save(Object.assign(b, rest));
  }
}

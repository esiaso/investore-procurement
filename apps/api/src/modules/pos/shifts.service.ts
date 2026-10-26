import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DocumentType, Permissions, PosShiftStatus, SessionUser, VarianceStatus } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { round2 } from '../billing/tax-calc';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { CloseShiftDto, OpenShiftDto, VarianceDecisionDto } from './pos.dto';
import { PosShift, PosTerminal } from './pos.entities';

/**
 * Cashier shifts: opening float, X report (running totals, any time), cash-up
 * with the Z report (expected vs counted cash), and the supervisor's decision
 * on a variance outside pos.varianceTolerance.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  async open(dto: OpenShiftDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const t = await m.findOne(PosTerminal, { where: { id: dto.terminalId }, lock: { mode: 'pessimistic_write' } });
      if (!t || !t.isActive) throw new NotFoundException('Till not found or inactive');
      StoreScope.assert(t.storeId);
      const onTill = await m.findOneBy(PosShift, { terminalId: t.id, status: PosShiftStatus.OPEN });
      if (onTill) throw new ConflictException(onTill.cashierId === actor.id ? 'You already have this till open' : 'Another cashier has this till open');
      const mine = await m.findOneBy(PosShift, { cashierId: actor.id, status: PosShiftStatus.OPEN });
      if (mine) throw new ConflictException('Close your shift on the other till first');
      const s = await m.save(
        m.create(PosShift, {
          number: await this.numbering.next(DocumentType.POS_SHIFT, { storeId: t.storeId, manager: m }),
          terminalId: t.id,
          storeId: t.storeId,
          cashierId: actor.id,
          openingFloat: dto.openingFloat,
          status: PosShiftStatus.OPEN,
        }),
      );
      return s.id;
    });
    return this.get(id);
  }

  /** The cashier's open shift on a till, or null. */
  async current(terminalId: string, actor: SessionUser) {
    const s = await this.ds.getRepository(PosShift).findOneBy({ terminalId, cashierId: actor.id, status: PosShiftStatus.OPEN });
    return s ? this.get(s.id) : null;
  }

  async get(id: string) {
    const s = await this.ds.getRepository(PosShift).findOne({ where: { id }, relations: { terminal: { store: true } } });
    if (!s) throw new NotFoundException('Shift not found');
    StoreScope.assert(s.storeId);
    const [cashier] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [s.cashierId]);
    return { ...s, cashierName: cashier?.full_name ?? null, report: s.status === PosShiftStatus.OPEN ? await this.report(this.ds.manager, s) : s.zReport };
  }

  list(q: { storeId?: string; status?: string; varianceStatus?: string; from?: string; to?: string }) {
    const params: unknown[] = [];
    const where: string[] = [];
    const allowed = StoreScope.current();
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.storeId) add('s.store_id = ?', q.storeId);
    if (allowed !== null) add('s.store_id = ANY(?::uuid[])', allowed);
    if (q.status) add('s.status = ?', q.status);
    if (q.varianceStatus) add('s.variance_status = ?', q.varianceStatus);
    if (q.from) add('s.opened_at >= ?::date', q.from);
    if (q.to) add('s.opened_at < ?::date + 1', q.to);
    return this.ds.query(
      `SELECT s.id, s.number, s.status, s.opened_at AS "openedAt", s.closed_at AS "closedAt", s.opening_float::float AS "openingFloat", s.expected_cash::float AS "expectedCash",
              s.counted_cash::float AS "countedCash", s.variance::float AS variance, s.variance_status AS "varianceStatus", t.code AS terminal, u.full_name AS cashier,
              (SELECT COALESCE(SUM(ps.total), 0)::float FROM pos_sale ps WHERE ps.shift_id = s.id AND ps.status <> 'VOIDED') AS sales
         FROM pos_shift s JOIN pos_terminal t ON t.id = s.terminal_id JOIN app_user u ON u.id = s.cashier_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.opened_at DESC LIMIT 500`,
      params,
    );
  }

  /**
   * Shift totals: sales by payment mode (amounts kept, after change),
   * voids and refunds (and how they were paid out), discounts, account
   * payments taken, M-Pesa codes not yet confirmed, expected cash.
   */
  async report(m: EntityManager, s: PosShift) {
    const byMode: { mode: string; amount: number; sales: number }[] = await m.query(
      `SELECT sp.mode_code AS mode, SUM(sp.amount)::float AS amount, COUNT(DISTINCT ps.id)::int AS sales
         FROM pos_sale ps JOIN sales_payment sp ON sp.invoice_id = ps.invoice_id WHERE ps.shift_id = $1 GROUP BY sp.mode_code ORDER BY sp.mode_code`,
      [s.id],
    );
    const [sales] = await m.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0)::float AS gross, COALESCE(SUM(discount_amount), 0)::float AS discounts,
              COUNT(*) FILTER (WHERE offline)::int AS offline, COALESCE(SUM(points_redeemed), 0)::int AS "pointsRedeemed"
         FROM pos_sale WHERE shift_id = $1`,
      [s.id],
    );
    const events: { type: string; count: number; amount: number; cash: number }[] = await m.query(
      `SELECT type, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount,
              COALESCE(SUM(amount) FILTER (WHERE details->>'modeCode' = 'CASH'), 0)::float AS cash
         FROM pos_event WHERE shift_id = $1 GROUP BY type`,
      [s.id],
    );
    const ev = (t: string) => events.find((e) => e.type === t) ?? { count: 0, amount: 0, cash: 0 };
    const unverified = await m.query(
      `SELECT receipt_no AS "receiptNo", amount::float FROM mpesa_transaction WHERE shift_id = $1 AND method = 'MANUAL' AND NOT verified ORDER BY created_at`,
      [s.id],
    );
    const cashSales = byMode.find((x) => x.mode === 'CASH')?.amount ?? 0;
    const expectedCash = round2(s.openingFloat + cashSales + ev('ACCOUNT_PAYMENT').cash - ev('VOID_SALE').cash - ev('REFUND').cash);
    return {
      shift: s.number,
      openingFloat: s.openingFloat,
      sales: { count: sales.count, gross: sales.gross, discounts: sales.discounts, offline: sales.offline, pointsRedeemed: sales.pointsRedeemed },
      byMode,
      voids: { count: ev('VOID_SALE').count, amount: ev('VOID_SALE').amount, cash: ev('VOID_SALE').cash, lineVoids: ev('VOID_LINE').count },
      refunds: { count: ev('REFUND').count, amount: ev('REFUND').amount, cash: ev('REFUND').cash },
      accountPayments: { count: ev('ACCOUNT_PAYMENT').count, amount: ev('ACCOUNT_PAYMENT').amount, cash: ev('ACCOUNT_PAYMENT').cash },
      overrides: { discounts: ev('DISCOUNT_OVERRIDE').count, pharmacist: ev('PHARMACIST_APPROVAL').count, interactions: ev('INTERACTION_OVERRIDE').count },
      unverifiedMpesa: unverified,
      expectedCash,
      at: new Date().toISOString(),
    };
  }

  /** Cash-up: Z report frozen on the shift; a variance outside the tolerance waits for a supervisor. */
  async close(id: string, dto: CloseShiftDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const s = await m.findOne(PosShift, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('Shift not found');
      StoreScope.assert(s.storeId);
      if (s.status !== PosShiftStatus.OPEN) throw new ConflictException('Shift is already closed');
      if (s.cashierId !== actor.id && !actor.permissions.includes(Permissions.POS_APPROVE_VARIANCE)) throw new ForbiddenException('Only the cashier (or a supervisor) can close this shift');
      if (dto.denominations) {
        const sum = round2(Object.entries(dto.denominations).reduce((t, [d, n]) => t + Number(d) * Number(n), 0));
        if (Math.abs(sum - dto.countedCash) > 0.005) throw new BadRequestException(`The denominations add up to ${sum}, not ${dto.countedCash}`);
      }
      const z = await this.report(m, s);
      const variance = round2(dto.countedCash - z.expectedCash);
      const tolerance = await this.settings.get('pos.varianceTolerance', m);
      Object.assign(s, {
        status: PosShiftStatus.CLOSED,
        closedAt: new Date(),
        countedCash: dto.countedCash,
        denominations: dto.denominations ?? null,
        expectedCash: z.expectedCash,
        variance,
        varianceStatus: Math.abs(variance) <= tolerance ? VarianceStatus.NONE : VarianceStatus.PENDING,
        closeNote: dto.note ?? null,
        zReport: { ...z, countedCash: dto.countedCash, variance, closedAt: new Date().toISOString(), closedBy: actor.fullName },
      });
      await m.save(s);
    });
    return this.get(id);
  }

  /** Sales of a shift, newest first (void / refund at the till). */
  async sales(id: string) {
    const s = await this.ds.getRepository(PosShift).findOneBy({ id });
    if (!s) throw new NotFoundException('Shift not found');
    StoreScope.assert(s.storeId);
    return this.ds.query(
      `SELECT ps.id, ps.status, ps.total::float, ps.sold_at AS "soldAt", ps.offline, si.number AS "invoiceNo", si.etims_status AS "etimsStatus", c.name AS customer
         FROM pos_sale ps JOIN sales_invoice si ON si.id = ps.invoice_id LEFT JOIN customer c ON c.id = ps.customer_id
        WHERE ps.shift_id = $1 ORDER BY ps.sold_at DESC LIMIT 200`,
      [id],
    );
  }

  async decide(id: string, dto: VarianceDecisionDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const s = await m.findOne(PosShift, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('Shift not found');
      StoreScope.assert(s.storeId);
      if (s.varianceStatus !== VarianceStatus.PENDING) throw new ConflictException('No variance awaits a decision');
      if (s.cashierId === actor.id) throw new ForbiddenException('The cashier cannot approve their own variance');
      Object.assign(s, { varianceStatus: dto.approve ? VarianceStatus.APPROVED : VarianceStatus.REJECTED, decidedBy: actor.id, decidedAt: new Date(), decisionNote: dto.note });
      await m.save(s);
    });
    return this.get(id);
  }
}

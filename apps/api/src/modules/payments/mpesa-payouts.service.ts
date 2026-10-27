import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { DocumentType, PaymentMethod, PaymentVoucherStatus, PayoutAttemptStatus, SessionUser } from '@sil/shared';
import { loadEnv } from '../../config/env';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { PaymentVoucher } from '../purchasing/purchasing.entities';
import { SettingsService } from '../settings/settings.service';
import { GatewayConfigError, PaymentGateway, PayoutResult } from './gateway';
import { DarajaPayoutGateway, parsePayoutResult, sharedMockPayouts, statusFromResult } from './mpesa-payouts';
import { MpesaPayout } from './payments.entities';
import { PaymentsService } from './payments.service';
import { commandFor, maskPhone } from './payout-rules';

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const nairobiDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Sends approved vouchers through M-PESA (Part C). A voucher is never paid
 * twice: one attempt at a time (row lock + a unique index on live / successful
 * attempts), a fresh OriginatorConversationID per attempt, and a request
 * whose outcome is unknown is never sent again before M-PESA has been asked
 * what became of it. Callbacks are idempotent.
 */
@Injectable()
export class MpesaPayoutsService implements OnModuleInit {
  private readonly log = new Logger('M-PESA payouts');
  private gatewayInstance: PaymentGateway | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly payments: PaymentsService,
    private readonly approvals: ApprovalsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.payments.useDispatcher((id, actor) => this.dispatch(id, actor));
    // The simulator delivers its callbacks in process.
    sharedMockPayouts.deliver = async (kind, id, body) => {
      if (kind === 'reversal') await this.reversalResult(id, body);
      else await this.applyCallback(kind, body);
    };
    this.jobs.register('payments.mpesaFollowUp', 'Ask M-PESA about payouts with no result yet; retry those never processed, else send them to review', () => this.followUp());
  }

  /** The configured gateway (mock unless MPESA_PAYOUT_MODE is sandbox / production). */
  gateway(): PaymentGateway {
    if (this.gatewayInstance) return this.gatewayInstance;
    const c = loadEnv().mpesaPayout;
    if (c.mode === 'mock') return (this.gatewayInstance = sharedMockPayouts);
    const base = `${(c.callbackBaseUrl ?? '').replace(/\/+$/, '')}/api/v1/callbacks/mpesa-payouts`;
    const t = c.callbackToken ?? '';
    this.gatewayInstance = new DarajaPayoutGateway(c, {
      result: `${base}/result/${t}`,
      timeout: `${base}/timeout/${t}`,
      status: (id) => `${base}/status/${t}/${id}`,
      reversal: (id) => `${base}/reversal/${t}/${id}`,
    });
    return this.gatewayInstance;
  }

  // ------------------------------------------------------------------ dispatch

  /** Called by PaymentsService.release once approvals and segregation of duties are checked. */
  async dispatch(voucherId: string, actor: SessionUser): Promise<void> {
    let gateway: PaymentGateway;
    try {
      gateway = this.gateway();
    } catch (e) {
      if (e instanceof GatewayConfigError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
    const payout = await this.ds.transaction(async (m) => {
      const v = await this.payments.lock(m, voucherId);
      if (![PaymentVoucherStatus.APPROVED, PaymentVoucherStatus.FAILED].includes(v.status)) throw new ConflictException({ code: 'NOT_APPROVED', message: `Voucher is ${v.status}` });
      if (!(await this.approvals.isApproved(m, DocumentType.PAYMENT_VOUCHER, voucherId))) throw new ConflictException({ code: 'NOT_APPROVED', message: 'Every approval level must be complete' });
      return this.newAttempt(m, v, actor.id);
    });
    await this.send(gateway, payout);
  }

  /** Records the attempt before anything is sent (the voucher row is locked by the caller). */
  private async newAttempt(m: EntityManager, v: PaymentVoucher, releasedBy: string | null): Promise<MpesaPayout> {
    const live = await m.findOne(MpesaPayout, { where: { voucherId: v.id, status: In([PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN, PayoutAttemptStatus.SUCCESS]) } });
    if (live) throw new ConflictException({ code: 'ALREADY_DISPATCHED', message: `${v.number} has already been sent to M-PESA (${live.status})` });
    const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM mpesa_payout WHERE voucher_id = $1`, [v.id]);
    const method = v.method as PaymentMethod;
    const p = m.create(MpesaPayout, {
      voucherId: v.id,
      attempt: n + 1,
      commandId: commandFor(method),
      originatorConversationId: `${v.number.replace(/[^A-Za-z0-9]/g, '')}-${n + 1}-${randomBytes(6).toString('hex')}`,
      partyB: method === PaymentMethod.MPESA_B2C ? v.payeePhone! : v.payeeShortcode!,
      accountRef: v.payeeAccountRef,
      amount: v.amount,
      status: PayoutAttemptStatus.PENDING,
      releasedBy,
    });
    try {
      await m.save(p);
    } catch (e) {
      // The unique index on live attempts: someone else dispatched it a moment ago.
      if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'ALREADY_DISPATCHED', message: `${v.number} has already been sent to M-PESA` });
      throw e;
    }
    v.status = PaymentVoucherStatus.PROCESSING;
    if (releasedBy) {
      v.releasedBy = releasedBy;
      v.releasedAt = new Date();
    }
    await m.save(v);
    return p;
  }

  private async send(gateway: PaymentGateway, p: MpesaPayout): Promise<void> {
    const v = await this.ds.getRepository(PaymentVoucher).findOneByOrFail({ id: p.voucherId });
    const answer = await gateway.dispatch({
      originatorConversationId: p.originatorConversationId,
      method: v.method as PaymentMethod,
      commandId: p.commandId,
      amount: p.amount,
      partyB: p.partyB,
      accountRef: p.accountRef,
      remarks: `${v.number} ${v.payeeName ?? ''}`.trim(),
    });
    const followUp = await this.settings.get('payments.mpesaFollowUpMinutes');
    await this.ds.transaction(async (m) => {
      const row = await m.findOneOrFail(MpesaPayout, { where: { id: p.id }, lock: { mode: 'pessimistic_write' } });
      row.requestBody = answer.request;
      if (answer.outcome === 'ACCEPTED') {
        row.conversationId = answer.conversationId;
        row.responseBody = answer.response;
        // A result already applied by an early callback stays as it is.
        if (row.status === PayoutAttemptStatus.PENDING) row.nextCheckAt = minutes(followUp);
        await m.save(row);
        return;
      }
      if (answer.outcome === 'REJECTED') {
        // Definitely not processed: the voucher can be fixed and released again.
        Object.assign(row, { status: PayoutAttemptStatus.FAILED, resultCode: answer.code, resultDesc: answer.message, responseBody: answer.response, nextCheckAt: null });
        await m.save(row);
        const voucher = await this.payments.lock(m, v.id);
        await this.payments.toReview(m, voucher, PaymentVoucherStatus.FAILED, `M-PESA refused the request: ${answer.message}`);
        return;
      }
      // Timeout / network: the outcome is unknown; ask M-PESA before anything else.
      Object.assign(row, { status: PayoutAttemptStatus.UNKNOWN, resultDesc: answer.message, nextCheckAt: minutes(1) });
      await m.save(row);
    });
    this.log.log(`${v.number} attempt ${p.attempt} to ${maskPhone(p.partyB) ?? p.partyB}: ${answer.outcome}`);
  }

  // ------------------------------------------------------------------ callbacks

  /** Daraja sends no credentials: the secret token in the path (and optionally the source IP) identify it. */
  assertCallback(token: string, ip: string | undefined): void {
    const c = loadEnv().mpesaPayout;
    const expected = c.mode === 'mock' ? (c.callbackToken ?? 'mock-callback-token') : c.callbackToken;
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(expected ?? '');
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new NotFoundException();
    if (c.callbackAllowedIps.length && !c.callbackAllowedIps.includes((ip ?? '').replace(/^::ffff:/, ''))) throw new ForbiddenException();
  }

  /** ResultURL / QueueTimeOutURL. Idempotent: a final attempt is never changed by a repeated callback. */
  async applyCallback(kind: 'result' | 'timeout', body: Record<string, unknown>): Promise<void> {
    const r = (body as { Result?: Record<string, unknown> }).Result ?? {};
    const ours = r.OriginatorConversationID ? String(r.OriginatorConversationID) : null;
    const theirs = r.ConversationID ? String(r.ConversationID) : null;
    const p = await this.ds.getRepository(MpesaPayout).findOne({ where: [...(ours ? [{ originatorConversationId: ours }] : []), ...(theirs ? [{ conversationId: theirs }] : [])] });
    if (!p) {
      this.log.warn(`Callback for an unknown payout (${ours ?? theirs ?? 'no id'})`);
      return;
    }
    if (kind === 'timeout') {
      await this.ds.transaction(async (m) => {
        const row = await m.findOneOrFail(MpesaPayout, { where: { id: p.id }, lock: { mode: 'pessimistic_write' } });
        if (row.status !== PayoutAttemptStatus.PENDING) return;
        Object.assign(row, { status: PayoutAttemptStatus.UNKNOWN, resultBody: body, resultDesc: String(r.ResultDesc ?? 'Queue timeout'), nextCheckAt: minutes(1) });
        await m.save(row);
      });
      return;
    }
    const result = parsePayoutResult(body);
    if (result) await this.applyResult(p.id, result, body);
  }

  /** Status query answer (status URL carries the attempt id). */
  async statusResult(payoutId: string, body: Record<string, unknown>): Promise<void> {
    const result = parsePayoutResult(body);
    if (!result) return;
    const answer = statusFromResult(result, body);
    if (answer.state === 'FOUND') await this.applyResult(payoutId, answer.result, body);
    else if (answer.state === 'NOT_FOUND') await this.notProcessed(payoutId);
  }

  private async applyResult(payoutId: string, result: PayoutResult, body: Record<string, unknown>): Promise<void> {
    await this.ds.transaction(async (m) => {
      const row = await m.findOne(MpesaPayout, { where: { id: payoutId }, lock: { mode: 'pessimistic_write' } });
      if (!row) return;
      if ([PayoutAttemptStatus.SUCCESS, PayoutAttemptStatus.FAILED, PayoutAttemptStatus.REVERSED].includes(row.status)) {
        // Already final (repeated callback, or status answer after the callback).
        if (row.status === PayoutAttemptStatus.FAILED && result.resultCode === '0') {
          await this.audit.record({ action: 'MPESA_RESULT_CONFLICT', entityType: 'mpesa_payout', entityId: row.id, after: { status: row.status, lateResult: result.resultCode, receipt: result.receiptNo } }, m);
          const v = await this.payments.lock(m, row.voucherId);
          await this.payments.toReview(m, v, PaymentVoucherStatus.REVIEW, `M-PESA reports ${result.receiptNo} paid for an attempt recorded as failed: check the statement`);
        }
        return;
      }
      row.resultBody = body;
      row.resultCode = result.resultCode;
      row.resultDesc = result.resultDesc;
      row.nextCheckAt = null;
      const v = await this.payments.lock(m, row.voucherId);
      if (result.resultCode === '0') {
        Object.assign(row, { status: PayoutAttemptStatus.SUCCESS, receiptNo: result.receiptNo, charges: result.charges, recipientName: result.recipientName, completedAt: result.completedAt ?? new Date() });
        await m.save(row);
        if (result.amount !== null && Math.abs(result.amount - row.amount) > 0.5) {
          await this.payments.toReview(m, v, PaymentVoucherStatus.REVIEW, `M-PESA paid ${result.amount}, the voucher is for ${row.amount} (receipt ${result.receiptNo})`);
          return;
        }
        if ([PaymentVoucherStatus.PROCESSING, PaymentVoucherStatus.REVIEW].includes(v.status)) {
          await this.payments.markPaid(m, v, result.receiptNo ?? row.originatorConversationId, nairobiDate(row.completedAt!));
        }
        return;
      }
      row.status = PayoutAttemptStatus.FAILED;
      await m.save(row);
      if (v.status === PaymentVoucherStatus.PROCESSING) await this.payments.toReview(m, v, PaymentVoucherStatus.FAILED, `M-PESA: ${result.resultDesc} (${result.resultCode})`);
    });
  }

  /** M-PESA confirms it never processed the request: retry with backoff, then review. */
  private async notProcessed(payoutId: string): Promise<void> {
    const max = await this.settings.get('payments.mpesaMaxAttempts');
    await this.ds.transaction(async (m) => {
      const row = await m.findOne(MpesaPayout, { where: { id: payoutId }, lock: { mode: 'pessimistic_write' } });
      if (!row || ![PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN].includes(row.status)) return;
      const retry = row.attempt < max;
      // nextCheckAt on a FAILED attempt = when the follow-up job sends the next one.
      Object.assign(row, { status: PayoutAttemptStatus.FAILED, resultCode: 'NOT_PROCESSED', resultDesc: 'M-PESA has no record of the request', nextCheckAt: retry ? minutes(2 ** row.attempt) : null });
      await m.save(row);
      if (!retry) {
        const v = await this.payments.lock(m, row.voucherId);
        await this.payments.toReview(m, v, PaymentVoucherStatus.FAILED, `Not processed by M-PESA after ${row.attempt} attempt(s)`);
      }
    });
  }

  // ------------------------------------------------------------------ follow-up job

  /**
   * Job payments.mpesaFollowUp: attempts with no result are queried (backing
   * off); those M-PESA never processed are sent again (new attempt) up to
   * payments.mpesaMaxAttempts; after payments.mpesaMaxStatusChecks unanswered
   * queries the voucher goes to review (its attempt stays live, so nothing
   * more is sent until someone resolves it).
   */
  async followUp() {
    const gateway = this.gateway();
    const maxChecks = await this.settings.get('payments.mpesaMaxStatusChecks');
    const due = await this.ds.getRepository(MpesaPayout).find({ where: { nextCheckAt: LessThanOrEqual(new Date()) }, order: { nextCheckAt: 'ASC' }, take: 200 });
    const out = { queried: 0, resolved: 0, retried: 0, review: 0 };
    for (const p of due) {
      if (p.status === PayoutAttemptStatus.FAILED) {
        // Scheduled retry of a request M-PESA never processed.
        const next = await this.ds.transaction(async (m) => {
          const row = await m.findOne(MpesaPayout, { where: { id: p.id }, lock: { mode: 'pessimistic_write' } });
          if (!row?.nextCheckAt) return null;
          row.nextCheckAt = null;
          await m.save(row);
          const v = await this.payments.lock(m, row.voucherId);
          if (v.status !== PaymentVoucherStatus.PROCESSING) return null;
          v.status = PaymentVoucherStatus.APPROVED; // newAttempt moves it back to PROCESSING
          return this.newAttempt(m, v, null);
        });
        if (next) {
          await this.send(gateway, next);
          out.retried++;
        }
        continue;
      }
      if (![PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN].includes(p.status)) continue;
      out.queried++;
      const answer = await gateway.queryStatus({ payoutId: p.id, originatorConversationId: p.originatorConversationId, conversationId: p.conversationId });
      if (answer.state === 'FOUND') {
        await this.applyResult(p.id, answer.result, { statusQuery: true, ...answer.result } as unknown as Record<string, unknown>);
        out.resolved++;
      } else if (answer.state === 'NOT_FOUND') {
        await this.notProcessed(p.id);
      } else {
        await this.ds.transaction(async (m) => {
          const row = await m.findOne(MpesaPayout, { where: { id: p.id }, lock: { mode: 'pessimistic_write' } });
          if (!row || ![PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN].includes(row.status)) return;
          row.statusChecks += 1;
          if (row.statusChecks >= maxChecks) {
            row.nextCheckAt = null;
            await m.save(row);
            const v = await this.payments.lock(m, row.voucherId);
            await this.payments.toReview(m, v, PaymentVoucherStatus.REVIEW, `No result from M-PESA after ${row.statusChecks} status checks: check the statement before doing anything else`);
            out.review++;
          } else {
            row.nextCheckAt = minutes(Math.min(60, 2 ** row.statusChecks));
            await m.save(row);
          }
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ reversal

  /** Asks M-PESA to reverse a paid voucher; the result comes by callback. */
  async reverse(voucherId: string, reason: string, actor: SessionUser) {
    const gateway = this.gateway();
    const p = await this.ds.transaction(async (m) => {
      const v = await this.payments.lock(m, voucherId);
      if (v.status !== PaymentVoucherStatus.PAID) throw new ConflictException(`Voucher is ${v.status}`);
      const row = await m.findOne(MpesaPayout, { where: { voucherId, status: PayoutAttemptStatus.SUCCESS }, lock: { mode: 'pessimistic_write' } });
      if (!row?.receiptNo) throw new ConflictException('Only M-PESA payments can be reversed here');
      if (row.reversalBody) throw new ConflictException('A reversal has already been requested');
      row.reversalBody = { requestedBy: actor.id, reason, requestedAt: new Date().toISOString() };
      await m.save(row);
      await this.audit.record({ action: 'PAYMENT_REVERSAL_REQUESTED', entityType: 'payment_voucher', entityId: voucherId, after: { receipt: row.receiptNo, reason } }, m);
      return row;
    });
    const answer = await gateway.reverse({ payoutId: p.id, originatorConversationId: `${p.originatorConversationId}-R`, receiptNo: p.receiptNo!, amount: p.amount, remarks: reason });
    await this.ds.query(`UPDATE mpesa_payout SET reversal_body = reversal_body || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ outcome: answer.outcome, message: answer.message })]);
    if (answer.outcome === 'REJECTED') throw new ConflictException(`M-PESA refused the reversal: ${answer.message}`);
    return this.payments.get(voucherId);
  }

  async reversalResult(payoutId: string, body: Record<string, unknown>): Promise<void> {
    const result = parsePayoutResult(body);
    if (!result) return;
    await this.ds.transaction(async (m) => {
      const row = await m.findOne(MpesaPayout, { where: { id: payoutId }, lock: { mode: 'pessimistic_write' } });
      if (!row || row.status !== PayoutAttemptStatus.SUCCESS) return;
      await m.query(`UPDATE mpesa_payout SET reversal_body = COALESCE(reversal_body, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [row.id, JSON.stringify({ result: body })]);
      if (result.resultCode !== '0') return;
      await m.query(`UPDATE mpesa_payout SET status = 'REVERSED', reversed_at = now() WHERE id = $1`, [row.id]);
      const v = await this.payments.lock(m, row.voucherId);
      await this.payments.markReversed(m, v, `Reversed on M-PESA (${result.receiptNo ?? 'reversal'})`);
    });
  }
}

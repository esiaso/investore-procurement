import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { PaymentMethod, PayoutAttemptStatus, SessionUser } from '@sil/shared';
import { loadEnv } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { GatewayConfigError, PaymentGateway, PayoutResult } from './gateway';
import { DarajaPayoutGateway, parsePayoutResult, sharedMockPayouts, statusFromResult } from './mpesa-payouts';
import { PayoutDoc, PayoutOwner, PayoutOwnerType } from './payout-owner';
import { MpesaPayout } from './payments.entities';
import { PaymentsService } from './payments.service';
import { commandFor, maskPhone } from './payout-rules';

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const nairobiDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const LIVE = [PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN, PayoutAttemptStatus.SUCCESS];

/** The document an attempt pays. */
const ownerOf = (p: MpesaPayout): [PayoutOwnerType, string] => (p.voucherId ? ['PV', p.voucherId] : ['PCV', p.pettyCashId!]);
const ownerColumn = (type: PayoutOwnerType) => (type === 'PV' ? 'voucherId' : 'pettyCashId');

/**
 * Pays approved documents (supplier payment vouchers, petty cash vouchers)
 * through M-PESA (Part C). A document is never paid twice: one attempt at a
 * time (row lock + a unique index on live / successful attempts), a fresh
 * OriginatorConversationID per attempt, and a request whose outcome is
 * unknown is never sent again before M-PESA has been asked what became of it.
 * Callbacks are idempotent.
 */
@Injectable()
export class MpesaPayoutsService implements OnModuleInit {
  private readonly log = new Logger('M-PESA payouts');
  private gatewayInstance: PaymentGateway | null = null;
  private readonly owners = new Map<PayoutOwnerType, PayoutOwner>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.registerOwner(this.payments);
    this.payments.useDispatcher((id, actor) => this.dispatch('PV', id, actor));
    // The simulator delivers its callbacks in process.
    sharedMockPayouts.deliver = async (kind, id, body) => {
      if (kind === 'reversal') await this.reversalResult(id, body);
      else await this.applyCallback(kind, body);
    };
    this.jobs.register('payments.mpesaFollowUp', 'Ask M-PESA about payouts with no result yet; retry those never processed, else send them to review', () => this.followUp());
  }

  registerOwner(owner: PayoutOwner) {
    this.owners.set(owner.type, owner);
  }

  private owner(type: PayoutOwnerType): PayoutOwner {
    const o = this.owners.get(type);
    if (!o) throw new Error(`No payout owner for ${type}`);
    return o;
  }

  /** The configured gateway (MPESA_PAYOUT_MODE: mock simulator, Daraja sandbox / production, or off). */
  gateway(): PaymentGateway {
    if (this.gatewayInstance) return this.gatewayInstance;
    const c = loadEnv().mpesaPayout;
    if (c.mode === 'off') throw new GatewayConfigError('M-PESA payouts are switched off (MPESA_PAYOUT_MODE=off)');
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

  /** The gateway, or 503 when payouts are switched off or not configured. */
  private usableGateway(): PaymentGateway {
    try {
      return this.gateway();
    } catch (e) {
      if (e instanceof GatewayConfigError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  // ------------------------------------------------------------------ dispatch

  /** Sends a document once its owner has checked approvals and segregation of duties. */
  async dispatch(type: PayoutOwnerType, id: string, actor: SessionUser): Promise<void> {
    const gateway = this.usableGateway();
    const sent = await this.ds.transaction(async (m) => {
      const doc = (await this.owner(type).claim(m, id, 'release'))!;
      return { doc, payout: await this.newAttempt(m, type, doc, actor.id) };
    });
    await this.send(gateway, sent.payout, sent.doc);
  }

  /** Records the attempt before anything is sent (the document row is locked by the owner's claim). */
  private async newAttempt(m: EntityManager, type: PayoutOwnerType, doc: PayoutDoc, releasedBy: string | null): Promise<MpesaPayout> {
    const col = ownerColumn(type);
    const live = await m.findOne(MpesaPayout, { where: { [col]: doc.id, status: In(LIVE) } });
    if (live) throw new ConflictException({ code: 'ALREADY_DISPATCHED', message: `${doc.number} has already been sent to M-PESA (${live.status})` });
    const n = await m.count(MpesaPayout, { where: { [col]: doc.id } });
    const p = m.create(MpesaPayout, {
      [col]: doc.id,
      attempt: n + 1,
      commandId: commandFor(doc.method),
      originatorConversationId: `${doc.number.replace(/[^A-Za-z0-9]/g, '')}-${n + 1}-${randomBytes(6).toString('hex')}`,
      partyB: doc.method === PaymentMethod.MPESA_B2C ? doc.payeePhone! : doc.payeeShortcode!,
      accountRef: doc.payeeAccountRef,
      amount: doc.amount,
      status: PayoutAttemptStatus.PENDING,
      releasedBy,
    });
    try {
      await m.save(p);
    } catch (e) {
      // The unique index on live attempts: someone else dispatched it a moment ago.
      if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'ALREADY_DISPATCHED', message: `${doc.number} has already been sent to M-PESA` });
      throw e;
    }
    await this.owner(type).dispatched(m, doc.id, releasedBy);
    return p;
  }

  private async send(gateway: PaymentGateway, p: MpesaPayout, doc: PayoutDoc): Promise<void> {
    const [type] = ownerOf(p);
    const answer = await gateway.dispatch({
      originatorConversationId: p.originatorConversationId,
      method: doc.method,
      commandId: p.commandId,
      amount: p.amount,
      partyB: p.partyB,
      accountRef: p.accountRef,
      remarks: `${doc.number} ${doc.payeeName ?? ''}`.trim(),
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
        // Definitely not processed: the document can be fixed and released again.
        Object.assign(row, { status: PayoutAttemptStatus.FAILED, resultCode: answer.code, resultDesc: answer.message, responseBody: answer.response, nextCheckAt: null });
        await m.save(row);
        await this.owner(type).failed(m, doc.id, 'FAILED', `M-PESA refused the request: ${answer.message}`, false);
        return;
      }
      // Timeout / network: the outcome is unknown; ask M-PESA before anything else.
      Object.assign(row, { status: PayoutAttemptStatus.UNKNOWN, resultDesc: answer.message, nextCheckAt: minutes(1) });
      await m.save(row);
    });
    this.log.log(`${doc.number} attempt ${p.attempt} to ${maskPhone(p.partyB) ?? p.partyB}: ${answer.outcome}`);
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
      const [type, docId] = ownerOf(row);
      const owner = this.owner(type);
      if ([PayoutAttemptStatus.SUCCESS, PayoutAttemptStatus.FAILED, PayoutAttemptStatus.REVERSED].includes(row.status)) {
        // Already final (repeated callback, or status answer after the callback).
        if (row.status === PayoutAttemptStatus.FAILED && result.resultCode === '0') {
          await this.audit.record({ action: 'MPESA_RESULT_CONFLICT', entityType: 'mpesa_payout', entityId: row.id, after: { status: row.status, lateResult: result.resultCode, receipt: result.receiptNo } }, m);
          await owner.failed(m, docId, 'REVIEW', `M-PESA reports ${result.receiptNo} paid for an attempt recorded as failed: check the statement`, false);
        }
        return;
      }
      row.resultBody = body;
      row.resultCode = result.resultCode;
      row.resultDesc = result.resultDesc;
      row.nextCheckAt = null;
      if (result.resultCode === '0') {
        Object.assign(row, { status: PayoutAttemptStatus.SUCCESS, receiptNo: result.receiptNo, charges: result.charges, recipientName: result.recipientName, completedAt: result.completedAt ?? new Date() });
        await m.save(row);
        if (result.amount !== null && Math.abs(result.amount - row.amount) > 0.5) {
          await owner.failed(m, docId, 'REVIEW', `M-PESA paid ${result.amount}, the document is for ${row.amount} (receipt ${result.receiptNo})`, false);
          return;
        }
        await owner.paid(m, docId, result.receiptNo ?? row.originatorConversationId, nairobiDate(row.completedAt!));
        return;
      }
      row.status = PayoutAttemptStatus.FAILED;
      await m.save(row);
      await owner.failed(m, docId, 'FAILED', `M-PESA: ${result.resultDesc} (${result.resultCode})`, true);
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
        const [type, docId] = ownerOf(row);
        await this.owner(type).failed(m, docId, 'FAILED', `Not processed by M-PESA after ${row.attempt} attempt(s)`, false);
      }
    });
  }

  // ------------------------------------------------------------------ follow-up job

  /**
   * Job payments.mpesaFollowUp: attempts with no result are queried (backing
   * off); those M-PESA never processed are sent again (new attempt) up to
   * payments.mpesaMaxAttempts; after payments.mpesaMaxStatusChecks unanswered
   * queries the document goes to review (its attempt stays live, so nothing
   * more is sent until someone resolves it).
   */
  async followUp() {
    const out = { queried: 0, resolved: 0, retried: 0, review: 0 };
    if (loadEnv().mpesaPayout.mode === 'off') return out;
    const gateway = this.gateway();
    const maxChecks = await this.settings.get('payments.mpesaMaxStatusChecks');
    const due = await this.ds.getRepository(MpesaPayout).find({ where: { nextCheckAt: LessThanOrEqual(new Date()) }, order: { nextCheckAt: 'ASC' }, take: 200 });
    for (const p of due) {
      const [type, docId] = ownerOf(p);
      if (p.status === PayoutAttemptStatus.FAILED) {
        // Scheduled retry of a request M-PESA never processed.
        const next = await this.ds.transaction(async (m) => {
          const row = await m.findOne(MpesaPayout, { where: { id: p.id }, lock: { mode: 'pessimistic_write' } });
          if (!row?.nextCheckAt) return null;
          row.nextCheckAt = null;
          await m.save(row);
          const doc = await this.owner(type).claim(m, docId, 'retry');
          return doc ? { doc, payout: await this.newAttempt(m, type, doc, null) } : null;
        });
        if (next) {
          await this.send(gateway, next.payout, next.doc);
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
            await this.owner(type).failed(m, docId, 'REVIEW', `No result from M-PESA after ${row.statusChecks} status checks: check the statement before doing anything else`, false);
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

  // ------------------------------------------------------------------ manual resolution

  /** Review queue, paid by hand: the live attempts are marked successful with the receipt. */
  async resolveAttempts(m: EntityManager, type: PayoutOwnerType, id: string, outcome: 'PAID' | 'FAILED', reference: string | null, note: string): Promise<void> {
    const live = await m.find(MpesaPayout, { where: { [ownerColumn(type)]: id, status: In(LIVE) }, lock: { mode: 'pessimistic_write' } });
    if (outcome === 'PAID') {
      for (const p of live) Object.assign(p, { status: PayoutAttemptStatus.SUCCESS, receiptNo: p.receiptNo ?? reference, resultDesc: `Resolved by hand: ${note}`, nextCheckAt: null });
    } else {
      if (live.some((p) => p.status === PayoutAttemptStatus.SUCCESS)) throw new ConflictException('M-PESA reported this payment as successful; reverse it instead');
      // Confirmed not paid: the attempts are closed so a new one can be made.
      for (const p of live) Object.assign(p, { status: PayoutAttemptStatus.FAILED, resultDesc: `Resolved by hand as not paid: ${note}`, nextCheckAt: null });
    }
    await m.save(live);
  }

  async hasLiveAttempt(m: EntityManager, type: PayoutOwnerType, id: string): Promise<boolean> {
    return (await m.count(MpesaPayout, { where: { [ownerColumn(type)]: id, status: In(LIVE) } })) > 0;
  }

  attempts(type: PayoutOwnerType, id: string) {
    return this.ds.query(
      `SELECT id, attempt, command_id AS "commandId", status, result_code AS "resultCode", result_desc AS "resultDesc", receipt_no AS "receiptNo", charges::float AS charges,
              recipient_name AS "recipientName", completed_at AS "completedAt", created_at AS "createdAt", status_checks AS "statusChecks", reversed_at AS "reversedAt"
         FROM mpesa_payout WHERE ${type === 'PV' ? 'voucher_id' : 'petty_cash_id'} = $1 ORDER BY attempt`,
      [id],
    );
  }

  // ------------------------------------------------------------------ reversal

  /** Asks M-PESA to reverse a paid document; the result comes by callback. */
  async reverse(type: PayoutOwnerType, id: string, reason: string, actor: SessionUser): Promise<void> {
    const gateway = this.usableGateway();
    const p = await this.ds.transaction(async (m) => {
      await this.owner(type).assertReversible(m, id);
      const row = await m.findOne(MpesaPayout, { where: { [ownerColumn(type)]: id, status: PayoutAttemptStatus.SUCCESS }, lock: { mode: 'pessimistic_write' } });
      if (!row?.receiptNo) throw new ConflictException('Only M-PESA payments can be reversed here');
      if (row.reversalBody) throw new ConflictException('A reversal has already been requested');
      row.reversalBody = { requestedBy: actor.id, reason, requestedAt: new Date().toISOString() };
      await m.save(row);
      await this.audit.record({ action: 'PAYMENT_REVERSAL_REQUESTED', entityType: type === 'PV' ? 'payment_voucher' : 'petty_cash_request', entityId: id, after: { receipt: row.receiptNo, reason } }, m);
      return row;
    });
    const answer = await gateway.reverse({ payoutId: p.id, originatorConversationId: `${p.originatorConversationId}-R`, receiptNo: p.receiptNo!, amount: p.amount, remarks: reason });
    await this.ds.query(`UPDATE mpesa_payout SET reversal_body = reversal_body || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ outcome: answer.outcome, message: answer.message })]);
    if (answer.outcome === 'REJECTED') throw new ConflictException(`M-PESA refused the reversal: ${answer.message}`);
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
      const [type, docId] = ownerOf(row);
      await this.owner(type).reversed(m, docId, `Reversed on M-PESA (${result.receiptNo ?? 'reversal'})`);
    });
  }
}

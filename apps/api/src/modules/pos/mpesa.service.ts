import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { MpesaEnvironment, MpesaMethod, MpesaStatus, PosShiftStatus, SessionUser } from '@sil/shared';
import { decryptField, encryptField } from '../../common/crypto';
import { StoreScope } from '../../common/store-scope';
import { loadEnv } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { DarajaMpesaAdapter, fromDarajaDate, MpesaAdapter, MpesaError, normalisePhone, parseStkCallback, sharedMockMpesa, StkResult } from './mpesa';
import { MpesaConfigDto, StkPushDto } from './pos.dto';
import { MpesaConfig, MpesaTransaction, PosShift, PosTerminal } from './pos.entities';

const CODE = 'DEFAULT';
const key = () => loadEnv().dataEncryptionKey;
const enc = (v: string) => encryptField(key(), v);
const dec = (v: string | null) => (v ? decryptField(key(), v) : '');

/**
 * M-Pesa at the till: STK Push (the customer confirms on their phone; the
 * result arrives by callback, or by query when the callback is late), C2B
 * confirmations for customers who pay the till / paybill directly, and
 * codes typed by the cashier. A transaction pays one sale only.
 */
@Injectable()
export class MpesaService implements OnModuleInit {
  private readonly log = new Logger('M-Pesa');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    // The mock delivers its callbacks in process.
    sharedMockMpesa.deliver = async (body) => {
      await this.applyStkResult(parseStkCallback(body), body);
    };
  }

  // ------------------------------------------------------------------ configuration

  async getConfig() {
    const c = await this.ds.getRepository(MpesaConfig).createQueryBuilder('c').addSelect(['c.consumerKeyEnc', 'c.consumerSecretEnc', 'c.passkeyEnc', 'c.callbackToken']).where('c.code = :c', { c: CODE }).getOne();
    if (!c) return null;
    const { consumerKeyEnc, consumerSecretEnc, passkeyEnc, callbackToken, ...rest } = c;
    const base = (rest.callbackBaseUrl ?? '').replace(/\/+$/, '');
    return {
      ...rest,
      hasCredentials: !!(consumerKeyEnc && consumerSecretEnc && passkeyEnc),
      // Shown so they can be registered with Safaricom (C2B) — the token is the only secret in them.
      callbackUrls: base ? { stk: `${base}/api/v1/callbacks/mpesa/stk/${callbackToken}`, c2bConfirmation: `${base}/api/v1/callbacks/mpesa/c2b/confirmation/${callbackToken}`, c2bValidation: `${base}/api/v1/callbacks/mpesa/c2b/validation/${callbackToken}` } : null,
    };
  }

  async saveConfig(dto: MpesaConfigDto) {
    if (dto.environment !== MpesaEnvironment.MOCK && !dto.apiBaseUrl) throw new BadRequestException('Daraja needs its API base URL (https://sandbox.safaricom.co.ke or https://api.safaricom.co.ke)');
    if (dto.environment !== MpesaEnvironment.MOCK && !dto.callbackBaseUrl) throw new BadRequestException('Daraja needs a public callback base URL');
    const repo = this.ds.getRepository(MpesaConfig);
    const row = (await repo.createQueryBuilder('c').addSelect('c.callbackToken').where('c.code = :c', { c: CODE }).getOne()) ?? repo.create({ code: CODE, callbackToken: randomBytes(18).toString('base64url') });
    Object.assign(row, {
      environment: dto.environment,
      shortcode: dto.shortcode,
      transactionType: dto.transactionType ?? 'CustomerPayBillOnline',
      partyB: dto.partyB ?? null,
      apiBaseUrl: dto.apiBaseUrl ?? null,
      callbackBaseUrl: dto.callbackBaseUrl ?? null,
      isActive: dto.isActive ?? true,
    });
    if (dto.consumerKey) row.consumerKeyEnc = enc(dto.consumerKey);
    if (dto.consumerSecret) row.consumerSecretEnc = enc(dto.consumerSecret);
    if (dto.passkey) row.passkeyEnc = enc(dto.passkey);
    if (dto.rotateCallbackToken) row.callbackToken = randomBytes(18).toString('base64url');
    await repo.save(row);
    return this.getConfig();
  }

  private async active(m: EntityManager = this.ds.manager): Promise<{ config: MpesaConfig; adapter: MpesaAdapter }> {
    const c = await m.getRepository(MpesaConfig).createQueryBuilder('c').addSelect(['c.consumerKeyEnc', 'c.consumerSecretEnc', 'c.passkeyEnc', 'c.callbackToken']).where('c.code = :c AND c.is_active', { c: CODE }).getOne();
    if (!c) throw new ConflictException({ code: 'MPESA_NOT_CONFIGURED', message: 'M-Pesa is not configured: use the code the customer received instead' });
    if (c.environment === MpesaEnvironment.MOCK) return { config: c, adapter: sharedMockMpesa };
    return {
      config: c,
      adapter: new DarajaMpesaAdapter({ baseUrl: c.apiBaseUrl!, consumerKey: dec(c.consumerKeyEnc), consumerSecret: dec(c.consumerSecretEnc), passkey: dec(c.passkeyEnc), shortcode: c.shortcode, transactionType: c.transactionType, partyB: c.partyB }),
    };
  }

  /** Callback secret check (constant time). The mock needs none. */
  private async checkToken(token: string): Promise<MpesaConfig> {
    const c = await this.ds.getRepository(MpesaConfig).createQueryBuilder('c').addSelect('c.callbackToken').where('c.code = :c', { c: CODE }).getOne();
    const a = Buffer.from(c?.callbackToken ?? '');
    const b = Buffer.from(token ?? '');
    if (!c || a.length !== b.length || !timingSafeEqual(a, b)) throw new NotFoundException();
    return c;
  }

  // ------------------------------------------------------------------ STK push

  /** Sends the payment prompt to the customer's phone for the open shift's till. */
  async stkPush(dto: StkPushDto, actor: SessionUser) {
    const terminal = await this.ds.getRepository(PosTerminal).findOneBy({ id: dto.terminalId, isActive: true });
    if (!terminal) throw new NotFoundException('Till not found');
    StoreScope.assert(terminal.storeId);
    const shift = await this.ds.getRepository(PosShift).findOneBy({ terminalId: terminal.id, cashierId: actor.id, status: PosShiftStatus.OPEN });
    if (!shift) throw new ConflictException('Open a shift on this till first');
    let phone: string;
    try {
      phone = normalisePhone(dto.phone);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const { config, adapter } = await this.active();
    const repo = this.ds.getRepository(MpesaTransaction);
    const accountRef = (dto.accountRef ?? terminal.code).slice(0, 12);
    const callbackUrl = `${(config.callbackBaseUrl ?? 'https://mock.invalid').replace(/\/+$/, '')}/api/v1/callbacks/mpesa/stk/${config.callbackToken}`;
    let started;
    try {
      started = await adapter.stkPush({ phone, amount: dto.amount, accountRef, description: 'Pharmacy', callbackUrl }, 15_000);
    } catch (e) {
      throw new BadRequestException(`M-Pesa did not accept the request: ${(e as Error).message}`);
    }
    const txn = await repo.save(
      repo.create({
        method: MpesaMethod.STK,
        status: started.ok ? MpesaStatus.PENDING : MpesaStatus.FAILED,
        terminalId: terminal.id,
        shiftId: shift.id,
        phone,
        amount: Math.ceil(dto.amount),
        accountRef,
        merchantRequestId: started.merchantRequestId,
        checkoutRequestId: started.checkoutRequestId,
        resultCode: started.responseCode,
        resultDesc: started.message.slice(0, 300),
        createdBy: actor.id,
      }),
    );
    if (!started.ok) throw new BadRequestException({ code: 'MPESA_REJECTED', message: `M-Pesa refused the request: ${started.message}`, transactionId: txn.id });
    // The mock answers at once (unless it simulates a delay or no answer).
    if (config.environment === MpesaEnvironment.MOCK && sharedMockMpesa.delayMs === 0 && started.checkoutRequestId) {
      const r = await adapter.stkQuery(started.checkoutRequestId, 1000);
      if (r && r.resultCode !== '1037') await this.applyStkResult(r, { mock: true });
    }
    return this.get(txn.id);
  }

  async get(id: string) {
    const t = await this.ds.getRepository(MpesaTransaction).findOneBy({ id });
    if (!t) throw new NotFoundException('M-Pesa transaction not found');
    return t;
  }

  /** Current state; asks Daraja when the callback is late, and times out after mpesa.stkTimeoutSeconds. */
  async status(id: string) {
    const t = await this.get(id);
    if (t.status !== MpesaStatus.PENDING || t.method !== MpesaMethod.STK || !t.checkoutRequestId) return t;
    const age = (Date.now() - t.createdAt.getTime()) / 1000;
    if (age > 15) {
      try {
        const { adapter } = await this.active();
        const r = await adapter.stkQuery(t.checkoutRequestId, 10_000);
        if (r) await this.applyStkResult(r, { query: r });
      } catch (e) {
        this.log.warn(`STK query failed: ${(e as Error).message}`);
      }
    }
    const fresh = await this.get(id);
    if (fresh.status === MpesaStatus.PENDING && age > (await this.settings.get('mpesa.stkTimeoutSeconds'))) {
      await this.ds.getRepository(MpesaTransaction).update({ id, status: MpesaStatus.PENDING }, { status: MpesaStatus.TIMEOUT, resultDesc: 'No answer from the customer in time' });
      return this.get(id);
    }
    return fresh;
  }

  /** STK result (callback or query): success records the receipt; 1032 cancelled; anything else failed. */
  private async applyStkResult(r: StkResult | null, raw: Record<string, unknown>) {
    if (!r) return;
    const repo = this.ds.getRepository(MpesaTransaction);
    const t = await repo.findOneBy({ checkoutRequestId: r.checkoutRequestId });
    if (!t || t.status === MpesaStatus.SUCCESS) return;
    const ok = r.resultCode === '0';
    Object.assign(t, {
      status: ok ? MpesaStatus.SUCCESS : r.resultCode === '1032' ? MpesaStatus.CANCELLED : r.resultCode === '1037' ? MpesaStatus.TIMEOUT : MpesaStatus.FAILED,
      resultCode: r.resultCode,
      resultDesc: r.resultDesc.slice(0, 300),
      receiptNo: ok ? (r.receiptNo ?? t.receiptNo) : t.receiptNo,
      transactionDate: r.transactionDate ?? t.transactionDate,
      amount: ok && r.amount ? r.amount : t.amount,
      raw,
    });
    await repo.save(t);
  }

  async stkCallback(token: string, body: Record<string, unknown>) {
    await this.checkToken(token);
    await this.applyStkResult(parseStkCallback(body), body);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ------------------------------------------------------------------ C2B (customer paid the till / paybill)

  async c2bValidation(token: string) {
    await this.checkToken(token);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /** Confirmation of a payment made to the till / paybill; the cashier then picks it by its code. */
  async c2bConfirmation(token: string, body: Record<string, unknown>) {
    await this.checkToken(token);
    const receipt = String(body.TransID ?? '').trim().toUpperCase();
    if (!receipt) throw new BadRequestException('TransID missing');
    const repo = this.ds.getRepository(MpesaTransaction);
    const existing = await repo.findOneBy({ receiptNo: receipt });
    if (existing) {
      // A typed code is confirmed once Safaricom tells us about it.
      if (!existing.verified) await repo.save(Object.assign(existing, { verified: true, raw: body, amount: Number(body.TransAmount ?? existing.amount) }));
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
    await repo.save(
      repo.create({
        method: MpesaMethod.C2B,
        status: MpesaStatus.SUCCESS,
        receiptNo: receipt,
        amount: Number(body.TransAmount ?? 0),
        phone: body.MSISDN ? String(body.MSISDN).slice(0, 15) : null,
        accountRef: body.BillRefNumber ? String(body.BillRefNumber).slice(0, 40) : null,
        payerName: [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(' ').slice(0, 200) || null,
        transactionDate: fromDarajaDate(body.TransTime),
        verified: true,
        raw: body,
      }),
    );
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /** Confirmations received for the till that no sale has used yet (to pick at the till). */
  unusedConfirmations(sinceHours = 24) {
    return this.ds.query(
      `SELECT id, receipt_no AS "receiptNo", amount::float, phone, payer_name AS "payerName", transaction_date AS "transactionDate"
         FROM mpesa_transaction WHERE method = 'C2B' AND status = 'SUCCESS' AND used_at IS NULL AND created_at > now() - ($1 || ' hours')::interval
        ORDER BY created_at DESC LIMIT 50`,
      [String(sinceHours)],
    );
  }

  // ------------------------------------------------------------------ paying a sale

  /**
   * Claims an M-Pesa payment for a sale (in the sale's transaction): a
   * successful STK push of this shift, or a receipt code (a C2B confirmation;
   * else recorded unverified unless pos.manualMpesaRequiresMatch). Returns the
   * receipt number for the invoice payment.
   */
  async claim(m: EntityManager, p: { transactionId?: string; code?: string; amount: number; shiftId: string; terminalId: string; saleId: string; actor: SessionUser }): Promise<{ receiptNo: string; verified: boolean }> {
    const repo = m.getRepository(MpesaTransaction);
    let t: MpesaTransaction | null = null;
    if (p.transactionId) {
      t = await repo.findOne({ where: { id: p.transactionId }, lock: { mode: 'pessimistic_write' } });
      if (!t) throw new BadRequestException('M-Pesa transaction not found');
      if (t.status !== MpesaStatus.SUCCESS) throw new BadRequestException(`The M-Pesa payment is ${t.status.toLowerCase()}`);
    } else {
      const code = (p.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{8,12}$/.test(code)) throw new BadRequestException('Enter the M-Pesa confirmation code (e.g. SJK4H7Q2LM)');
      t = await repo.findOne({ where: { receiptNo: code }, lock: { mode: 'pessimistic_write' } });
      if (!t) {
        if (await this.settings.get('pos.manualMpesaRequiresMatch', m)) throw new BadRequestException(`No M-Pesa confirmation for ${code} has been received yet`);
        t = await repo.save(repo.create({ method: MpesaMethod.MANUAL, status: MpesaStatus.SUCCESS, receiptNo: code, amount: p.amount, terminalId: p.terminalId, shiftId: p.shiftId, verified: false, createdBy: p.actor.id }));
      }
    }
    if (t.usedAt) throw new ConflictException({ code: 'MPESA_ALREADY_USED', message: `M-Pesa ${t.receiptNo} already paid another sale` });
    if (t.amount + 0.001 < p.amount) throw new BadRequestException(`M-Pesa ${t.receiptNo} is for ${t.amount}, less than ${p.amount}`);
    await repo.update(t.id, { usedAt: new Date(), saleId: p.saleId, shiftId: t.shiftId ?? p.shiftId, terminalId: t.terminalId ?? p.terminalId });
    return { receiptNo: t.receiptNo!, verified: t.verified };
  }
}

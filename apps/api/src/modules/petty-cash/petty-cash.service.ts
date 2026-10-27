import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  AttachmentOwner,
  DocumentType,
  MPESA_METHODS,
  NotificationCategory,
  PaymentMethod,
  Permissions,
  PettyCashKind,
  PettyCashStatus,
  PettyCashTxnType,
  ReplenishmentStatus,
  SessionUser,
} from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../files/attachments.service';
import { FinanceService } from '../finance/finance.service';
import { JobsService } from '../jobs/jobs.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { MpesaPayoutsService } from '../payments/mpesa-payouts.service';
import { PayoutDoc, PayoutOwner } from '../payments/payout-owner';
import { normalisePayee } from '../payments/payout-rules';
import { SettingsService } from '../settings/settings.service';
import { CountDto, DisburseDto, FloatDto, PettyCashDto, PettyCashQueryDto, ReplenishmentDto, ResolvePettyCashDto, RetirementDto, VerifyRetirementDto } from './petty-cash.dto';
import { PettyCashCount, PettyCashFloat, PettyCashReplenishment, PettyCashRequest, PettyCashRetirementLine, PettyCashTransaction } from './petty-cash.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;
const PAY_METHODS = [PaymentMethod.CASH, ...MPESA_METHODS];
/** Requests holding float money until they are paid or dropped. */
const COMMITTED = [PettyCashStatus.PENDING_APPROVAL, PettyCashStatus.APPROVED, PettyCashStatus.PROCESSING, PettyCashStatus.REVIEW];
/** An advance is outstanding from approval until it is retired. */
const UNRETIRED = [PettyCashStatus.PENDING_APPROVAL, PettyCashStatus.APPROVED, PettyCashStatus.PROCESSING, PettyCashStatus.REVIEW, PettyCashStatus.DISBURSED, PettyCashStatus.RETIREMENT_SUBMITTED, PettyCashStatus.FAILED];
const EDITABLE = [PettyCashStatus.DRAFT, PettyCashStatus.RETURNED];

/**
 * Petty cash (Part B): floats held by custodians, payment requests and
 * advances through the approval matrix (every level before any cash
 * moves), disbursement in cash or by M-PESA, retirement of advances,
 * replenishment with its own approval, cash counts and the cash book.
 */
@Injectable()
export class PettyCashService implements OnModuleInit, ApprovalHandler, PayoutOwner {
  readonly type = 'PCV' as const;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly finance: FinanceService,
    private readonly payouts: MpesaPayoutsService,
    private readonly jobs: JobsService,
    private readonly pdf: PdfService,
  ) {}

  onModuleInit() {
    this.payouts.registerOwner(this);
    this.approvals.registerHandler(DocumentType.PETTY_CASH_VOUCHER, this);
    this.approvals.registerHandler(DocumentType.PETTY_CASH_REPLENISHMENT, {
      onApproved: (m, req) => this.replenishmentDecided(m, req, ReplenishmentStatus.APPROVED, null),
      onRejected: (m, req, _a, comment) => this.replenishmentDecided(m, req, ReplenishmentStatus.REJECTED, comment),
      onReturned: (m, req, _a, comment) => this.replenishmentDecided(m, req, ReplenishmentStatus.RETURNED, comment),
    });
    this.links.registerResolver(DocumentType.PETTY_CASH_VOUCHER, async (ids) => {
      const rows = await this.ds.getRepository(PettyCashRequest).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.disbursedOn ?? r.createdAt.toISOString(), amount: r.amount }]));
    });
    this.links.registerResolver(DocumentType.PETTY_CASH_REPLENISHMENT, async (ids) => {
      const rows = await this.ds.getRepository(PettyCashReplenishment).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString(), amount: r.amount }]));
    });
    this.attachments.registerOwner(AttachmentOwner.PETTY_CASH, {
      read: [Permissions.PETTY_CASH_REQUEST, Permissions.PETTY_CASH_DISBURSE, Permissions.PETTY_CASH_MANAGE],
      write: [Permissions.PETTY_CASH_REQUEST, Permissions.PETTY_CASH_DISBURSE],
      visible: async (m, id, actor) => {
        const r = await m.findOneBy(PettyCashRequest, { id });
        return !!r && (!actor || (await this.canSee(m, r, actor)));
      },
    });
    this.jobs.register('pettyCash.retirementReminders', 'Remind holders of advances past their retirement date (and their custodians)', () => this.remindRetirements());
  }

  // ------------------------------------------------------------------ floats

  async saveFloat(dto: FloatDto, id?: string) {
    if (dto.perTransactionLimit > dto.floatLimit) throw new BadRequestException('The per-transaction limit cannot exceed the float limit');
    if (dto.replenishThreshold >= dto.floatLimit) throw new BadRequestException('The replenishment threshold must be below the float limit');
    return this.ds.transaction(async (m) => {
      const [custodian] = await m.query(`SELECT 1 FROM app_user WHERE id = $1 AND is_active`, [dto.custodianId]);
      if (!custodian) throw new BadRequestException('The custodian was not found or is inactive');
      if (dto.glAccountId) await this.finance.assertGlAccount(m, dto.glAccountId);
      const f = id ? await m.findOneBy(PettyCashFloat, { id }) : m.create(PettyCashFloat, { code: dto.code, balance: 0 });
      if (!f) throw new NotFoundException('Float not found');
      Object.assign(f, {
        code: dto.code,
        name: dto.name,
        departmentId: dto.departmentId ?? null,
        location: dto.location ?? null,
        custodianId: dto.custodianId,
        floatLimit: dto.floatLimit,
        perTransactionLimit: dto.perTransactionLimit,
        replenishThreshold: dto.replenishThreshold,
        glAccountId: dto.glAccountId ?? null,
        mpesaEnabled: dto.mpesaEnabled ?? false,
        mpesaShortcode: dto.mpesaShortcode ?? null,
        isActive: dto.isActive ?? true,
      });
      const saved = await m.save(f);
      if (!id && dto.openingBalance) await this.post(m, saved.id, PettyCashTxnType.OPENING, dto.openingBalance, null, 'Opening balance');
      return saved;
    });
  }

  async floats(actor: SessionUser) {
    const rows = await this.ds.getRepository(PettyCashFloat).find({ relations: { department: true, glAccount: true }, order: { code: 'ASC' } });
    const committed: { float_id: string; s: number }[] = await this.ds.query(
      `SELECT float_id, SUM(amount)::float AS s FROM petty_cash_request WHERE status = ANY($1::petty_cash_status[]) GROUP BY float_id`,
      [COMMITTED],
    );
    const users: { id: string; full_name: string }[] = await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.custodianId)]);
    return rows
      .filter((f) => f.isActive || actor.permissions.includes(Permissions.PETTY_CASH_MANAGE))
      .map((f) => {
        const c = committed.find((x) => x.float_id === f.id)?.s ?? 0;
        return { ...f, custodianName: users.find((u) => u.id === f.custodianId)?.full_name ?? null, committed: c, available: round2(f.balance - c), belowThreshold: f.balance < f.replenishThreshold };
      });
  }

  /** Adds a movement to the float's cash book (the only way the balance changes). */
  private async post(m: EntityManager, floatId: string, type: PettyCashTxnType, amount: number, ref: { type: string; id: string; no: string } | null, note: string | null) {
    const f = await m.findOne(PettyCashFloat, { where: { id: floatId }, lock: { mode: 'pessimistic_write' } });
    if (!f) throw new NotFoundException('Float not found');
    const balance = round2(f.balance + amount);
    if (balance < -0.005) throw new ConflictException({ code: 'INSUFFICIENT_FLOAT', message: `${f.name} has ${f.balance} in hand` });
    f.balance = balance;
    await m.save(f);
    await m.save(
      m.create(PettyCashTransaction, { floatId, txnDate: await this.settings.today(m), type, amount: round2(amount), balanceAfter: balance, refType: ref?.type ?? null, refId: ref?.id ?? null, refNo: ref?.no ?? null, note }),
    );
    return f;
  }

  // ------------------------------------------------------------------ requests

  private async canSee(m: EntityManager, r: PettyCashRequest, actor: SessionUser): Promise<boolean> {
    if (r.requestedBy === actor.id || r.payeeUserId === actor.id) return true;
    if (actor.permissions.includes(Permissions.PETTY_CASH_MANAGE)) return true;
    const f = await m.findOneBy(PettyCashFloat, { id: r.floatId });
    if (f?.custodianId === actor.id) return true;
    const [acted] = await m.query(
      `SELECT 1 FROM approval_request q LEFT JOIN approval_action a ON a.request_id = q.id
        WHERE q.document_type = 'PCV' AND q.document_id = $1 AND (a.user_id = $2 OR q.status = 'PENDING') LIMIT 1`,
      [r.id, actor.id],
    );
    return !!acted;
  }

  private async validate(m: EntityManager, dto: PettyCashDto, actor: SessionUser, selfId?: string) {
    const f = await m.findOneBy(PettyCashFloat, { id: dto.floatId, isActive: true });
    if (!f) throw new NotFoundException('Float not found or inactive');
    if (!PAY_METHODS.includes(dto.method)) throw new BadRequestException('Petty cash is paid in cash or by M-PESA');
    if (MPESA_METHODS.includes(dto.method)) {
      if (!f.mpesaEnabled) throw new BadRequestException(`${f.name} does not pay by M-PESA`);
      if (Math.round(dto.amount) !== dto.amount) throw new BadRequestException({ code: 'WHOLE_SHILLINGS', message: 'M-PESA pays whole shillings' });
    }
    if (dto.amount > f.perTransactionLimit) {
      throw new BadRequestException({ code: 'OVER_LIMIT', message: `The limit per transaction on ${f.name} is ${f.perTransactionLimit}` });
    }
    if (dto.glAccountId) await this.finance.assertGlAccount(m, dto.glAccountId);
    let payee: ReturnType<typeof normalisePayee>;
    try {
      payee = normalisePayee(dto.method, dto);
    } catch (e) {
      throw new BadRequestException({ code: 'INVALID_PAYEE', message: (e as Error).message });
    }
    const advance = dto.kind === PettyCashKind.ADVANCE;
    // Advances are always to the person asking for them.
    const payeeUserId = advance ? actor.id : dto.payeeType === 'STAFF' ? (dto.payeeUserId ?? actor.id) : null;
    if (advance) {
      const [open] = await m.query(
        `SELECT number FROM petty_cash_request WHERE requested_by = $1 AND kind = 'ADVANCE' AND status = ANY($2::petty_cash_status[]) AND ($3::uuid IS NULL OR id <> $3) LIMIT 1`,
        [actor.id, UNRETIRED, selfId ?? null],
      );
      if (open) throw new ConflictException({ code: 'ADVANCE_OUTSTANDING', message: `Retire advance ${open.number} before asking for another` });
    }
    return { f, payee, payeeUserId };
  }

  /** Same payee and amount within the duplicate window. */
  private async duplicateOf(m: EntityManager, r: Pick<PettyCashRequest, 'id' | 'amount' | 'payeePhone' | 'payeeShortcode' | 'payeeAccountRef' | 'payeeUserId' | 'payeeName'>) {
    const days = await this.settings.get('pettyCash.duplicateWindowDays', m);
    const [dup] = await m.query(
      `SELECT id, number FROM petty_cash_request
        WHERE id <> $1 AND amount = $2 AND status NOT IN ('REJECTED', 'CANCELLED', 'DRAFT') AND created_at > now() - make_interval(days => $3::int)
          AND (($4::text IS NOT NULL AND payee_phone = $4) OR ($5::text IS NOT NULL AND payee_shortcode = $5 AND COALESCE(payee_account_ref, '') = COALESCE($6, ''))
               OR ($7::uuid IS NOT NULL AND payee_user_id = $7) OR lower(payee_name) = lower($8))
        ORDER BY created_at DESC LIMIT 1`,
      [r.id ?? '00000000-0000-0000-0000-000000000000', r.amount, days, r.payeePhone, r.payeeShortcode, r.payeeAccountRef, r.payeeUserId, r.payeeName],
    );
    return dup as { id: string; number: string } | undefined;
  }

  async create(dto: PettyCashDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const { f, payee, payeeUserId } = await this.validate(m, dto, actor);
      const [me] = await m.query(`SELECT full_name FROM app_user WHERE id = $1`, [payeeUserId ?? actor.id]);
      const r = await m.save(
        m.create(PettyCashRequest, {
          number: await this.numbering.next(DocumentType.PETTY_CASH_VOUCHER, { manager: m }),
          floatId: f.id,
          kind: dto.kind,
          status: PettyCashStatus.DRAFT,
          requestedBy: actor.id,
          payeeType: dto.kind === PettyCashKind.ADVANCE ? 'STAFF' : dto.payeeType,
          payeeUserId,
          supplierId: dto.payeeType === 'VENDOR' ? (dto.supplierId ?? null) : null,
          payeeName: dto.payeeName?.trim() || me?.full_name || 'Payee',
          purpose: dto.purpose,
          glAccountId: dto.glAccountId ?? null,
          departmentId: dto.departmentId ?? actor.departmentId ?? f.departmentId!,
          projectId: dto.projectId ?? null,
          amount: dto.amount,
          method: dto.method,
          ...payee,
          duplicateJustification: dto.duplicateJustification ?? null,
        }),
      );
      if (!r.departmentId) throw new BadRequestException('Give the cost centre (department)');
      if (dto.submit) await this.startApproval(m, r);
      return r.id;
    });
    return this.get(id);
  }

  async update(id: string, dto: PettyCashDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can change it');
      if (!EDITABLE.includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
      const { f, payee, payeeUserId } = await this.validate(m, dto, actor, id);
      Object.assign(r, {
        floatId: f.id,
        kind: dto.kind,
        payeeType: dto.kind === PettyCashKind.ADVANCE ? 'STAFF' : dto.payeeType,
        payeeUserId,
        supplierId: dto.payeeType === 'VENDOR' ? (dto.supplierId ?? null) : null,
        payeeName: dto.payeeName?.trim() || r.payeeName,
        purpose: dto.purpose,
        glAccountId: dto.glAccountId ?? null,
        departmentId: dto.departmentId ?? r.departmentId,
        projectId: dto.projectId ?? null,
        amount: dto.amount,
        method: dto.method,
        ...payee,
        duplicateJustification: dto.duplicateJustification ?? null,
      });
      await m.save(r);
      if (dto.submit) await this.startApproval(m, r);
    });
    return this.get(id);
  }

  async submit(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.requestedBy !== actor.id) throw new ForbiddenException('Only the requester can submit it');
      await this.startApproval(m, r);
    });
    return this.get(id);
  }

  /** Limits, float balance, duplicates; then the approval matrix (requester and custodian never approve). */
  private async startApproval(m: EntityManager, r: PettyCashRequest) {
    if (!EDITABLE.includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
    const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
    const [{ c }] = await m.query(`SELECT COALESCE(SUM(amount), 0)::float AS c FROM petty_cash_request WHERE float_id = $1 AND id <> $2 AND status = ANY($3::petty_cash_status[])`, [f.id, r.id, COMMITTED]);
    const available = round2(f.balance - c);
    if (r.amount > available) throw new ConflictException({ code: 'INSUFFICIENT_FLOAT', message: `${f.name} has ${available} available (balance ${f.balance}, ${c} committed)` });
    const dup = await this.duplicateOf(m, r);
    if (dup && !r.duplicateJustification) {
      throw new ConflictException({ code: 'POSSIBLE_DUPLICATE', message: `Same payee and amount as ${dup.number}: give a justification to continue`, duplicateOf: dup.number });
    }
    r.possibleDuplicateOf = dup?.id ?? null;
    await this.approvals.start(m, {
      documentType: DocumentType.PETTY_CASH_VOUCHER,
      documentId: r.id,
      documentNo: r.number,
      amount: r.amount,
      departmentId: r.departmentId,
      requestedBy: r.requestedBy,
      // Segregation of duties: the custodian who pays never approves.
      excludeUserIds: [f.custodianId],
      summary: `${r.kind === PettyCashKind.ADVANCE ? 'Advance' : 'Payment'} to ${r.payeeName}: ${r.purpose.slice(0, 80)}${dup ? ` · possible duplicate of ${dup.number}` : ''}`,
      link: `/petty-cash/${r.id}`,
    });
    r.status = PettyCashStatus.PENDING_APPROVAL;
    await m.save(r);
  }

  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const r = await m.findOneByOrFail(PettyCashRequest, { id: req.documentId });
    r.status = PettyCashStatus.APPROVED;
    await m.save(r);
    const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
    await this.notifications.dispatch(m, [f.custodianId], NotificationCategory.PETTY_CASH, { title: `${r.number} approved: pay ${r.payeeName}`, body: `${r.amount.toLocaleString('en-KE')} (${r.method})`, link: `/petty-cash/${r.id}` });
    await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.PETTY_CASH, { title: `${r.number} approved`, link: `/petty-cash/${r.id}` });
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const r = await m.findOneByOrFail(PettyCashRequest, { id: req.documentId });
    Object.assign(r, { status: PettyCashStatus.REJECTED, lastComment: comment });
    await m.save(r);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const r = await m.findOneByOrFail(PettyCashRequest, { id: req.documentId });
    Object.assign(r, { status: PettyCashStatus.RETURNED, lastComment: comment });
    await m.save(r);
  }

  /**
   * The custodian pays. Blocked (and logged) unless every approval level is
   * complete, the custodian of the float pays, and they neither asked for it
   * nor approved it. Cash moves now; M-PESA is dispatched.
   */
  async disburse(id: string, dto: DisburseDto, actor: SessionUser) {
    const r = await this.ds.getRepository(PettyCashRequest).findOneBy({ id });
    if (!r) throw new NotFoundException('Request not found');
    const f = await this.ds.getRepository(PettyCashFloat).findOneByOrFail({ id: r.floatId });
    const block = async (reason: string, err: Error) => {
      await this.audit.record({ action: 'PETTY_CASH_RELEASE_BLOCKED', entityType: 'petty_cash_request', entityId: id, after: { number: r.number, status: r.status, reason } });
      throw err;
    };
    const mpesa = MPESA_METHODS.includes(r.method as PaymentMethod);
    const payable = r.status === PettyCashStatus.APPROVED || (mpesa && r.status === PettyCashStatus.FAILED);
    if (!payable || !(await this.approvals.isApproved(this.ds.manager, DocumentType.PETTY_CASH_VOUCHER, id))) {
      await block('not fully approved', new ConflictException({ code: 'NOT_APPROVED', message: `Request is ${r.status}: every approval level must be complete before it is paid` }));
    }
    if (f.custodianId !== actor.id) await block('not the custodian', new ForbiddenException({ code: 'NOT_CUSTODIAN', message: `Only the custodian of ${f.name} pays from it` }));
    if (r.requestedBy === actor.id) await block('requester', new ForbiddenException({ code: 'SEGREGATION_OF_DUTIES', message: 'You asked for this payment and cannot pay it out' }));
    if ((await this.approvals.approvedBy(DocumentType.PETTY_CASH_VOUCHER, id)).includes(actor.id)) {
      await block('approver', new ForbiddenException({ code: 'SEGREGATION_OF_DUTIES', message: 'You approved this payment and cannot pay it out' }));
    }
    if (mpesa) {
      await this.payouts.dispatch('PCV', id, actor);
      return this.get(id);
    }
    await this.ds.transaction(async (m) => {
      const locked = await this.lock(m, id);
      if (locked.status !== PettyCashStatus.APPROVED) throw new ConflictException(`Request is ${locked.status}`);
      locked.disbursedBy = actor.id;
      locked.receivedByName = dto.receivedByName ?? null;
      await this.markDisbursed(m, locked, dto.reference?.trim() || locked.number);
    });
    return this.get(id);
  }

  /** Paid out: the float's cash book, the retirement date of an advance, and a replenishment when the float runs low. */
  private async markDisbursed(m: EntityManager, r: PettyCashRequest, reference: string) {
    const today = await this.settings.today(m);
    const f = await this.post(m, r.floatId, PettyCashTxnType.DISBURSEMENT, -r.amount, { type: 'PCV', id: r.id, no: r.number }, `${r.payeeName}: ${r.purpose.slice(0, 200)}`);
    Object.assign(r, { status: PettyCashStatus.DISBURSED, disbursedOn: today, reference });
    if (r.kind === PettyCashKind.ADVANCE) {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + (await this.settings.get('pettyCash.retirementDays', m)));
      r.retirementDueOn = d.toISOString().slice(0, 10);
    }
    await m.save(r);
    await this.notifications.dispatch(m, [r.payeeUserId ?? r.requestedBy], NotificationCategory.PETTY_CASH, {
      title: `${r.number}: paid`,
      body: r.kind === PettyCashKind.ADVANCE ? `Retire this advance with receipts by ${r.retirementDueOn}` : 'Please confirm you received it',
      link: `/petty-cash/${r.id}`,
    });
    if (f.balance < f.replenishThreshold) await this.autoReplenish(m, f);
  }

  /** The payee confirms they received the money. */
  async acknowledge(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if ((r.payeeUserId ?? r.requestedBy) !== actor.id) throw new ForbiddenException('Only the payee can confirm receipt');
      if (![PettyCashStatus.DISBURSED, PettyCashStatus.RETIREMENT_SUBMITTED, PettyCashStatus.RETIRED].includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
      if (!r.acknowledgedAt) Object.assign(r, { acknowledgedAt: new Date(), acknowledgedBy: actor.id });
      await m.save(r);
    });
    return this.get(id);
  }

  async cancel(id: string, reason: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
      const mine = r.requestedBy === actor.id;
      if (!mine && f.custodianId !== actor.id && !actor.permissions.includes(Permissions.PETTY_CASH_MANAGE)) throw new ForbiddenException('You cannot cancel this request');
      if (![...EDITABLE, PettyCashStatus.PENDING_APPROVAL, PettyCashStatus.APPROVED, PettyCashStatus.FAILED].includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
      if (await this.payouts.hasLiveAttempt(m, 'PCV', id)) throw new ConflictException('An M-PESA payment for this request is live or paid');
      await this.approvals.cancelPending(m, DocumentType.PETTY_CASH_VOUCHER, id, actor.id);
      Object.assign(r, { status: PettyCashStatus.CANCELLED, lastComment: reason });
      await m.save(r);
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ advances: retirement

  /** The holder of an advance accounts for it with receipts; the unspent balance is handed back. */
  async submitRetirement(id: string, dto: RetirementDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.kind !== PettyCashKind.ADVANCE) throw new BadRequestException('Only advances are retired');
      if (r.requestedBy !== actor.id) throw new ForbiddenException('Only the holder of the advance retires it');
      if (r.status !== PettyCashStatus.DISBURSED) throw new ConflictException(`Request is ${r.status}`);
      for (const l of dto.lines) if (l.glAccountId) await this.finance.assertGlAccount(m, l.glAccountId);
      await m.delete(PettyCashRetirementLine, { requestId: id });
      await m.save(dto.lines.map((l) => m.create(PettyCashRetirementLine, { requestId: id, description: l.description, amount: l.amount, glAccountId: l.glAccountId ?? r.glAccountId, receiptRef: l.receiptRef ?? null })));
      const spent = round2(dto.lines.reduce((s, l) => s + l.amount, 0));
      Object.assign(r, { status: PettyCashStatus.RETIREMENT_SUBMITTED, spentAmount: spent, refundAmount: round2(r.amount - spent), retirementNotes: dto.notes ?? null });
      await m.save(r);
      const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
      await this.notifications.dispatch(m, [f.custodianId], NotificationCategory.PETTY_CASH, {
        title: `${r.number}: retirement to check`,
        body: r.refundAmount! >= 0 ? `Spent ${spent}; ${r.refundAmount} to be handed back` : `Spent ${spent}: ${-r.refundAmount!} more than the advance`,
        link: `/petty-cash/${r.id}`,
      });
    });
    return this.get(id);
  }

  /** The custodian checks the receipts and takes the refund (or pays the overspend). */
  async verifyRetirement(id: string, dto: VerifyRetirementDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
      if (f.custodianId !== actor.id) throw new ForbiddenException(`Only the custodian of ${f.name} checks retirements`);
      if (r.requestedBy === actor.id) throw new ForbiddenException({ code: 'SEGREGATION_OF_DUTIES', message: 'You cannot check your own retirement' });
      if (r.status !== PettyCashStatus.RETIREMENT_SUBMITTED) throw new ConflictException(`Request is ${r.status}`);
      if (!dto.accept) {
        Object.assign(r, { status: PettyCashStatus.DISBURSED, lastComment: dto.comment ?? 'Retirement returned for correction' });
        await m.save(r);
        await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.PETTY_CASH, { title: `${r.number}: retirement returned`, body: r.lastComment, link: `/petty-cash/${r.id}` });
        return;
      }
      const ref = { type: 'PCV', id: r.id, no: r.number };
      if (r.refundAmount! > 0) await this.post(m, r.floatId, PettyCashTxnType.REFUND, r.refundAmount!, ref, 'Unspent advance returned');
      if (r.refundAmount! < 0) await this.post(m, r.floatId, PettyCashTxnType.TOP_UP, r.refundAmount!, ref, 'Advance overspent: difference paid');
      Object.assign(r, { status: PettyCashStatus.RETIRED, retiredAt: new Date(), retiredBy: actor.id, lastComment: dto.comment ?? null });
      await m.save(r);
      await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.PETTY_CASH, { title: `${r.number}: advance retired`, link: `/petty-cash/${r.id}` });
    });
    return this.get(id);
  }

  /** Job pettyCash.retirementReminders. */
  async remindRetirements() {
    const today = await this.settings.today();
    const due: { id: string; number: string; requested_by: string; custodian_id: string; retirement_due_on: string }[] = await this.ds.query(
      `SELECT r.id, r.number, r.requested_by, f.custodian_id, to_char(r.retirement_due_on, 'YYYY-MM-DD') AS retirement_due_on
         FROM petty_cash_request r JOIN petty_cash_float f ON f.id = r.float_id
        WHERE r.kind = 'ADVANCE' AND r.status = 'DISBURSED' AND r.retirement_due_on < $1::date`,
      [today],
    );
    for (const r of due) {
      await this.notifications.dispatch(this.ds.manager, [r.requested_by, r.custodian_id], NotificationCategory.PETTY_CASH, {
        title: `${r.number}: advance overdue for retirement`,
        body: `It was due on ${r.retirement_due_on}; no new advance can be given until it is retired`,
        link: `/petty-cash/${r.id}`,
      });
    }
    return { overdue: due.length };
  }

  // ------------------------------------------------------------------ M-PESA payout owner

  async claim(m: EntityManager, id: string, mode: 'release' | 'retry'): Promise<PayoutDoc | null> {
    const r = await this.lock(m, id);
    if (mode === 'retry') {
      if (r.status !== PettyCashStatus.PROCESSING) return null;
    } else {
      if (![PettyCashStatus.APPROVED, PettyCashStatus.FAILED].includes(r.status)) throw new ConflictException({ code: 'NOT_APPROVED', message: `Request is ${r.status}` });
      if (!(await this.approvals.isApproved(m, DocumentType.PETTY_CASH_VOUCHER, id))) throw new ConflictException({ code: 'NOT_APPROVED', message: 'Every approval level must be complete' });
      const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
      if (r.amount > f.balance) throw new ConflictException({ code: 'INSUFFICIENT_FLOAT', message: `${f.name} has ${f.balance} in hand` });
    }
    return { id: r.id, number: r.number, method: r.method as PaymentMethod, amount: r.amount, payeePhone: r.payeePhone, payeeShortcode: r.payeeShortcode, payeeAccountRef: r.payeeAccountRef, payeeName: r.payeeName };
  }

  async dispatched(m: EntityManager, id: string, releasedBy: string | null): Promise<void> {
    const r = await this.lock(m, id);
    r.status = PettyCashStatus.PROCESSING;
    if (releasedBy) r.disbursedBy = releasedBy;
    await m.save(r);
  }

  async paid(m: EntityManager, id: string, receipt: string): Promise<void> {
    const r = await this.lock(m, id);
    if ([PettyCashStatus.PROCESSING, PettyCashStatus.REVIEW].includes(r.status)) await this.markDisbursed(m, r, receipt);
  }

  async failed(m: EntityManager, id: string, status: 'FAILED' | 'REVIEW', note: string, onlyIfProcessing: boolean): Promise<void> {
    const r = await this.lock(m, id);
    if (onlyIfProcessing && r.status !== PettyCashStatus.PROCESSING) return;
    Object.assign(r, { status: status === 'FAILED' ? PettyCashStatus.FAILED : PettyCashStatus.REVIEW, lastComment: note });
    await m.save(r);
    const f = await m.findOneByOrFail(PettyCashFloat, { id: r.floatId });
    await this.notifications.dispatch(m, [f.custodianId, r.requestedBy], NotificationCategory.PETTY_CASH, { title: `${r.number}: M-PESA payment ${status === 'FAILED' ? 'failed' : 'needs review'}`, body: note, link: `/petty-cash/${r.id}` });
  }

  async assertReversible(m: EntityManager, id: string): Promise<void> {
    const r = await this.lock(m, id);
    if (r.status !== PettyCashStatus.DISBURSED) throw new ConflictException(`Request is ${r.status}`);
  }

  async reversed(m: EntityManager, id: string, note: string): Promise<void> {
    const r = await this.lock(m, id);
    await this.post(m, r.floatId, PettyCashTxnType.REVERSAL, r.amount, { type: 'PCV', id: r.id, no: r.number }, note);
    Object.assign(r, { status: PettyCashStatus.REVERSED, lastComment: note });
    await m.save(r);
  }

  /** Review queue: paid (with the M-PESA receipt) or not paid, after checking the statement. */
  async resolve(id: string, dto: ResolvePettyCashDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (![PettyCashStatus.REVIEW, PettyCashStatus.FAILED].includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
      if (dto.outcome === 'PAID' && !dto.reference?.trim()) throw new BadRequestException('Give the M-PESA receipt');
      await this.payouts.resolveAttempts(m, 'PCV', id, dto.outcome, dto.reference?.trim() ?? null, dto.note);
      if (dto.outcome === 'PAID') await this.markDisbursed(m, r, dto.reference!.trim());
      else {
        Object.assign(r, { status: PettyCashStatus.APPROVED, lastComment: `Not paid (checked by hand): ${dto.note}` });
        await m.save(r);
      }
      await this.audit.record({ action: 'PAYMENT_RESOLVED', entityType: 'petty_cash_request', entityId: id, after: { outcome: dto.outcome, reference: dto.reference ?? null, note: dto.note, by: actor.id } }, m);
    });
    return this.get(id);
  }

  async reverse(id: string, reason: string, actor: SessionUser) {
    await this.payouts.reverse('PCV', id, reason, actor);
    return this.get(id);
  }

  // ------------------------------------------------------------------ replenishment

  async createReplenishment(dto: ReplenishmentDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const f = await m.findOneBy(PettyCashFloat, { id: dto.floatId });
      if (!f) throw new NotFoundException('Float not found');
      if (f.custodianId !== actor.id && !actor.permissions.includes(Permissions.PETTY_CASH_MANAGE)) throw new ForbiddenException('Only the custodian or petty cash managers request replenishments');
      return (await this.newReplenishment(m, f, actor.id, dto.amount, dto.reason ?? null)).id;
    });
    return this.getReplenishment(id);
  }

  private async newReplenishment(m: EntityManager, f: PettyCashFloat, requestedBy: string, amount: number | undefined, reason: string | null) {
    const [open] = await m.query(`SELECT number FROM petty_cash_replenishment WHERE float_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED')`, [f.id]);
    if (open) throw new ConflictException({ code: 'REPLENISHMENT_OPEN', message: `${open.number} is already open for ${f.name}` });
    const amt = round2(amount ?? f.floatLimit - f.balance);
    if (amt <= 0) throw new BadRequestException(`${f.name} is at its limit`);
    if (f.balance + amt > f.floatLimit + 0.005) throw new BadRequestException({ code: 'OVER_FLOAT_LIMIT', message: `At most ${round2(f.floatLimit - f.balance)} brings ${f.name} to its limit` });
    const rp = await m.save(
      m.create(PettyCashReplenishment, {
        number: await this.numbering.next(DocumentType.PETTY_CASH_REPLENISHMENT, { manager: m }),
        floatId: f.id,
        status: ReplenishmentStatus.PENDING_APPROVAL,
        amount: amt,
        balanceAtRequest: f.balance,
        requestedBy,
        reason,
      }),
    );
    await this.approvals.start(m, {
      documentType: DocumentType.PETTY_CASH_REPLENISHMENT,
      documentId: rp.id,
      documentNo: rp.number,
      amount: amt,
      departmentId: f.departmentId ?? undefined,
      requestedBy,
      excludeUserIds: [f.custodianId],
      summary: `Top up ${f.name} (balance ${f.balance}, limit ${f.floatLimit})`,
      link: `/petty-cash/replenishments/${rp.id}`,
    });
    return rp;
  }

  /** The float fell below its threshold: a replenishment goes for approval (unless one is open). */
  private async autoReplenish(m: EntityManager, f: PettyCashFloat) {
    const [open] = await m.query(`SELECT 1 FROM petty_cash_replenishment WHERE float_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED')`, [f.id]);
    if (open) return;
    const rp = await this.newReplenishment(m, f, f.custodianId, undefined, `Balance ${f.balance} is below the threshold of ${f.replenishThreshold}`);
    await this.notifications.dispatch(m, [f.custodianId], NotificationCategory.PETTY_CASH, { title: `${f.name} is low: ${rp.number} requested`, link: `/petty-cash/replenishments/${rp.id}` });
  }

  private async replenishmentDecided(m: EntityManager, req: ApprovalRequest, status: ReplenishmentStatus, comment: string | null) {
    const rp = await m.findOneByOrFail(PettyCashReplenishment, { id: req.documentId });
    Object.assign(rp, { status, lastComment: comment });
    await m.save(rp);
    const f = await m.findOneByOrFail(PettyCashFloat, { id: rp.floatId });
    await this.notifications.dispatch(m, [f.custodianId], NotificationCategory.PETTY_CASH, { title: `${rp.number} ${status.toLowerCase()}`, body: comment, link: `/petty-cash/replenishments/${rp.id}` });
  }

  async submitReplenishment(id: string) {
    await this.ds.transaction(async (m) => {
      const rp = await m.findOne(PettyCashReplenishment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!rp) throw new NotFoundException('Replenishment not found');
      if (rp.status !== ReplenishmentStatus.RETURNED) throw new ConflictException(`Replenishment is ${rp.status}`);
      const f = await m.findOneByOrFail(PettyCashFloat, { id: rp.floatId });
      await this.approvals.start(m, { documentType: DocumentType.PETTY_CASH_REPLENISHMENT, documentId: rp.id, documentNo: rp.number, amount: rp.amount, departmentId: f.departmentId ?? undefined, requestedBy: rp.requestedBy, excludeUserIds: [f.custodianId], link: `/petty-cash/replenishments/${rp.id}` });
      rp.status = ReplenishmentStatus.PENDING_APPROVAL;
      await m.save(rp);
    });
    return this.getReplenishment(id);
  }

  /** The custodian receives the approved top-up into the float. */
  async receiveReplenishment(id: string, reference: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const rp = await m.findOne(PettyCashReplenishment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!rp) throw new NotFoundException('Replenishment not found');
      const f = await m.findOneByOrFail(PettyCashFloat, { id: rp.floatId });
      if (f.custodianId !== actor.id) throw new ForbiddenException(`Only the custodian of ${f.name} receives the cash`);
      if (rp.status !== ReplenishmentStatus.APPROVED || !(await this.approvals.isApproved(m, DocumentType.PETTY_CASH_REPLENISHMENT, id))) throw new ConflictException({ code: 'NOT_APPROVED', message: `Replenishment is ${rp.status}` });
      await this.post(m, f.id, PettyCashTxnType.REPLENISHMENT, rp.amount, { type: 'PCRP', id: rp.id, no: rp.number }, `Top-up ${reference}`);
      Object.assign(rp, { status: ReplenishmentStatus.RECEIVED, receivedAt: new Date(), receivedBy: actor.id, reference });
      await m.save(rp);
    });
    return this.getReplenishment(id);
  }

  async cancelReplenishment(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const rp = await m.findOne(PettyCashReplenishment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!rp) throw new NotFoundException('Replenishment not found');
      if (![ReplenishmentStatus.DRAFT, ReplenishmentStatus.PENDING_APPROVAL, ReplenishmentStatus.RETURNED, ReplenishmentStatus.APPROVED].includes(rp.status)) throw new ConflictException(`Replenishment is ${rp.status}`);
      await this.approvals.cancelPending(m, DocumentType.PETTY_CASH_REPLENISHMENT, id, actor.id);
      rp.status = ReplenishmentStatus.CANCELLED;
      await m.save(rp);
    });
    return this.getReplenishment(id);
  }

  async getReplenishment(id: string) {
    const rp = await this.ds.getRepository(PettyCashReplenishment).findOne({ where: { id }, relations: { float: true } });
    if (!rp) throw new NotFoundException('Replenishment not found');
    return rp;
  }

  replenishments(floatId?: string) {
    return this.ds.getRepository(PettyCashReplenishment).find({ where: floatId ? { floatId } : {}, relations: { float: true }, order: { createdAt: 'DESC' }, take: 200 });
  }

  // ------------------------------------------------------------------ counts and the cash book

  /** Cash count: the variance against the ledger balance is recorded (and the managers told). */
  async count(floatId: string, dto: CountDto, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const f = await m.findOne(PettyCashFloat, { where: { id: floatId }, lock: { mode: 'pessimistic_write' } });
      if (!f) throw new NotFoundException('Float not found');
      if (f.custodianId !== actor.id && !actor.permissions.includes(Permissions.PETTY_CASH_MANAGE)) throw new ForbiddenException('Only the custodian or petty cash managers count the float');
      const c = await m.save(m.create(PettyCashCount, { floatId, countedBy: actor.id, expected: f.balance, counted: dto.counted, variance: round2(dto.counted - f.balance), notes: dto.notes ?? null }));
      if (Math.abs(c.variance) > 0.005) {
        const managers: { user_id: string }[] = await m.query(
          `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
          [Permissions.PETTY_CASH_MANAGE],
        );
        await this.notifications.dispatch(m, managers.map((x) => x.user_id), NotificationCategory.PETTY_CASH, {
          title: `${f.name}: cash count variance ${c.variance > 0 ? '+' : ''}${c.variance}`,
          body: `Counted ${c.counted}, the cash book says ${c.expected}`,
          link: `/petty-cash/floats/${f.id}`,
        });
      }
      return c;
    });
  }

  /** Cash book of a period: opening + replenishments + refunds − disbursements … = closing, with the counts. */
  async statement(floatId: string, from: string, to: string) {
    const f = await this.ds.getRepository(PettyCashFloat).findOne({ where: { id: floatId }, relations: { department: true } });
    if (!f) throw new NotFoundException('Float not found');
    const [before] = await this.ds.query(
      `SELECT balance_after::float AS b FROM petty_cash_transaction WHERE float_id = $1 AND txn_date < $2::date ORDER BY txn_date DESC, created_at DESC LIMIT 1`,
      [floatId, from],
    );
    const txns: (PettyCashTransaction & { amount: number })[] = await this.ds.query(
      `SELECT id, txn_date AS "txnDate", type, amount::float AS amount, balance_after::float AS "balanceAfter", ref_type AS "refType", ref_id AS "refId", ref_no AS "refNo", note, created_at AS "createdAt"
         FROM petty_cash_transaction WHERE float_id = $1 AND txn_date BETWEEN $2::date AND $3::date ORDER BY txn_date, created_at`,
      [floatId, from, to],
    );
    const sum = (t: PettyCashTxnType) => round2(txns.filter((x) => x.type === t).reduce((s, x) => s + x.amount, 0));
    const opening = before?.b ?? 0;
    const totals = Object.fromEntries(Object.values(PettyCashTxnType).map((t) => [t, sum(t)])) as Record<PettyCashTxnType, number>;
    const closing = round2(opening + txns.reduce((s, x) => s + x.amount, 0));
    const counts = await this.ds.query(
      `SELECT c.id, c.created_at AS "countedAt", u.full_name AS "countedBy", c.expected::float AS expected, c.counted::float AS counted, c.variance::float AS variance, c.notes
         FROM petty_cash_count c JOIN app_user u ON u.id = c.counted_by WHERE c.float_id = $1 AND c.created_at::date BETWEEN $2::date AND $3::date ORDER BY c.created_at`,
      [floatId, from, to],
    );
    return { float: f, from, to, opening, totals, closing, balanced: Math.abs(closing - (txns.length ? txns[txns.length - 1].balanceAfter : opening)) < 0.01, transactions: txns, counts };
  }

  // ------------------------------------------------------------------ reads

  async lock(m: EntityManager, id: string): Promise<PettyCashRequest> {
    const r = await m.findOne(PettyCashRequest, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  async get(id: string, actor?: SessionUser) {
    const r = await this.ds.getRepository(PettyCashRequest).findOne({ where: { id }, relations: { float: true, glAccount: true, department: true, retirementLines: true } });
    if (!r) throw new NotFoundException('Request not found');
    if (actor && !(await this.canSee(this.ds.manager, r, actor))) throw new ForbiddenException('You cannot see this request');
    const users: { id: string; full_name: string }[] = await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [[r.requestedBy, r.disbursedBy, r.float?.custodianId, r.retiredBy].filter(Boolean)]);
    const name = (u: string | null | undefined) => users.find((x) => x.id === u)?.full_name ?? null;
    const [dup] = r.possibleDuplicateOf ? await this.ds.query(`SELECT id, number FROM petty_cash_request WHERE id = $1`, [r.possibleDuplicateOf]) : [];
    return {
      ...r,
      requestedByName: name(r.requestedBy),
      disbursedByName: name(r.disbursedBy),
      custodianName: name(r.float?.custodianId),
      retiredByName: name(r.retiredBy),
      duplicate: dup ?? null,
      overdue: r.kind === PettyCashKind.ADVANCE && r.status === PettyCashStatus.DISBURSED && !!r.retirementDueOn && r.retirementDueOn < (await this.settings.today()),
      attempts: await this.payouts.attempts('PCV', id),
    };
  }

  async list(q: PettyCashQueryDto, actor: SessionUser) {
    const qb = this.ds.getRepository(PettyCashRequest).createQueryBuilder('r').leftJoinAndSelect('r.float', 'f').orderBy('r.createdAt', 'DESC');
    const scope = q.scope ?? 'mine';
    if (scope === 'mine') qb.andWhere('(r.requested_by = :me OR r.payee_user_id = :me)', { me: actor.id });
    else if (scope === 'custodian') qb.andWhere('f.custodian_id = :me', { me: actor.id });
    else if (!actor.permissions.includes(Permissions.PETTY_CASH_MANAGE)) throw new ForbiddenException('You cannot see every petty cash request');
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.floatId) qb.andWhere('r.float_id = :f', { f: q.floatId });
    if (q.kind) qb.andWhere('r.kind = :k', { k: q.kind });
    if (q.review) qb.andWhere(`r.status IN ('FAILED', 'REVIEW')`);
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Printable petty cash voucher with the approval signatures and the payee's acknowledgement. */
  async renderPdf(id: string, actor: SessionUser): Promise<{ number: string; pdf: Buffer }> {
    const r = await this.get(id, actor);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const cur = await this.settings.get('locale.currency');
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const history = await this.approvals.history(DocumentType.PETTY_CASH_VOUCHER, id);
    const signs = history.flatMap((h) => h.actions.filter((a) => a.action === 'APPROVE').map((a) => `${esc(a.stepName ?? '')}: ${esc(a.userName ?? '')}<br>${d(a.at)}`));
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">PETTY CASH ${r.kind === PettyCashKind.ADVANCE ? 'ADVANCE ' : ''}VOUCHER</h1>
      <div class="grid"><div class="box">Voucher: <b>${esc(r.number)}</b><br>Float: ${esc(r.float?.name)}<br>Payee: ${esc(r.payeeName)}<br>Cost centre: ${esc(r.department?.name)}</div>
      <div class="box">Status: ${esc(r.status)}<br>Paid: ${d(r.disbursedOn) || '—'} · ${esc(r.method)}${r.reference ? ` · ${esc(r.reference)}` : ''}<br>Account: ${esc(r.glAccount ? `${r.glAccount.code} ${r.glAccount.name}` : '—')}</div></div>
      <p><b>Purpose:</b> ${esc(r.purpose)}</p>
      <p style="font-size:16px"><b>Amount: ${money(r.amount, cur)}</b></p>
      ${(r.retirementLines ?? []).length ? `<table><thead><tr><th>Receipt</th><th>Description</th><th class="r">Amount</th></tr></thead><tbody>${r.retirementLines!.map((l) => `<tr><td>${esc(l.receiptRef ?? '')}</td><td>${esc(l.description)}</td><td class="r">${money(l.amount, cur)}</td></tr>`).join('')}</tbody></table><p>Spent ${money(r.spentAmount ?? 0, cur)} · ${(r.refundAmount ?? 0) >= 0 ? `returned ${money(r.refundAmount ?? 0, cur)}` : `overspent ${money(-(r.refundAmount ?? 0), cur)}`}</p>` : ''}
      <div class="signs"><div class="sign">Requested by: ${esc(r.requestedByName ?? '')}</div>${signs.map((x) => `<div class="sign">Approved — ${x}</div>`).join('')}<div class="sign">Paid by (custodian): ${esc(r.disbursedByName ?? '')}</div><div class="sign">Received by: ${esc(r.receivedByName ?? (r.acknowledgedAt ? r.payeeName : ''))}${r.acknowledgedAt ? `<br>Confirmed in the system ${d(r.acknowledgedAt)}` : '<br>Signature'}</div></div>
    </body></html>`;
    return { number: r.number, pdf: await this.pdf.render(html) };
  }
}

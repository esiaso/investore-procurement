import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  DocumentType,
  InvoiceStatus,
  MPESA_METHODS,
  NotificationCategory,
  Paginated,
  PaymentMethod,
  PaymentVoucherStatus,
  Permissions,
  PurchaseOrderStatus,
  SessionUser,
} from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import { likeTerm } from '../../common/pagination';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { AuditService } from '../audit/audit.service';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { PaymentVoucher, PaymentVoucherLine, PurchaseOrder, SupplierInvoice } from '../purchasing/purchasing.entities';
import { SettingsService } from '../settings/settings.service';
import { PayoutDoc, PayoutOwner } from './payout-owner';
import { normalisePayee } from './payout-rules';
import { CreateVoucherDto, PayablesQueryDto, ReleaseDto, ResolveDto, VoucherQueryDto } from './payments.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Vouchers holding an invoice amount until they are paid or dropped. */
const OPEN_VOUCHER = [
  PaymentVoucherStatus.DRAFT,
  PaymentVoucherStatus.PENDING_APPROVAL,
  PaymentVoucherStatus.RETURNED,
  PaymentVoucherStatus.APPROVED,
  PaymentVoucherStatus.PROCESSING,
  PaymentVoucherStatus.FAILED,
  PaymentVoucherStatus.REVIEW,
];
const PAYABLE_INVOICE = [InvoiceStatus.APPROVED, InvoiceStatus.SCHEDULED, InvoiceStatus.PARTIALLY_PAID];

/**
 * Supplier payments (A6): vouchers batching one supplier's approved invoices,
 * their own approval (preparer ≠ approver ≠ payer), release by bank / cheque
 * reference or through M-PESA, and the invoice balances that follow.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, ApprovalHandler, PayoutOwner {
  readonly type = 'PV' as const;

  /** M-PESA dispatch (set by the payouts service to avoid a dependency cycle). */
  private dispatcher: ((voucherId: string, actor: SessionUser) => Promise<void>) | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.PAYMENT_VOUCHER, this);
    this.links.registerResolver(DocumentType.PAYMENT_VOUCHER, async (ids) => {
      const rows = await this.ds.getRepository(PaymentVoucher).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.paidOn ?? r.createdAt.toISOString(), amount: r.amount }]));
    });
  }

  useDispatcher(fn: (voucherId: string, actor: SessionUser) => Promise<void>) {
    this.dispatcher = fn;
  }

  // ------------------------------------------------------------------ payables

  /** Approved invoices with what is still to pay (not on an open voucher), ageing by due date. */
  async payables(q: PayablesQueryDto) {
    const today = await this.settings.today();
    const params: unknown[] = [PAYABLE_INVOICE, OPEN_VOUCHER, today];
    const where = [`i.status = ANY($1::invoice_status[])`];
    if (q.supplierId) where.push(`i.supplier_id = $${params.push(q.supplierId)}`);
    const rows: Record<string, unknown>[] = await this.ds.query(
      `SELECT i.id, i.number, i.supplier_invoice_no AS "supplierInvoiceNo", i.supplier_id AS "supplierId", s.name AS supplier, i.invoice_date AS "invoiceDate",
              COALESCE(i.due_date, i.invoice_date) AS "dueDate", i.currency, i.total::float AS total, i.wht_total::float AS "whtTotal", i.paid_amount::float AS "paidAmount",
              COALESCE((SELECT SUM(l.amount) FROM payment_voucher_line l JOIN payment_voucher v ON v.id = l.voucher_id WHERE l.invoice_id = i.id AND v.status = ANY($2::payment_voucher_status[])), 0)::float AS scheduled,
              ($3::date - COALESCE(i.due_date, i.invoice_date))::int AS "daysOverdue", po.number AS "orderNumber"
         FROM supplier_invoice i JOIN supplier s ON s.id = i.supplier_id JOIN purchase_order po ON po.id = i.purchase_order_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.name, COALESCE(i.due_date, i.invoice_date)`,
      params,
    );
    return rows
      .map((r) => {
        const outstanding = round2((r.total as number) - (r.paidAmount as number));
        const available = round2(outstanding - (r.scheduled as number));
        const d = r.daysOverdue as number;
        return { ...r, outstanding, available, bucket: d <= 0 ? 'CURRENT' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+' };
      })
      .filter((r) => r.outstanding > 0);
  }

  // ------------------------------------------------------------------ vouchers

  async create(dto: CreateVoucherDto, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const supplier = (await m.query(`SELECT id, name FROM supplier WHERE id = $1`, [dto.supplierId]))[0];
      if (!supplier) throw new NotFoundException('Supplier not found');
      const invoices = await m.find(SupplierInvoice, { where: { id: In(dto.invoices.map((i) => i.invoiceId)) }, lock: { mode: 'pessimistic_write' } });
      if (invoices.length !== new Set(dto.invoices.map((i) => i.invoiceId)).size) throw new BadRequestException('An invoice was not found or is listed twice');
      const base = await this.settings.get('locale.currency', m);
      const currency = invoices[0].currency;
      const lines: Partial<PaymentVoucherLine>[] = [];
      for (const want of dto.invoices) {
        const inv = invoices.find((i) => i.id === want.invoiceId)!;
        if (inv.supplierId !== dto.supplierId) throw new BadRequestException(`${inv.number} is from another supplier`);
        if (inv.currency !== currency) throw new BadRequestException('All invoices on a voucher must be in the same currency');
        if (!PAYABLE_INVOICE.includes(inv.status)) throw new ConflictException(`${inv.number} is ${inv.status}; only approved invoices can be paid`);
        const available = await this.available(m, inv);
        const amount = round2(want.amount ?? available);
        if (amount <= 0 || amount > available + 0.005) throw new BadRequestException({ code: 'OVER_PAYMENT', message: `${inv.number}: at most ${available} is still to pay` });
        // Withholding tax in proportion to the part paid.
        const whtAmount = inv.total > 0 ? round2((inv.whtTotal * amount) / inv.total) : 0;
        lines.push({ invoiceId: inv.id, amount, whtAmount, netAmount: round2(amount - whtAmount) });
      }
      const method = dto.method;
      const gross = round2(lines.reduce((s, l) => s + l.amount!, 0));
      const wht = round2(lines.reduce((s, l) => s + l.whtAmount!, 0));
      const net = round2(gross - wht);
      let payee: ReturnType<typeof normalisePayee>;
      try {
        payee = normalisePayee(method, dto);
      } catch (e) {
        throw new BadRequestException({ code: 'INVALID_PAYEE', message: (e as Error).message });
      }
      if (MPESA_METHODS.includes(method)) {
        if (currency !== base) throw new BadRequestException(`M-PESA pays in ${base} only`);
        if (Math.round(net) !== net) throw new BadRequestException({ code: 'WHOLE_SHILLINGS', message: `M-PESA pays whole shillings: the net amount is ${net}` });
      }
      const v = await m.save(
        m.create(PaymentVoucher, {
          number: await this.numbering.next(DocumentType.PAYMENT_VOUCHER, { manager: m }),
          supplierId: dto.supplierId,
          invoiceId: lines.length === 1 ? lines[0].invoiceId! : null,
          status: PaymentVoucherStatus.DRAFT,
          method,
          currency,
          grossAmount: gross,
          whtAmount: wht,
          amount: net,
          dueDate: dto.dueDate ?? null,
          payeeName: dto.payeeName ?? supplier.name,
          ...payee,
          narrative: dto.narrative ?? null,
          preparedBy: actor.id,
          lines: lines.map((l) => m.create(PaymentVoucherLine, l)),
        }),
      );
      for (const inv of invoices) {
        await this.links.link(m, { type: DocumentType.SUPPLIER_INVOICE, id: inv.id, no: inv.number }, { type: DocumentType.PAYMENT_VOUCHER, id: v.id, no: v.number });
        await this.refreshInvoice(m, inv.id);
      }
      return v.id;
    });
    return this.get(id);
  }

  /** Outstanding on an invoice not already on another open voucher. */
  private async available(m: EntityManager, inv: SupplierInvoice, exceptVoucherId?: string): Promise<number> {
    const [{ s }] = await m.query(
      `SELECT COALESCE(SUM(l.amount), 0)::float AS s FROM payment_voucher_line l JOIN payment_voucher v ON v.id = l.voucher_id
        WHERE l.invoice_id = $1 AND v.status = ANY($2::payment_voucher_status[]) AND ($3::uuid IS NULL OR v.id <> $3)`,
      [inv.id, OPEN_VOUCHER, exceptVoucherId ?? null],
    );
    return round2(inv.total - inv.paidAmount - s);
  }

  /** APPROVED → SCHEDULED (on a voucher) → PARTIALLY_PAID → PAID, from what is paid and scheduled. */
  async refreshInvoice(m: EntityManager, invoiceId: string): Promise<void> {
    const inv = await m.findOneByOrFail(SupplierInvoice, { id: invoiceId });
    if (!PAYABLE_INVOICE.includes(inv.status) && inv.status !== InvoiceStatus.PAID) return;
    const [{ s }] = await m.query(
      `SELECT COALESCE(SUM(l.amount), 0)::float AS s FROM payment_voucher_line l JOIN payment_voucher v ON v.id = l.voucher_id
        WHERE l.invoice_id = $1 AND v.status = ANY($2::payment_voucher_status[])`,
      [invoiceId, OPEN_VOUCHER],
    );
    inv.status =
      inv.paidAmount >= inv.total - 0.005
        ? InvoiceStatus.PAID
        : inv.paidAmount > 0
          ? InvoiceStatus.PARTIALLY_PAID
          : s > 0
            ? InvoiceStatus.SCHEDULED
            : InvoiceStatus.APPROVED;
    await m.save(inv);
    // The order is PAID once fully invoiced and every invoice is paid (and back when a payment is reversed).
    const po = await m.findOneBy(PurchaseOrder, { id: inv.purchaseOrderId });
    if (!po || ![PurchaseOrderStatus.INVOICED, PurchaseOrderStatus.PAID].includes(po.status)) return;
    const [{ unpaid }] = await m.query(
      `SELECT COUNT(*)::int AS unpaid FROM supplier_invoice WHERE purchase_order_id = $1 AND status NOT IN ('PAID', 'CANCELLED', 'REJECTED')`,
      [po.id],
    );
    const status = unpaid ? PurchaseOrderStatus.INVOICED : PurchaseOrderStatus.PAID;
    if (po.status !== status) {
      po.status = status;
      await m.save(po);
    }
  }

  async submit(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const v = await this.lock(m, id);
      if (![PaymentVoucherStatus.DRAFT, PaymentVoucherStatus.RETURNED].includes(v.status)) throw new ConflictException(`Voucher is ${v.status}`);
      const lines = await m.find(PaymentVoucherLine, { where: { voucherId: id }, relations: { invoice: true } });
      for (const l of lines) {
        if (!PAYABLE_INVOICE.includes(l.invoice!.status)) throw new ConflictException(`${l.invoice!.number} is ${l.invoice!.status}`);
      }
      const baseValue = round2(lines.reduce((s, l) => s + l.amount * (l.invoice!.exchangeRate || 1), 0));
      const [s] = await m.query(`SELECT name FROM supplier WHERE id = $1`, [v.supplierId]);
      await this.approvals.start(m, {
        documentType: DocumentType.PAYMENT_VOUCHER,
        documentId: v.id,
        documentNo: v.number,
        amount: baseValue,
        currency: v.currency,
        requestedBy: v.preparedBy ?? actor.id,
        // Segregation of duties: whoever prepared the payment never approves it.
        excludeUserIds: [v.preparedBy, actor.id].filter((u): u is string => !!u),
        summary: `${s?.name ?? ''} · ${v.method} · ${lines.length} invoice(s)`,
        link: `/payment-vouchers/${v.id}`,
      });
      v.status = PaymentVoucherStatus.PENDING_APPROVAL;
      await m.save(v);
    });
    return this.get(id);
  }

  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const v = await m.findOneByOrFail(PaymentVoucher, { id: req.documentId });
    v.status = PaymentVoucherStatus.APPROVED;
    await m.save(v);
    // Tell the people who can release it (never the preparer).
    const releasers: { user_id: string }[] = await m.query(
      `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
      [Permissions.PAYMENTS_RELEASE],
    );
    await this.notifications.dispatch(m, releasers.map((r) => r.user_id).filter((u) => u !== v.preparedBy), NotificationCategory.PAYMENTS, {
      title: `${v.number} approved: ready to pay`,
      body: `${v.method} ${v.currency} ${v.amount.toLocaleString('en-KE')}`,
      link: `/payment-vouchers/${v.id}`,
    });
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const v = await m.findOneByOrFail(PaymentVoucher, { id: req.documentId });
    v.status = PaymentVoucherStatus.REJECTED;
    v.lastComment = comment;
    await m.save(v);
    await this.releaseInvoices(m, v.id);
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    const v = await m.findOneByOrFail(PaymentVoucher, { id: req.documentId });
    v.status = PaymentVoucherStatus.RETURNED;
    v.lastComment = comment;
    await m.save(v);
  }

  private async releaseInvoices(m: EntityManager, voucherId: string) {
    const lines = await m.find(PaymentVoucherLine, { where: { voucherId } });
    for (const l of lines) await this.refreshInvoice(m, l.invoiceId);
  }

  /**
   * Releases an approved payment. Blocked (and the attempt logged) unless
   * every approval level is complete and the releaser is neither the
   * preparer nor an approver. Bank / cheque / cash need the reference;
   * M-PESA is dispatched.
   */
  async release(id: string, dto: ReleaseDto, actor: SessionUser) {
    const v = await this.ds.getRepository(PaymentVoucher).findOneBy({ id });
    if (!v) throw new NotFoundException('Voucher not found');
    const block = async (reason: string, err: Error) => {
      await this.audit.record({ action: 'PAYMENT_RELEASE_BLOCKED', entityType: 'payment_voucher', entityId: id, after: { number: v.number, status: v.status, reason } });
      throw err;
    };
    // FAILED = the channel definitely did not pay it (refused / failed result): it may be released again.
    const releasable = v.status === PaymentVoucherStatus.APPROVED || (v.status === PaymentVoucherStatus.FAILED && MPESA_METHODS.includes(v.method as PaymentMethod));
    if (!releasable || !(await this.approvals.isApproved(this.ds.manager, DocumentType.PAYMENT_VOUCHER, id))) {
      await block('not fully approved', new ConflictException({ code: 'NOT_APPROVED', message: `Voucher is ${v.status}: every approval level must be complete before it is paid` }));
    }
    if (v.preparedBy === actor.id) await block('preparer', new ForbiddenException({ code: 'SEGREGATION_OF_DUTIES', message: 'You prepared this payment and cannot release it' }));
    if ((await this.approvals.approvedBy(DocumentType.PAYMENT_VOUCHER, id)).includes(actor.id)) {
      await block('approver', new ForbiddenException({ code: 'SEGREGATION_OF_DUTIES', message: 'You approved this payment and cannot release it' }));
    }
    if (MPESA_METHODS.includes(v.method as PaymentMethod)) {
      if (!this.dispatcher) throw new ConflictException('M-PESA payouts are not available');
      await this.dispatcher(id, actor);
      return this.get(id);
    }
    if (!dto.paymentReference?.trim()) throw new BadRequestException(`A ${v.method === PaymentMethod.CHEQUE ? 'cheque number' : 'payment reference'} is required`);
    await this.ds.transaction(async (m) => {
      const locked = await this.lock(m, id);
      if (locked.status !== PaymentVoucherStatus.APPROVED) throw new ConflictException(`Voucher is ${locked.status}`);
      locked.releasedBy = actor.id;
      locked.releasedAt = new Date();
      await this.markPaid(m, locked, dto.paymentReference!.trim(), dto.paidOn ?? (await this.settings.today(m)));
    });
    return this.get(id);
  }

  /** Paid: the invoices are settled (cash + WHT) and the preparer is told. */
  async markPaid(m: EntityManager, v: PaymentVoucher, reference: string, paidOn: string): Promise<void> {
    v.status = PaymentVoucherStatus.PAID;
    v.paymentReference = reference;
    v.paidOn = paidOn;
    await m.save(v);
    const lines = await m.find(PaymentVoucherLine, { where: { voucherId: v.id } });
    for (const l of lines) {
      await m.query(`UPDATE supplier_invoice SET paid_amount = paid_amount + $2 WHERE id = $1`, [l.invoiceId, l.amount]);
      await this.refreshInvoice(m, l.invoiceId);
    }
    if (v.preparedBy) {
      await this.notifications.dispatch(m, [v.preparedBy], NotificationCategory.PAYMENTS, { title: `${v.number} paid`, body: `Reference ${reference}`, link: `/payment-vouchers/${v.id}` });
    }
  }

  /** A paid voucher reversed: the invoices are owed again. */
  async markReversed(m: EntityManager, v: PaymentVoucher, note: string): Promise<void> {
    v.status = PaymentVoucherStatus.REVERSED;
    v.lastComment = note;
    await m.save(v);
    const lines = await m.find(PaymentVoucherLine, { where: { voucherId: v.id } });
    for (const l of lines) {
      await m.query(`UPDATE supplier_invoice SET paid_amount = GREATEST(0, paid_amount - $2) WHERE id = $1`, [l.invoiceId, l.amount]);
      await this.refreshInvoice(m, l.invoiceId);
    }
  }

  /** Failed / unknown outcome: into the review queue, and the reconcilers and the preparer are told. */
  async toReview(m: EntityManager, v: PaymentVoucher, status: PaymentVoucherStatus.FAILED | PaymentVoucherStatus.REVIEW, note: string): Promise<void> {
    v.status = status;
    v.lastComment = note;
    await m.save(v);
    const who: { user_id: string }[] = await m.query(
      `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
      [Permissions.PAYMENTS_RECONCILE],
    );
    await this.notifications.dispatch(m, [...who.map((r) => r.user_id), v.preparedBy ?? ''], NotificationCategory.PAYMENTS, {
      title: `${v.number}: payment ${status === PaymentVoucherStatus.FAILED ? 'failed' : 'needs review'}`,
      body: note,
      link: `/payment-vouchers/${v.id}`,
    });
  }

  /**
   * Settles a voucher in the review queue by hand, after checking the M-PESA
   * statement / bank: PAID needs the receipt or reference; FAILED frees the
   * invoices (the next release creates a fresh M-PESA attempt).
   */
  async resolve(id: string, dto: ResolveDto, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const v = await this.lock(m, id);
      if (![PaymentVoucherStatus.REVIEW, PaymentVoucherStatus.FAILED].includes(v.status)) throw new ConflictException(`Voucher is ${v.status}`);
      const live: { id: string; status: string }[] = await m.query(`SELECT id, status FROM mpesa_payout WHERE voucher_id = $1 AND status IN ('PENDING', 'UNKNOWN', 'SUCCESS')`, [id]);
      if (dto.outcome === 'PAID') {
        if (!dto.reference?.trim()) throw new BadRequestException('Give the M-PESA receipt / payment reference');
        for (const p of live) await m.query(`UPDATE mpesa_payout SET status = 'SUCCESS', receipt_no = COALESCE(receipt_no, $2), result_desc = $3, next_check_at = NULL WHERE id = $1`, [p.id, dto.reference.trim(), `Resolved by hand: ${dto.note}`]);
        await this.markPaid(m, v, dto.reference.trim(), dto.paidOn ?? (await this.settings.today(m)));
      } else {
        if (live.some((p) => p.status === 'SUCCESS')) throw new ConflictException('M-PESA reported this payment as successful; reverse it instead');
        // Confirmed not paid: the attempts are closed so a new one can be made.
        for (const p of live) await m.query(`UPDATE mpesa_payout SET status = 'FAILED', result_desc = $2, next_check_at = NULL WHERE id = $1`, [p.id, `Resolved by hand as not paid: ${dto.note}`]);
        v.status = PaymentVoucherStatus.APPROVED;
        v.lastComment = `Not paid (checked by hand): ${dto.note}`;
        await m.save(v);
      }
      await this.audit.record({ action: 'PAYMENT_RESOLVED', entityType: 'payment_voucher', entityId: id, after: { outcome: dto.outcome, reference: dto.reference ?? null, note: dto.note, by: actor.id } }, m);
    });
    return this.get(id);
  }

  async cancel(id: string, reason: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const v = await this.lock(m, id);
      const cancellable = [PaymentVoucherStatus.DRAFT, PaymentVoucherStatus.RETURNED, PaymentVoucherStatus.PENDING_APPROVAL, PaymentVoucherStatus.APPROVED, PaymentVoucherStatus.FAILED];
      if (!cancellable.includes(v.status)) throw new ConflictException(`Voucher is ${v.status}`);
      const [live] = await m.query(`SELECT 1 FROM mpesa_payout WHERE voucher_id = $1 AND status IN ('PENDING', 'UNKNOWN', 'SUCCESS')`, [id]);
      if (live) throw new ConflictException('An M-PESA payment for this voucher is live or paid');
      await this.approvals.cancelPending(m, DocumentType.PAYMENT_VOUCHER, id, actor.id);
      v.status = PaymentVoucherStatus.CANCELLED;
      v.lastComment = reason;
      await m.save(v);
      await this.releaseInvoices(m, id);
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ M-PESA payout owner

  async claim(m: EntityManager, id: string, mode: 'release' | 'retry'): Promise<PayoutDoc | null> {
    const v = await this.lock(m, id);
    if (mode === 'retry') {
      if (v.status !== PaymentVoucherStatus.PROCESSING) return null;
    } else {
      if (![PaymentVoucherStatus.APPROVED, PaymentVoucherStatus.FAILED].includes(v.status)) throw new ConflictException({ code: 'NOT_APPROVED', message: `Voucher is ${v.status}` });
      if (!(await this.approvals.isApproved(m, DocumentType.PAYMENT_VOUCHER, id))) throw new ConflictException({ code: 'NOT_APPROVED', message: 'Every approval level must be complete' });
    }
    return { id: v.id, number: v.number, method: v.method as PaymentMethod, amount: v.amount, payeePhone: v.payeePhone, payeeShortcode: v.payeeShortcode, payeeAccountRef: v.payeeAccountRef, payeeName: v.payeeName };
  }

  async dispatched(m: EntityManager, id: string, releasedBy: string | null): Promise<void> {
    const v = await this.lock(m, id);
    v.status = PaymentVoucherStatus.PROCESSING;
    if (releasedBy) {
      v.releasedBy = releasedBy;
      v.releasedAt = new Date();
    }
    await m.save(v);
  }

  async paid(m: EntityManager, id: string, receipt: string, paidOn: string): Promise<void> {
    const v = await this.lock(m, id);
    if ([PaymentVoucherStatus.PROCESSING, PaymentVoucherStatus.REVIEW].includes(v.status)) await this.markPaid(m, v, receipt, paidOn);
  }

  async failed(m: EntityManager, id: string, status: 'FAILED' | 'REVIEW', note: string, onlyIfProcessing: boolean): Promise<void> {
    const v = await this.lock(m, id);
    if (onlyIfProcessing && v.status !== PaymentVoucherStatus.PROCESSING) return;
    await this.toReview(m, v, status === 'FAILED' ? PaymentVoucherStatus.FAILED : PaymentVoucherStatus.REVIEW, note);
  }

  async assertReversible(m: EntityManager, id: string): Promise<void> {
    const v = await this.lock(m, id);
    if (v.status !== PaymentVoucherStatus.PAID) throw new ConflictException(`Voucher is ${v.status}`);
  }

  async reversed(m: EntityManager, id: string, note: string): Promise<void> {
    await this.markReversed(m, await this.lock(m, id), note);
  }

  async lock(m: EntityManager, id: string): Promise<PaymentVoucher> {
    const v = await m.findOne(PaymentVoucher, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!v) throw new NotFoundException('Voucher not found');
    return v;
  }

  async get(id: string) {
    const v = await this.ds.getRepository(PaymentVoucher).findOne({ where: { id }, relations: { supplier: true, lines: { invoice: true } } });
    if (!v) throw new NotFoundException('Voucher not found');
    const attempts = await this.ds.query(
      `SELECT id, attempt, command_id AS "commandId", status, result_code AS "resultCode", result_desc AS "resultDesc", receipt_no AS "receiptNo", charges::float AS charges,
              recipient_name AS "recipientName", completed_at AS "completedAt", created_at AS "createdAt", status_checks AS "statusChecks", reversed_at AS "reversedAt"
         FROM mpesa_payout WHERE voucher_id = $1 ORDER BY attempt`,
      [id],
    );
    const users: { id: string; full_name: string }[] = await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [[v.preparedBy, v.releasedBy].filter(Boolean)]);
    const name = (u: string | null) => users.find((x) => x.id === u)?.full_name ?? null;
    return { ...v, preparedByName: name(v.preparedBy), releasedByName: name(v.releasedBy), attempts };
  }

  /** Printable payment voucher with the approval signatures. */
  async renderPdf(id: string): Promise<{ number: string; pdf: Buffer }> {
    const v = await this.get(id);
    const [facility] = await this.ds.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const d = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const history = await this.approvals.history(DocumentType.PAYMENT_VOUCHER, id);
    const signs = history.flatMap((h) => h.actions.filter((a) => a.action === 'APPROVE').map((a) => `${esc(a.stepName ?? '')}: ${esc(a.userName ?? '')}<br>${d(a.at)}`));
    const payee = v.payeePhone ? `M-PESA ${v.payeePhone.slice(0, 4)}****${v.payeePhone.slice(-4)}` : v.payeeShortcode ? `${v.method === 'MPESA_TILL' ? 'Till' : 'PayBill'} ${v.payeeShortcode}${v.payeeAccountRef ? ` acc. ${esc(v.payeeAccountRef)}` : ''}` : esc(v.method);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">PAYMENT VOUCHER</h1>
      <div class="grid"><div class="box">Voucher: <b>${esc(v.number)}</b><br>Payee: ${esc(v.payeeName ?? v.supplier?.name)}<br>Pay by: ${payee}</div>
      <div class="box">Status: ${esc(v.status)}<br>Due: ${d(v.dueDate) || '—'}<br>Paid: ${d(v.paidOn) || '—'}${v.paymentReference ? ` · ${esc(v.paymentReference)}` : ''}</div></div>
      <table><thead><tr><th>Invoice</th><th>Supplier invoice</th><th class="r">Settled</th><th class="r">WHT</th><th class="r">Paid</th></tr></thead>
      <tbody>${(v.lines ?? []).map((l) => `<tr><td>${esc(l.invoice?.number)}</td><td>${esc(l.invoice?.supplierInvoiceNo)}</td><td class="r">${money(l.amount, v.currency)}</td><td class="r">${money(l.whtAmount, v.currency)}</td><td class="r">${money(l.netAmount, v.currency)}</td></tr>`).join('')}
      <tr><td colspan="2"><b>Total</b></td><td class="r"><b>${money(v.grossAmount, v.currency)}</b></td><td class="r"><b>${money(v.whtAmount, v.currency)}</b></td><td class="r"><b>${money(v.amount, v.currency)}</b></td></tr></tbody></table>
      ${v.narrative ? `<p>${esc(v.narrative)}</p>` : ''}
      <div class="signs"><div class="sign">Prepared by: ${esc(v.preparedByName ?? '')}</div>${signs.map((x) => `<div class="sign">Approved — ${x}</div>`).join('')}<div class="sign">Released by: ${esc(v.releasedByName ?? '')}</div></div>
    </body></html>`;
    return { number: v.number, pdf: await this.pdf.render(html) };
  }

  async list(q: VoucherQueryDto): Promise<Paginated<PaymentVoucher>> {
    const qb = this.ds.getRepository(PaymentVoucher).createQueryBuilder('v').leftJoinAndSelect('v.supplier', 'supplier').orderBy('v.createdAt', 'DESC');
    if (q.status) qb.andWhere('v.status = :st', { st: q.status });
    if (q.review) qb.andWhere(`v.status IN ('FAILED', 'REVIEW')`);
    if (q.supplierId) qb.andWhere('v.supplier_id = :s', { s: q.supplierId });
    if (q.method) qb.andWhere('v.method = :m', { m: q.method });
    if (q.search) qb.andWhere('(v.number ILIKE :q OR supplier.name ILIKE :q OR v.payment_reference ILIKE :q)', { q: likeTerm(q.search) });
    const [items, total] = await qb.skip((q.page - 1) * q.pageSize).take(q.pageSize).getManyAndCount();
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

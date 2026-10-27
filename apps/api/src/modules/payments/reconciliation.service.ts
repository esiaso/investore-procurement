import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotificationCategory, Permissions, ReconciliationStatus, SessionUser } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { MpesaPayoutsService } from './mpesa-payouts.service';
import { parseDarajaDate } from './mpesa-payouts';
import { MpesaStatementLine, PaymentReconciliation } from './payments.entities';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minimal CSV (quoted fields, commas inside quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const num = (v: string | undefined) => {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
};

/** "2026-10-27 10:15:30" (Nairobi), or the Daraja formats. */
function statementDate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+03:00`);
  return parseDarajaDate(v);
}

/**
 * M-PESA reconciliation: the organisation statement (CSV export from the
 * M-PESA portal) is imported, and payouts of a day (or range) are matched by
 * receipt and amount. Charges lines are separated; anything unmatched is an
 * exception, and the reconcilers are told.
 */
@Injectable()
export class PaymentReconciliationService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly payouts: MpesaPayoutsService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('payments.mpesaReconcile', "Reconcile yesterday's M-PESA payouts against the imported statement", async () => {
      const today = await this.settings.today();
      const y = new Date(`${today}T12:00:00Z`);
      y.setUTCDate(y.getUTCDate() - 1);
      const day = y.toISOString().slice(0, 10);
      const r = await this.reconcile(day, day, null);
      return { reconciliationId: r.id, status: r.status, matched: r.matched, exceptions: r.exceptions.length };
    });
  }

  /** Imports statement lines (upsert by receipt). Columns found by header name. */
  async importStatement(csv: string, actor: SessionUser) {
    const rows = parseCsv(csv);
    const headerAt = rows.findIndex((r) => r.some((c) => /receipt/i.test(c)));
    if (headerAt < 0) throw new BadRequestException('No header row with a "Receipt No." column');
    const h = rows[headerAt].map((c) => c.toLowerCase());
    const col = (re: RegExp) => h.findIndex((c) => re.test(c));
    const iReceipt = col(/receipt/);
    const iTime = col(/completion|date|time/);
    const iDetails = col(/details|description/);
    const iIn = col(/paid in/);
    const iOut = col(/withdrawn|paid out/);
    if (iTime < 0 || (iIn < 0 && iOut < 0)) throw new BadRequestException('The statement needs Completion Time and Paid In / Withdrawn columns');
    let imported = 0;
    let skipped = 0;
    for (const r of rows.slice(headerAt + 1)) {
      const receipt = (r[iReceipt] ?? '').trim().toUpperCase();
      const at = statementDate(r[iTime] ?? '');
      if (!/^[A-Z0-9]{6,30}$/.test(receipt) || !at) {
        skipped++;
        continue;
      }
      await this.ds
        .createQueryBuilder()
        .insert()
        .into(MpesaStatementLine)
        .values({ receiptNo: receipt, completedAt: at, details: iDetails >= 0 ? (r[iDetails] ?? '').slice(0, 500) : null, paidIn: iIn >= 0 ? num(r[iIn]) : 0, withdrawn: iOut >= 0 ? num(r[iOut]) : 0, importedBy: actor.id })
        .orUpdate(['completed_at', 'details', 'paid_in', 'withdrawn'], ['receipt_no'])
        .execute();
      imported++;
    }
    return { imported, skipped };
  }

  /** Matches successful / reversed payouts completed in the range with the statement. */
  async reconcile(from: string, to: string, actor: SessionUser | null): Promise<PaymentReconciliation> {
    const range = [`${from}T00:00:00+03:00`, `${to}T23:59:59.999+03:00`];
    const system: { receipt_no: string | null; amount: number; status: string; number: string; originator: string }[] = await this.ds.query(
      `SELECT p.receipt_no, p.amount::float AS amount, p.status, v.number, p.originator_conversation_id AS originator
         FROM mpesa_payout p JOIN payment_voucher v ON v.id = p.voucher_id
        WHERE p.status IN ('SUCCESS', 'REVERSED') AND p.completed_at BETWEEN $1 AND $2`,
      range,
    );
    const statement: { receipt_no: string; withdrawn: number; details: string | null }[] = await this.ds.query(
      `SELECT receipt_no, withdrawn::float AS withdrawn, details FROM mpesa_statement_line WHERE completed_at BETWEEN $1 AND $2 AND withdrawn > 0`,
      range,
    );
    // Charges are their own statement lines (expensed to bank charges), not payments.
    const charges = statement.filter((s) => /charge/i.test(s.details ?? ''));
    const paid = statement.filter((s) => !/charge/i.test(s.details ?? ''));
    const exceptions: PaymentReconciliation['exceptions'] = [];
    let matched = 0;
    for (const s of system) {
      const line = s.receipt_no ? paid.find((x) => x.receipt_no === s.receipt_no) : undefined;
      if (!line) exceptions.push({ kind: 'NOT_ON_STATEMENT', receiptNo: s.receipt_no, voucherNo: s.number, system: s.amount, statement: null, note: `${s.number} is recorded as paid but is not on the statement` });
      else if (Math.abs(line.withdrawn - s.amount) > 0.5) exceptions.push({ kind: 'AMOUNT_MISMATCH', receiptNo: s.receipt_no, voucherNo: s.number, system: s.amount, statement: line.withdrawn, note: `${s.number}: ${s.amount} recorded, ${line.withdrawn} on the statement` });
      else matched++;
    }
    // Paid out on M-PESA but not recorded as paid here (e.g. an attempt stuck as unknown or failed).
    const known: { receipt_no: string; status: string; number: string }[] = paid.length
      ? await this.ds.query(`SELECT p.receipt_no, p.status, v.number FROM mpesa_payout p JOIN payment_voucher v ON v.id = p.voucher_id WHERE p.receipt_no = ANY($1::text[])`, [paid.map((x) => x.receipt_no)])
      : [];
    for (const line of paid) {
      if (system.some((s) => s.receipt_no === line.receipt_no)) continue;
      const k = known.find((x) => x.receipt_no === line.receipt_no);
      exceptions.push(
        k
          ? { kind: 'STATUS_MISMATCH', receiptNo: line.receipt_no, voucherNo: k.number, system: null, statement: line.withdrawn, note: `${line.receipt_no} is on the statement but ${k.number}'s attempt is ${k.status}` }
          : { kind: 'NOT_IN_SYSTEM', receiptNo: line.receipt_no, system: null, statement: line.withdrawn, note: `${line.receipt_no} (${line.details ?? ''}) was paid out but matches no voucher` },
      );
    }
    const pending: { number: string; status: string }[] = await this.ds.query(
      `SELECT v.number, p.status FROM mpesa_payout p JOIN payment_voucher v ON v.id = p.voucher_id WHERE p.status IN ('PENDING', 'UNKNOWN') AND p.created_at <= $1`,
      [range[1]],
    );
    for (const p of pending) exceptions.push({ kind: 'PENDING', receiptNo: null, voucherNo: p.number, note: `${p.number} has no M-PESA result yet (${p.status})` });
    const balance = await this.payouts.gateway().balance().catch(() => null);
    const rec = await this.ds.getRepository(PaymentReconciliation).save({
      dateFrom: from,
      dateTo: to,
      status: exceptions.length ? ReconciliationStatus.EXCEPTIONS : ReconciliationStatus.MATCHED,
      matched,
      systemTotal: round2(system.filter((s) => s.status === 'SUCCESS').reduce((a, s) => a + s.amount, 0)),
      statementTotal: round2(paid.reduce((a, s) => a + s.withdrawn, 0)),
      exceptions: [...exceptions, ...(charges.length ? [{ kind: 'CHARGES', receiptNo: null, statement: round2(charges.reduce((a, s) => a + s.withdrawn, 0)), note: `${charges.length} charge line(s)` }] : [])],
      accountBalance: balance,
      runBy: actor?.id ?? null,
    });
    if (exceptions.length) {
      const who: { user_id: string }[] = await this.ds.query(
        `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
        [Permissions.PAYMENTS_RECONCILE],
      );
      await this.notifications.dispatch(this.ds.manager, who.map((w) => w.user_id), NotificationCategory.PAYMENTS, {
        title: `M-PESA reconciliation ${from === to ? from : `${from} – ${to}`}: ${exceptions.length} exception(s)`,
        link: `/payments/reconciliation/${rec.id}`,
      });
    }
    return rec;
  }

  list() {
    return this.ds.getRepository(PaymentReconciliation).find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  get(id: string) {
    return this.ds.getRepository(PaymentReconciliation).findOneByOrFail({ id });
  }
}

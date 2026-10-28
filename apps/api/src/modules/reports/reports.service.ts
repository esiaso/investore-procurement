import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Permissions, ReportFormat, ReportFrequency, ReportPeriod, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { JobsService } from '../jobs/jobs.service';
import { MailService } from '../mail/mail.service';
import { PdfService } from '../mail/pdf.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { INVENTORY_REPORTS } from './definitions/inventory';
import { PHARMACY_REPORTS } from './definitions/pharmacy';
import { PURCHASING_REPORTS } from './definitions/purchasing';
import { NON_STOCK_REPORTS } from './definitions/nonstock';
import { RenderedReport, reportCsv, reportHtml, reportXlsx } from './report-export';
import { ReportDef, ReportFilters, ReportResult } from './report-types';
import { ScheduleDto } from './reports.dto';
import { ReportRun, ReportSchedule } from './reports.entities';

export const REPORTS: ReportDef[] = [...INVENTORY_REPORTS, ...PHARMACY_REPORTS, ...PURCHASING_REPORTS, ...NON_STOCK_REPORTS];

const CONTENT_TYPES: Record<ReportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local date arithmetic on YYYY-MM-DD strings. */
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Offset of a time zone from UTC at an instant (ms). */
function tzOffset(at: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
}
/** The instant of a local date and hour in a time zone. */
function zoned(date: string, hour: number, tz: string): Date {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  return new Date(guess - tzOffset(guess, tz));
}

/** Absolute dates of a schedule's period on a given local day. */
export function resolvePeriod(period: ReportPeriod, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  switch (period) {
    case ReportPeriod.YESTERDAY:
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case ReportPeriod.LAST_7_DAYS:
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case ReportPeriod.LAST_30_DAYS:
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case ReportPeriod.LAST_WEEK: {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      const monday = addDays(today, -dow - 7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case ReportPeriod.LAST_MONTH: {
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      return { from: prev, to: addDays(firstOfMonth, -1) };
    }
    case ReportPeriod.MONTH_TO_DATE:
      return { from: firstOfMonth, to: today };
  }
}

/** Next local run after `after` (daily at hour, weekly on weekday, monthly on day). */
export function nextRun(s: Pick<ReportSchedule, 'frequency' | 'hour' | 'weekday' | 'monthDay'>, after: Date, tz: string): Date {
  let day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(after);
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
    const at = zoned(day, s.hour, tz);
    if (at <= after) continue;
    const d = new Date(`${day}T00:00:00Z`);
    if (s.frequency === ReportFrequency.WEEKLY && ((d.getUTCDay() + 6) % 7) + 1 !== (s.weekday ?? 1)) continue;
    if (s.frequency === ReportFrequency.MONTHLY && d.getUTCDate() !== (s.monthDay ?? 1)) continue;
    return at;
  }
  throw new Error('No next run found');
}

/**
 * Inventory, pharmacy, purchasing and supply chain reports: a registry of
 * definitions, each filterable (dates, store, category, item, supplier,
 * department) within the user's store scope, shown on screen or exported to
 * CSV, Excel or PDF, and emailed on a schedule.
 */
@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly log = new Logger('Reports');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
    private readonly mail: MailService,
    private readonly jobs: JobsService,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    this.jobs.register('reports.scheduled', 'Email scheduled reports that are due', () => this.runDue());
    this.mail.registerAttachment('REPORT_RUN', async (id) => (await this.renderRun(id)).body);
  }

  private def(key: string): ReportDef {
    const d = REPORTS.find((r) => r.key === key);
    if (!d) throw new NotFoundException(`Unknown report ${key}`);
    return d;
  }

  private allowed(d: ReportDef, user: SessionUser) {
    return d.permissions.some((p) => user.permissions.includes(p));
  }

  /** Reports this user may run. */
  catalog(user: SessionUser) {
    return REPORTS.filter((d) => this.allowed(d, user)).map(({ run: _run, ...d }) => d);
  }

  /** Cleans and checks the filters a report uses. */
  private filters(d: ReportDef, raw: Record<string, unknown>): ReportFilters {
    const f: ReportFilters = {};
    for (const k of d.filters) {
      const v = raw[k];
      if (v === undefined || v === null || v === '') continue;
      const s = String(v);
      if (k === 'from' || k === 'to') {
        if (!DATE.test(s)) throw new BadRequestException(`${k} must be a date (YYYY-MM-DD)`);
        f[k] = s;
      } else if (k === 'days' || k === 'limit') {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new BadRequestException(`${k} must be a whole number`);
        f[k] = n;
      } else if (k === 'groupBy') {
        if (!d.groupBy?.some((g) => g.value === s)) throw new BadRequestException(`groupBy must be one of ${d.groupBy?.map((g) => g.value).join(', ')}`);
        f.groupBy = s;
      } else if (k === 'status') {
        if (!/^[A-Z_]{2,40}$/.test(s)) throw new BadRequestException('Invalid status');
        f.status = s;
      } else if (k === 'currency') {
        if (!/^[A-Z]{3}$/.test(s)) throw new BadRequestException('currency must be a 3-letter code');
        f.currency = s;
      } else if (k === 'method') {
        if (!/^[A-Z_]{2,30}$/.test(s)) throw new BadRequestException('Invalid payment method');
        f.method = s;
      } else if (k === 'period') {
        if (!['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(s)) throw new BadRequestException('period must be DAY, WEEK, MONTH, QUARTER or YEAR');
        f.period = s;
      } else {
        if (!UUID.test(s)) throw new BadRequestException(`${k} must be an id`);
        (f as Record<string, unknown>)[k] = s;
      }
    }
    for (const k of d.required ?? []) if (f[k] === undefined) throw new BadRequestException(`${d.title} needs ${k}`);
    if (f.from && f.to && f.to < f.from) throw new BadRequestException('The period ends before it starts');
    if (f.storeId && StoreScope.current() !== null && !StoreScope.current()!.includes(f.storeId)) throw new ForbiddenException('That store is outside your scope');
    return f;
  }

  private async execute(d: ReportDef, f: ReportFilters, scope: string[] | null): Promise<ReportResult> {
    if (f.storeId && scope !== null && !scope.includes(f.storeId)) throw new ForbiddenException('That store is outside your scope');
    const res = await d.run({
      ds: this.ds,
      f,
      scope,
      tz: await this.settings.get('locale.timezone'),
      today: await this.settings.today(),
      maxRows: await this.settings.get('reports.maxRows'),
      settings: this.settings,
    });
    return { ...res, columns: res.columns ?? d.columns };
  }

  /** Runs a report for the screen. */
  async run(key: string, raw: Record<string, unknown>, user: SessionUser) {
    const d = this.def(key);
    if (!this.allowed(d, user)) throw new ForbiddenException('You may not run this report');
    const f = this.filters(d, raw);
    const res = await this.execute(d, f, StoreScope.current());
    return { key: d.key, title: d.title, filters: f, criteria: await this.criteria(d, f), generatedAt: new Date().toISOString(), ...res };
  }

  /** Filters in words for the export header. */
  private async criteria(d: ReportDef, f: ReportFilters): Promise<string[]> {
    const name = async (table: string, id?: string, label = 'name') => (id ? ((await this.ds.query(`SELECT ${label} AS n FROM ${table} WHERE id = $1`, [id]))[0]?.n ?? id) : null);
    const out: string[] = [];
    if (f.from || f.to) out.push(`Period: ${f.from ?? '…'} to ${f.to ?? '…'}`);
    const pairs: [string, string | null][] = [
      ['Store', await name('store', f.storeId)],
      ['Category', await name('item_category', f.categoryId)],
      ['Item', await name('item', f.itemId, `code || ' ' || name`)],
      ['Supplier', await name('supplier', f.supplierId)],
      ['Department', await name('department', f.departmentId)],
      ['Project', await name('project', f.projectId)],
      ['User', await name('app_user', f.userId, 'full_name')],
      ['Float', await name('petty_cash_float', f.floatId)],
    ];
    for (const [k, v] of pairs) if (v) out.push(`${k}: ${v}`);
    if (f.groupBy) out.push(`By: ${d.groupBy?.find((g) => g.value === f.groupBy)?.label ?? f.groupBy}`);
    if (f.status) out.push(`Status: ${f.status}`);
    if (f.currency) out.push(`Currency: ${f.currency}`);
    if (f.method) out.push(`Method: ${f.method}`);
    if (f.period) out.push(`Per: ${f.period.toLowerCase()}`);
    if (f.days) out.push(`Days: ${f.days}`);
    if (f.limit) out.push(`Top: ${f.limit}`);
    if (!out.length) out.push(`As at ${await this.settings.today()}`);
    return out;
  }

  private async render(d: ReportDef, f: ReportFilters, scope: string[] | null, format: ReportFormat, userId: string | null) {
    const res = await this.execute(d, f, scope);
    const [facility] = await this.ds.query(`SELECT name FROM facility ORDER BY created_at LIMIT 1`);
    const [who] = userId ? await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [userId]) : [];
    const tz = await this.settings.get('locale.timezone');
    const doc: RenderedReport = {
      title: d.title,
      facility: facility?.name ?? 'Hospital',
      criteria: [...(await this.criteria(d, f)), ...(scope !== null && !f.storeId ? [`Stores: ${scope.length} in scope`] : [])],
      generatedAt: new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
      generatedBy: who?.full_name ?? null,
      columns: res.columns!,
      rows: res.rows,
      totals: res.totals,
      notes: res.notes,
      landscape: d.landscape,
    };
    const stamp = (await this.settings.today()).replace(/-/g, '');
    const filename = `${d.key}-${stamp}.${format}`;
    const body =
      format === ReportFormat.CSV ? Buffer.from(reportCsv(doc), 'utf8') : format === ReportFormat.XLSX ? await reportXlsx(doc) : await this.pdf.render(reportHtml(doc), undefined, { landscape: d.landscape });
    return { body, filename, contentType: CONTENT_TYPES[format], rowCount: res.rows.length };
  }

  /** CSV / Excel / PDF of a report (logged as a run). */
  async export(key: string, raw: Record<string, unknown>, format: ReportFormat, user: SessionUser) {
    const d = this.def(key);
    if (!this.allowed(d, user)) throw new ForbiddenException('You may not run this report');
    if (!Object.values(ReportFormat).includes(format)) throw new BadRequestException('format must be csv, xlsx or pdf');
    const f = this.filters(d, raw);
    const scope = StoreScope.current();
    const out = await this.render(d, f, scope, format, user.id);
    await this.ds.getRepository(ReportRun).save({ reportKey: d.key, filters: f as Record<string, unknown>, format, storeScope: scope, userId: user.id, rowCount: out.rowCount });
    return out;
  }

  /** Email attachment: the run rendered with the filters and scope it was created with. */
  async renderRun(id: string) {
    const run = await this.ds.getRepository(ReportRun).findOneBy({ id });
    if (!run) throw new NotFoundException('Report run not found');
    return this.render(this.def(run.reportKey), run.filters as ReportFilters, run.storeScope, run.format, run.userId);
  }

  // ------------------------------------------------------------------ schedules

  async schedules(user: SessionUser) {
    const all = user.permissions.includes(Permissions.SETTINGS_MANAGE);
    const rows: (ReportSchedule & { owner: string })[] = await this.ds.query(
      `SELECT s.id, s.name, s.report_key AS "reportKey", s.filters, s.period, s.format, s.frequency, s.hour, s.weekday, s.month_day AS "monthDay", s.recipients,
              s.owner_id AS "ownerId", u.full_name AS owner, s.is_active AS "isActive", s.next_run_at AS "nextRunAt", s.last_run_at AS "lastRunAt", s.last_error AS "lastError"
         FROM report_schedule s JOIN app_user u ON u.id = s.owner_id WHERE $1 OR s.owner_id = $2 ORDER BY s.name`,
      [all, user.id],
    );
    return rows.map((r) => ({ ...r, title: REPORTS.find((d) => d.key === r.reportKey)?.title ?? r.reportKey }));
  }

  private async ownSchedule(id: string, user: SessionUser) {
    const s = await this.ds.getRepository(ReportSchedule).findOneBy({ id });
    if (!s) throw new NotFoundException('Schedule not found');
    if (s.ownerId !== user.id && !user.permissions.includes(Permissions.SETTINGS_MANAGE)) throw new ForbiddenException('This schedule belongs to someone else');
    return s;
  }

  async saveSchedule(id: string | null, dto: ScheduleDto, user: SessionUser) {
    const d = this.def(dto.reportKey);
    if (!this.allowed(d, user)) throw new ForbiddenException('You may not run this report');
    // Check the fixed filters now (the period is filled in at each run).
    const sample = resolvePeriod(dto.period, await this.settings.today());
    const { from: _f, to: _t, ...fixed } = this.filters(d, { ...dto.filters, ...sample });
    if (dto.frequency === ReportFrequency.WEEKLY && !dto.weekday) throw new BadRequestException('A weekly report needs a weekday');
    if (dto.frequency === ReportFrequency.MONTHLY && !dto.monthDay) throw new BadRequestException('A monthly report needs a day of the month');
    const repo = this.ds.getRepository(ReportSchedule);
    const row = id ? await this.ownSchedule(id, user) : repo.create({ ownerId: user.id });
    Object.assign(row, {
      name: dto.name,
      reportKey: d.key,
      filters: fixed,
      period: dto.period,
      format: dto.format,
      frequency: dto.frequency,
      hour: dto.hour,
      weekday: dto.frequency === ReportFrequency.WEEKLY ? dto.weekday : null,
      monthDay: dto.frequency === ReportFrequency.MONTHLY ? dto.monthDay : null,
      recipients: [...new Set(dto.recipients.map((r) => r.trim().toLowerCase()))],
      isActive: dto.isActive ?? true,
      lastError: null,
    });
    row.nextRunAt = nextRun(row, new Date(), await this.settings.get('locale.timezone'));
    return repo.save(row);
  }

  async deleteSchedule(id: string, user: SessionUser) {
    const s = await this.ownSchedule(id, user);
    await this.ds.getRepository(ReportSchedule).delete({ id: s.id });
  }

  /** Sends one schedule now (and moves its next run on). */
  async sendSchedule(id: string, user: SessionUser) {
    await this.ownSchedule(id, user);
    return this.send(id);
  }

  /** Job reports.scheduled: every schedule that is due. */
  async runDue() {
    const due: { id: string }[] = await this.ds.query(`SELECT id FROM report_schedule WHERE is_active AND next_run_at <= now() ORDER BY next_run_at LIMIT 50`);
    let sent = 0;
    for (const s of due) if ((await this.send(s.id)).queued) sent++;
    return { due: due.length, sent };
  }

  /** Runs a schedule as its owner (permissions and store scope at the time) and queues one email per recipient. */
  private async send(id: string): Promise<{ queued: number; runId?: string; error?: string }> {
    const repo = this.ds.getRepository(ReportSchedule);
    const s = await repo.findOneByOrFail({ id });
    const tz = await this.settings.get('locale.timezone');
    const today = await this.settings.today();
    try {
      const owner = await this.users.findForSession(s.ownerId);
      const d = this.def(s.reportKey);
      if (!owner || !this.allowed(d, owner)) throw new ForbiddenException('The owner can no longer run this report');
      const f = { ...(s.filters as ReportFilters), ...(d.filters.includes('from') ? resolvePeriod(s.period, today) : {}) };
      const scope = owner.storeIds;
      if (f.storeId && scope !== null && !scope.includes(f.storeId)) throw new ForbiddenException('The store is outside the owner’s scope');
      // Fail now (not in the mail queue) if the report cannot run.
      const res = await this.execute(d, f, scope);
      const queued = await this.ds.transaction(async (m) => {
        const run = await m.getRepository(ReportRun).save({ reportKey: d.key, filters: f as Record<string, unknown>, format: s.format, storeScope: scope, scheduleId: s.id, userId: s.ownerId, rowCount: res.rows.length });
        const filename = `${d.key}-${today.replace(/-/g, '')}.${s.format}`;
        const period = f.from ? ` (${f.from} to ${f.to})` : '';
        for (const to of s.recipients)
          await this.mail.enqueue(m, {
            to,
            subject: `${s.name}${period}`,
            text: `${d.title}${period}: ${res.rows.length} row(s), attached as ${s.format.toUpperCase()}.\n\nScheduled by ${owner.fullName}. Change or stop it under Reports → Scheduled.`,
            attachments: [{ kind: 'REPORT_RUN', id: run.id, filename }],
            doc: { type: 'REPORT_SCHEDULE', id: s.id },
          });
        await m.getRepository(ReportSchedule).update(s.id, { lastRunAt: new Date(), lastError: null, nextRunAt: nextRun(s, new Date(), tz) });
        return { queued: s.recipients.length, runId: run.id };
      });
      return queued;
    } catch (e) {
      const error = (e as Error).message.slice(0, 1000);
      this.log.warn(`schedule ${s.name}: ${error}`);
      await repo.update(s.id, { lastRunAt: new Date(), lastError: error, nextRunAt: nextRun(s, new Date(), tz) });
      return { queued: 0, error };
    }
  }
}

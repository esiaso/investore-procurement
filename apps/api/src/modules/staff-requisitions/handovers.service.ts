import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomInt } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  AttachmentOwner,
  DocumentType,
  HandoverChannel,
  HandoverStatus,
  ItemCondition,
  NotificationCategory,
  Permissions,
  PurchaseLineType,
  SessionUser,
  StaffRequisitionLineStatus,
  StaffRequisitionStatus,
} from '@sil/shared';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { AttachmentsService } from '../files/attachments.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { refreshStaffRequisitionStatus } from './staff-requisition-status';
import { Handover, HandoverLine, StaffRequisition, StaffRequisitionLine } from './staff-requisitions.entities';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface HandoverInput {
  requisitionId: string;
  receivedBy?: string;
  condition?: ItemCondition;
  notes?: string;
  lines: { requisitionLineId: string; quantity: number; remarks?: string }[];
}

/**
 * Delivery to the final user (A7): received non-stock goods are handed over
 * to the requester (or a colleague in their department), who acknowledges
 * them in the app, or by giving the officer a one-time code sent to them.
 * Acknowledged quantities count as delivered; the requisition closes when
 * every line has been delivered.
 */
@Injectable()
export class HandoversService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
  ) {}

  onModuleInit() {
    this.links.registerResolver(DocumentType.HANDOVER, async (ids) => {
      const rows = await this.ds.getRepository(Handover).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: (r.acknowledgedAt ?? r.createdAt).toISOString() }]));
    });
    this.attachments.registerOwner(AttachmentOwner.HANDOVER, {
      read: [Permissions.PURCHASING_HANDOVER, Permissions.STAFF_REQUISITION_CREATE],
      write: [Permissions.PURCHASING_HANDOVER],
      visible: async (m, id, actor) => {
        const h = await m.findOneBy(Handover, { id });
        return !!h && (!actor || (await this.canSee(m, h, actor)));
      },
    });
  }

  private async canSee(m: EntityManager, h: Handover, actor: SessionUser): Promise<boolean> {
    if (h.receivedBy === actor.id || h.preparedBy === actor.id) return true;
    if (actor.permissions.includes(Permissions.PURCHASING_HANDOVER) || actor.permissions.includes(Permissions.STAFF_REQUISITION_READ_ALL)) return true;
    const r = await m.findOneBy(StaffRequisition, { id: h.requisitionId });
    return !!r && (r.requestedBy === actor.id || (!!actor.departmentId && actor.departmentId === r.departmentId));
  }

  /** Per line: received from the supplier, delivered, waiting on a pending hand-over, and what can still be handed over. */
  async deliverable(m: EntityManager, requisitionId: string) {
    const lines = await m.find(StaffRequisitionLine, { where: { requisitionId }, relations: { uom: true }, order: { lineNo: 'ASC' } });
    const pending: { requisition_line_id: string; q: number }[] = await m.query(
      `SELECT hl.requisition_line_id, SUM(hl.quantity)::float AS q FROM handover_line hl JOIN handover h ON h.id = hl.handover_id
        WHERE h.requisition_id = $1 AND h.status = 'PENDING' GROUP BY hl.requisition_line_id`,
      [requisitionId],
    );
    return lines
      .filter((l) => l.lineType !== PurchaseLineType.STOCK)
      .map((l) => {
        const waiting = pending.find((p) => p.requisition_line_id === l.id)?.q ?? 0;
        return {
          requisitionLineId: l.id,
          lineNo: l.lineNo,
          lineType: l.lineType,
          description: l.description,
          uom: l.uom?.code ?? null,
          quantity: l.quantity,
          receivedQty: l.receivedQty,
          deliveredQty: l.deliveredQty,
          pendingQty: waiting,
          available: Math.max(0, round4(l.receivedQty - l.deliveredQty - waiting)),
          status: l.status,
        };
      });
  }

  async create(dto: HandoverInput, actor: SessionUser) {
    const id = await this.ds.transaction(async (m) => {
      const r = await m.findOne(StaffRequisition, { where: { id: dto.requisitionId }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw new NotFoundException('Requisition not found');
      if ([StaffRequisitionStatus.CLOSED, StaffRequisitionStatus.CANCELLED].includes(r.status)) throw new ConflictException(`Requisition is ${r.status}`);
      const receivedBy = dto.receivedBy ?? r.requestedBy;
      if (receivedBy !== r.requestedBy) {
        const [u] = await m.query(`SELECT 1 FROM app_user WHERE id = $1 AND department_id = $2 AND is_active`, [receivedBy, r.departmentId]);
        if (!u) throw new BadRequestException('The receiver must be the requester or an active member of the requesting department');
      }
      if (receivedBy === actor.id) throw new ForbiddenException('You cannot hand goods over to yourself');
      const can = await this.deliverable(m, r.id);
      const ids = new Set<string>();
      for (const l of dto.lines) {
        if (ids.has(l.requisitionLineId)) throw new BadRequestException('A line is listed twice');
        ids.add(l.requisitionLineId);
        const d = can.find((x) => x.requisitionLineId === l.requisitionLineId);
        if (!d) throw new BadRequestException('A line is not a non-stock line of this requisition');
        if (l.quantity > d.available + 1e-9) {
          throw new BadRequestException({ code: 'NOT_RECEIVED', message: `Line ${d.lineNo}: only ${d.available} received and not yet handed over` });
        }
      }
      const h = await m.save(
        m.create(Handover, {
          number: await this.numbering.next(DocumentType.HANDOVER, { manager: m }),
          requisitionId: r.id,
          status: HandoverStatus.PENDING,
          preparedBy: actor.id,
          receivedBy,
          condition: dto.condition ?? ItemCondition.GOOD,
          notes: dto.notes ?? null,
          lines: dto.lines.map((l) => m.create(HandoverLine, { requisitionLineId: l.requisitionLineId, quantity: l.quantity, remarks: l.remarks ?? null })),
        }),
      );
      await this.links.link(m, { type: DocumentType.STAFF_REQUISITION, id: r.id, no: r.number }, { type: DocumentType.HANDOVER, id: h.id, no: h.number });
      await this.notifications.dispatch(m, [receivedBy], NotificationCategory.REQUISITIONS, {
        title: `${r.number}: ready for collection`,
        body: `${dto.lines.length} line(s) on ${h.number}; confirm when you have them`,
        link: `/handovers/${h.id}`,
      });
      return h.id;
    });
    return this.get(id);
  }

  /** The receiver confirms in the app. */
  async acknowledge(id: string, comment: string | undefined, actor: SessionUser, ip?: string) {
    await this.ds.transaction(async (m) => {
      const h = await this.lock(m, id);
      if (h.receivedBy !== actor.id) throw new ForbiddenException('Only the receiver can confirm this hand-over');
      await this.complete(m, h, HandoverChannel.IN_APP, comment, ip);
    });
    return this.get(id);
  }

  /** Sends the receiver a one-time code to give the officer at the counter. */
  async sendOtp(id: string, actor: SessionUser) {
    const minutes = await this.settings.get('requisitions.handoverOtpMinutes');
    await this.ds.transaction(async (m) => {
      const h = await this.lock(m, id);
      if (h.preparedBy !== actor.id) throw new ForbiddenException('Only the officer handing over can request a code');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await m.update(Handover, { id }, { otpHash: sha256(`${h.id}:${code}`), otpExpiresAt: new Date(Date.now() + minutes * 60_000), otpAttempts: 0 });
      // Only the receiver gets the code (their own inbox / email / SMS).
      await this.notifications.dispatch(m, [h.receivedBy], NotificationCategory.REQUISITIONS, {
        title: `${h.number}: your collection code`,
        body: `Give code ${code} to the officer to confirm you received the items. It expires in ${minutes} minutes.`,
        link: `/handovers/${h.id}`,
      });
    });
    return { sent: true, expiresInMinutes: minutes };
  }

  /** The officer enters the receiver's code. */
  async verifyOtp(id: string, code: string, actor: SessionUser, ip?: string) {
    const max = await this.settings.get('requisitions.handoverOtpMaxAttempts');
    const outcome = await this.ds.transaction(async (m) => {
      const h = await this.lock(m, id);
      if (h.preparedBy !== actor.id) throw new ForbiddenException('Only the officer handing over can enter the code');
      const [{ otp_hash: hash }] = await m.query(`SELECT otp_hash FROM handover WHERE id = $1`, [id]);
      if (!hash || !h.otpExpiresAt) throw new BadRequestException('Request a code first');
      if (h.otpExpiresAt.getTime() < Date.now() || h.otpAttempts >= max) {
        await m.update(Handover, { id }, { otpHash: null, otpExpiresAt: null });
        return 'expired' as const;
      }
      if (sha256(`${h.id}:${code.trim()}`) !== hash) {
        await m.update(Handover, { id }, { otpAttempts: h.otpAttempts + 1 });
        return 'wrong' as const;
      }
      await m.update(Handover, { id }, { otpHash: null, otpExpiresAt: null });
      await this.complete(m, h, HandoverChannel.OTP, undefined, ip);
      return 'ok' as const;
    });
    if (outcome === 'expired') throw new GoneException('The code has expired or too many wrong codes were entered; request a new one');
    if (outcome === 'wrong') throw new BadRequestException({ code: 'WRONG_CODE', message: 'Wrong code' });
    return this.get(id);
  }

  private async complete(m: EntityManager, h: Handover, channel: HandoverChannel, comment: string | undefined, ip: string | undefined) {
    const lines = await m.find(HandoverLine, { where: { handoverId: h.id } });
    for (const l of lines) {
      const sl = await m.findOne(StaffRequisitionLine, { where: { id: l.requisitionLineId }, lock: { mode: 'pessimistic_write' } });
      if (!sl) continue;
      sl.deliveredQty = round4(sl.deliveredQty + l.quantity);
      if (sl.deliveredQty >= sl.quantity - 1e-9) sl.status = StaffRequisitionLineStatus.DELIVERED;
      await m.save(sl);
    }
    Object.assign(h, { status: HandoverStatus.ACKNOWLEDGED, ackChannel: channel, acknowledgedAt: new Date(), ackComment: comment ?? null, ackIp: ip ?? null });
    await m.save(h);
    const status = await refreshStaffRequisitionStatus(m, h.requisitionId);
    const r = await m.findOneByOrFail(StaffRequisition, { id: h.requisitionId });
    await this.notifications.notify(m, [h.preparedBy], { title: `${h.number} confirmed by the receiver`, link: `/handovers/${h.id}` });
    if (status === StaffRequisitionStatus.CLOSED) {
      await this.notifications.dispatch(m, [r.requestedBy], NotificationCategory.REQUISITIONS, { title: `${r.number}: delivered and closed`, link: `/staff-requisitions/${r.id}` });
    }
  }

  async cancel(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const h = await this.lock(m, id);
      if (h.preparedBy !== actor.id) throw new ForbiddenException('Only the officer handing over can cancel it');
      h.status = HandoverStatus.CANCELLED;
      await m.save(h);
    });
    return this.get(id);
  }

  private async lock(m: EntityManager, id: string): Promise<Handover> {
    const h = await m.findOne(Handover, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!h) throw new NotFoundException('Hand-over not found');
    if (h.status !== HandoverStatus.PENDING) throw new ConflictException(`Hand-over is ${h.status}`);
    return h;
  }

  async get(id: string, actor?: SessionUser) {
    const h = await this.ds.getRepository(Handover).findOne({ where: { id }, relations: { requisition: true, lines: { requisitionLine: { uom: true } } } });
    if (!h) throw new NotFoundException('Hand-over not found');
    if (actor && !(await this.canSee(this.ds.manager, h, actor))) throw new ForbiddenException('You cannot see this hand-over');
    const users: { id: string; full_name: string }[] = await this.ds.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [[h.preparedBy, h.receivedBy]]);
    const name = (u: string) => users.find((x) => x.id === u)?.full_name ?? null;
    return {
      ...h,
      preparedByName: name(h.preparedBy),
      receivedByName: name(h.receivedBy),
      otpPending: !!h.otpExpiresAt && h.otpExpiresAt.getTime() > Date.now(),
      lines: (h.lines ?? []).sort((a, b) => (a.requisitionLine?.lineNo ?? 0) - (b.requisitionLine?.lineNo ?? 0)),
    };
  }

  /** A requisition's hand-overs, or those waiting for the user's confirmation (mine=true). */
  async list(q: { requisitionId?: string; mine?: boolean; status?: string }, actor: SessionUser) {
    const qb = this.ds.getRepository(Handover).createQueryBuilder('h').leftJoinAndSelect('h.requisition', 'r').orderBy('h.createdAt', 'DESC').take(200);
    if (q.requisitionId) qb.andWhere('h.requisition_id = :rid', { rid: q.requisitionId });
    if (q.status) qb.andWhere('h.status = :st', { st: q.status });
    if (q.mine) qb.andWhere('h.received_by = :me', { me: actor.id });
    else if (!actor.permissions.includes(Permissions.PURCHASING_HANDOVER) && !actor.permissions.includes(Permissions.STAFF_REQUISITION_READ_ALL)) {
      qb.andWhere('(h.received_by = :me OR r.requested_by = :me OR r.department_id = :dep)', { me: actor.id, dep: actor.departmentId ?? null });
    }
    return qb.getMany();
  }

  /**
   * Stock lines are delivered when their store requisition line has been
   * issued in full (the issue voucher is the hand-over).
   */
  async onStoreIssue(m: EntityManager, storeRequisitionId: string): Promise<void> {
    const [rows]: [{ requisition_id: string }[], number] = await m.query(
      `UPDATE staff_requisition_line sl SET status = 'DELIVERED', delivered_qty = sl.quantity
         FROM store_requisition_line srl
        WHERE sl.store_requisition_line_id = srl.id AND srl.requisition_id = $1 AND sl.status = 'TO_STORE'
          AND srl.issued_qty + srl.cancelled_qty >= srl.requested_qty
        RETURNING sl.requisition_id`,
      [storeRequisitionId],
    );
    for (const reqId of new Set(rows.map((r) => r.requisition_id))) await refreshStaffRequisitionStatus(m, reqId);
  }
}

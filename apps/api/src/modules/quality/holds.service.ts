import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { BatchHoldStatus, DocumentType, HoldReason, HoldStatus, Permissions, SessionUser } from '@sil/shared';
import { NotificationsService } from '../approvals/notifications.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { QualityHold } from './quality.entities';

export interface HoldInput {
  batchId: string;
  storeId?: string | null;
  reason: HoldReason;
  details: string;
  sourceType: string;
  sourceId?: string | null;
}

/**
 * Batch status from its open holds: RECALL wins over QUARANTINE; with none
 * open the batch is usable again unless it has expired.
 */
export function batchStatusFor(openReasons: HoldReason[], expiryDate: string | null, today: string): BatchHoldStatus {
  if (openReasons.includes(HoldReason.RECALL)) return BatchHoldStatus.RECALL;
  if (openReasons.length) return BatchHoldStatus.QUARANTINE;
  if (expiryDate && expiryDate <= today) return BatchHoldStatus.EXPIRED;
  return BatchHoldStatus.NONE;
}

/** Quarantine / hold workflow for stock pending inspection, investigation, recall or after an excursion. */
@Injectable()
export class HoldsService {
  /** Set by the disposals service: raises a disposal for rejected stock. */
  onReject: ((m: EntityManager, hold: QualityHold, actor: SessionUser) => Promise<string | null>) | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  /** Places a hold (inside the caller's transaction) unless the same source already holds the batch. */
  async place(m: EntityManager, input: HoldInput, actorId: string | null): Promise<QualityHold> {
    const existing = await m.findOneBy(QualityHold, { batchId: input.batchId, sourceType: input.sourceType, sourceId: input.sourceId ?? undefined, status: HoldStatus.OPEN });
    if (existing && input.sourceId) return existing;
    const [b] = await m.query(
      `SELECT b.id, b.batch_no, i.name, COALESCE((SELECT SUM(on_hand) FROM stock_balance WHERE batch_id = b.id), 0)::float AS on_hand
         FROM batch b JOIN item i ON i.id = b.item_id WHERE b.id = $1`,
      [input.batchId],
    );
    if (!b) throw new NotFoundException('Batch not found');
    const hold = await m.save(
      m.create(QualityHold, {
        number: await this.numbering.next(DocumentType.QUALITY_HOLD, { manager: m }),
        batchId: input.batchId,
        storeId: input.storeId ?? null,
        reason: input.reason,
        details: input.details.slice(0, 1000),
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        quantityAtHold: b.on_hand,
        status: HoldStatus.OPEN,
        placedBy: actorId,
      }),
    );
    await this.refreshBatch(m, input.batchId);
    const reviewers: { id: string }[] = await m.query(
      `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role_permission rp ON rp.role_id = ur.role_id
        WHERE rp.permission_code = $1 AND u.is_active`,
      [Permissions.QUALITY_RELEASE],
    );
    await this.notifications.notify(m, reviewers.map((r) => r.id), {
      title: `${hold.number}: ${b.name} batch ${b.batch_no} on hold (${input.reason.toLowerCase()})`,
      body: input.details.slice(0, 300),
      link: `/quality/holds/${hold.id}`,
    });
    return hold;
  }

  /** Recomputes the batch's hold status from its open holds. */
  async refreshBatch(m: EntityManager, batchId: string) {
    const open: { reason: HoldReason }[] = await m.query(`SELECT reason FROM quality_hold WHERE batch_id = $1 AND status = 'OPEN'`, [batchId]);
    const [b] = await m.query(`SELECT to_char(expiry_date, 'YYYY-MM-DD') AS expiry FROM batch WHERE id = $1`, [batchId]);
    const status = batchStatusFor(open.map((o) => o.reason), b?.expiry ?? null, await this.settings.today(m));
    const reason = open.length ? `Quality hold: ${[...new Set(open.map((o) => o.reason))].join(', ')}` : null;
    await m.query(`UPDATE batch SET hold_status = $2, hold_reason = $3, updated_at = now() WHERE id = $1`, [batchId, status, status === BatchHoldStatus.EXPIRED ? 'Expired' : reason]);
  }

  async create(dto: { batchId: string; storeId?: string; reason: HoldReason; details: string }, actor: SessionUser) {
    if (dto.reason === HoldReason.RECALL) throw new BadRequestException('Recalls hold their batches from the recall notice');
    const id = await this.ds.transaction(async (m) => (await this.place(m, { ...dto, sourceType: 'MANUAL' }, actor.id)).id);
    return this.get(id);
  }

  /**
   * Release (stock is usable again) or reject (it is not: a disposal is raised).
   * Recall holds are closed by the recall, not released here.
   */
  async decide(id: string, decision: 'RELEASE' | 'REJECT', note: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const hold = await m.findOne(QualityHold, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!hold) throw new NotFoundException('Hold not found');
      if (hold.status !== HoldStatus.OPEN) throw new ConflictException(`Hold is ${hold.status}`);
      if (hold.reason === HoldReason.RECALL && decision === 'RELEASE') throw new ConflictException('Recalled stock is released by closing the recall');
      if (hold.placedBy === actor.id) throw new ForbiddenException('The person who placed the hold cannot decide it');
      Object.assign(hold, { status: decision === 'RELEASE' ? HoldStatus.RELEASED : HoldStatus.REJECTED, decidedBy: actor.id, decidedAt: new Date(), decisionNote: note });
      if (decision === 'REJECT' && this.onReject) hold.disposalId = await this.onReject(m, hold, actor);
      await m.save(hold);
      await this.refreshBatch(m, hold.batchId);
    });
    return this.get(id);
  }

  /** Closes open holds of one source (e.g. a closed recall), refreshing the batches. */
  async closeForSource(m: EntityManager, sourceType: string, sourceId: string, status: HoldStatus, note: string, actorId: string) {
    const holds = await m.find(QualityHold, { where: { sourceType, sourceId, status: HoldStatus.OPEN } });
    for (const h of holds) {
      Object.assign(h, { status, decidedBy: actorId, decidedAt: new Date(), decisionNote: note });
      await m.save(h);
    }
    for (const b of new Set(holds.map((h) => h.batchId))) await this.refreshBatch(m, b);
    return holds.length;
  }

  async get(id: string) {
    const h = await this.ds.getRepository(QualityHold).findOne({ where: { id }, relations: { batch: { item: true }, store: true } });
    if (!h) throw new NotFoundException('Hold not found');
    const locations = await this.ds.query(
      `SELECT s.name AS store, bn.code AS bin, sb.on_hand::float AS "onHand" FROM stock_balance sb JOIN store s ON s.id = sb.store_id LEFT JOIN bin bn ON bn.id = sb.bin_id
        WHERE sb.batch_id = $1 AND sb.on_hand <> 0 ORDER BY s.name, bn.code`,
      [h.batchId],
    );
    const people = await this.ds.query(`SELECT id, full_name AS "fullName" FROM app_user WHERE id = ANY($1::uuid[])`, [[h.placedBy, h.decidedBy].filter(Boolean)]);
    const name = (u: string | null) => people.find((p: { id: string }) => p.id === u)?.fullName ?? null;
    return { ...h, locations, placedByName: name(h.placedBy), decidedByName: name(h.decidedBy) };
  }

  list(q: { status?: string; reason?: string; batchId?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.reason) where.reason = q.reason;
    if (q.batchId) where.batchId = q.batchId;
    return this.ds.getRepository(QualityHold).find({ where, relations: { batch: { item: true }, store: true }, order: { createdAt: 'DESC' }, take: 1000 });
  }

  openFor(m: EntityManager, batchIds: string[]) {
    return m.find(QualityHold, { where: { batchId: In(batchIds), status: HoldStatus.OPEN } });
  }
}

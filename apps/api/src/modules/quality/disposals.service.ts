import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { AttachmentOwner, DisposalMethod, DisposalStatus, DocumentType, Permissions, SessionUser, StockTxnType } from '@sil/shared';
import { DOC_STYLES, esc, fmtDate, letterhead, money } from '../../common/html';
import { StoreScope } from '../../common/store-scope';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { AttachmentsService } from '../files/attachments.service';
import { InventoryService } from '../inventory/inventory.service';
import { MovementLine, postMovements } from '../inventory/posting';
import { PdfService } from '../mail/pdf.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { Disposal, DisposalLine, DisposalMember } from './disposal.entities';
import { HoldsService } from './holds.service';
import { QualityHold } from './quality.entities';

const r2 = (n: number) => Math.round(n * 100) / 100;
const EDITABLE = [DisposalStatus.DRAFT, DisposalStatus.RETURNED];

export interface DisposalInput {
  storeId: string;
  method: DisposalMethod;
  reason: string;
  recipient?: string | null;
  publicNoticeRef?: string | null;
  notes?: string | null;
  lines: { batchId: string; binId?: string | null; quantity: number }[];
}

/**
 * What must be in place before a disposal goes for approval. Committee
 * sign-offs always; with the PPADA rule set, a public notice for a sale and
 * at least the configured committee size.
 */
export function disposalProblems(d: { method: DisposalMethod; recipient: string | null; publicNoticeRef: string | null }, signed: number, minCommittee: number, ppada: boolean): string[] {
  const out: string[] = [];
  if (signed < minCommittee) out.push(`${minCommittee} committee sign-offs are needed (${signed} so far)`);
  if ([DisposalMethod.SALE, DisposalMethod.DONATION, DisposalMethod.TRANSFER, DisposalMethod.RETURN_TO_SUPPLIER].includes(d.method) && !d.recipient?.trim()) out.push('Name the buyer, receiving facility or supplier');
  if (ppada && d.method === DisposalMethod.SALE && !d.publicNoticeRef?.trim()) out.push('PPADA rule set: a sale of public stores needs the public notice / tender reference');
  return out;
}

@Injectable()
export class DisposalsService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
    private readonly holds: HoldsService,
    private readonly attachments: AttachmentsService,
    private readonly pdf: PdfService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.DISPOSAL, this);
    this.links.registerResolver(DocumentType.DISPOSAL, async (ids) => {
      const rows = await this.ds.getRepository(Disposal).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.createdAt.toISOString().slice(0, 10), amount: r.totalValue }]));
    });
    this.attachments.registerOwner(AttachmentOwner.DISPOSAL, {
      read: [Permissions.DISPOSALS_MANAGE, Permissions.INVENTORY_READ],
      write: [Permissions.DISPOSALS_MANAGE],
      visible: async (m, id, actor) => {
        const [d] = await m.query(`SELECT store_id FROM disposal WHERE id = $1`, [id]);
        const scope = actor ? StoreScope.current() : null;
        return !!d && (scope === null || scope.includes(d.store_id));
      },
    });
    // A rejected quality hold raises a draft disposal of the batch's stock in the store (or every store).
    this.holds.onReject = (m, hold, actor) => this.fromHold(m, hold, actor);
  }

  private async buildLines(m: EntityManager, storeId: string, lines: DisposalInput['lines']): Promise<Partial<DisposalLine>[]> {
    if (!lines.length) throw new BadRequestException('Add the stock to dispose of');
    const out: Partial<DisposalLine>[] = [];
    for (const [i, l] of lines.entries()) {
      const [b] = await m.query(
        `SELECT b.id, b.item_id, b.unit_cost::float AS cost, COALESCE(SUM(sb.on_hand), 0)::float AS on_hand
           FROM batch b LEFT JOIN stock_balance sb ON sb.batch_id = b.id AND sb.store_id = $2 AND sb.bin_id IS NOT DISTINCT FROM $3
          WHERE b.id = $1 GROUP BY b.id`,
        [l.batchId, storeId, l.binId ?? null],
      );
      if (!b) throw new BadRequestException(`Line ${i + 1}: batch not found`);
      if (l.quantity <= 0 || l.quantity > b.on_hand + 1e-9) throw new BadRequestException(`Line ${i + 1}: only ${b.on_hand} on hand in that location`);
      out.push({ itemId: b.item_id, batchId: l.batchId, binId: l.binId ?? null, quantity: l.quantity, unitCost: b.cost });
    }
    return out;
  }

  async create(dto: DisposalInput, actor: SessionUser, m?: EntityManager) {
    StoreScope.assert(dto.storeId);
    const run = async (tx: EntityManager) => {
      const lines = await this.buildLines(tx, dto.storeId, dto.lines);
      const d = await tx.save(
        tx.create(Disposal, {
          number: await this.numbering.next(DocumentType.DISPOSAL, { storeId: dto.storeId, manager: tx }),
          storeId: dto.storeId,
          method: dto.method,
          reason: dto.reason,
          recipient: dto.recipient ?? null,
          publicNoticeRef: dto.publicNoticeRef ?? null,
          notes: dto.notes ?? null,
          status: DisposalStatus.DRAFT,
          totalValue: r2(lines.reduce((s, l) => s + l.quantity! * l.unitCost!, 0)),
          lines: lines.map((l) => tx.create(DisposalLine, l)),
          members: [tx.create(DisposalMember, { userId: actor.id, role: 'CHAIR' })],
        }),
      );
      return d.id;
    };
    const id = m ? await run(m) : await this.ds.transaction(run);
    return m ? id : this.get(id);
  }

  /** Draft disposals (one per store holding stock) for a rejected hold. Returns the first. */
  private async fromHold(m: EntityManager, hold: QualityHold, actor: SessionUser): Promise<string | null> {
    const rows: { store_id: string; bin_id: string | null; on_hand: number }[] = await m.query(
      `SELECT store_id, bin_id, on_hand::float AS on_hand FROM stock_balance WHERE batch_id = $1 AND on_hand > 0 ${hold.storeId ? 'AND store_id = $2' : ''} ORDER BY store_id`,
      hold.storeId ? [hold.batchId, hold.storeId] : [hold.batchId],
    );
    let first: string | null = null;
    for (const storeId of [...new Set(rows.map((r) => r.store_id))]) {
      const id = (await this.create(
        {
          storeId,
          method: DisposalMethod.DESTRUCTION,
          reason: `Rejected on ${hold.number} (${hold.reason.toLowerCase()}): ${hold.details}`.slice(0, 1000),
          lines: rows.filter((r) => r.store_id === storeId).map((r) => ({ batchId: hold.batchId, binId: r.bin_id, quantity: r.on_hand })),
        },
        actor,
        m,
      )) as string;
      await m.update(Disposal, id, { holdIds: [hold.id] });
      first ??= id;
    }
    return first;
  }

  private async lock(m: EntityManager, id: string) {
    const d = await m.findOne(Disposal, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!d) throw new NotFoundException('Disposal not found');
    StoreScope.assert(d.storeId);
    return d;
  }

  async update(id: string, dto: Partial<DisposalInput>, _actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`Disposal is ${d.status}`);
      if (dto.lines) {
        const lines = await this.buildLines(m, d.storeId, dto.lines);
        await m.delete(DisposalLine, { disposalId: id });
        await m.save(lines.map((l) => m.create(DisposalLine, { ...l, disposalId: id })));
        d.totalValue = r2(lines.reduce((s, l) => s + l.quantity! * l.unitCost!, 0));
      }
      for (const k of ['method', 'reason', 'recipient', 'publicNoticeRef', 'notes'] as const) if (dto[k] !== undefined) (d as never as Record<string, unknown>)[k] = dto[k];
      // Changes need fresh sign-offs.
      await m.update(DisposalMember, { disposalId: id }, { signedAt: null });
      await m.save(d);
    });
    return this.get(id);
  }

  /** Appoints the committee (users with disposals.manage). */
  async committee(id: string, members: { userId: string; role: string }[]) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`Disposal is ${d.status}`);
      const ids = [...new Set(members.map((x) => x.userId))];
      if (ids.length !== members.length) throw new BadRequestException('A member is listed twice');
      const ok: { user_id: string }[] = await m.query(
        `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $2 JOIN app_user u ON u.id = ur.user_id AND u.is_active WHERE ur.user_id = ANY($1::uuid[])`,
        [ids, Permissions.DISPOSALS_MANAGE],
      );
      if (ok.length !== ids.length) throw new BadRequestException('Every member needs the disposals.manage permission');
      const existing = await m.find(DisposalMember, { where: { disposalId: id } });
      for (const e of existing) if (!ids.includes(e.userId)) await m.delete(DisposalMember, { id: e.id });
      for (const x of members) {
        const e = existing.find((y) => y.userId === x.userId);
        if (e) await m.update(DisposalMember, e.id, { role: x.role });
        else await m.save(m.create(DisposalMember, { disposalId: id, userId: x.userId, role: x.role }));
      }
    });
    return this.get(id);
  }

  /** A committee member signs the recommendation (method and quantities as they stand). */
  async sign(id: string, actor: SessionUser, comment?: string) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`Disposal is ${d.status}`);
      const me = await m.findOneBy(DisposalMember, { disposalId: id, userId: actor.id });
      if (!me) throw new ForbiddenException('You are not on this disposal committee');
      Object.assign(me, { signedAt: new Date(), comment: comment ?? null });
      await m.save(me);
    });
    return this.get(id);
  }

  async submit(id: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`Disposal is ${d.status}`);
      const signed = await m.count(DisposalMember, { where: { disposalId: id, signedAt: Not(IsNull()) } });
      const ppada = await this.settings.get('procurement.ppadaRuleSet', m);
      const problems = disposalProblems(d, signed, await this.settings.get('disposal.minCommittee', m), ppada);
      if (problems.length) throw new BadRequestException({ code: 'DISPOSAL_INCOMPLETE', message: problems.join('; ') });
      d.status = DisposalStatus.PENDING_APPROVAL;
      d.submittedBy = actor.id;
      await m.save(d);
      await this.approvals.start(m, {
        documentType: DocumentType.DISPOSAL,
        documentId: d.id,
        documentNo: d.number,
        amount: d.totalValue,
        requestedBy: actor.id,
        summary: `${d.method.replace(/_/g, ' ').toLowerCase()} · ${d.reason}`.slice(0, 300),
        link: `/disposals/${d.id}`,
      });
    });
    return this.get(id);
  }

  /** Approved: the stock is written off (reason DISPOSAL). */
  async onApproved(m: EntityManager, req: ApprovalRequest, actor: SessionUser): Promise<void> {
    const d = await m.findOneByOrFail(Disposal, { id: req.documentId });
    const lines = await m.find(DisposalLine, { where: { disposalId: d.id } });
    const members = await m.find(DisposalMember, { where: { disposalId: d.id } });
    // Controlled drugs: a committee member other than the approver co-signs.
    const coSigner = members.find((x) => x.userId !== actor.id && x.signedAt)?.userId ?? null;
    const ctx = await this.inventory.postingContext(actor, { type: DocumentType.DISPOSAL, id: d.id, number: d.number }, undefined, coSigner, m);
    // The write-off is authorised by the approved workflow, not by the last approver's handling rights.
    ctx.permissions = null;
    const movements: MovementLine[] = lines.map((l) => ({ txnType: StockTxnType.ADJUSTMENT, storeId: d.storeId, binId: l.binId, itemId: l.itemId, batchId: l.batchId, quantity: -l.quantity, reasonCode: 'DISPOSAL' }));
    const posted = await postMovements(m, movements, ctx);
    for (const [i, l] of lines.entries()) await m.update(DisposalLine, l.id, { unitCost: posted[i].unitCost });
    d.totalValue = r2(lines.reduce((s, l, i) => s + l.quantity * posted[i].unitCost, 0));
    d.status = DisposalStatus.APPROVED;
    d.postedAt = new Date();
    d.lastComment = null;
    await m.save(d);
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(Disposal, req.documentId, { status: DisposalStatus.REJECTED, lastComment: comment });
  }

  async onReturned(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(Disposal, req.documentId, { status: DisposalStatus.RETURNED, lastComment: comment });
  }

  /** Records how and where it was disposed of and stores the certificate (PDF) with the record. */
  async complete(id: string, dto: { completedOn?: string; place: string; agent: string; wasteTransferNote?: string | null; proceeds?: number | null; notes?: string | null }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (d.status !== DisposalStatus.APPROVED) throw new ConflictException(`Disposal is ${d.status}; it must be approved first`);
      if (d.method === DisposalMethod.SALE && (dto.proceeds === undefined || dto.proceeds === null)) throw new BadRequestException('Record the proceeds of the sale');
      Object.assign(d, {
        status: DisposalStatus.COMPLETED,
        completedOn: dto.completedOn ?? (await this.settings.today(m)),
        place: dto.place,
        agent: dto.agent,
        wasteTransferNote: dto.wasteTransferNote ?? null,
        proceeds: dto.proceeds ?? null,
        notes: dto.notes ?? d.notes,
      });
      await m.save(d);
      const pdf = await this.renderCertificate(m, d.id);
      await this.attachments.attach(m, { ownerType: AttachmentOwner.DISPOSAL, ownerId: d.id, category: 'CERTIFICATE', fileName: `${d.number.replace(/\//g, '-')}-certificate.pdf`, mimeType: 'application/pdf', body: pdf }, actor.id, true);
    });
    return this.get(id);
  }

  async cancel(id: string) {
    await this.ds.transaction(async (m) => {
      const d = await this.lock(m, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`Disposal is ${d.status}`);
      d.status = DisposalStatus.CANCELLED;
      await m.save(d);
    });
    return this.get(id);
  }

  async get(id: string) {
    const d = await this.ds.getRepository(Disposal).findOne({ where: { id }, relations: { store: true, lines: { item: true, batch: true, bin: true }, members: true } });
    if (!d) throw new NotFoundException('Disposal not found');
    StoreScope.assert(d.storeId);
    const users = await this.ds.query(`SELECT id, full_name AS "fullName" FROM app_user WHERE id = ANY($1::uuid[])`, [(d.members ?? []).map((x) => x.userId)]);
    const files = await this.attachments.list(AttachmentOwner.DISPOSAL, id, null);
    return { ...d, members: (d.members ?? []).map((x) => ({ ...x, fullName: users.find((u: { id: string }) => u.id === x.userId)?.fullName })), files };
  }

  candidates(): Promise<{ id: string; fullName: string; username: string }[]> {
    return this.ds.query(
      `SELECT DISTINCT u.id, u.full_name AS "fullName", u.username FROM app_user u JOIN user_role ur ON ur.user_id = u.id
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1 WHERE u.is_active ORDER BY 2`,
      [Permissions.DISPOSALS_MANAGE],
    );
  }

  list(q: { status?: string; storeId?: string }) {
    const qb = this.ds.getRepository(Disposal).createQueryBuilder('d').leftJoinAndSelect('d.store', 'store').orderBy('d.createdAt', 'DESC').take(500);
    StoreScope.apply(qb, 'd.store_id');
    if (q.status) qb.andWhere('d.status = :s', { s: q.status });
    if (q.storeId) qb.andWhere('d.store_id = :st', { st: q.storeId });
    return qb.getMany();
  }

  /** Certificate of disposal (also stored as an attachment on completion). */
  async renderCertificate(m: EntityManager, id: string): Promise<Buffer> {
    const d = await m.findOneOrFail(Disposal, { where: { id }, relations: { store: true, lines: { item: true, batch: true }, members: true } });
    const [facility] = await m.query(`SELECT name, address, phone, email FROM facility ORDER BY created_at LIMIT 1`);
    const users: { id: string; full_name: string }[] = await m.query(`SELECT id, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [(d.members ?? []).map((x) => x.userId)]);
    const approvals: { by: string; step: string; at: Date }[] = await m.query(
      `SELECT u.full_name AS by, a.step_name AS step, a.at FROM approval_request r JOIN approval_action a ON a.request_id = r.id JOIN app_user u ON u.id = a.user_id
        WHERE r.document_type = $1 AND r.document_id = $2 AND a.action = 'APPROVE' ORDER BY a.at`,
      [DocumentType.DISPOSAL, id],
    );
    const fmt = await this.settings.get('locale.dateFormat', m);
    const tz = await this.settings.get('locale.timezone', m);
    const cur = await this.settings.get('locale.currency', m);
    const dt = (x: string | Date | null | undefined) => fmtDate(x, fmt, tz);
    const rows = (d.lines ?? [])
      .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item?.code)}</td><td>${esc(l.item?.name)}</td><td>${esc(l.batch?.batchNo)}</td><td>${dt(l.batch?.expiryDate)}</td><td class="r">${l.quantity}</td><td class="r">${money(l.unitCost, cur)}</td><td class="r">${money(l.quantity * l.unitCost, cur)}</td></tr>`)
      .join('');
    const committee = (d.members ?? []).map((x) => `<div class="sign">${esc(users.find((u) => u.id === x.userId)?.full_name)} (${esc(x.role.toLowerCase())})<br>${x.signedAt ? `Signed ${dt(x.signedAt)}` : 'Not signed'}</div>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLES}</style></head><body>
      ${letterhead(facility)}
      <h1 style="margin-top:12px">CERTIFICATE OF DISPOSAL</h1>
      <div class="grid">
        <div class="box">Disposal: <b>${esc(d.number)}</b><br>Store: ${esc(d.store?.name)}<br>Method: <b>${esc(d.method.replace(/_/g, ' ').toLowerCase())}</b>${d.recipient ? `<br>To: ${esc(d.recipient)}` : ''}</div>
        <div class="box">Completed: ${dt(d.completedOn)}<br>Place: ${esc(d.place ?? '—')}<br>Agent / handler: ${esc(d.agent ?? '—')}${d.wasteTransferNote ? `<br>Waste-transfer note: ${esc(d.wasteTransferNote)}` : ''}${d.proceeds !== null ? `<br>Proceeds: ${money(d.proceeds, cur)}` : ''}</div>
      </div>
      <p>Reason: ${esc(d.reason)}</p>
      <table><thead><tr><th>#</th><th>Code</th><th>Description</th><th>Batch</th><th>Expiry</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="totals"><tr><td><b>Total value</b></td><td class="r"><b>${money(d.totalValue, cur)}</b></td></tr></table>
      <p><b>Approved by:</b> ${approvals.map((a) => `${esc(a.by)} (${esc(a.step)}, ${dt(a.at)})`).join('; ') || '—'}</p>
      ${d.publicNoticeRef ? `<p><b>Public notice / board approval:</b> ${esc(d.publicNoticeRef)}</p>` : ''}
      <h3>Disposal committee</h3><div class="signs">${committee}</div>
      <div class="foot">Dispose of pharmaceutical waste only through a licensed handler, following the PPB and NEMA guidelines; keep the handler's waste-transfer note with this certificate.</div>
    </body></html>`;
    return this.pdf.render(html);
  }

  async certificate(id: string) {
    const d = await this.get(id);
    const stored = (d.files as { id: string; category: string }[]).find((f) => f.category === 'CERTIFICATE');
    if (stored) return { number: d.number, body: (await this.attachments.download(stored.id, null)).body };
    return { number: d.number, body: await this.renderCertificate(this.ds.manager, id) };
  }
}


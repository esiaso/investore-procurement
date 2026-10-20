import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { BidStatus, CommitteeRole, ContractStatus, ContractType, DocumentType, EvaluationStage, Permissions, SessionUser, SourcingMethod, TenderStatus } from '@sil/shared';
import { ApprovalRequest } from '../approvals/approvals.entities';
import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { DocumentLinksService } from '../approvals/document-links.service';
import { NotificationsService } from '../approvals/notifications.service';
import { MailService } from '../mail/mail.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { Contract, ContractLine, PerformanceSecurity } from './contracts.entities';
import { evaluateBids, scoringMembers } from './evaluation';
import { methodProblem } from './sourcing';
import { Bid, BidLine, BidOpening, EvaluationCriterion, EvaluationMember, EvaluationScore, Tender, TenderClarification, TenderDocumentIssue, TenderLine } from './tenders.entities';

const r2 = (n: number) => Math.round(n * 100) / 100;
const TENDER_METHODS = [SourcingMethod.OPEN_TENDER, SourcingMethod.RESTRICTED_TENDER, SourcingMethod.RFP] as string[];
const INVITATION_ONLY = [SourcingMethod.RESTRICTED_TENDER, SourcingMethod.RFP] as string[];

export interface TenderInput {
  title: string;
  description?: string | null;
  method: string;
  requisitionId?: string | null;
  planLineId?: string | null;
  departmentId?: string | null;
  estimatedValue: number;
  closingAt: string;
  bidSecurityAmount?: number;
  bidValidityDays?: number;
  technicalWeight?: number;
  technicalPassMark?: number;
  invitedSupplierIds?: string[];
  justification?: string | null;
  lines: { itemId?: string | null; description?: string; quantity: number; specification?: string | null }[];
  criteria?: { stage: EvaluationStage; name: string; weight?: number; maxScore?: number }[];
}

export interface BidInput {
  lines: { tenderLineId: string; unitPrice: number; offeredBrand?: string | null }[];
  bidSecurityRef?: string | null;
  bidSecurityAmount?: number;
  deliveryDays?: number | null;
  technicalProposal?: string | null;
}

/**
 * Tender lifecycle: notice → bid documents → clarifications / addenda → sealed
 * bids → opening (minutes) → committee with conflict-of-interest declarations →
 * preliminary, technical and financial evaluation → recommendation and
 * professional opinion → award approval → award / regret notifications →
 * optional standstill (PPADA rule set) → contract signing.
 */
@Injectable()
export class TendersService implements OnModuleInit, ApprovalHandler {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly links: DocumentLinksService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler(DocumentType.TENDER, this);
    this.links.registerResolver(DocumentType.TENDER, async (ids) => {
      const rows = await this.ds.getRepository(Tender).findBy({ id: In(ids) });
      return new Map(rows.map((r) => [r.id, { status: r.status, date: r.closingAt.toISOString().slice(0, 10), amount: r.estimatedValue }]));
    });
  }

  private async lock(m: EntityManager, id: string) {
    const t = await m.findOne(Tender, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!t) throw new NotFoundException('Tender not found');
    return t;
  }

  private validateCriteria(criteria: TenderInput['criteria'], technicalWeight: number) {
    const tech = (criteria ?? []).filter((c) => c.stage === EvaluationStage.TECHNICAL);
    if (tech.length) {
      const sum = tech.reduce((s, c) => s + (c.weight ?? 0), 0);
      if (sum !== 100) throw new BadRequestException(`Technical criteria weights must add up to 100 (they add up to ${sum})`);
    } else if (technicalWeight > 0) {
      throw new BadRequestException('A technical weight needs technical criteria');
    }
    if ((criteria ?? []).some((c) => c.stage === EvaluationStage.FINANCIAL)) throw new BadRequestException('The financial stage is scored from prices, not criteria');
  }

  async create(dto: TenderInput, actor: SessionUser) {
    if (!TENDER_METHODS.includes(dto.method)) throw new BadRequestException(`A tender uses ${TENDER_METHODS.join(', ')}`);
    const id = await this.ds.transaction(async (m) => {
      const problem = methodProblem(await this.settings.get('procurement.sourcingMethods', m), dto.method, dto.estimatedValue, dto.justification);
      if (problem) throw new BadRequestException({ code: 'SOURCING_METHOD', message: problem });
      const technicalWeight = dto.technicalWeight ?? 0;
      this.validateCriteria(dto.criteria, technicalWeight);
      if (new Date(dto.closingAt) <= new Date()) throw new BadRequestException('The closing time must be in the future');
      const tender = await m.save(
        m.create(Tender, {
          number: await this.numbering.next(DocumentType.TENDER, { manager: m }),
          title: dto.title,
          description: dto.description ?? null,
          method: dto.method,
          requisitionId: dto.requisitionId ?? null,
          planLineId: dto.planLineId ?? null,
          departmentId: dto.departmentId ?? actor.departmentId ?? null,
          estimatedValue: dto.estimatedValue,
          closingAt: new Date(dto.closingAt),
          bidSecurityAmount: dto.bidSecurityAmount ?? 0,
          bidValidityDays: dto.bidValidityDays ?? (await this.settings.get('procurement.bidValidityDays', m)),
          technicalWeight,
          technicalPassMark: dto.technicalPassMark ?? 0,
          invitedSupplierIds: dto.invitedSupplierIds ?? [],
          status: TenderStatus.DRAFT,
          lines: await Promise.all(
            dto.lines.map(async (l, i) => {
              let description = l.description?.trim();
              if (l.itemId && !description) description = (await m.query(`SELECT name FROM item WHERE id = $1`, [l.itemId]))[0]?.name;
              if (!description) throw new BadRequestException(`Line ${i + 1}: item or description needed`);
              return m.create(TenderLine, { lineNo: i + 1, itemId: l.itemId ?? null, description, quantity: l.quantity, specification: l.specification ?? null });
            }),
          ),
        }),
      );
      for (const [i, c] of (dto.criteria ?? []).entries()) {
        await m.save(m.create(EvaluationCriterion, { tenderId: tender.id, stage: c.stage, name: c.name, weight: c.stage === EvaluationStage.TECHNICAL ? (c.weight ?? 0) : 0, maxScore: c.stage === EvaluationStage.PRELIMINARY ? 1 : (c.maxScore ?? 10), sortOrder: i }));
      }
      if (dto.requisitionId) {
        const [pr] = await m.query(`SELECT number FROM purchase_requisition WHERE id = $1`, [dto.requisitionId]);
        if (pr) await this.links.link(m, { type: DocumentType.PURCHASE_REQUISITION, id: dto.requisitionId, no: pr.number }, { type: DocumentType.TENDER, id: tender.id, no: tender.number });
      }
      return tender.id;
    });
    return this.get(id, actor);
  }

  /** Publishes the notice; invited suppliers (restricted / RFP) are emailed. */
  async publish(id: string) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.DRAFT) throw new ConflictException(`Tender is ${t.status}`);
      if (t.closingAt <= new Date()) throw new BadRequestException('The closing time has passed; change it first');
      if (INVITATION_ONLY.includes(t.method)) {
        const rule = (await this.settings.get('procurement.sourcingMethods', m)).find((r) => r.code === t.method);
        if (t.invitedSupplierIds.length < (rule?.minBidders ?? 1)) throw new BadRequestException(`Invite at least ${rule?.minBidders ?? 1} suppliers`);
      }
      t.status = TenderStatus.PUBLISHED;
      t.publishedAt = new Date();
      await m.save(t);
      for (const s of await this.supplierContacts(m, t.invitedSupplierIds)) {
        await this.mail.enqueue(m, {
          to: s.email,
          subject: `Invitation to tender ${t.number}: ${t.title}`,
          text: `Dear ${s.name},\n\nYou are invited to bid for ${t.number} "${t.title}". Bids close on ${t.closingAt.toISOString().replace('T', ' ').slice(0, 16)} (UTC). Bid documents and clarifications are available in the supplier portal or from the procurement office.\n\nProcurement`,
          doc: { type: DocumentType.TENDER, id: t.id },
        });
      }
    });
  }

  private async supplierContacts(m: EntityManager, ids: string[]): Promise<{ id: string; name: string; email: string }[]> {
    if (!ids.length) return [];
    const rows: { id: string; name: string; email: string | null }[] = await m.query(`SELECT id, name, email FROM supplier WHERE id = ANY($1::uuid[])`, [ids]);
    return rows.filter((r) => r.email) as { id: string; name: string; email: string }[];
  }

  private assertCanBid(t: Tender, supplierId: string) {
    if (t.status !== TenderStatus.PUBLISHED) throw new ConflictException(`Tender is ${t.status}`);
    if (INVITATION_ONLY.includes(t.method) && !t.invitedSupplierIds.includes(supplierId)) throw new ForbiddenException('This tender is by invitation only');
  }

  async issueDocument(id: string, supplierId: string, fee: number, actor: SessionUser | null) {
    return this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      this.assertCanBid(t, supplierId);
      if (t.closingAt <= new Date()) throw new ConflictException('The tender has closed');
      const existing = await m.findOneBy(TenderDocumentIssue, { tenderId: id, supplierId });
      if (existing) return existing;
      return m.save(m.create(TenderDocumentIssue, { tenderId: id, supplierId, fee, issuedBy: actor?.id ?? null }));
    });
  }

  async askClarification(id: string, supplierId: string | null, question: string) {
    return this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (supplierId) this.assertCanBid(t, supplierId);
      else if (t.status !== TenderStatus.PUBLISHED) throw new ConflictException(`Tender is ${t.status}`);
      return m.save(m.create(TenderClarification, { tenderId: id, supplierId, question }));
    });
  }

  /** Answers a question (or issues an addendum); everyone holding the bid documents is emailed. */
  async answerClarification(id: string, clarificationId: string, dto: { answer: string; isAddendum?: boolean; question?: string }, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.PUBLISHED) throw new ConflictException(`Tender is ${t.status}`);
      let c = clarificationId === 'new' ? m.create(TenderClarification, { tenderId: id, supplierId: null, question: dto.question ?? 'Addendum' }) : await m.findOneBy(TenderClarification, { id: clarificationId, tenderId: id });
      if (!c) throw new NotFoundException('Clarification not found');
      Object.assign(c, { answer: dto.answer, isAddendum: dto.isAddendum ?? false, answeredAt: new Date(), answeredBy: actor.id });
      c = await m.save(c);
      const holders: { supplier_id: string }[] = await m.query(`SELECT supplier_id FROM tender_document_issue WHERE tender_id = $1`, [id]);
      for (const s of await this.supplierContacts(m, [...new Set([...holders.map((h) => h.supplier_id), ...t.invitedSupplierIds])])) {
        await this.mail.enqueue(m, {
          to: s.email,
          subject: `${c.isAddendum ? 'Addendum' : 'Clarification'} to tender ${t.number}`,
          text: `Question: ${c.question}\n\n${c.isAddendum ? 'Addendum' : 'Answer'}: ${c.answer}`,
          doc: { type: DocumentType.TENDER, id: t.id },
        });
      }
      return c;
    });
  }

  /**
   * Records (or replaces, until closing) a supplier's bid. Late bids are
   * refused. Officers record physical bids; suppliers submit in the portal.
   */
  async submitBid(id: string, supplierId: string, dto: BidInput, actor: SessionUser, viaPortal: boolean) {
    return this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      this.assertCanBid(t, supplierId);
      if (new Date() >= t.closingAt) throw new ConflictException({ code: 'LATE_BID', message: 'Bids closed at the closing time; late bids are not accepted' });
      const [sup] = await m.query(`SELECT status FROM supplier WHERE id = $1`, [supplierId]);
      if (!sup) throw new NotFoundException('Supplier not found');
      if (sup.status !== 'ACTIVE') throw new ForbiddenException(`Supplier is ${sup.status}`);
      if (t.bidSecurityAmount > 0 && (dto.bidSecurityAmount ?? 0) < t.bidSecurityAmount) throw new BadRequestException(`A bid security of at least ${t.bidSecurityAmount} is required`);
      const lines = await m.find(TenderLine, { where: { tenderId: id } });
      if (dto.lines.length !== lines.length || !lines.every((l) => dto.lines.some((x) => x.tenderLineId === l.id))) throw new BadRequestException('Price every line of the tender');
      const total = r2(dto.lines.reduce((s, x) => s + x.unitPrice * lines.find((l) => l.id === x.tenderLineId)!.quantity, 0));
      // Bidding implies the documents were obtained.
      await m.query(`INSERT INTO tender_document_issue (tender_id, supplier_id, fee) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [id, supplierId]);
      const existing = await m.findOneBy(Bid, { tenderId: id, supplierId });
      if (existing) await m.delete(Bid, { id: existing.id });
      return m.save(
        m.create(Bid, {
          tenderId: id,
          supplierId,
          submittedAt: new Date(),
          recordedBy: actor.id,
          viaPortal,
          bidSecurityRef: dto.bidSecurityRef ?? null,
          bidSecurityAmount: dto.bidSecurityAmount ?? 0,
          deliveryDays: dto.deliveryDays ?? null,
          technicalProposal: dto.technicalProposal ?? null,
          totalPrice: total,
          status: BidStatus.SUBMITTED,
          lines: dto.lines.map((l) => m.create(BidLine, { tenderLineId: l.tenderLineId, unitPrice: l.unitPrice, offeredBrand: l.offeredBrand ?? null })),
        }),
      );
    });
  }

  async withdrawBid(id: string, supplierId: string) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.PUBLISHED || new Date() >= t.closingAt) throw new ConflictException('Bids can only be withdrawn before closing');
      const bid = await m.findOneBy(Bid, { tenderId: id, supplierId, status: BidStatus.SUBMITTED });
      if (!bid) throw new NotFoundException('No bid to withdraw');
      bid.status = BidStatus.WITHDRAWN;
      await m.save(bid);
    });
  }

  /** Public opening after the closing time: minutes and price read-outs. */
  async open(id: string, dto: { attendees: string[]; minutes?: string; openedBy?: string[] }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (![TenderStatus.PUBLISHED, TenderStatus.CLOSED].includes(t.status)) throw new ConflictException(`Tender is ${t.status}`);
      if (new Date() < t.closingAt) throw new ConflictException('Bids cannot be opened before the closing time');
      const bids = await m.find(Bid, { where: { tenderId: id, status: BidStatus.SUBMITTED }, relations: { supplier: true } });
      const openers = [...new Set([actor.id, ...(dto.openedBy ?? [])])];
      await m.save(
        m.create(BidOpening, {
          tenderId: id,
          openedAt: new Date(),
          attendees: dto.attendees,
          openedBy: openers,
          readouts: bids.map((b) => ({ bidId: b.id, supplier: b.supplier?.name ?? b.supplierId, totalPrice: b.totalPrice, bidSecurity: b.bidSecurityRef, late: b.submittedAt > t.closingAt })),
          minutes: dto.minutes ?? null,
        }),
      );
      await m.update(Bid, { tenderId: id, status: BidStatus.SUBMITTED }, { status: BidStatus.OPENED });
      t.status = TenderStatus.OPENED;
      t.openedAt = new Date();
      await m.save(t);
    });
    return this.get(id, actor);
  }

  async appointCommittee(id: string, members: { userId: string; role: CommitteeRole }[]) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if ([TenderStatus.RECOMMENDED, TenderStatus.PENDING_APPROVAL, TenderStatus.AWARDED, TenderStatus.CONTRACTED, TenderStatus.CANCELLED].includes(t.status)) throw new ConflictException(`Tender is ${t.status}`);
      if (members.filter((x) => x.role === CommitteeRole.CHAIR).length !== 1) throw new BadRequestException('Appoint exactly one chair');
      const ids = members.map((x) => x.userId);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('A member is listed twice');
      const eligible: { user_id: string }[] = await m.query(
        `SELECT DISTINCT ur.user_id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $2
           JOIN app_user u ON u.id = ur.user_id AND u.is_active WHERE ur.user_id = ANY($1::uuid[])`,
        [ids, Permissions.TENDERS_EVALUATE],
      );
      const missing = ids.filter((u) => !eligible.some((e) => e.user_id === u));
      if (missing.length) throw new BadRequestException('Every member needs the tenders.evaluate permission');
      const existing = await m.find(EvaluationMember, { where: { tenderId: id } });
      for (const e of existing.filter((x) => !ids.includes(x.userId))) {
        if (await m.existsBy(EvaluationScore, { memberId: e.id })) throw new ConflictException('A member who has already scored cannot be removed');
        await m.delete(EvaluationMember, { id: e.id });
      }
      for (const x of members) {
        const row = existing.find((e) => e.userId === x.userId);
        if (row) await m.update(EvaluationMember, row.id, { role: x.role });
        else await m.save(m.create(EvaluationMember, { tenderId: id, userId: x.userId, role: x.role }));
      }
      await this.notifications.notify(m, ids, { title: `You are on the evaluation committee for ${t.number}`, body: 'Declare any conflict of interest before scoring.', link: `/tenders/${t.id}` });
    });
  }

  evaluators(): Promise<{ id: string; fullName: string; username: string }[]> {
    return this.ds.query(
      `SELECT DISTINCT u.id, u.full_name AS "fullName", u.username FROM app_user u JOIN user_role ur ON ur.user_id = u.id
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
        WHERE u.is_active ORDER BY 2`,
      [Permissions.TENDERS_EVALUATE],
    );
  }

  /** A member's conflict-of-interest declaration (required before scoring; once only). */
  async declare(id: string, actor: SessionUser, dto: { hasConflict: boolean; declaration: string }) {
    return this.ds.transaction(async (m) => {
      const member = await m.findOneBy(EvaluationMember, { tenderId: id, userId: actor.id });
      if (!member) throw new ForbiddenException('You are not on this evaluation committee');
      if (member.declaredAt) throw new ConflictException('Already declared');
      Object.assign(member, { declaredAt: new Date(), hasConflict: dto.hasConflict, declaration: dto.declaration });
      return m.save(member);
    });
  }

  async score(id: string, actor: SessionUser, scores: { criterionId: string; bidId: string; score: number; comment?: string }[]) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (![TenderStatus.OPENED, TenderStatus.EVALUATION].includes(t.status)) throw new ConflictException(`Scoring is not open (tender is ${t.status})`);
      const member = await m.findOneBy(EvaluationMember, { tenderId: id, userId: actor.id });
      if (!member) throw new ForbiddenException('You are not on this evaluation committee');
      if (!member.declaredAt) throw new ForbiddenException({ code: 'COI_REQUIRED', message: 'Declare any conflict of interest before scoring' });
      if (member.hasConflict) throw new ForbiddenException('You declared a conflict of interest and may not score this tender');
      const criteria = await m.find(EvaluationCriterion, { where: { tenderId: id } });
      const bids = await m.find(Bid, { where: { tenderId: id, status: Not(In([BidStatus.WITHDRAWN, BidStatus.SUBMITTED])) } });
      for (const s of scores) {
        const c = criteria.find((x) => x.id === s.criterionId);
        if (!c) throw new BadRequestException('Unknown criterion');
        if (!bids.some((b) => b.id === s.bidId)) throw new BadRequestException('Unknown or unopened bid');
        if (s.score < 0 || s.score > c.maxScore) throw new BadRequestException(`${c.name}: score 0–${c.maxScore}`);
        await m.query(
          `INSERT INTO evaluation_score (tender_id, criterion_id, bid_id, member_id, score, comment) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (criterion_id, bid_id, member_id) DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment, scored_at = now()`,
          [id, s.criterionId, s.bidId, member.id, s.score, s.comment ?? null],
        );
      }
      if (t.status === TenderStatus.OPENED) {
        t.status = TenderStatus.EVALUATION;
        await m.save(t);
      }
    });
    return this.evaluation(id);
  }

  /** Current evaluation (ranking) and what is still to be scored. */
  async evaluation(id: string, m: EntityManager = this.ds.manager) {
    const t = await m.findOneBy(Tender, { id });
    if (!t) throw new NotFoundException('Tender not found');
    const members = await m.find(EvaluationMember, { where: { tenderId: id } });
    const criteria = await m.find(EvaluationCriterion, { where: { tenderId: id }, order: { sortOrder: 'ASC' } });
    const bids = await m.find(Bid, { where: { tenderId: id, status: Not(In([BidStatus.WITHDRAWN, BidStatus.SUBMITTED])) }, relations: { supplier: true } });
    const scores = await m.find(EvaluationScore, { where: { tenderId: id } });
    const voters = scoringMembers(members);
    const results = evaluateBids({
      bids: bids.map((b) => ({ id: b.id, totalPrice: b.totalPrice })),
      members: voters,
      criteria: criteria.map((c) => ({ id: c.id, stage: c.stage, weight: c.weight, maxScore: c.maxScore })),
      scores: scores.map((s) => ({ criterionId: s.criterionId, bidId: s.bidId, memberId: s.memberId, score: s.score })),
      technicalWeight: t.technicalWeight,
      technicalPassMark: t.technicalPassMark,
    });
    // Missing: preliminary scores for every bid; technical scores for bids passing preliminary.
    const missing: { memberId: string; userId: string; bidId: string; criterion: string }[] = [];
    for (const memberId of voters) {
      for (const b of bids) {
        const r = results.find((x) => x.bidId === b.id)!;
        for (const c of criteria) {
          if (c.stage === EvaluationStage.TECHNICAL && !r.responsive) continue;
          if (!scores.some((s) => s.memberId === memberId && s.bidId === b.id && s.criterionId === c.id)) missing.push({ memberId, userId: members.find((x) => x.id === memberId)!.userId, bidId: b.id, criterion: c.name });
        }
      }
    }
    const undeclared = members.filter((x) => !x.declaredAt).map((x) => x.userId);
    return {
      members: members.map((x) => ({ ...x, scoring: voters.includes(x.id) })),
      criteria,
      bids: bids.map((b) => ({ id: b.id, supplierId: b.supplierId, supplier: b.supplier?.name, totalPrice: b.totalPrice, ...results.find((r) => r.bidId === b.id)! })),
      complete: voters.length >= 1 && missing.length === 0 && undeclared.length === 0,
      missing,
      undeclared,
    };
  }

  /** Locks the evaluation and records the recommendation (top-ranked bid). */
  async recommend(id: string, dto: { report: string }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.EVALUATION) throw new ConflictException(`Tender is ${t.status}`);
      const ev = await this.evaluation(id, m);
      const min = await this.settings.get('procurement.minEvaluationCommittee', m);
      if (ev.members.filter((x) => x.scoring).length < min) throw new BadRequestException(`At least ${min} committee members without a conflict must evaluate`);
      if (!ev.complete) throw new BadRequestException({ code: 'EVALUATION_INCOMPLETE', message: `Evaluation incomplete: ${ev.undeclared.length} member(s) have not declared, ${ev.missing.length} score(s) missing` });
      const chair = ev.members.find((x) => x.role === CommitteeRole.CHAIR);
      if (chair?.userId !== actor.id && !actor.permissions.includes(Permissions.TENDERS_MANAGE)) throw new ForbiddenException('The chair (or a procurement manager) records the recommendation');
      for (const b of ev.bids) {
        const status = !b.responsive ? BidStatus.NON_RESPONSIVE : !b.qualified ? BidStatus.TECHNICALLY_FAILED : BidStatus.QUALIFIED;
        await m.update(Bid, b.id, { status, technicalScore: b.technicalScore, financialScore: b.financialScore, combinedScore: b.combinedScore, rank: b.rank });
      }
      const top = ev.bids.find((b) => b.rank === 1);
      if (!top) throw new BadRequestException('No bid qualified; cancel or re-tender');
      Object.assign(t, { status: TenderStatus.RECOMMENDED, recommendedBidId: top.id, evaluationReport: dto.report });
      await m.save(t);
    });
    return this.get(id, actor);
  }

  /** Head of procurement's professional opinion, then award approval. Committee members may not give it. */
  async submitForAward(id: string, dto: { opinion: string }, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.RECOMMENDED) throw new ConflictException(`Tender is ${t.status}`);
      if (await m.existsBy(EvaluationMember, { tenderId: id, userId: actor.id })) throw new ForbiddenException('The professional opinion must come from outside the evaluation committee');
      const bid = await m.findOneOrFail(Bid, { where: { id: t.recommendedBidId! }, relations: { supplier: true } });
      Object.assign(t, { professionalOpinion: dto.opinion, opinionBy: actor.id, status: TenderStatus.PENDING_APPROVAL });
      await m.save(t);
      await this.approvals.start(m, {
        documentType: DocumentType.TENDER,
        documentId: t.id,
        documentNo: t.number,
        amount: bid.totalPrice,
        departmentId: t.departmentId,
        requestedBy: actor.id,
        summary: `Award ${t.title} to ${bid.supplier?.name ?? ''}`,
        link: `/tenders/${t.id}`,
      });
    });
    return this.get(id, actor);
  }

  /** Award approved: notify the winner and the others; standstill if the PPADA rule set is on. */
  async onApproved(m: EntityManager, req: ApprovalRequest): Promise<void> {
    const t = await m.findOneByOrFail(Tender, { id: req.documentId });
    const bids = await m.find(Bid, { where: { tenderId: t.id, status: Not(BidStatus.WITHDRAWN) }, relations: { supplier: true } });
    const ppada = await this.settings.get('procurement.ppadaRuleSet', m);
    const days = await this.settings.get('procurement.standstillDays', m);
    t.status = TenderStatus.AWARDED;
    t.awardedBidId = t.recommendedBidId;
    t.awardedAt = new Date();
    t.standstillUntil = ppada ? new Date(Date.now() + days * 86_400_000) : null;
    await m.save(t);
    for (const b of bids) {
      const won = b.id === t.awardedBidId;
      await m.update(Bid, b.id, { status: won ? BidStatus.AWARDED : BidStatus.REGRET });
      if (!b.supplier?.email) continue;
      await this.mail.enqueue(m, {
        to: b.supplier.email,
        subject: won ? `Notification of award: ${t.number}` : `Tender ${t.number}: outcome`,
        text: won
          ? `Dear ${b.supplier.name},\n\nWe are pleased to inform you that your bid of ${b.totalPrice} for "${t.title}" has been accepted.${t.standstillUntil ? ` The contract will be signed after the standstill period ending ${t.standstillUntil.toISOString().slice(0, 10)}.` : ' We will contact you to sign the contract.'}\n\nProcurement`
          : `Dear ${b.supplier.name},\n\nThank you for bidding for "${t.title}". We regret that your bid was not successful${b.statusReason ? ` (${b.statusReason})` : b.status === BidStatus.NON_RESPONSIVE ? ' (non-responsive at preliminary evaluation)' : b.status === BidStatus.TECHNICALLY_FAILED ? ' (below the technical pass mark)' : ''}.${t.standstillUntil ? ` You may raise a complaint before ${t.standstillUntil.toISOString().slice(0, 10)}.` : ''}\n\nProcurement`,
        doc: { type: DocumentType.TENDER, id: t.id },
      });
    }
  }

  async onRejected(m: EntityManager, req: ApprovalRequest, _a: SessionUser, comment: string): Promise<void> {
    await m.update(Tender, req.documentId, { status: TenderStatus.EVALUATION, recommendedBidId: null, professionalOpinion: null, cancellationReason: `Award rejected: ${comment}`.slice(0, 1000) });
  }

  async onReturned(m: EntityManager, req: ApprovalRequest): Promise<void> {
    await m.update(Tender, req.documentId, { status: TenderStatus.RECOMMENDED });
  }

  /** Contract from the awarded bid (after any standstill). */
  async signContract(
    id: string,
    dto: { type: ContractType; startDate: string; endDate: string; deliveryTerms?: string; paymentTermsDays?: number; leadTimeDays?: number; supplierSignatory: string; security?: { securityType: string; reference: string; issuer: string; amount: number; expiresOn: string } },
    actor: SessionUser,
  ) {
    const contractId = await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if (t.status !== TenderStatus.AWARDED) throw new ConflictException(`Tender is ${t.status}`);
      if (t.standstillUntil && t.standstillUntil > new Date()) throw new ConflictException({ code: 'STANDSTILL', message: `Standstill period until ${t.standstillUntil.toISOString().slice(0, 10)}` });
      if (dto.endDate < dto.startDate) throw new BadRequestException('End date before start date');
      const bid = await m.findOneOrFail(Bid, { where: { id: t.awardedBidId! }, relations: { lines: true } });
      const lines = await m.find(TenderLine, { where: { tenderId: id } });
      const unpriced = lines.filter((l) => !l.itemId);
      if (unpriced.length) throw new BadRequestException('Every tender line needs a catalogue item to become a contract line');
      const contract = await m.save(
        m.create(Contract, {
          number: await this.numbering.next(DocumentType.CONTRACT, { manager: m }),
          title: t.title,
          supplierId: bid.supplierId,
          tenderId: t.id,
          type: dto.type,
          status: ContractStatus.ACTIVE,
          startDate: dto.startDate,
          endDate: dto.endDate,
          value: bid.totalPrice,
          deliveryTerms: dto.deliveryTerms ?? null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          leadTimeDays: dto.leadTimeDays ?? null,
          signedAt: new Date(),
          signedBy: actor.id,
          supplierSignatory: dto.supplierSignatory,
          lines: lines.map((l) => {
            const bl = bid.lines!.find((x) => x.tenderLineId === l.id)!;
            return m.create(ContractLine, { itemId: l.itemId!, unitPrice: bl.unitPrice, quantity: l.quantity, brand: bl.offeredBrand });
          }),
        }),
      );
      if (dto.security) await m.save(m.create(PerformanceSecurity, { ...dto.security, contractId: contract.id }));
      t.status = TenderStatus.CONTRACTED;
      t.contractId = contract.id;
      await m.save(t);
      await this.links.link(m, { type: DocumentType.TENDER, id: t.id, no: t.number }, { type: DocumentType.CONTRACT, id: contract.id, no: contract.number });
      return contract.id;
    });
    return { contractId };
  }

  async cancel(id: string, reason: string) {
    await this.ds.transaction(async (m) => {
      const t = await this.lock(m, id);
      if ([TenderStatus.CONTRACTED, TenderStatus.CANCELLED, TenderStatus.PENDING_APPROVAL].includes(t.status)) throw new ConflictException(`Tender is ${t.status}`);
      Object.assign(t, { status: TenderStatus.CANCELLED, cancellationReason: reason });
      await m.save(t);
    });
  }

  list(q: { status?: string; search?: string }) {
    const qb = this.ds.getRepository(Tender).createQueryBuilder('t').orderBy('t.createdAt', 'DESC').take(500);
    if (q.status) qb.andWhere('t.status = :s', { s: q.status });
    if (q.search) qb.andWhere('(t.number ILIKE :q OR t.title ILIKE :q)', { q: `%${q.search}%` });
    return qb.getMany();
  }

  /**
   * Full tender for staff. Until the bids are opened their prices and contents
   * stay sealed: only who bid and when is shown.
   */
  async get(id: string, actor?: SessionUser) {
    const t = await this.ds.getRepository(Tender).findOne({ where: { id }, relations: { lines: { item: true } }, order: { lines: { lineNo: 'ASC' } } });
    if (!t) throw new NotFoundException('Tender not found');
    const sealed = !t.openedAt;
    const bids = await this.ds.getRepository(Bid).find({ where: { tenderId: id }, relations: { supplier: true, lines: true }, order: { submittedAt: 'ASC' } });
    const documents = await this.ds.getRepository(TenderDocumentIssue).find({ where: { tenderId: id }, relations: { supplier: true }, order: { issuedAt: 'ASC' } });
    const clarifications = await this.ds.getRepository(TenderClarification).find({ where: { tenderId: id }, order: { createdAt: 'ASC' } });
    const opening = await this.ds.getRepository(BidOpening).findOneBy({ tenderId: id });
    const criteria = await this.ds.getRepository(EvaluationCriterion).find({ where: { tenderId: id }, order: { sortOrder: 'ASC' } });
    const members = await this.ds.query(
      `SELECT m.id, m.user_id AS "userId", u.full_name AS "fullName", m.role, m.declared_at AS "declaredAt", m.has_conflict AS "hasConflict"
         FROM evaluation_member m JOIN app_user u ON u.id = m.user_id WHERE m.tender_id = $1 ORDER BY m.role, u.full_name`,
      [id],
    );
    const isMember = actor ? members.some((x: { userId: string }) => x.userId === actor.id) : false;
    return {
      ...t,
      sealed,
      bids: bids.map((b) =>
        sealed
          ? { id: b.id, supplierId: b.supplierId, supplier: b.supplier?.name, submittedAt: b.submittedAt, status: b.status, viaPortal: b.viaPortal, bidSecurityRef: b.bidSecurityRef }
          : { ...b, supplier: b.supplier?.name },
      ),
      documents: documents.map((d) => ({ supplierId: d.supplierId, supplier: d.supplier?.name, issuedAt: d.issuedAt, fee: d.fee })),
      clarifications,
      opening,
      criteria,
      members,
      isMember,
    };
  }

  /** Job: closes tenders whose closing time passed (bids then await opening). */
  async closeDue(): Promise<{ closed: number }> {
    const res = await this.ds.query(`UPDATE tender SET status = 'CLOSED', updated_at = now() WHERE status = 'PUBLISHED' AND closing_at <= now() RETURNING id`);
    const rows = Array.isArray(res[0]) ? res[0] : res;
    return { closed: rows.length };
  }
}

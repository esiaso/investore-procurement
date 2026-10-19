import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { ApprovalActionType, ApprovalStatus, ApproverType, SessionUser } from '@sil/shared';
import { SettingsService } from '../settings/settings.service';
import { ApprovalAction, ApprovalDelegation, ApprovalRequest, ApprovalStep, ApprovalWorkflow } from './approvals.entities';
import { NotificationsService } from './notifications.service';
import { MatchInput, selectWorkflow } from './workflow-match';

/** Implemented by each module whose documents go through approvals. */
export interface ApprovalHandler {
  /** Runs in the approval transaction; throwing aborts the approval (e.g. budget exceeded). */
  onApproved(m: EntityManager, request: ApprovalRequest, actor: SessionUser): Promise<void>;
  onRejected(m: EntityManager, request: ApprovalRequest, actor: SessionUser, comment: string): Promise<void>;
  onReturned(m: EntityManager, request: ApprovalRequest, actor: SessionUser, comment: string): Promise<void>;
}

export interface StartApprovalInput extends MatchInput {
  documentId: string;
  documentNo: string;
  requestedBy: string;
  summary?: string;
  link?: string;
}

interface Eligibility {
  eligible: boolean;
  onBehalfOf: string | null;
}

@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  registerHandler(documentType: string, handler: ApprovalHandler): void {
    this.handlers.set(documentType, handler);
  }

  private handler(documentType: string): ApprovalHandler {
    const h = this.handlers.get(documentType);
    if (!h) throw new Error(`No approval handler registered for ${documentType}`);
    return h;
  }

  /** Starts an approval cycle in the caller's transaction and notifies the first approvers. */
  async start(m: EntityManager, input: StartApprovalInput): Promise<ApprovalRequest> {
    const pending = await m.findOneBy(ApprovalRequest, {
      documentType: input.documentType,
      documentId: input.documentId,
      status: ApprovalStatus.PENDING,
    });
    if (pending) throw new ConflictException('This document is already awaiting approval');
    const workflows = await m.find(ApprovalWorkflow, { where: { documentType: input.documentType, isActive: true }, relations: { steps: true } });
    const workflow = selectWorkflow(workflows, input);
    if (!workflow || !workflow.steps?.length) {
      throw new BadRequestException({
        message: `No approval workflow is configured for ${input.documentType} of ${input.amount}`,
        code: 'NO_WORKFLOW',
      });
    }
    const first = [...workflow.steps].sort((a, b) => a.sequence - b.sequence)[0];
    const request = await m.save(
      m.create(ApprovalRequest, {
        documentType: input.documentType,
        documentId: input.documentId,
        documentNo: input.documentNo,
        workflowId: workflow.id,
        status: ApprovalStatus.PENDING,
        currentStep: first.sequence,
        amount: input.amount,
        requestedBy: input.requestedBy,
        summary: input.summary ?? null,
        link: input.link ?? null,
      }),
    );
    await m.save(
      m.create(ApprovalAction, { requestId: request.id, stepSequence: 0, stepName: 'Submitted', action: ApprovalActionType.SUBMIT, userId: input.requestedBy }),
    );
    await this.notifyStep(m, request, first);
    return request;
  }

  /** Users who may act on a step: role members or the named user, plus their active delegates. */
  async approversFor(m: EntityManager, step: ApprovalStep): Promise<{ userId: string; onBehalfOf: string | null }[]> {
    const direct: string[] =
      step.approverType === ApproverType.USER
        ? step.userId
          ? [step.userId]
          : []
        : (
            await m.query(
              `SELECT ur.user_id FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active`,
              [step.roleId],
            )
          ).map((r: { user_id: string }) => r.user_id);
    if (!direct.length) return [];
    const today = await this.settings.today(m);
    const delegations = await m.query(
      `SELECT from_user_id, to_user_id FROM approval_delegation
        WHERE is_active AND from_user_id = ANY($1::uuid[]) AND $2::date BETWEEN starts_on AND ends_on`,
      [direct, today],
    );
    return [
      ...direct.map((userId) => ({ userId, onBehalfOf: null })),
      ...delegations.map((d: { from_user_id: string; to_user_id: string }) => ({ userId: d.to_user_id, onBehalfOf: d.from_user_id })),
    ];
  }

  private async eligibility(m: EntityManager, request: ApprovalRequest, step: ApprovalStep, actor: SessionUser): Promise<Eligibility> {
    const approvers = await this.approversFor(m, step);
    const direct = approvers.find((a) => a.userId === actor.id && a.onBehalfOf === null);
    if (direct) return { eligible: true, onBehalfOf: null };
    const delegated = approvers.find((a) => a.userId === actor.id);
    return { eligible: !!delegated, onBehalfOf: delegated?.onBehalfOf ?? null };
  }

  private async notifyStep(m: EntityManager, request: ApprovalRequest, step: ApprovalStep): Promise<void> {
    const approvers = (await this.approversFor(m, step)).map((a) => a.userId).filter((id) => id !== request.requestedBy);
    await this.notifications.notify(m, [...new Set(approvers)], {
      title: `Approval needed: ${request.documentNo}`,
      body: `${step.name}${request.summary ? ` · ${request.summary}` : ''}`,
      link: request.link,
    });
  }

  async act(requestId: string, actor: SessionUser, action: ApprovalActionType, comment?: string): Promise<ApprovalRequest> {
    if (![ApprovalActionType.APPROVE, ApprovalActionType.REJECT, ApprovalActionType.RETURN].includes(action)) {
      throw new BadRequestException('Unsupported action');
    }
    if (action !== ApprovalActionType.APPROVE && !comment?.trim()) {
      throw new BadRequestException('A comment is required to reject or return');
    }
    await this.ds.transaction(async (m) => {
      const request = await m.findOne(ApprovalRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
      if (!request) throw new NotFoundException('Approval request not found');
      if (request.status !== ApprovalStatus.PENDING) throw new ConflictException(`Request is ${request.status}`);
      // Segregation of duties.
      if (request.requestedBy === actor.id) throw new ForbiddenException('You cannot approve your own document');
      const steps = (await m.find(ApprovalStep, { where: { workflowId: request.workflowId }, order: { sequence: 'ASC' } })) ?? [];
      const step = steps.find((s) => s.sequence === request.currentStep)!;
      const { eligible, onBehalfOf } = await this.eligibility(m, request, step, actor);
      if (!eligible) throw new ForbiddenException(`You are not an approver for step "${step.name}"`);
      const earlier = await m.findOne(ApprovalAction, {
        where: { requestId, userId: actor.id, action: ApprovalActionType.APPROVE },
      });
      if (earlier) throw new ForbiddenException('Each step must be approved by a different person');

      await m.save(
        m.create(ApprovalAction, {
          requestId,
          stepSequence: step.sequence,
          stepName: step.name,
          action,
          userId: actor.id,
          onBehalfOfUserId: onBehalfOf,
          comment: comment?.trim() || null,
        }),
      );

      const h = this.handler(request.documentType);
      if (action === ApprovalActionType.APPROVE) {
        const next = steps.find((s) => s.sequence > step.sequence);
        if (next) {
          request.currentStep = next.sequence;
          await m.save(request);
          await this.notifyStep(m, request, next);
          return;
        }
        request.status = ApprovalStatus.APPROVED;
        await m.save(request);
        await h.onApproved(m, request, actor);
        await this.notifications.notify(m, [request.requestedBy], { title: `${request.documentNo} approved`, link: request.link });
      } else if (action === ApprovalActionType.REJECT) {
        request.status = ApprovalStatus.REJECTED;
        await m.save(request);
        await h.onRejected(m, request, actor, comment!.trim());
        await this.notifications.notify(m, [request.requestedBy], { title: `${request.documentNo} rejected`, body: comment, link: request.link });
      } else {
        request.status = ApprovalStatus.RETURNED;
        await m.save(request);
        await h.onReturned(m, request, actor, comment!.trim());
        await this.notifications.notify(m, [request.requestedBy], { title: `${request.documentNo} returned for amendment`, body: comment, link: request.link });
      }
    });
    return this.get(requestId);
  }

  /** Withdraws a pending cycle (document cancelled or edited). */
  async cancelPending(m: EntityManager, documentType: string, documentId: string, actorId: string): Promise<void> {
    const pending = await m.findOneBy(ApprovalRequest, { documentType, documentId, status: ApprovalStatus.PENDING });
    if (!pending) return;
    pending.status = ApprovalStatus.CANCELLED;
    await m.save(pending);
    await m.save(m.create(ApprovalAction, { requestId: pending.id, stepSequence: pending.currentStep, action: ApprovalActionType.CANCEL, userId: actorId }));
  }

  async get(id: string): Promise<ApprovalRequest> {
    const r = await this.ds.getRepository(ApprovalRequest).findOne({ where: { id }, relations: { workflow: { steps: true }, actions: true } });
    if (!r) throw new NotFoundException('Approval request not found');
    return r;
  }

  /** Every approval cycle of a document, with actions and user names. */
  async history(documentType: string, documentId: string) {
    const requests = await this.ds.getRepository(ApprovalRequest).find({
      where: { documentType, documentId },
      relations: { workflow: { steps: { role: true } }, actions: true },
      order: { createdAt: 'ASC' },
    });
    const userIds = [...new Set(requests.flatMap((r) => (r.actions ?? []).flatMap((a) => [a.userId, a.onBehalfOfUserId]).filter(Boolean)))] as string[];
    const users = userIds.length
      ? await this.ds.query(`SELECT id, username, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [userIds])
      : [];
    const name = new Map<string, string>(users.map((u: { id: string; full_name: string; username: string }) => [u.id, `${u.full_name} (${u.username})`]));
    return requests.map((r) => ({
      ...r,
      workflow: r.workflow ? { ...r.workflow, steps: [...(r.workflow.steps ?? [])].sort((a, b) => a.sequence - b.sequence) } : undefined,
      actions: [...(r.actions ?? [])]
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((a) => ({ ...a, userName: name.get(a.userId) ?? null, onBehalfOfName: a.onBehalfOfUserId ? (name.get(a.onBehalfOfUserId) ?? null) : null })),
    }));
  }

  /** Pending requests the user can act on now (directly or as a delegate). */
  async inbox(actor: SessionUser) {
    const today = await this.settings.today();
    return this.ds.query(
      `WITH delegators AS (
         SELECT from_user_id FROM approval_delegation
          WHERE to_user_id = $1 AND is_active AND $2::date BETWEEN starts_on AND ends_on
       )
       SELECT r.id, r.document_type AS "documentType", r.document_id AS "documentId", r.document_no AS "documentNo",
              r.amount::float AS amount, r.summary, r.link, r.created_at AS "createdAt", s.name AS "stepName",
              u.full_name AS "requestedByName", w.name AS "workflowName"
         FROM approval_request r
         JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step
         JOIN approval_workflow w ON w.id = r.workflow_id
         JOIN app_user u ON u.id = r.requested_by
        WHERE r.status = 'PENDING' AND r.requested_by <> $1
          AND NOT EXISTS (SELECT 1 FROM approval_action a WHERE a.request_id = r.id AND a.user_id = $1 AND a.action = 'APPROVE')
          AND (
            (s.approver_type = 'USER' AND (s.user_id = $1 OR s.user_id IN (SELECT from_user_id FROM delegators)))
            OR (s.approver_type = 'ROLE' AND EXISTS (
                  SELECT 1 FROM user_role ur JOIN app_user au ON au.id = ur.user_id
                   WHERE ur.role_id = s.role_id AND au.is_active
                     AND (ur.user_id = $1 OR ur.user_id IN (SELECT from_user_id FROM delegators))))
          )
        ORDER BY r.created_at`,
      [actor.id, today],
    );
  }

  // ------------------------------------------------------------------ configuration

  listWorkflows(): Promise<ApprovalWorkflow[]> {
    return this.ds.getRepository(ApprovalWorkflow).find({ relations: { steps: { role: true } }, order: { documentType: 'ASC', minAmount: 'ASC' } });
  }

  async saveWorkflow(id: string | null, dto: Omit<Partial<ApprovalWorkflow>, 'steps'> & { steps: Partial<ApprovalStep>[] }): Promise<ApprovalWorkflow> {
    if (!dto.steps?.length) throw new BadRequestException('A workflow needs at least one step');
    for (const s of dto.steps) {
      if (s.approverType === ApproverType.ROLE && !s.roleId) throw new BadRequestException('Role steps need a role');
      if (s.approverType === ApproverType.USER && !s.userId) throw new BadRequestException('User steps need a user');
    }
    if (dto.minAmount != null && dto.maxAmount != null && dto.maxAmount <= dto.minAmount) {
      throw new BadRequestException('maxAmount must be greater than minAmount');
    }
    return this.ds.transaction(async (m) => {
      let wf: ApprovalWorkflow;
      if (id) {
        const existing = await m.findOne(ApprovalWorkflow, { where: { id } });
        if (!existing) throw new NotFoundException('Workflow not found');
        const { steps: _s, ...rest } = dto;
        wf = await m.save(Object.assign(existing, rest));
        await m.delete(ApprovalStep, { workflowId: id });
      } else {
        const { steps: _s, ...rest } = dto;
        wf = await m.save(m.create(ApprovalWorkflow, rest));
      }
      await m.save(
        dto.steps.map((s, i) =>
          m.create(ApprovalStep, {
            workflowId: wf.id,
            sequence: i + 1,
            name: s.name ?? `Step ${i + 1}`,
            approverType: s.approverType!,
            roleId: s.approverType === ApproverType.ROLE ? s.roleId! : null,
            userId: s.approverType === ApproverType.USER ? s.userId! : null,
          }),
        ),
      );
      return m.findOneOrFail(ApprovalWorkflow, { where: { id: wf.id }, relations: { steps: true } });
    });
  }

  // ------------------------------------------------------------------ delegations

  listDelegations(actor: SessionUser, all: boolean): Promise<ApprovalDelegation[]> {
    return this.ds.getRepository(ApprovalDelegation).find({
      where: all ? {} : [{ fromUserId: actor.id }, { toUserId: actor.id }],
      order: { startsOn: 'DESC' },
    });
  }

  async createDelegation(actor: SessionUser, dto: { fromUserId?: string; toUserId: string; startsOn: string; endsOn: string; reason?: string }, canManage: boolean) {
    const fromUserId = dto.fromUserId ?? actor.id;
    if (fromUserId !== actor.id && !canManage) throw new ForbiddenException('You can only delegate your own approvals');
    if (fromUserId === dto.toUserId) throw new BadRequestException('Cannot delegate to yourself');
    if (dto.endsOn < dto.startsOn) throw new BadRequestException('End date is before start date');
    const [to] = await this.ds.query(`SELECT id FROM app_user WHERE id = $1 AND is_active`, [dto.toUserId]);
    if (!to) throw new BadRequestException('Delegate not found or inactive');
    const repo = this.ds.getRepository(ApprovalDelegation);
    return repo.save(repo.create({ fromUserId, toUserId: dto.toUserId, startsOn: dto.startsOn, endsOn: dto.endsOn, reason: dto.reason ?? null }));
  }

  async endDelegation(actor: SessionUser, id: string, canManage: boolean) {
    const repo = this.ds.getRepository(ApprovalDelegation);
    const d = await repo.findOneBy({ id });
    if (!d) throw new NotFoundException('Delegation not found');
    if (d.fromUserId !== actor.id && !canManage) throw new ForbiddenException('Not your delegation');
    d.isActive = false;
    return repo.save(d);
  }

  /** User ids named in any step (for "approved by" stamps etc.). */
  async usersByIds(ids: string[]) {
    if (!ids.length) return [];
    return this.ds.query(`SELECT id, username, full_name FROM app_user WHERE id = ANY($1::uuid[])`, [ids]);
  }

  async approvedBy(documentType: string, documentId: string): Promise<string[]> {
    const rows = await this.ds.query(
      `SELECT DISTINCT a.user_id FROM approval_action a JOIN approval_request r ON r.id = a.request_id
        WHERE r.document_type = $1 AND r.document_id = $2 AND a.action = 'APPROVE'`,
      [documentType, documentId],
    );
    return rows.map((r: { user_id: string }) => r.user_id);
  }

  findRequests(documentType: string, ids: string[]) {
    return this.ds.getRepository(ApprovalRequest).find({ where: { documentType, documentId: In(ids) } });
  }
}

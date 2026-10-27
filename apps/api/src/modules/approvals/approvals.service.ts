import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { ApprovalActionType, ApprovalChannel, ApprovalStatus, ApproverType, NotificationCategory, SessionUser } from '@sil/shared';
import { loadEnv } from '../../config/env';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ApprovalAction, ApprovalDelegation, ApprovalRequest, ApprovalStep, ApprovalToken, ApprovalWorkflow } from './approvals.entities';
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
  /** Segregation of duties: others who may not approve (e.g. the preparer of a payment). */
  excludeUserIds?: string[];
}

/** Where and how an approver acted (recorded on the action). */
export interface ActionContext {
  ip?: string | null;
  userAgent?: string | null;
  channel?: ApprovalChannel;
}

interface Eligibility {
  eligible: boolean;
  onBehalfOf: string | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class ApprovalsService implements OnModuleInit {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('approvals.escalate', 'Remind approvers and escalate approvals past their time limit', () => this.escalate());
  }

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
    const base = await this.settings.get('locale.currency', m);
    const currency = input.currency ?? base;
    const workflows = await m.find(ApprovalWorkflow, { where: { documentType: input.documentType, isActive: true }, relations: { steps: true } });
    const workflow = selectWorkflow(workflows, { ...input, currency });
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
        currency,
        requestedBy: input.requestedBy,
        departmentId: input.departmentId ?? null,
        summary: input.summary ?? null,
        link: input.link ?? null,
        excludedUserIds: [...new Set((input.excludeUserIds ?? []).filter((u) => u && u !== input.requestedBy))],
        stepStartedAt: new Date(),
      }),
    );
    await m.save(
      m.create(ApprovalAction, { requestId: request.id, stepSequence: 0, stepName: 'Submitted', action: ApprovalActionType.SUBMIT, userId: input.requestedBy }),
    );
    await this.notifyStep(m, request, first);
    return request;
  }

  private async roleMembers(m: EntityManager, roleId: string, departmentId?: string | null): Promise<string[]> {
    const rows: { user_id: string }[] = departmentId
      ? await m.query(`SELECT ur.user_id FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active AND u.department_id = $2`, [roleId, departmentId])
      : await m.query(`SELECT ur.user_id FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.role_id = $1 AND u.is_active`, [roleId]);
    return rows.map((r) => r.user_id);
  }

  /**
   * Users who may act on a step: role members (only those in the document's
   * department for DEPARTMENT_ROLE steps) or the named user; once the step is
   * escalated, members of the escalation role too; plus active delegates of
   * all of them. The requester and excluded users never qualify.
   */
  async approversFor(
    m: EntityManager,
    step: ApprovalStep,
    request: Pick<ApprovalRequest, 'departmentId'> & Partial<Pick<ApprovalRequest, 'escalatedStep' | 'requestedBy' | 'excludedUserIds'>>,
  ): Promise<{ userId: string; onBehalfOf: string | null }[]> {
    let direct: string[];
    if (step.approverType === ApproverType.USER) {
      direct = step.userId ? [step.userId] : [];
    } else if (step.approverType === ApproverType.DEPARTMENT_ROLE) {
      direct = request.departmentId ? await this.roleMembers(m, step.roleId!, request.departmentId) : [];
    } else {
      direct = await this.roleMembers(m, step.roleId!);
    }
    if (step.escalateToRoleId && request.escalatedStep === step.sequence) direct = [...direct, ...(await this.roleMembers(m, step.escalateToRoleId))];
    const barred = new Set([request.requestedBy, ...(request.excludedUserIds ?? [])].filter(Boolean));
    direct = [...new Set(direct)];
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
    ].filter((a) => !barred.has(a.userId));
  }

  private async eligibility(m: EntityManager, request: ApprovalRequest, step: ApprovalStep, actor: SessionUser): Promise<Eligibility> {
    const approvers = await this.approversFor(m, step, request);
    const direct = approvers.find((a) => a.userId === actor.id && a.onBehalfOf === null);
    if (direct) return { eligible: true, onBehalfOf: null };
    const delegated = approvers.find((a) => a.userId === actor.id);
    return { eligible: !!delegated, onBehalfOf: delegated?.onBehalfOf ?? null };
  }

  /** Base URL of the web app for links in emails (APP_PUBLIC_URL). */
  private appUrl(): string {
    const env = loadEnv();
    return (env.appPublicUrl ?? env.corsOrigins[0] ?? '').replace(/\/$/, '');
  }

  /** Issues a single-use approve / reject link for one approver at the current step. */
  private async issueToken(m: EntityManager, request: ApprovalRequest, userId: string): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    const hours = await this.settings.get('approvals.linkExpiryHours', m);
    await m.save(m.create(ApprovalToken, { tokenHash: hash(token), requestId: request.id, stepSequence: request.currentStep, userId, expiresAt: new Date(Date.now() + hours * 3_600_000) }));
    return token;
  }

  /** In-app (always) and email / SMS by preference; each email carries the approver's own approve / reject link. */
  private async notifyStep(m: EntityManager, request: ApprovalRequest, step: ApprovalStep, prefix = 'Approval needed'): Promise<void> {
    const approvers = [...new Set((await this.approversFor(m, step, request)).map((a) => a.userId))];
    const amount = `${request.currency ?? ''} ${Number(request.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`.trim();
    for (const userId of approvers) {
      const token = await this.issueToken(m, request, userId);
      const url = `${this.appUrl()}/approve/${token}`;
      await this.notifications.dispatch(m, [userId], NotificationCategory.APPROVALS, {
        title: `${prefix}: ${request.documentNo}`,
        body: `${step.name}${request.summary ? ` · ${request.summary}` : ''}`,
        link: request.link,
        emailText: `${request.documentNo} (${amount}) is waiting for your approval at "${step.name}".\n${request.summary ?? ''}\n\nApprove or reject it here (the link works once): ${url}\n\nOr open it in the system: ${this.appUrl()}${request.link ?? '/approvals'}`,
      });
    }
  }

  async act(requestId: string, actor: SessionUser, action: ApprovalActionType, comment?: string, ctx: ActionContext = {}): Promise<ApprovalRequest> {
    if (![ApprovalActionType.APPROVE, ApprovalActionType.REJECT, ApprovalActionType.RETURN].includes(action)) {
      throw new BadRequestException('Unsupported action');
    }
    if (action !== ApprovalActionType.APPROVE && !comment?.trim()) {
      throw new BadRequestException('A comment is required to reject or return');
    }
    await this.ds.transaction((m) => this.actIn(m, requestId, actor, action, comment, ctx));
    return this.get(requestId);
  }

  private async actIn(m: EntityManager, requestId: string, actor: SessionUser, action: ApprovalActionType, comment: string | undefined, ctx: ActionContext): Promise<void> {
    const request = await m.findOne(ApprovalRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.status !== ApprovalStatus.PENDING) throw new ConflictException(`Request is ${request.status}`);
    // Segregation of duties.
    if (request.requestedBy === actor.id) throw new ForbiddenException('You cannot approve your own document');
    if ((request.excludedUserIds ?? []).includes(actor.id)) throw new ForbiddenException('You prepared this document, so you cannot approve it (segregation of duties)');
    const steps = (await m.find(ApprovalStep, { where: { workflowId: request.workflowId }, order: { sequence: 'ASC' } })) ?? [];
    const step = steps.find((s) => s.sequence === request.currentStep)!;
    const { eligible, onBehalfOf } = await this.eligibility(m, request, step, actor);
    if (!eligible) throw new ForbiddenException(`You are not an approver for step "${step.name}"`);
    const earlier = await m.findOne(ApprovalAction, { where: { requestId, userId: actor.id, action: ApprovalActionType.APPROVE } });
    if (earlier) throw new ForbiddenException('Each approval must be by a different person');

    await m.save(
      m.create(ApprovalAction, {
        requestId,
        stepSequence: step.sequence,
        stepName: step.name,
        action,
        userId: actor.id,
        onBehalfOfUserId: onBehalfOf,
        comment: comment?.trim() || null,
        channel: ctx.channel ?? ApprovalChannel.IN_APP,
        ip: ctx.ip?.slice(0, 64) ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      }),
    );

    const h = this.handler(request.documentType);
    if (action === ApprovalActionType.APPROVE) {
      // A parallel level needs N different approvers before it moves on.
      const approvals = await m.count(ApprovalAction, { where: { requestId, stepSequence: step.sequence, action: ApprovalActionType.APPROVE } });
      if (approvals < Math.max(1, step.minApprovals ?? 1)) return;
      const next = steps.find((s) => s.sequence > step.sequence);
      if (next) {
        request.currentStep = next.sequence;
        request.stepStartedAt = new Date();
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
  }

  // ------------------------------------------------------------------ approve / reject by link

  private async validToken(m: EntityManager, token: string, lock = false) {
    const t = await m.findOne(ApprovalToken, { where: { tokenHash: hash(token) }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!t) throw new NotFoundException('This approval link is not valid');
    if (t.usedAt) throw new GoneException('This approval link has already been used');
    if (t.expiresAt.getTime() < Date.now()) throw new GoneException('This approval link has expired; open the document in the system');
    const request = await m.findOneByOrFail(ApprovalRequest, { id: t.requestId });
    if (request.status !== ApprovalStatus.PENDING || request.currentStep !== t.stepSequence) throw new GoneException('This approval has moved on; the link no longer applies');
    return { t, request };
  }

  /** What the link is for (shown before the approver decides). */
  async linkInfo(token: string) {
    const { t, request } = await this.validToken(this.ds.manager, token);
    const [user] = await this.ds.query(`SELECT full_name FROM app_user WHERE id = $1`, [t.userId]);
    const [step] = await this.ds.query(`SELECT name FROM approval_step WHERE workflow_id = $1 AND sequence = $2`, [request.workflowId, request.currentStep]);
    return {
      documentType: request.documentType,
      documentNo: request.documentNo,
      amount: request.amount,
      currency: request.currency,
      summary: request.summary,
      stepName: step?.name ?? null,
      approver: user?.full_name ?? null,
      link: request.link,
      expiresAt: t.expiresAt,
    };
  }

  /** Approve / reject / return through a link: acts as the user the link was issued to, once. */
  async actByLink(token: string, action: ApprovalActionType, comment: string | undefined, ctx: ActionContext) {
    if (action !== ApprovalActionType.APPROVE && !comment?.trim()) throw new BadRequestException('A comment is required to reject or return');
    const requestId = await this.ds.transaction(async (m) => {
      const { t, request } = await this.validToken(m, token, true);
      const [{ users: actor }] = await m.query(
        `SELECT json_build_object('id', u.id, 'username', u.username, 'fullName', u.full_name, 'permissions', '[]'::json, 'roles', '[]'::json, 'storeIds', NULL) AS users FROM app_user u WHERE u.id = $1 AND u.is_active`,
        [t.userId],
      );
      if (!actor) throw new ForbiddenException('The approver is no longer active');
      t.usedAt = new Date();
      await m.save(t);
      await this.actIn(m, request.id, actor as SessionUser, action, comment, { ...ctx, channel: ctx.channel ?? ApprovalChannel.EMAIL_LINK });
      return request.id;
    });
    return this.get(requestId);
  }

  // ------------------------------------------------------------------ reminders and escalation

  /**
   * Job approvals.escalate: approvals waiting at a step longer than its
   * remindAfterHours are re-sent to the approvers (once); longer than
   * escalateAfterHours, the escalation role may act on them too (once).
   */
  async escalate() {
    const due: { id: string; remind: boolean; escalate: boolean }[] = await this.ds.query(
      `SELECT r.id,
              (s.remind_after_hours IS NOT NULL AND r.reminded_step IS DISTINCT FROM r.current_step AND r.step_started_at < now() - make_interval(hours => s.remind_after_hours)) AS remind,
              (s.escalate_after_hours IS NOT NULL AND s.escalate_to_role_id IS NOT NULL AND r.escalated_step IS DISTINCT FROM r.current_step
               AND r.step_started_at < now() - make_interval(hours => s.escalate_after_hours)) AS escalate
         FROM approval_request r JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step
        WHERE r.status = 'PENDING'`,
    );
    let reminded = 0;
    let escalated = 0;
    for (const d of due.filter((x) => x.remind || x.escalate)) {
      await this.ds.transaction(async (m) => {
        const r = await m.findOneOrFail(ApprovalRequest, { where: { id: d.id }, lock: { mode: 'pessimistic_write' } });
        const step = await m.findOneByOrFail(ApprovalStep, { workflowId: r.workflowId, sequence: r.currentStep });
        if (d.escalate) {
          r.escalatedStep = r.currentStep;
          r.remindedStep = r.currentStep;
          await m.save(r);
          await m.save(m.create(ApprovalAction, { requestId: r.id, stepSequence: step.sequence, stepName: step.name, action: ApprovalActionType.ESCALATE, userId: null, comment: `Waiting more than ${step.escalateAfterHours} h` }));
          await this.notifyStep(m, r, step, 'Escalated approval');
          escalated++;
        } else {
          r.remindedStep = r.currentStep;
          await m.save(r);
          await m.save(m.create(ApprovalAction, { requestId: r.id, stepSequence: step.sequence, stepName: step.name, action: ApprovalActionType.REMIND, userId: null, comment: `Waiting more than ${step.remindAfterHours} h` }));
          await this.notifyStep(m, r, step, 'Reminder: approval needed');
          reminded++;
        }
      });
    }
    return { reminded, escalated };
  }

  /** Withdraws a pending cycle (document cancelled or edited). */
  async cancelPending(m: EntityManager, documentType: string, documentId: string, actorId: string): Promise<void> {
    const pending = await m.findOneBy(ApprovalRequest, { documentType, documentId, status: ApprovalStatus.PENDING });
    if (!pending) return;
    pending.status = ApprovalStatus.CANCELLED;
    await m.save(pending);
    await m.save(m.create(ApprovalAction, { requestId: pending.id, stepSequence: pending.currentStep, action: ApprovalActionType.CANCEL, userId: actorId }));
  }

  /** Whether every required level of a document's latest approval cycle is complete. */
  async isApproved(m: EntityManager, documentType: string, documentId: string): Promise<boolean> {
    const [latest] = await m.find(ApprovalRequest, { where: { documentType, documentId }, order: { createdAt: 'DESC' }, take: 1 });
    return latest?.status === ApprovalStatus.APPROVED;
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
        .map((a) => ({ ...a, userName: a.userId ? (name.get(a.userId) ?? null) : 'System', onBehalfOfName: a.onBehalfOfUserId ? (name.get(a.onBehalfOfUserId) ?? null) : null })),
    }));
  }

  /** Pending requests the user can act on now (directly, as a delegate, or by escalation). */
  async inbox(actor: SessionUser) {
    const today = await this.settings.today();
    return this.ds.query(
      `WITH delegators AS (
         SELECT from_user_id FROM approval_delegation
          WHERE to_user_id = $1 AND is_active AND $2::date BETWEEN starts_on AND ends_on
       ), me AS (SELECT $1::uuid AS id UNION SELECT from_user_id FROM delegators)
       SELECT r.id, r.document_type AS "documentType", r.document_id AS "documentId", r.document_no AS "documentNo",
              r.amount::float AS amount, r.currency, r.summary, r.link, r.created_at AS "createdAt", r.step_started_at AS "waitingSince",
              s.name AS "stepName", s.min_approvals AS "minApprovals", (r.escalated_step = r.current_step) AS escalated,
              (SELECT COUNT(*)::int FROM approval_action a WHERE a.request_id = r.id AND a.step_sequence = r.current_step AND a.action = 'APPROVE') AS "approvalsAtStep",
              u.full_name AS "requestedByName", w.name AS "workflowName"
         FROM approval_request r
         JOIN approval_step s ON s.workflow_id = r.workflow_id AND s.sequence = r.current_step
         JOIN approval_workflow w ON w.id = r.workflow_id
         JOIN app_user u ON u.id = r.requested_by
        WHERE r.status = 'PENDING' AND r.requested_by <> $1 AND NOT (r.excluded_user_ids ? $1::text)
          AND NOT EXISTS (SELECT 1 FROM approval_action a WHERE a.request_id = r.id AND a.user_id = $1 AND a.action = 'APPROVE')
          AND (
            (s.approver_type = 'USER' AND s.user_id IN (SELECT id FROM me))
            OR (s.approver_type IN ('ROLE', 'DEPARTMENT_ROLE') AND EXISTS (
                  SELECT 1 FROM user_role ur JOIN app_user au ON au.id = ur.user_id
                   WHERE ur.role_id = s.role_id AND au.is_active
                     AND (s.approver_type = 'ROLE' OR au.department_id = r.department_id)
                     AND ur.user_id IN (SELECT id FROM me)))
            OR (r.escalated_step = r.current_step AND s.escalate_to_role_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM user_role ur JOIN app_user au ON au.id = ur.user_id
                   WHERE ur.role_id = s.escalate_to_role_id AND au.is_active AND ur.user_id IN (SELECT id FROM me)))
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
      if ((s.approverType === ApproverType.ROLE || s.approverType === ApproverType.DEPARTMENT_ROLE) && !s.roleId) {
        throw new BadRequestException('Role steps need a role');
      }
      if (s.approverType === ApproverType.USER && !s.userId) throw new BadRequestException('User steps need a user');
      if (s.approverType === ApproverType.USER && (s.minApprovals ?? 1) > 1) throw new BadRequestException('A step for one named user cannot need more than one approval');
      if (s.escalateAfterHours && !s.escalateToRoleId) throw new BadRequestException('Escalation needs a role to escalate to');
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
        const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM approval_request WHERE workflow_id = $1 AND status = 'PENDING'`, [id]);
        if (n) {
          // Documents in approval finish on the version they started with: that
          // version is kept (inactive, renamed) and the change becomes a new workflow.
          const [{ v }] = await m.query(`SELECT COUNT(*)::int + 1 AS v FROM approval_workflow WHERE code LIKE $1`, [`${existing.code}~v%`]);
          await m.update(ApprovalWorkflow, { id }, { code: `${existing.code}~v${v}`.slice(0, 40), isActive: false });
          wf = await m.save(m.create(ApprovalWorkflow, { ...rest, code: rest.code ?? existing.code }));
        } else {
          wf = await m.save(Object.assign(existing, rest));
          await m.delete(ApprovalStep, { workflowId: id });
        }
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
            roleId: s.approverType === ApproverType.USER ? null : s.roleId!,
            userId: s.approverType === ApproverType.USER ? s.userId! : null,
            minApprovals: Math.max(1, s.minApprovals ?? 1),
            remindAfterHours: s.remindAfterHours ?? null,
            escalateAfterHours: s.escalateAfterHours ?? null,
            escalateToRoleId: s.escalateToRoleId ?? null,
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

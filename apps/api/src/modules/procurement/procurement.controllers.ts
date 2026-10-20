import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { SettingsService } from '../settings/settings.service';
import { AgenciesService } from './agencies.service';
import { ContractsService } from './contracts.service';
import { KpisService } from './kpis.service';
import { PerformanceService } from './performance.service';
import { PlansService } from './plans.service';
import { PortalService } from './portal.service';
import {
  AcknowledgeDto,
  ActionQueryDto,
  AnswerDto,
  BidDto,
  CallOffDto,
  ClarificationDto,
  CloseActionDto,
  CommitteeDto,
  ConsolidateDto,
  ContractQueryDto,
  CorrectiveActionDto,
  CreateContractDto,
  CreatePlanDto,
  CreateTenderDto,
  DeclarationDto,
  DeliveryDto,
  IssueDocumentDto,
  KpiQueryDto,
  MilestoneDto,
  NoteDto,
  OpenTenderDto,
  OpinionDto,
  OrderTemplateDto,
  PeriodDto,
  PlanQueryDto,
  PortalQuotationDto,
  QuestionDto,
  ReasonDto,
  RecommendDto,
  RecommendQueryDto,
  ReviewSubmissionDto,
  RevisePlanDto,
  SanctionDto,
  ScorecardQueryDto,
  ScoresDto,
  SecurityDto,
  SignDto,
  SignTenderContractDto,
  StaffBidDto,
  SubmissionDto,
  TenderQueryDto,
  UpdatePlanDto,
  VariationDto,
} from './procurement.dto';
import { recommendMethod } from './sourcing';
import { TendersService } from './tenders.service';

const P = Permissions;

@ApiTags('procurement plans')
@Controller('procurement-plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get() @RequirePermissions(P.PLANS_READ)
  list(@Query() q: PlanQueryDto) {
    return this.plans.list(q);
  }

  @Get(':id') @RequirePermissions(P.PLANS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(id);
  }

  @Post() @RequirePermissions(P.PLANS_MANAGE)
  create(@Body() dto: CreatePlanDto, @CurrentUser() u: SessionUser) {
    return this.plans.create(dto, u);
  }

  @Put(':id') @RequirePermissions(P.PLANS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto, @CurrentUser() u: SessionUser) {
    return this.plans.update(id, dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(P.PLANS_MANAGE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.plans.submit(id, u);
  }

  /** Mid-year revision (new version through approval). */
  @Post(':id/revise') @HttpCode(200) @RequirePermissions(P.PLANS_MANAGE)
  revise(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevisePlanDto, @CurrentUser() u: SessionUser) {
    return this.plans.revise(id, dto, u);
  }

  @Post('consolidate') @HttpCode(200) @RequirePermissions(P.PLANS_CONSOLIDATE)
  consolidate(@Body() dto: ConsolidateDto, @CurrentUser() u: SessionUser) {
    return this.plans.consolidate(dto.financialYear, u);
  }
}

@ApiTags('procurement plans')
@Controller('sourcing')
export class SourcingController {
  constructor(
    private readonly settings: SettingsService,
    private readonly contracts: ContractsService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Get('methods') @RequireAnyPermission(P.PURCHASING_READ, P.PLANS_READ, P.TENDERS_READ)
  methods() {
    return this.settings.get('procurement.sourcingMethods');
  }

  /** Recommended method for an estimated value (and whether a framework agreement covers the items). */
  @Get('recommend') @RequireAnyPermission(P.PURCHASING_READ, P.PLANS_READ, P.TENDERS_READ)
  async recommend(@Query() q: RecommendQueryDto) {
    const itemIds = q.itemIds ? q.itemIds.split(',').filter(Boolean) : [];
    const framework = await this.contracts.frameworkCovers(this.ds.manager, itemIds, await this.settings.today());
    return { method: recommendMethod(await this.settings.get('procurement.sourcingMethods'), q.amount, framework), frameworkAvailable: framework };
  }
}

@ApiTags('tenders')
@Controller('tenders')
export class TendersController {
  constructor(private readonly tenders: TendersService) {}

  @Get() @RequirePermissions(P.TENDERS_READ)
  list(@Query() q: TenderQueryDto) {
    return this.tenders.list(q);
  }

  @Get(':id') @RequireAnyPermission(P.TENDERS_READ, P.TENDERS_EVALUATE)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.tenders.get(id, u);
  }

  @Post() @RequirePermissions(P.TENDERS_MANAGE)
  create(@Body() dto: CreateTenderDto, @CurrentUser() u: SessionUser) {
    return this.tenders.create(dto, u);
  }

  @Post(':id/publish') @HttpCode(200) @RequirePermissions(P.TENDERS_MANAGE)
  async publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.tenders.publish(id);
    return this.tenders.get(id, u);
  }

  @Post(':id/documents') @RequirePermissions(P.TENDERS_MANAGE)
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueDocumentDto, @CurrentUser() u: SessionUser) {
    return this.tenders.issueDocument(id, dto.supplierId, dto.fee ?? 0, u);
  }

  @Post(':id/clarifications') @RequirePermissions(P.TENDERS_MANAGE)
  ask(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClarificationDto) {
    return this.tenders.askClarification(id, dto.supplierId ?? null, dto.question);
  }

  /** Answer a question; clarificationId "new" issues an addendum. */
  @Put(':id/clarifications/:cid') @RequirePermissions(P.TENDERS_MANAGE)
  answer(@Param('id', ParseUUIDPipe) id: string, @Param('cid') cid: string, @Body() dto: AnswerDto, @CurrentUser() u: SessionUser) {
    return this.tenders.answerClarification(id, cid, dto, u);
  }

  /** Physical bid recorded by an officer (bid submission register). */
  @Post(':id/bids') @RequirePermissions(P.TENDERS_MANAGE)
  async bid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffBidDto, @CurrentUser() u: SessionUser) {
    const { supplierId, ...bid } = dto;
    const b = await this.tenders.submitBid(id, supplierId, bid, u, false);
    return { id: b.id, submittedAt: b.submittedAt };
  }

  @Post(':id/open') @HttpCode(200) @RequirePermissions(P.TENDERS_MANAGE)
  open(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OpenTenderDto, @CurrentUser() u: SessionUser) {
    return this.tenders.open(id, dto, u);
  }

  @Put(':id/committee') @RequirePermissions(P.TENDERS_MANAGE)
  async committee(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CommitteeDto, @CurrentUser() u: SessionUser) {
    await this.tenders.appointCommittee(id, dto.members);
    return this.tenders.get(id, u);
  }

  @Post(':id/declaration') @RequirePermissions(P.TENDERS_EVALUATE)
  declare(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeclarationDto, @CurrentUser() u: SessionUser) {
    return this.tenders.declare(id, u, dto);
  }

  @Post(':id/scores') @HttpCode(200) @RequirePermissions(P.TENDERS_EVALUATE)
  score(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScoresDto, @CurrentUser() u: SessionUser) {
    return this.tenders.score(id, u, dto.scores);
  }

  @Get(':id/evaluation') @RequireAnyPermission(P.TENDERS_READ, P.TENDERS_EVALUATE)
  evaluation(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenders.evaluation(id);
  }

  @Post(':id/recommend') @HttpCode(200) @RequireAnyPermission(P.TENDERS_EVALUATE, P.TENDERS_MANAGE)
  recommend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecommendDto, @CurrentUser() u: SessionUser) {
    return this.tenders.recommend(id, dto, u);
  }

  /** Professional opinion and submission for award approval. */
  @Post(':id/award') @HttpCode(200) @RequirePermissions(P.TENDERS_MANAGE)
  award(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OpinionDto, @CurrentUser() u: SessionUser) {
    return this.tenders.submitForAward(id, dto, u);
  }

  @Post(':id/contract') @RequirePermissions(P.TENDERS_MANAGE, P.CONTRACTS_MANAGE)
  contract(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SignTenderContractDto, @CurrentUser() u: SessionUser) {
    return this.tenders.signContract(id, dto, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.TENDERS_MANAGE)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: SessionUser) {
    await this.tenders.cancel(id, dto.reason);
    return this.tenders.get(id, u);
  }
}

@ApiTags('contracts')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get() @RequirePermissions(P.CONTRACTS_READ)
  list(@Query() q: ContractQueryDto) {
    return this.contracts.list(q);
  }

  @Get(':id') @RequirePermissions(P.CONTRACTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.contracts.get(id);
  }

  @Post() @RequirePermissions(P.CONTRACTS_MANAGE)
  create(@Body() dto: CreateContractDto) {
    return this.contracts.create(dto);
  }

  @Post(':id/sign') @HttpCode(200) @RequirePermissions(P.CONTRACTS_MANAGE)
  sign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SignDto, @CurrentUser() u: SessionUser) {
    return this.contracts.sign(id, dto, u);
  }

  @Post(':id/terminate') @HttpCode(200) @RequirePermissions(P.CONTRACTS_MANAGE)
  terminate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.contracts.terminate(id, dto.reason);
  }

  /** Call-off order → draft purchase order within the remaining balances. */
  @Post(':id/call-offs') @RequirePermissions(P.CONTRACTS_MANAGE, P.PURCHASING_PO)
  callOff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CallOffDto, @CurrentUser() u: SessionUser) {
    return this.contracts.callOff(id, dto, u);
  }

  @Post(':id/securities') @RequirePermissions(P.CONTRACTS_MANAGE)
  security(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SecurityDto) {
    return this.contracts.addSecurity(id, dto);
  }

  @Post(':id/securities/:sid/release') @HttpCode(200) @RequirePermissions(P.CONTRACTS_MANAGE)
  release(@Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string) {
    return this.contracts.releaseSecurity(id, sid);
  }

  @Post(':id/milestones') @RequirePermissions(P.CONTRACTS_MANAGE)
  milestone(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MilestoneDto) {
    return this.contracts.addMilestone(id, dto);
  }

  @Post(':id/milestones/:mid/complete') @HttpCode(200) @RequirePermissions(P.CONTRACTS_MANAGE)
  complete(@Param('id', ParseUUIDPipe) id: string, @Param('mid', ParseUUIDPipe) mid: string, @Body() dto: NoteDto) {
    return this.contracts.completeMilestone(id, mid, dto.notes);
  }

  @Post(':id/variations') @RequirePermissions(P.CONTRACTS_MANAGE)
  variation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VariationDto, @CurrentUser() u: SessionUser) {
    return this.contracts.createVariation(id, dto, u);
  }
}

@ApiTags('supplier performance')
@Controller('supplier-performance')
export class PerformanceController {
  constructor(private readonly perf: PerformanceService) {}

  @Get('scorecards') @RequireAnyPermission(P.SUPPLIERS_PERFORMANCE, P.SUPPLIERS_READ)
  scorecards(@Query() q: ScorecardQueryDto) {
    return this.perf.scorecards(q);
  }

  @Post('scorecards/compute') @HttpCode(200) @RequirePermissions(P.SUPPLIERS_PERFORMANCE)
  compute(@Body() dto: PeriodDto, @CurrentUser() u: SessionUser) {
    return this.perf.compute(dto.period, u);
  }

  @Get('corrective-actions') @RequireAnyPermission(P.SUPPLIERS_PERFORMANCE, P.SUPPLIERS_READ)
  actions(@Query() q: ActionQueryDto) {
    return this.perf.correctiveActions(q);
  }

  @Post('corrective-actions') @RequirePermissions(P.SUPPLIERS_PERFORMANCE)
  addAction(@Body() dto: CorrectiveActionDto, @CurrentUser() u: SessionUser) {
    return this.perf.addCorrectiveAction(dto, u);
  }

  @Post('corrective-actions/:id/close') @HttpCode(200) @RequirePermissions(P.SUPPLIERS_PERFORMANCE)
  closeAction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseActionDto) {
    return this.perf.closeCorrectiveAction(id, dto.outcome);
  }

  @Get('sanctions') @RequireAnyPermission(P.SUPPLIERS_PERFORMANCE, P.SUPPLIERS_READ)
  sanctions(@Query('supplierId') supplierId?: string) {
    return this.perf.sanctions(supplierId);
  }

  /** Suspension / blacklisting / reinstatement request (approval workflow SSN). */
  @Post('sanctions') @RequirePermissions(P.SUPPLIERS_PERFORMANCE)
  sanction(@Body() dto: SanctionDto, @CurrentUser() u: SessionUser) {
    return this.perf.requestSanction(dto, u);
  }
}

@ApiTags('national agencies')
@Controller('order-templates')
export class AgenciesController {
  constructor(private readonly agencies: AgenciesService) {}

  @Get() @RequirePermissions(P.PURCHASING_READ)
  list() {
    return this.agencies.templates();
  }

  @Post() @RequirePermissions(P.PURCHASING_PO)
  create(@Body() dto: OrderTemplateDto) {
    return this.agencies.saveTemplate(null, dto);
  }

  @Put(':id') @RequirePermissions(P.PURCHASING_PO)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderTemplateDto) {
    return this.agencies.saveTemplate(id, dto);
  }

  /** Raise this cycle's draft PO now. */
  @Post(':id/raise') @HttpCode(200) @RequirePermissions(P.PURCHASING_PO)
  raise(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.agencies.raise(id, u);
  }

  @Get('agency-orders') @RequirePermissions(P.PURCHASING_READ)
  agencyOrders() {
    return this.agencies.agencyOrders();
  }
}

@ApiTags('national agencies')
@Controller('purchase-orders')
export class DeliveryController {
  constructor(private readonly agencies: AgenciesService) {}

  @Get(':id/deliveries') @RequirePermissions(P.PURCHASING_READ)
  deliveries(@Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.deliveries(id);
  }

  @Post(':id/deliveries') @RequireAnyPermission(P.PURCHASING_PO, P.PURCHASING_RECEIVE)
  track(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryDto, @CurrentUser() u: SessionUser) {
    return this.agencies.track(id, dto, u);
  }
}

@ApiTags('procurement KPIs')
@Controller('procurement')
export class KpisController {
  constructor(
    private readonly kpis: KpisService,
    private readonly portal: PortalService,
  ) {}

  @Get('kpis') @RequirePermissions(P.PROCUREMENT_KPIS)
  get(@Query() q: KpiQueryDto) {
    return this.kpis.kpis(q);
  }

  /** Optional PPADA rule set: PPRA-style award report. */
  @Get('ppra-report') @RequirePermissions(P.PROCUREMENT_KPIS)
  ppra(@Query() q: KpiQueryDto) {
    return this.kpis.ppraReport(q);
  }

  /** Delivery notes / invoices suppliers sent through the portal. */
  @Get('portal-submissions') @RequirePermissions(P.PURCHASING_READ)
  submissions(@Query('status') status?: string) {
    return this.portal.staffSubmissions(status);
  }

  @Put('portal-submissions/:id') @RequireAnyPermission(P.PURCHASING_RECEIVE, P.PURCHASING_INVOICE)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewSubmissionDto) {
    return this.portal.reviewSubmission(id, dto);
  }
}

/** Supplier portal: everything is scoped to the signed-in user's supplier. */
@ApiTags('supplier portal')
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me') @RequirePermissions(P.PORTAL_ACCESS)
  me(@CurrentUser() u: SessionUser) {
    return this.portal.me(u);
  }

  @Get('rfqs') @RequirePermissions(P.PORTAL_ACCESS)
  rfqs(@CurrentUser() u: SessionUser) {
    return this.portal.rfqList(u);
  }

  @Get('rfqs/:id') @RequirePermissions(P.PORTAL_ACCESS)
  rfq(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.portal.rfq(u, id);
  }

  @Post('rfqs/:id/quotation') @RequirePermissions(P.PORTAL_ACCESS)
  quote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PortalQuotationDto, @CurrentUser() u: SessionUser) {
    return this.portal.submitQuotation(u, id, dto);
  }

  @Get('tenders') @RequirePermissions(P.PORTAL_ACCESS)
  tenders(@CurrentUser() u: SessionUser) {
    return this.portal.tenderList(u);
  }

  @Get('tenders/:id') @RequirePermissions(P.PORTAL_ACCESS)
  tender(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.portal.tender(u, id);
  }

  @Post('tenders/:id/documents') @RequirePermissions(P.PORTAL_ACCESS)
  documents(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.portal.requestDocuments(u, id);
  }

  @Post('tenders/:id/clarifications') @RequirePermissions(P.PORTAL_ACCESS)
  ask(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuestionDto, @CurrentUser() u: SessionUser) {
    return this.portal.askClarification(u, id, dto.question);
  }

  @Post('tenders/:id/bid') @RequirePermissions(P.PORTAL_ACCESS)
  bid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BidDto, @CurrentUser() u: SessionUser) {
    return this.portal.submitBid(u, id, dto);
  }

  @Post('tenders/:id/withdraw') @HttpCode(200) @RequirePermissions(P.PORTAL_ACCESS)
  async withdraw(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.portal.withdrawBid(u, id);
    return { withdrawn: true };
  }

  @Get('purchase-orders') @RequirePermissions(P.PORTAL_ACCESS)
  orders(@CurrentUser() u: SessionUser) {
    return this.portal.orders(u);
  }

  @Get('purchase-orders/:id') @RequirePermissions(P.PORTAL_ACCESS)
  order(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.portal.order(u, id);
  }

  @Post('purchase-orders/:id/acknowledge') @HttpCode(200) @RequirePermissions(P.PORTAL_ACCESS)
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgeDto, @CurrentUser() u: SessionUser) {
    return this.portal.acknowledge(u, id, dto.note);
  }

  @Post('purchase-orders/:id/delivery') @HttpCode(200) @RequirePermissions(P.PORTAL_ACCESS)
  delivery(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryDto, @CurrentUser() u: SessionUser) {
    return this.portal.trackDelivery(u, id, dto);
  }

  @Post('purchase-orders/:id/documents') @RequirePermissions(P.PORTAL_ACCESS)
  submit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmissionDto, @CurrentUser() u: SessionUser) {
    return this.portal.submitDocument(u, id, dto);
  }

  @Get('submissions') @RequirePermissions(P.PORTAL_ACCESS)
  submissions(@CurrentUser() u: SessionUser) {
    return this.portal.submissions(u);
  }

  @Get('payments') @RequirePermissions(P.PORTAL_ACCESS)
  payments(@CurrentUser() u: SessionUser) {
    return this.portal.payments(u);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { RejectDto } from '../inventory/inventory.dto';
import { ConsumptionService } from './consumption.service';
import { DepartmentReturnsService } from './department-returns.service';
import { IssuesService } from './issues.service';
import { ReturnReasonsService } from './return-reasons.service';
import { StoreRequisitionsService } from './store-requisitions.service';
import {
  CancelLinesDto,
  ConsumptionQueryDto,
  CreateDepartmentReturnDto,
  CreateIssueDto,
  CreateStoreRequisitionDto,
  DocQueryDto,
  IssueQueryDto,
  PostDepartmentReturnDto,
  ReturnReasonDto,
  ReturnReasonQueryDto,
  StoreRequisitionQueryDto,
} from './stores.dto';

const P = Permissions;
/** Department staff, the issuing store and read-only roles can see department documents (scoped in the services). */
const SEE = [P.INVENTORY_REQUISITION, P.INVENTORY_ISSUE, P.INVENTORY_DEPT_RETURN, P.INVENTORY_READ] as const;

@ApiTags('stores')
@Controller('store-requisitions')
export class StoreRequisitionsController {
  constructor(
    private readonly requisitions: StoreRequisitionsService,
    private readonly issues: IssuesService,
  ) {}

  @Get() @RequireAnyPermission(...SEE)
  list(@Query() q: StoreRequisitionQueryDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.list(q, u);
  }

  /** Lines still owed after partial issues. */
  @Get('backorders') @RequireAnyPermission(...SEE)
  backorders(@Query() q: StoreRequisitionQueryDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.backorders(q, u);
  }

  @Get(':id') @RequireAnyPermission(...SEE)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.requisitions.get(id, u);
  }

  @Post() @RequirePermissions(P.INVENTORY_REQUISITION)
  create(@Body() dto: CreateStoreRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.create(dto, u);
  }

  @Put(':id') @RequirePermissions(P.INVENTORY_REQUISITION)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateStoreRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.update(id, dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(P.INVENTORY_REQUISITION)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.requisitions.submit(id, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequireAnyPermission(P.INVENTORY_REQUISITION, P.INVENTORY_ISSUE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.cancel(id, dto.reason, u);
  }

  @Post(':id/cancel-backorder') @HttpCode(200) @RequireAnyPermission(P.INVENTORY_REQUISITION, P.INVENTORY_ISSUE)
  cancelBackorder(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelLinesDto, @CurrentUser() u: SessionUser) {
    return this.requisitions.cancelBackorders(id, dto, u);
  }

  @Post(':id/reserve') @HttpCode(200) @RequirePermissions(P.INVENTORY_ISSUE)
  reserve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.requisitions.refreshReservations(id, u);
  }

  /** FEFO picks for everything outstanding, plus all usable batches for manual picks. */
  @Get(':id/issue-plan') @RequirePermissions(P.INVENTORY_ISSUE)
  plan(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.issues.suggest(id, u);
  }

  @Post(':id/issues') @RequirePermissions(P.INVENTORY_ISSUE)
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateIssueDto, @CurrentUser() u: SessionUser) {
    return this.issues.issue(id, dto, u);
  }
}

@ApiTags('stores')
@Controller('issues')
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get() @RequireAnyPermission(...SEE)
  list(@Query() q: IssueQueryDto, @CurrentUser() u: SessionUser) {
    return this.issues.list(q, u);
  }

  @Get(':id') @RequireAnyPermission(...SEE)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.issues.get(id, u);
  }

  /** Printable issue voucher. */
  @Get(':id/pdf') @RequireAnyPermission(...SEE)
  async pdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const { number, pdf } = await this.issues.renderPdf(id, u);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${number.replace(/\//g, '-')}.pdf"`);
    return new StreamableFile(pdf);
  }
}

@ApiTags('stores')
@Controller('department-returns')
export class DepartmentReturnsController {
  constructor(private readonly returns: DepartmentReturnsService) {}

  @Get() @RequireAnyPermission(...SEE)
  list(@Query() q: DocQueryDto, @CurrentUser() u: SessionUser) {
    return this.returns.list(q, u);
  }

  /** Issued stock a department can still return to a store. */
  @Get('returnable') @RequireAnyPermission(...SEE)
  returnable(@Query('departmentId', ParseUUIDPipe) departmentId: string, @Query('storeId', ParseUUIDPipe) storeId: string, @CurrentUser() u: SessionUser) {
    return this.returns.returnable(departmentId, storeId, u);
  }

  @Get(':id') @RequireAnyPermission(...SEE)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.returns.get(id, u);
  }

  @Post() @RequireAnyPermission(P.INVENTORY_REQUISITION, P.INVENTORY_DEPT_RETURN)
  create(@Body() dto: CreateDepartmentReturnDto, @CurrentUser() u: SessionUser) {
    return this.returns.create(dto, u);
  }

  @Post(':id/post') @HttpCode(200) @RequirePermissions(P.INVENTORY_DEPT_RETURN)
  post(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDepartmentReturnDto, @CurrentUser() u: SessionUser) {
    return this.returns.post(id, dto, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequireAnyPermission(P.INVENTORY_REQUISITION, P.INVENTORY_DEPT_RETURN)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.returns.cancel(id, u);
  }
}

@ApiTags('stores')
@Controller('return-reasons')
export class ReturnReasonsController {
  constructor(private readonly reasons: ReturnReasonsService) {}

  @Get()
  list(@Query() q: ReturnReasonQueryDto) {
    return this.reasons.list(q.for);
  }

  @Get('all') @RequirePermissions(P.SETTINGS_MANAGE)
  all() {
    return this.reasons.list(undefined, true);
  }

  @Post() @RequirePermissions(P.SETTINGS_MANAGE)
  create(@Body() dto: ReturnReasonDto) {
    return this.reasons.create(dto);
  }

  @Put(':id') @RequirePermissions(P.SETTINGS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnReasonDto) {
    return this.reasons.update(id, dto);
  }
}

@ApiTags('stores')
@Controller('consumption')
export class ConsumptionController {
  constructor(private readonly consumption: ConsumptionService) {}

  /** Cost per department / period / item / patient reference; `format=csv` downloads it. */
  @Get() @RequirePermissions(P.INVENTORY_CONSUMPTION)
  async report(@Query() q: ConsumptionQueryDto, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const report = await this.consumption.report(q, u);
    if (q.format !== 'csv') return report;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="consumption-${report.groupBy}-${q.from}-to-${q.to}.csv"`);
    return this.consumption.toCsv(report);
  }
}

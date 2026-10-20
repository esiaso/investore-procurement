import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions, StoreScoped } from '../../common/decorators';
import { ReorderService } from '../planning/reorder.service';
import {
  AccuracyQueryDto,
  AdjustmentDto,
  DonorStockQueryDto,
  ForecastQueryDto,
  ForecastRequisitionDto,
  FundingSourceDto,
  ProgrammeDto,
  QuantifyDto,
  RunForecastDto,
  ScheduleQueryDto,
  SupplyPlanQueryDto,
  TrackAccuracyDto,
} from './forecasting.dto';
import { DemandForecast } from './forecasting.entities';
import { ForecastingService } from './forecasting.service';

const P = Permissions;

@ApiTags('forecasting')
@Controller('forecasting')
export class ForecastingController {
  constructor(
    private readonly forecasting: ForecastingService,
    private readonly reorder: ReorderService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Get('forecasts') @RequirePermissions(P.FORECASTING_READ) @StoreScoped('query.storeId')
  current(@Query() q: ForecastQueryDto) {
    return this.forecasting.current(q);
  }

  @Get('forecasts/:id') @RequirePermissions(P.FORECASTING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.forecasting.get(id);
  }

  @Post('forecasts/run') @HttpCode(200) @RequirePermissions(P.FORECASTING_MANAGE) @StoreScoped('body.storeId')
  run(@Body() dto: RunForecastDto, @CurrentUser() u: SessionUser) {
    return this.forecasting.run(dto, u);
  }

  /** Draft purchase requisition (or transfer request) from forecast suggestions. */
  @Post('forecasts/requisition') @RequirePermissions(P.FORECASTING_READ, P.INVENTORY_PLANNING) @StoreScoped('body.storeId')
  async requisition(@Body() dto: ForecastRequisitionDto, @CurrentUser() u: SessionUser) {
    const rows = await this.ds.getRepository(DemandForecast).findBy({ id: In(dto.forecastIds), storeId: dto.storeId, isCurrent: true });
    const lines = rows.filter((r) => r.suggestedQty > 0).map((r) => ({ itemId: r.itemId, quantity: r.suggestedQty }));
    if (!lines.length) throw new BadRequestException('Nothing suggested to order');
    return this.reorder.createRequisition({ storeId: dto.storeId, departmentId: dto.departmentId, justification: 'From demand forecast', lines }, u);
  }

  @Get('accuracy') @RequirePermissions(P.FORECASTING_READ) @StoreScoped('query.storeId')
  accuracy(@Query() q: AccuracyQueryDto) {
    return this.forecasting.accuracy(q);
  }

  @Post('accuracy/run') @HttpCode(200) @RequirePermissions(P.FORECASTING_MANAGE)
  trackAccuracy(@Body() dto: TrackAccuracyDto) {
    return this.forecasting.trackAccuracy(dto.month);
  }

  @Get('adjustments') @RequirePermissions(P.FORECASTING_READ)
  adjustments() {
    return this.forecasting.adjustments();
  }

  @Post('adjustments') @RequirePermissions(P.FORECASTING_MANAGE)
  createAdjustment(@Body() dto: AdjustmentDto) {
    return this.forecasting.saveAdjustment(null, dto);
  }

  @Put('adjustments/:id') @RequirePermissions(P.FORECASTING_MANAGE)
  updateAdjustment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustmentDto) {
    return this.forecasting.saveAdjustment(id, dto);
  }

  @Get('programmes') @RequirePermissions(P.FORECASTING_READ)
  programmes() {
    return this.forecasting.programmes();
  }

  @Post('programmes') @RequirePermissions(P.FORECASTING_MANAGE)
  createProgramme(@Body() dto: ProgrammeDto) {
    return this.forecasting.saveProgramme(null, dto);
  }

  @Put('programmes/:id') @RequirePermissions(P.FORECASTING_MANAGE)
  updateProgramme(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProgrammeDto) {
    return this.forecasting.saveProgramme(id, dto);
  }

  @Get('quantifications') @RequirePermissions(P.FORECASTING_READ)
  quantifications(@Query('programmeId') programmeId?: string) {
    return this.forecasting.quantifications(programmeId);
  }

  @Get('quantifications/:id') @RequirePermissions(P.FORECASTING_READ)
  quantification(@Param('id', ParseUUIDPipe) id: string) {
    return this.forecasting.quantification(id);
  }

  @Post('quantifications') @RequirePermissions(P.FORECASTING_MANAGE) @StoreScoped('body.storeId')
  quantify(@Body() dto: QuantifyDto) {
    return this.forecasting.quantify(dto);
  }
}

@ApiTags('forecasting')
@Controller('supply-planning')
export class SupplyPlanningController {
  constructor(private readonly forecasting: ForecastingService) {}

  /** Months of stock and pipeline (on hand + on order + in transit) per item. */
  @Get() @RequirePermissions(P.FORECASTING_READ) @StoreScoped('query.storeId')
  plan(@Query() q: SupplyPlanQueryDto) {
    return this.forecasting.supplyPlan(q.storeId, q);
  }

  @Get('schedule') @RequirePermissions(P.FORECASTING_READ) @StoreScoped('query.storeId')
  schedule(@Query() q: ScheduleQueryDto) {
    return this.forecasting.orderSchedule(q.storeId, q.itemId);
  }
}

@ApiTags('forecasting')
@Controller('funding-sources')
export class FundingSourcesController {
  constructor(private readonly forecasting: ForecastingService) {}

  @Get() @RequirePermissions(P.FORECASTING_READ)
  list() {
    return this.forecasting.fundingSources();
  }

  @Post() @RequirePermissions(P.FORECASTING_MANAGE)
  create(@Body() dto: FundingSourceDto) {
    return this.forecasting.saveFundingSource(null, dto);
  }

  @Put(':id') @RequirePermissions(P.FORECASTING_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FundingSourceDto) {
    return this.forecasting.saveFundingSource(id, dto);
  }

  /** Donor-specific stock report. */
  @Get('stock') @RequirePermissions(P.FORECASTING_READ) @StoreScoped('query.storeId')
  stock(@Query() q: DonorStockQueryDto) {
    return this.forecasting.donorStock(q);
  }
}

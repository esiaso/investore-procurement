import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions, StoreScoped } from '../../common/decorators';
import { AlertsService } from './alerts.service';
import { AmcService } from './amc.service';
import { ExpiryRow, ExpiryService } from './expiry.service';
import {
  AlertQueryDto,
  CreateReorderRequisitionDto,
  DashboardQueryDto,
  ExpiryQueryDto,
  RedistributeDto,
  ReorderQueryDto,
  SettingsQueryDto,
  UpdateStoreItemSettingDto,
  WriteOffDto,
} from './planning.dto';
import { Column, PlanningService } from './planning.service';
import { ReorderRow, ReorderService } from './reorder.service';

const P = Permissions;

const REORDER_COLUMNS: Column<ReorderRow>[] = [
  ['Store', (r) => r.storeName],
  ['Item code', (r) => r.itemCode],
  ['Item', (r) => r.itemName],
  ['Unit', (r) => r.uom],
  ['Category', (r) => r.categoryName],
  ['Mode', (r) => r.mode],
  ['AMC', (r) => r.amc],
  ['Available', (r) => r.available],
  ['On order', (r) => r.onOrder],
  ['In transit', (r) => r.inTransit],
  ['Reorder level', (r) => r.reorderLevel],
  ['Max', (r) => r.maxLevel],
  ['Days of stock', (r) => r.daysOfStock],
  ['Stock-out', (r) => (r.stockOut ? 'yes' : '')],
  ['Suggested qty', (r) => r.suggestedQty],
  ['Unit cost', (r) => r.unitCost],
  ['Suggested value', (r) => r.suggestedValue],
];

const EXPIRY_COLUMNS: Column<ExpiryRow>[] = [
  ['Store', (r) => r.storeName],
  ['Item code', (r) => r.itemCode],
  ['Item', (r) => r.itemName],
  ['Batch', (r) => r.batchNo],
  ['Expiry', (r) => r.expiryDate],
  ['Days left', (r) => r.daysLeft],
  ['Quantity', (r) => r.quantity],
  ['Unit', (r) => r.uom],
  ['Value', (r) => r.value],
  ['AMC here', (r) => r.amc],
  ['Days to use up', (r) => r.daysToConsume],
  ['At risk', (r) => (r.atRisk ? 'yes' : '')],
  ['Suggested store', (r) => r.suggestedStore?.name ?? ''],
  ['Hold', (r) => r.holdStatus],
];

async function send<T>(planning: PlanningService, res: Response, format: string | undefined, name: string, columns: Column<T>[], rows: T[]) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return planning.toCsv(columns, rows);
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return new StreamableFile(await planning.toXlsx(name, columns, rows));
  }
  return rows;
}

@ApiTags('stock planning')
@Controller('stock-planning')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly reorder: ReorderService,
    private readonly expiry: ExpiryService,
    private readonly alerts: AlertsService,
    private readonly amc: AmcService,
  ) {}

  @Get('settings') @RequirePermissions(P.INVENTORY_READ) @StoreScoped('query.storeId')
  settings(@Query() q: SettingsQueryDto) {
    return this.planning.listSettings(q);
  }

  @Put('settings/:id') @RequirePermissions(P.INVENTORY_PLANNING)
  updateSetting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreItemSettingDto) {
    return this.planning.updateSetting(id, dto);
  }

  @Put('settings/:storeId/:itemId') @RequirePermissions(P.INVENTORY_PLANNING) @StoreScoped('params.storeId')
  upsertSetting(@Param('storeId', ParseUUIDPipe) storeId: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: UpdateStoreItemSettingDto) {
    return this.planning.upsertSetting(storeId, itemId, dto);
  }

  /** Suggested reorder report (`format=csv|xlsx` to download). */
  @Get('reorder') @RequirePermissions(P.INVENTORY_READ) @StoreScoped('query.storeId')
  async reorderReport(@Query() q: ReorderQueryDto, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    return send(this.planning, res, q.format, 'reorder-suggestions', REORDER_COLUMNS, await this.reorder.report(q, u));
  }

  /** Draft purchase requisition (buying stores) or transfer request to the parent store (satellites). */
  @Post('reorder/requisition') @RequirePermissions(P.INVENTORY_PLANNING) @StoreScoped('body.storeId')
  createRequisition(@Body() dto: CreateReorderRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.reorder.createRequisition(dto, u);
  }

  @Get('expiry') @RequirePermissions(P.INVENTORY_READ) @StoreScoped('query.storeId')
  async expiryReport(@Query() q: ExpiryQueryDto, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    return send(this.planning, res, q.format, 'near-expiry', EXPIRY_COLUMNS, await this.expiry.report(q, u));
  }

  @Post('expiry/redistribute') @RequirePermissions(P.INVENTORY_PLANNING, P.INVENTORY_TRANSFER_REQUEST) @StoreScoped('body.fromStoreId')
  redistribute(@Body() dto: RedistributeDto, @CurrentUser() u: SessionUser) {
    return this.expiry.redistribute(dto, u);
  }

  @Post('expiry/write-off') @RequirePermissions(P.INVENTORY_PLANNING, P.INVENTORY_ADJUST) @StoreScoped('body.storeId')
  writeOff(@Body() dto: WriteOffDto, @CurrentUser() u: SessionUser) {
    return this.expiry.writeOff(dto, u);
  }

  @Get('disposal-certificate/:adjustmentId') @RequirePermissions(P.INVENTORY_READ)
  async certificate(@Param('adjustmentId', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { number, pdf } = await this.expiry.disposalCertificate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="disposal-${number.replace(/\//g, '-')}.pdf"`);
    return new StreamableFile(pdf);
  }

  @Get('alerts') @RequireAnyPermission(P.INVENTORY_READ, P.INVENTORY_ALERTS) @StoreScoped('query.storeId')
  listAlerts(@Query() q: AlertQueryDto, @CurrentUser() u: SessionUser) {
    return this.alerts.list({ ...q, storeIds: u.storeIds });
  }

  @Get('dashboard') @RequirePermissions(P.INVENTORY_READ) @StoreScoped('query.storeId')
  dashboard(@Query() q: DashboardQueryDto, @CurrentUser() u: SessionUser) {
    return this.planning.dashboard(u, q.storeId);
  }

  /** Recalculate now (normally the scheduled jobs do this). */
  @Post('recalculate') @HttpCode(200) @RequirePermissions(P.INVENTORY_PLANNING) @StoreScoped('query.storeId')
  async recalc(@Query() q: DashboardQueryDto) {
    return { amc: await this.amc.recalc(q.storeId), reorder: await this.reorder.scan(q.storeId) };
  }
}

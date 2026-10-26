import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { toCsv } from '../../common/csv';
import { CurrentUser, Public, RequireAnyPermission, RequirePermissions, StoreScoped } from '../../common/decorators';
import { MpesaService } from './mpesa.service';
import { PosAdminService } from './pos-admin.service';
import { PosReportsService } from './pos-reports.service';
import {
  AccountPaymentDto,
  BasketCheckDto,
  CloseShiftDto,
  CustomerDto,
  CustomerQueryDto,
  ItemSearchDto,
  MpesaConfigDto,
  OpenShiftDto,
  PosEventsQueryDto,
  PosReportDto,
  PosSaleDto,
  PromotionDto,
  RefundDto,
  StkPushDto,
  SyncDto,
  TerminalDto,
  VarianceDecisionDto,
  VoidSaleDto,
} from './pos.dto';
import { PosService } from './pos.service';
import { ShiftsService } from './shifts.service';

const P = Permissions;

@ApiTags('pos')
@Controller('pos')
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly shifts: ShiftsService,
    private readonly admin: PosAdminService,
    private readonly mpesa: MpesaService,
    private readonly reports: PosReportsService,
  ) {}

  // ------------------------------------------------------------------ tills and shifts

  @Get('terminals') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE, P.POS_REPORTS)
  terminals() {
    return this.admin.terminals();
  }

  @Post('terminals') @RequirePermissions(P.POS_MANAGE) @StoreScoped('body.storeId')
  createTerminal(@Body() dto: TerminalDto) {
    return this.admin.saveTerminal(null, dto);
  }

  @Put('terminals/:id') @RequirePermissions(P.POS_MANAGE) @StoreScoped('body.storeId')
  updateTerminal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TerminalDto) {
    return this.admin.saveTerminal(id, dto);
  }

  /** Items, prices, customers and payment modes for selling offline. */
  @Get('terminals/:id/catalog') @RequirePermissions(P.POS_SELL)
  catalog(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.pos.catalog(id, u);
  }

  @Post('shifts') @RequirePermissions(P.POS_SELL)
  open(@Body() dto: OpenShiftDto, @CurrentUser() u: SessionUser) {
    return this.shifts.open(dto, u);
  }

  @Get('shifts/current') @RequirePermissions(P.POS_SELL)
  current(@Query('terminalId', ParseUUIDPipe) terminalId: string, @CurrentUser() u: SessionUser) {
    return this.shifts.current(terminalId, u);
  }

  @Get('shifts') @RequireAnyPermission(P.POS_REPORTS, P.POS_APPROVE_VARIANCE) @StoreScoped('query.storeId')
  listShifts(@Query() q: { storeId?: string; status?: string; varianceStatus?: string; from?: string; to?: string }) {
    return this.shifts.list(q);
  }

  /** X report while open; the Z report once closed. */
  @Get('shifts/:id') @RequireAnyPermission(P.POS_SELL, P.POS_REPORTS, P.POS_APPROVE_VARIANCE)
  shift(@Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.get(id);
  }

  @Get('shifts/:id/sales') @RequireAnyPermission(P.POS_SELL, P.POS_REPORTS)
  shiftSales(@Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.sales(id);
  }

  @Post('shifts/:id/close') @HttpCode(200) @RequirePermissions(P.POS_SELL)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseShiftDto, @CurrentUser() u: SessionUser) {
    return this.shifts.close(id, dto, u);
  }

  @Post('shifts/:id/variance') @HttpCode(200) @RequirePermissions(P.POS_APPROVE_VARIANCE)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VarianceDecisionDto, @CurrentUser() u: SessionUser) {
    return this.shifts.decide(id, dto, u);
  }

  // ------------------------------------------------------------------ selling

  @Get('items') @RequirePermissions(P.POS_SELL)
  items(@Query() q: ItemSearchDto, @CurrentUser() u: SessionUser) {
    return this.pos.searchItems(q.terminalId, q.q, u);
  }

  /** Prices, promotions, controls and interaction alerts for the basket. */
  @Post('check') @HttpCode(200) @RequirePermissions(P.POS_SELL)
  check(@Body() dto: BasketCheckDto, @CurrentUser() u: SessionUser) {
    return this.pos.check(dto, u);
  }

  @Post('sales') @RequirePermissions(P.POS_SELL)
  sell(@Body() dto: PosSaleDto, @CurrentUser() u: SessionUser) {
    return this.pos.sell(dto, u);
  }

  /** Sales made offline; each is recorded once (clientRef). */
  @Post('sales/sync') @HttpCode(200) @RequirePermissions(P.POS_SELL)
  sync(@Body() dto: SyncDto, @CurrentUser() u: SessionUser) {
    return this.pos.sync(dto.sales, u);
  }

  @Get('sales/:id') @RequireAnyPermission(P.POS_SELL, P.POS_REPORTS)
  sale(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.sale(id);
  }

  @Post('sales/:id/void') @HttpCode(200) @RequirePermissions(P.POS_SELL)
  voidSale(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidSaleDto, @CurrentUser() u: SessionUser) {
    return this.pos.voidSale(id, dto, u);
  }

  @Post('sales/:id/refund') @HttpCode(200) @RequirePermissions(P.POS_REFUND)
  refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto, @CurrentUser() u: SessionUser) {
    return this.pos.refund(id, dto, u);
  }

  // ------------------------------------------------------------------ customers and promotions

  @Get('customers') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE)
  customers(@Query() q: CustomerQueryDto) {
    return this.admin.customers(q);
  }

  @Post('customers') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE)
  createCustomer(@Body() dto: CustomerDto, @CurrentUser() u: SessionUser) {
    return this.admin.saveCustomer(null, dto, u);
  }

  @Put('customers/:id') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE)
  updateCustomer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerDto, @CurrentUser() u: SessionUser) {
    return this.admin.saveCustomer(id, dto, u);
  }

  @Get('customers/:id/statement') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE)
  statement(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.statement(id);
  }

  @Post('customers/:id/payments') @RequirePermissions(P.POS_SELL)
  accountPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AccountPaymentDto, @CurrentUser() u: SessionUser) {
    return this.admin.accountPayment(id, dto, u);
  }

  @Get('promotions') @RequireAnyPermission(P.POS_SELL, P.POS_MANAGE)
  promotions() {
    return this.admin.promotions();
  }

  @Post('promotions') @RequirePermissions(P.POS_MANAGE)
  createPromotion(@Body() dto: PromotionDto) {
    return this.admin.savePromotion(null, dto);
  }

  @Put('promotions/:id') @RequirePermissions(P.POS_MANAGE)
  updatePromotion(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PromotionDto) {
    return this.admin.savePromotion(id, dto);
  }

  // ------------------------------------------------------------------ M-Pesa

  @Get('mpesa/config') @RequirePermissions(P.POS_MANAGE)
  mpesaConfig() {
    return this.mpesa.getConfig();
  }

  @Put('mpesa/config') @RequirePermissions(P.POS_MANAGE)
  saveMpesaConfig(@Body() dto: MpesaConfigDto) {
    return this.mpesa.saveConfig(dto);
  }

  /** Sends the payment prompt to the customer's phone. */
  @Post('mpesa/stk') @RequirePermissions(P.POS_SELL)
  stk(@Body() dto: StkPushDto, @CurrentUser() u: SessionUser) {
    return this.mpesa.stkPush(dto, u);
  }

  /** Payments made to the till / paybill (C2B) not used by a sale yet. */
  @Get('mpesa/confirmations') @RequirePermissions(P.POS_SELL)
  confirmations() {
    return this.mpesa.unusedConfirmations();
  }

  @Get('mpesa/:id') @RequirePermissions(P.POS_SELL)
  mpesaStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.mpesa.status(id);
  }

  // ------------------------------------------------------------------ reports

  @Get('reports/sales') @RequirePermissions(P.POS_REPORTS) @StoreScoped('query.storeId')
  async salesReport(@Query() q: PosReportDto, @Res({ passthrough: true }) res: Response) {
    const rows = await this.reports.sales(q);
    if (q.format !== 'csv') return rows;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pos-sales-by-${q.groupBy}.csv"`);
    return toCsv(rows);
  }

  @Get('reports/events') @RequirePermissions(P.POS_REPORTS) @StoreScoped('query.storeId')
  async eventsReport(@Query() q: PosEventsQueryDto, @Res({ passthrough: true }) res: Response) {
    const rows = await this.reports.events(q);
    if (q.format !== 'csv') return rows;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pos-voids-refunds.csv"');
    return toCsv(rows);
  }
}

/**
 * Safaricom Daraja callbacks (STK result, C2B validation / confirmation).
 * Public: Daraja sends no credentials, so the secret token in the path
 * identifies them; CSRF does not apply (no cookie).
 */
@ApiTags('pos')
@Controller('callbacks/mpesa')
export class MpesaCallbackController {
  constructor(private readonly mpesa: MpesaService) {}

  @Public() @Post('stk/:token') @HttpCode(200)
  stk(@Param('token') token: string, @Body() body: Record<string, unknown>) {
    return this.mpesa.stkCallback(token, body);
  }

  @Public() @Post('c2b/validation/:token') @HttpCode(200)
  validation(@Param('token') token: string) {
    return this.mpesa.c2bValidation(token);
  }

  @Public() @Post('c2b/confirmation/:token') @HttpCode(200)
  confirmation(@Param('token') token: string, @Body() body: Record<string, unknown>) {
    return this.mpesa.c2bConfirmation(token, body);
  }
}

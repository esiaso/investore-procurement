import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Permissions, SalesSource, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions, StoreScoped } from '../../common/decorators';
import { API_KEY_HEADER, ApiClientsService } from './api-clients.service';
import { toCsv } from '../../common/csv';
import { CreateCreditNoteDto, CreateSaleDto, InvoiceQueryDto, PayerDto, PriceListDto, PriceListItemDto, ReportQueryDto } from './billing.dto';
import { BillingService } from './billing.service';
import { SalesReportsService } from './sales-reports.service';

const P = Permissions;

class ReceiptQueryDto {
  @ApiPropertyOptional({ enum: ['THERMAL', 'A4'] }) @IsOptional() @IsIn(['THERMAL', 'A4']) layout?: 'THERMAL' | 'A4';
  @ApiPropertyOptional({ description: 'Print as COPY (reprint)' }) @IsOptional() @IsIn(['true', 'false']) copy?: 'true' | 'false';
}

class PaymentModeCodeDto {
  @ApiProperty({ description: 'eTIMS payment type (code class 07)' }) @IsString() @MaxLength(5) etimsPaymentTypeCode: string;
}

class CreateApiClientDto {
  @ApiProperty() @IsString() @MaxLength(60) name: string;
  @ApiProperty({ description: 'Service user the client acts as' }) @IsUUID() userId: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
}

class StoreFilterDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

class ActiveDto {
  @ApiProperty() @IsBoolean() isActive: boolean;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** OTC sale or patient-chargeable consumables: stock out (FEFO), invoice, eTIMS. */
  @Post('invoices') @RequirePermissions(P.BILLING_INVOICE) @StoreScoped('body.storeId')
  sell(@Body() dto: CreateSaleDto, @CurrentUser() u: SessionUser) {
    return this.billing.sell(dto, u);
  }

  @Get('invoices') @RequireAnyPermission(P.BILLING_READ, P.PHARMACY_READ) @StoreScoped('query.storeId')
  list(@Query() q: InvoiceQueryDto) {
    return this.billing.list(q);
  }

  @Get('invoices/:id') @RequireAnyPermission(P.BILLING_READ, P.PHARMACY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.get(id);
  }

  /** Receipt / invoice PDF (80 mm thermal or A4). Until eTIMS accepts it, it prints as "eTIMS PENDING". */
  @Get('invoices/:id/receipt') @RequireAnyPermission(P.BILLING_READ, P.PHARMACY_READ)
  async receipt(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReceiptQueryDto, @Res({ passthrough: true }) res: Response) {
    const { number, pdf } = await this.billing.receiptPdf(id, q.layout ?? 'THERMAL', q.copy === 'true');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${number.replace(/\//g, '-')}.pdf"`);
    return new StreamableFile(pdf);
  }

  @Post('invoices/:id/credit-notes') @RequirePermissions(P.BILLING_MANAGE)
  creditNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCreditNoteDto, @CurrentUser() u: SessionUser) {
    return this.billing.creditNote(id, dto, u);
  }

  @Get('price-lists') @RequireAnyPermission(P.BILLING_READ, P.BILLING_INVOICE, P.PHARMACY_READ)
  priceLists() {
    return this.billing.priceLists();
  }

  @Post('price-lists') @RequirePermissions(P.BILLING_MANAGE)
  createPriceList(@Body() dto: PriceListDto) {
    return this.billing.savePriceList(null, dto);
  }

  @Put('price-lists/:id') @RequirePermissions(P.BILLING_MANAGE)
  updatePriceList(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PriceListDto) {
    return this.billing.savePriceList(id, dto);
  }

  @Get('price-lists/:id/items') @RequireAnyPermission(P.BILLING_READ, P.BILLING_INVOICE)
  priceListItems(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.priceListItems(id);
  }

  @Put('price-lists/:id/items') @RequirePermissions(P.BILLING_MANAGE)
  setPrice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PriceListItemDto) {
    return this.billing.setPrice(id, dto.itemId, dto.price);
  }

  @Get('payers') @RequireAnyPermission(P.BILLING_READ, P.BILLING_INVOICE, P.PATIENTS_READ)
  payers() {
    return this.billing.payers();
  }

  @Post('payers') @RequirePermissions(P.BILLING_MANAGE)
  createPayer(@Body() dto: PayerDto) {
    return this.billing.savePayer(null, dto);
  }

  @Put('payers/:id') @RequirePermissions(P.BILLING_MANAGE)
  updatePayer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayerDto) {
    return this.billing.savePayer(id, dto);
  }

  @Get('payment-modes') @RequireAnyPermission(P.BILLING_READ, P.BILLING_INVOICE, P.PHARMACY_DISPENSE)
  paymentModes() {
    return this.billing.paymentModes();
  }

  @Put('payment-modes/:code') @RequirePermissions(P.BILLING_MANAGE)
  setPaymentModeCode(@Param('code') code: string, @Body() dto: PaymentModeCodeDto) {
    return this.billing.setPaymentModeCode(code, dto.etimsPaymentTypeCode);
  }
}

function csvOr(res: Response, format: string | undefined, name: string, rows: Record<string, unknown>[]) {
  if (format !== 'csv') return rows;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  return toCsv(rows);
}

@ApiTags('billing')
@Controller('billing/reports')
export class SalesReportsController {
  constructor(private readonly reports: SalesReportsService) {}

  @Get('etims-status') @RequireAnyPermission(P.ETIMS_READ, P.BILLING_READ) @StoreScoped('query.storeId')
  etimsStatus(@Query() q: StoreFilterDto) {
    return this.reports.etimsSyncStatus(q);
  }

  @Get('vat-output') @RequireAnyPermission(P.BILLING_READ, P.ETIMS_READ) @StoreScoped('query.storeId')
  async vatOutput(@Query() q: ReportQueryDto, @Res({ passthrough: true }) res: Response) {
    return csvOr(res, q.format, 'vat-output', await this.reports.vatOutput(q));
  }

  @Get('purchases-by-tax') @RequireAnyPermission(P.BILLING_READ, P.ETIMS_READ, P.PURCHASING_INVOICE) @StoreScoped('query.storeId')
  async purchases(@Query() q: ReportQueryDto, @Res({ passthrough: true }) res: Response) {
    return csvOr(res, q.format, 'purchases-by-tax', await this.reports.purchasesByTax(q));
  }

  @Get('credit-notes') @RequireAnyPermission(P.BILLING_READ, P.ETIMS_READ) @StoreScoped('query.storeId')
  async creditNotes(@Query() q: ReportQueryDto, @Res({ passthrough: true }) res: Response) {
    return csvOr(res, q.format, 'credit-note-register', await this.reports.creditNoteRegister(q));
  }

  @Get('reconciliation') @RequireAnyPermission(P.BILLING_READ, P.ETIMS_READ) @StoreScoped('query.storeId')
  reconciliation(@Query() q: ReportQueryDto) {
    return this.reports.reconciliation(q);
  }
}

@ApiTags('integration')
@Controller('api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get() @RequirePermissions(P.ETIMS_MANAGE)
  list() {
    return this.clients.list();
  }

  /** The key is shown once in the response. */
  @Post() @RequirePermissions(P.ETIMS_MANAGE, P.USERS_MANAGE)
  create(@Body() dto: CreateApiClientDto) {
    return this.clients.create(dto);
  }

  @Put(':id/active') @RequirePermissions(P.ETIMS_MANAGE)
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto) {
    return this.clients.setActive(id, dto.isActive);
  }
}

class HmisInvoiceDto extends CreateSaleDto {}

/**
 * HMIS integration (API key in `x-api-key`): issue an eTIMS invoice for
 * charges raised in the HMIS. `externalRef` (the HMIS bill id) makes the call
 * idempotent; a repeat returns 409 with the existing invoice id.
 */
@ApiTags('integration')
@ApiHeader({ name: API_KEY_HEADER, required: true })
@Controller('integration')
export class IntegrationController {
  constructor(private readonly billing: BillingService) {}

  private assertClient(req: Request) {
    const client = (req as Request & { apiClient?: { scopes: string[] } }).apiClient;
    if (!client) throw new ForbiddenException('Integration endpoints need an API key');
    if (!client.scopes.includes(P.BILLING_INVOICE)) throw new ForbiddenException('API key lacks the billing.invoice scope');
  }

  @Post('invoices') @RequirePermissions(P.BILLING_INVOICE) @StoreScoped('body.storeId')
  async issue(@Body() dto: HmisInvoiceDto, @CurrentUser() u: SessionUser, @Req() req: Request) {
    this.assertClient(req);
    const inv = await this.billing.sell({ ...dto, source: dto.source ?? SalesSource.HMIS }, u);
    return this.summary(inv);
  }

  @Get('invoices/:id') @RequirePermissions(P.BILLING_INVOICE)
  async status(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    this.assertClient(req);
    return this.summary(await this.billing.get(id));
  }

  private async summary(inv: Awaited<ReturnType<BillingService['get']>>) {
    return {
      id: inv.id,
      number: inv.number,
      externalRef: inv.externalRef,
      totalAmount: inv.totalAmount,
      totalTax: inv.totalTax,
      taxSummary: inv.taxSummary,
      etimsStatus: inv.etimsStatus,
      cuInvoiceNo: inv.cuInvoiceNo,
      receiptSignature: inv.rcptSign,
      internalData: inv.intrlData,
      sdcDateTime: inv.sdcDateTime,
      qrUrl: await this.billing.qrFor(inv.id),
      etimsError: inv.etimsError,
    };
  }
}

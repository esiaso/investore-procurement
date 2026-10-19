import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DocumentType, Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { MailService } from '../mail/mail.service';
import { GrnsService } from './grns.service';
import { InvoicesService } from './invoices.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  AmendPurchaseOrderDto,
  AwardRfqDto,
  CreateGrnDto,
  CreateInvoiceDto,
  CreatePurchaseOrderDto,
  CreateRequisitionDto,
  CreateRfqDto,
  DocListQueryDto,
  InspectGrnDto,
  PayInvoiceDto,
  PostGrnDto,
  ReasonDto,
  RecordQuotationDto,
  RegulariseGrnDto,
} from './purchasing.dto';
import { RequisitionsService } from './requisitions.service';
import { RfqsService } from './rfqs.service';

@ApiTags('purchasing')
@Controller('requisitions')
export class RequisitionsController {
  constructor(private readonly prs: RequisitionsService) {}

  @Get() @RequirePermissions(Permissions.PURCHASING_READ)
  list(@Query() q: DocListQueryDto) {
    return this.prs.list(q);
  }

  @Get(':id') @RequirePermissions(Permissions.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.prs.get(id);
  }

  @Post() @RequirePermissions(Permissions.PURCHASING_REQUISITION)
  create(@Body() dto: CreateRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.prs.create(dto, u);
  }

  @Put(':id') @RequirePermissions(Permissions.PURCHASING_REQUISITION)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.prs.update(id, dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_REQUISITION)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.prs.submit(id, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_REQUISITION)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.prs.cancel(id, u);
  }
}

@ApiTags('purchasing')
@Controller('rfqs')
export class RfqsController {
  constructor(private readonly rfqs: RfqsService) {}

  @Get() @RequirePermissions(Permissions.PURCHASING_READ)
  list(@Query() q: DocListQueryDto) {
    return this.rfqs.list(q);
  }

  @Get(':id') @RequirePermissions(Permissions.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.get(id);
  }

  /** Comparative analysis sheet. */
  @Get(':id/comparison') @RequirePermissions(Permissions.PURCHASING_READ)
  comparison(@Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.comparison(id);
  }

  @Post() @RequirePermissions(Permissions.PURCHASING_RFQ)
  create(@Body() dto: CreateRfqDto) {
    return this.rfqs.create(dto);
  }

  @Post(':id/send') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RFQ)
  send(@Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.send(id);
  }

  @Post(':id/quotations') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RFQ)
  quote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordQuotationDto) {
    return this.rfqs.recordQuotation(id, dto);
  }

  @Post(':id/award') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RFQ)
  award(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AwardRfqDto, @CurrentUser() u: SessionUser) {
    return this.rfqs.award(id, dto, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RFQ)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.cancel(id);
  }
}

@ApiTags('purchasing')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly pos: PurchaseOrdersService,
    private readonly mail: MailService,
  ) {}

  @Get() @RequirePermissions(Permissions.PURCHASING_READ)
  list(@Query() q: DocListQueryDto) {
    return this.pos.list(q);
  }

  @Get(':id') @RequirePermissions(Permissions.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.get(id);
  }

  @Get(':id/versions') @RequirePermissions(Permissions.PURCHASING_READ)
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.versions(id);
  }

  @Get(':id/emails') @RequirePermissions(Permissions.PURCHASING_READ)
  emails(@Param('id', ParseUUIDPipe) id: string) {
    return this.mail.forDocument(DocumentType.PURCHASE_ORDER, id);
  }

  /** Printable PDF with approval stamps. */
  @Get(':id/pdf') @RequirePermissions(Permissions.PURCHASING_READ)
  @Header('Content-Type', 'application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const po = await this.pos.get(id);
    res.setHeader('Content-Disposition', `inline; filename="${po.number.replace(/\//g, '-')}.pdf"`);
    return new StreamableFile(await this.pos.renderPdf(id));
  }

  @Post() @RequirePermissions(Permissions.PURCHASING_PO)
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() u: SessionUser) {
    return this.pos.create(dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.pos.submit(id, u);
  }

  @Post(':id/amend') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  amend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AmendPurchaseOrderDto, @CurrentUser() u: SessionUser) {
    return this.pos.amend(id, dto, u);
  }

  @Post(':id/send') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.pos.send(id, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: SessionUser) {
    return this.pos.cancel(id, dto.reason, u);
  }

  @Post(':id/close') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.pos.close(id, dto.reason);
  }
}

@ApiTags('purchasing')
@Controller('grns')
export class GrnsController {
  constructor(private readonly grns: GrnsService) {}

  @Get() @RequirePermissions(Permissions.PURCHASING_READ)
  list(@Query() q: DocListQueryDto, @CurrentUser() u: SessionUser) {
    return this.grns.list(q, u);
  }

  @Get(':id') @RequirePermissions(Permissions.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.grns.get(id, u);
  }

  @Post() @RequirePermissions(Permissions.PURCHASING_RECEIVE)
  create(@Body() dto: CreateGrnDto, @CurrentUser() u: SessionUser) {
    return this.grns.create(dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RECEIVE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.grns.submitForInspection(id, u);
  }

  @Post(':id/inspect') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_INSPECT)
  inspect(@Param('id', ParseUUIDPipe) id: string, @Body() dto: InspectGrnDto, @CurrentUser() u: SessionUser) {
    return this.grns.inspect(id, dto, u);
  }

  /** Posts accepted quantities to stock. */
  @Post(':id/post') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RECEIVE)
  post(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostGrnDto, @CurrentUser() u: SessionUser) {
    return this.grns.post(id, dto, u);
  }

  @Post(':id/regularise') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PO)
  regularise(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RegulariseGrnDto) {
    return this.grns.regularise(id, dto.purchaseOrderId);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_RECEIVE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.grns.cancel(id, u);
  }
}

@ApiTags('purchasing')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get() @RequirePermissions(Permissions.PURCHASING_READ)
  list(@Query() q: DocListQueryDto) {
    return this.invoices.list(q);
  }

  @Get(':id') @RequirePermissions(Permissions.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(id);
  }

  /** PO vs received vs invoiced, per line. */
  @Get(':id/match') @RequirePermissions(Permissions.PURCHASING_READ)
  match(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.matchView(id);
  }

  @Post() @RequirePermissions(Permissions.PURCHASING_INVOICE)
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() u: SessionUser) {
    return this.invoices.create(dto, u);
  }

  @Post(':id/rematch') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_INVOICE)
  rematch(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.rematch(id);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_INVOICE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.invoices.submit(id, u);
  }

  @Post(':id/pay') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_PAYMENT)
  pay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayInvoiceDto) {
    return this.invoices.pay(id, dto);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.PURCHASING_INVOICE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.invoices.cancel(id, u);
  }
}

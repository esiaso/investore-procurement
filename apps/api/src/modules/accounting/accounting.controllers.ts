import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, Public, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { ConnectionDto, MappingDto, PeriodQueryDto, PostingQueryDto, PreviewDto, SettlementDto } from './accounting.dto';
import { AccountingService } from './accounting.service';

const P = Permissions;

@ApiTags('accounting')
@Controller('accounting')
export class AccountingController {
  constructor(private readonly acc: AccountingService) {}

  // ------------------------------------------------------------------ connection

  @Get('connection') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_MANAGE)
  connection() {
    return this.acc.getConnection();
  }

  @Put('connection') @RequirePermissions(P.ACCOUNTING_MANAGE)
  saveConnection(@Body() dto: ConnectionDto) {
    return this.acc.saveConnection(dto);
  }

  /** Where to send the browser for Intuit's consent screen. */
  @Post('connection/authorize') @HttpCode(200) @RequirePermissions(P.ACCOUNTING_MANAGE)
  authorize() {
    return this.acc.startOAuth();
  }

  @Post('connection/disconnect') @HttpCode(200) @RequirePermissions(P.ACCOUNTING_MANAGE)
  disconnect() {
    return this.acc.disconnect();
  }

  /** Company name and closing date read again from QuickBooks. */
  @Post('connection/refresh') @HttpCode(200) @RequirePermissions(P.ACCOUNTING_MANAGE)
  refresh() {
    return this.acc.refreshCompany();
  }

  /** QuickBooks accounts, classes and tax codes. */
  @Get('lists') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_MANAGE)
  lists() {
    return this.acc.lists();
  }

  // ------------------------------------------------------------------ mappings

  @Get('mappings') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_MANAGE)
  mappings() {
    return this.acc.mappings();
  }

  @Put('mappings') @RequirePermissions(P.ACCOUNTING_MANAGE)
  saveMapping(@Body() dto: MappingDto) {
    return this.acc.saveMapping(dto);
  }

  @Delete('mappings/:id') @HttpCode(204) @RequirePermissions(P.ACCOUNTING_MANAGE)
  deleteMapping(@Param('id', ParseUUIDPipe) id: string) {
    return this.acc.deleteMapping(id);
  }

  @Get('external-refs') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_MANAGE)
  externalRefs() {
    return this.acc.externalRefs();
  }

  // ------------------------------------------------------------------ batches and postings

  @Get('batches') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  batches() {
    return this.acc.batches();
  }

  /** Builds and validates what would be posted for the period. */
  @Post('batches') @RequirePermissions(P.ACCOUNTING_POST)
  preview(@Body() dto: PreviewDto, @CurrentUser() u: SessionUser) {
    return this.acc.preview(dto, u);
  }

  @Get('batches/:id') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  batch(@Param('id', ParseUUIDPipe) id: string) {
    return this.acc.batch(id);
  }

  @Post('batches/:id/post') @HttpCode(200) @RequirePermissions(P.ACCOUNTING_POST)
  post(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.acc.post(id, u);
  }

  @Get('postings') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  postings(@Query() q: PostingQueryDto) {
    return this.acc.postings(q);
  }

  @Get('postings/:id') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  posting(@Param('id', ParseUUIDPipe) id: string) {
    return this.acc.posting(id);
  }

  /** Rebuild a blocked / failed document from its source and send it again. */
  @Post('postings/:id/reprocess') @HttpCode(200) @RequirePermissions(P.ACCOUNTING_POST)
  reprocess(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.acc.reprocess(id, u);
  }

  @Get('reconciliation') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  reconciliation(@Query() q: PeriodQueryDto) {
    return this.acc.reconciliation(q.from, q.to);
  }

  // ------------------------------------------------------------------ payer settlements

  @Get('settlements') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  settlements() {
    return this.acc.settlements();
  }

  @Get('settlements/outstanding/:payerId') @RequireAnyPermission(P.ACCOUNTING_READ, P.ACCOUNTING_POST)
  outstanding(@Param('payerId', ParseUUIDPipe) payerId: string) {
    return this.acc.outstanding(payerId);
  }

  @Post('settlements') @RequirePermissions(P.ACCOUNTING_POST)
  settle(@Body() dto: SettlementDto, @CurrentUser() u: SessionUser) {
    return this.acc.settle(dto, u);
  }
}

/**
 * Intuit's OAuth redirect. Public: the browser arrives from Intuit; the
 * one-time state started by a manager identifies the authorisation.
 */
@ApiTags('accounting')
@Controller('callbacks/quickbooks')
export class QuickBooksCallbackController {
  constructor(private readonly acc: AccountingService) {}

  @Public() @Get()
  async callback(@Query() q: { code?: string; state?: string; realmId?: string; error?: string }, @Req() req: Request, @Res() res: Response) {
    try {
      await this.acc.oauthCallback(q, (req as Request & { user?: SessionUser }).user?.id ?? null);
      res.redirect('/accounting/quickbooks?connected=1');
    } catch (e) {
      res.redirect(`/accounting/quickbooks?error=${encodeURIComponent((e as Error).message)}`);
    }
  }
}

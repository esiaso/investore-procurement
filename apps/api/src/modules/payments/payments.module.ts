import { Body, Controller, Get, HttpCode, Ip, Module, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, Public, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { JobsModule } from '../jobs/jobs.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PaymentVoucher, PaymentVoucherLine } from '../purchasing/purchasing.entities';
import { MpesaPayoutsService } from './mpesa-payouts.service';
import { CreateVoucherDto, PayablesQueryDto, ReasonDto, ReconcileDto, ReleaseDto, ResolveDto, StatementImportDto, VoucherQueryDto } from './payments.dto';
import { MpesaPayout, MpesaStatementLine, PaymentReconciliation } from './payments.entities';
import { PaymentsService } from './payments.service';
import { PaymentReconciliationService } from './reconciliation.service';

const P = Permissions;
const ANY_PAYMENTS = [P.PAYMENTS_PREPARE, P.PAYMENTS_RELEASE, P.PAYMENTS_RECONCILE] as const;

@ApiTags('payments')
@Controller('payment-vouchers')
export class PaymentVouchersController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: MpesaPayoutsService,
  ) {}

  /** ?status=, ?review=true (failed / needing review), ?supplierId=, ?method=, ?search= */
  @Get() @RequireAnyPermission(...ANY_PAYMENTS)
  list(@Query() q: VoucherQueryDto) {
    return this.payments.list(q);
  }

  @Get(':id') @RequireAnyPermission(...ANY_PAYMENTS)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }

  @Get(':id/pdf') @RequireAnyPermission(...ANY_PAYMENTS)
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.payments.renderPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"`);
    return new StreamableFile(r.pdf);
  }

  /** One supplier's approved invoices (a batch), by bank, cheque or M-PESA. */
  @Post() @RequirePermissions(P.PAYMENTS_PREPARE)
  create(@Body() dto: CreateVoucherDto, @CurrentUser() u: SessionUser) {
    return this.payments.create(dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(P.PAYMENTS_PREPARE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.payments.submit(id, u);
  }

  /** Pays an approved voucher: bank / cheque reference, or M-PESA dispatch. Never by its preparer or an approver. */
  @Post(':id/release') @HttpCode(200) @RequirePermissions(P.PAYMENTS_RELEASE)
  release(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseDto, @CurrentUser() u: SessionUser) {
    return this.payments.release(id, dto, u);
  }

  /** Review queue: settle a failed / unknown payment after checking the statement. */
  @Post(':id/resolve') @HttpCode(200) @RequirePermissions(P.PAYMENTS_RECONCILE)
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDto, @CurrentUser() u: SessionUser) {
    return this.payments.resolve(id, dto, u);
  }

  /** M-PESA Reversal of a paid voucher (result by callback). */
  @Post(':id/reverse') @HttpCode(200) @RequirePermissions(P.PAYMENTS_RELEASE)
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: SessionUser) {
    return this.payouts.reverse(id, dto.reason, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.PAYMENTS_PREPARE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: SessionUser) {
    return this.payments.cancel(id, dto.reason, u);
  }
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: MpesaPayoutsService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  /** Approved invoices still to pay, with ageing. */
  @Get('payables') @RequireAnyPermission(...ANY_PAYMENTS)
  payables(@Query() q: PayablesQueryDto) {
    return this.payments.payables(q);
  }

  /** Runs the M-PESA follow-up now (status queries, retries, review). */
  @Post('mpesa/follow-up') @HttpCode(200) @RequirePermissions(P.PAYMENTS_RECONCILE)
  followUp() {
    return this.payouts.followUp();
  }

  @Post('mpesa/statements') @HttpCode(200) @RequirePermissions(P.PAYMENTS_RECONCILE)
  importStatement(@Body() dto: StatementImportDto, @CurrentUser() u: SessionUser) {
    return this.reconciliation.importStatement(dto.csv, u);
  }

  @Get('reconciliations') @RequirePermissions(P.PAYMENTS_RECONCILE)
  reconciliations() {
    return this.reconciliation.list();
  }

  @Get('reconciliations/:id') @RequirePermissions(P.PAYMENTS_RECONCILE)
  getReconciliation(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.get(id);
  }

  @Post('reconciliations') @RequirePermissions(P.PAYMENTS_RECONCILE)
  reconcile(@Body() dto: ReconcileDto, @CurrentUser() u: SessionUser) {
    return this.reconciliation.reconcile(dto.from, dto.to, u);
  }
}

/**
 * Daraja result callbacks (B2C / B2B results, queue timeouts, status query
 * and reversal results). Public: Daraja sends no credentials, so the secret
 * token in the path (and optionally the source IP) identify it; rate-limited
 * with the other callbacks; CSRF does not apply. Always acknowledged once the
 * token is right, so Daraja does not resend; processing is idempotent.
 */
@ApiTags('payments')
@Controller('callbacks/mpesa-payouts')
export class MpesaPayoutCallbackController {
  constructor(private readonly payouts: MpesaPayoutsService) {}

  private static readonly ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

  @Public() @Post('result/:token') @HttpCode(200)
  async result(@Param('token') token: string, @Body() body: Record<string, unknown>, @Ip() ip: string) {
    this.payouts.assertCallback(token, ip);
    await this.payouts.applyCallback('result', body);
    return MpesaPayoutCallbackController.ACK;
  }

  @Public() @Post('timeout/:token') @HttpCode(200)
  async timeout(@Param('token') token: string, @Body() body: Record<string, unknown>, @Ip() ip: string) {
    this.payouts.assertCallback(token, ip);
    await this.payouts.applyCallback('timeout', body);
    return MpesaPayoutCallbackController.ACK;
  }

  @Public() @Post('status/:token/:id') @HttpCode(200)
  async status(@Param('token') token: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Ip() ip: string) {
    this.payouts.assertCallback(token, ip);
    await this.payouts.statusResult(id, body);
    return MpesaPayoutCallbackController.ACK;
  }

  @Public() @Post('reversal/:token/:id') @HttpCode(200)
  async reversal(@Param('token') token: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Ip() ip: string) {
    this.payouts.assertCallback(token, ip);
    await this.payouts.reversalResult(id, body);
    return MpesaPayoutCallbackController.ACK;
  }
}

/** Supplier payments (vouchers, approvals, release), M-PESA payouts behind a PaymentGateway, and reconciliation. */
@Module({
  imports: [TypeOrmModule.forFeature([PaymentVoucher, PaymentVoucherLine, MpesaPayout, MpesaStatementLine, PaymentReconciliation]), NumberingModule, JobsModule],
  controllers: [PaymentVouchersController, PaymentsController, MpesaPayoutCallbackController],
  providers: [PaymentsService, MpesaPayoutsService, PaymentReconciliationService],
  exports: [PaymentsService, MpesaPayoutsService],
})
export class PaymentsModule {}

import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { FinanceModule } from '../finance/finance.module';
import { JobsModule } from '../jobs/jobs.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PaymentsModule } from '../payments/payments.module';
import {
  CountDto,
  DisburseDto,
  FloatDto,
  PettyCashDto,
  PettyCashQueryDto,
  PettyReasonDto,
  ReceiveDto,
  ReplenishmentDto,
  ResolvePettyCashDto,
  RetirementDto,
  StatementQueryDto,
  VerifyRetirementDto,
} from './petty-cash.dto';
import { PettyCashCount, PettyCashFloat, PettyCashReplenishment, PettyCashRequest, PettyCashRetirementLine, PettyCashTransaction } from './petty-cash.entities';
import { PettyCashService } from './petty-cash.service';

const P = Permissions;
const ANY_PETTY = [P.PETTY_CASH_REQUEST, P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE] as const;

@ApiTags('petty-cash')
@Controller('petty-cash')
export class PettyCashController {
  constructor(private readonly petty: PettyCashService) {}

  // ---------------------------------------------------------------- floats

  @Get('floats') @RequireAnyPermission(...ANY_PETTY)
  floats(@CurrentUser() u: SessionUser) {
    return this.petty.floats(u);
  }

  @Post('floats') @RequirePermissions(P.PETTY_CASH_MANAGE)
  createFloat(@Body() dto: FloatDto) {
    return this.petty.saveFloat(dto);
  }

  @Put('floats/:id') @RequirePermissions(P.PETTY_CASH_MANAGE)
  updateFloat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FloatDto) {
    return this.petty.saveFloat(dto, id);
  }

  /** Cash book: opening, movements by type, closing, counts and variances. */
  @Get('floats/:id/statement') @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  statement(@Param('id', ParseUUIDPipe) id: string, @Query() q: StatementQueryDto) {
    return this.petty.statement(id, q.from, q.to);
  }

  @Post('floats/:id/counts') @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  count(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CountDto, @CurrentUser() u: SessionUser) {
    return this.petty.count(id, dto, u);
  }

  // ---------------------------------------------------------------- replenishment

  @Get('replenishments') @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  replenishments(@Query('floatId') floatId?: string) {
    return this.petty.replenishments(floatId);
  }

  @Get('replenishments/:id') @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  replenishment(@Param('id', ParseUUIDPipe) id: string) {
    return this.petty.getReplenishment(id);
  }

  /** Top-up request (goes for approval at once). */
  @Post('replenishments') @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  createReplenishment(@Body() dto: ReplenishmentDto, @CurrentUser() u: SessionUser) {
    return this.petty.createReplenishment(dto, u);
  }

  @Post('replenishments/:id/submit') @HttpCode(200) @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  submitReplenishment(@Param('id', ParseUUIDPipe) id: string) {
    return this.petty.submitReplenishment(id);
  }

  /** The custodian receives the approved cash into the float. */
  @Post('replenishments/:id/receive') @HttpCode(200) @RequirePermissions(P.PETTY_CASH_DISBURSE)
  receive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveDto, @CurrentUser() u: SessionUser) {
    return this.petty.receiveReplenishment(id, dto.reference, u);
  }

  @Post('replenishments/:id/cancel') @HttpCode(200) @RequireAnyPermission(P.PETTY_CASH_DISBURSE, P.PETTY_CASH_MANAGE)
  cancelReplenishment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.petty.cancelReplenishment(id, u);
  }

  // ---------------------------------------------------------------- requests

  /** ?scope=mine|custodian|all, ?status=, ?floatId=, ?kind=, ?review=true */
  @Get('requests') @RequireAnyPermission(...ANY_PETTY)
  list(@Query() q: PettyCashQueryDto, @CurrentUser() u: SessionUser) {
    return this.petty.list(q, u);
  }

  @Get('requests/:id') @RequirePermissions()
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.petty.get(id, u);
  }

  @Get('requests/:id/pdf') @RequirePermissions()
  async pdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.petty.renderPdf(id, u);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"`);
    return new StreamableFile(r.pdf);
  }

  @Post('requests') @RequirePermissions(P.PETTY_CASH_REQUEST)
  create(@Body() dto: PettyCashDto, @CurrentUser() u: SessionUser) {
    return this.petty.create(dto, u);
  }

  @Put('requests/:id') @RequirePermissions(P.PETTY_CASH_REQUEST)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PettyCashDto, @CurrentUser() u: SessionUser) {
    return this.petty.update(id, dto, u);
  }

  @Post('requests/:id/submit') @HttpCode(200) @RequirePermissions(P.PETTY_CASH_REQUEST)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.petty.submit(id, u);
  }

  /** The custodian pays (cash now, or M-PESA) once every approval level is complete. */
  @Post('requests/:id/disburse') @HttpCode(200) @RequirePermissions(P.PETTY_CASH_DISBURSE)
  disburse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DisburseDto, @CurrentUser() u: SessionUser) {
    return this.petty.disburse(id, dto, u);
  }

  /** The payee confirms receipt. */
  @Post('requests/:id/acknowledge') @HttpCode(200) @RequirePermissions()
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.petty.acknowledge(id, u);
  }

  @Post('requests/:id/retirement') @HttpCode(200) @RequirePermissions(P.PETTY_CASH_REQUEST)
  retire(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RetirementDto, @CurrentUser() u: SessionUser) {
    return this.petty.submitRetirement(id, dto, u);
  }

  @Post('requests/:id/retirement/verify') @HttpCode(200) @RequirePermissions(P.PETTY_CASH_DISBURSE)
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyRetirementDto, @CurrentUser() u: SessionUser) {
    return this.petty.verifyRetirement(id, dto, u);
  }

  @Post('requests/:id/resolve') @HttpCode(200) @RequireAnyPermission(P.PETTY_CASH_MANAGE, P.PAYMENTS_RECONCILE)
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolvePettyCashDto, @CurrentUser() u: SessionUser) {
    return this.petty.resolve(id, dto, u);
  }

  @Post('requests/:id/reverse') @HttpCode(200) @RequireAnyPermission(P.PETTY_CASH_MANAGE, P.PAYMENTS_RELEASE)
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PettyReasonDto, @CurrentUser() u: SessionUser) {
    return this.petty.reverse(id, dto.reason, u);
  }

  @Post('requests/:id/cancel') @HttpCode(200) @RequireAnyPermission(...ANY_PETTY)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PettyReasonDto, @CurrentUser() u: SessionUser) {
    return this.petty.cancel(id, dto.reason, u);
  }
}

/** Petty cash: floats, requests and advances, disbursement (cash / M-PESA), retirement, replenishment and counts. */
@Module({
  imports: [
    TypeOrmModule.forFeature([PettyCashFloat, PettyCashRequest, PettyCashRetirementLine, PettyCashTransaction, PettyCashReplenishment, PettyCashCount]),
    NumberingModule,
    JobsModule,
    FinanceModule,
    PaymentsModule,
  ],
  controllers: [PettyCashController],
  providers: [PettyCashService],
  exports: [PettyCashService],
})
export class PettyCashModule {}

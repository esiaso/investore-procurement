import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { CancelDto, ConsolidateDto, HandoverAckDto, HandoverDto, HandoverOtpDto, HandoverQueryDto, QueueQueryDto, StaffRequisitionDto, StaffRequisitionQueryDto } from './staff-requisitions.dto';
import { HandoversService } from './handovers.service';
import { StaffRequisitionsService } from './staff-requisitions.service';

const P = Permissions;

@ApiTags('staff-requisitions')
@Controller('staff-requisitions')
export class StaffRequisitionsController {
  constructor(private readonly reqs: StaffRequisitionsService) {}

  /** scope=mine (default), department, or all (requisitions.read_all). */
  @Get() @RequirePermissions()
  list(@Query() q: StaffRequisitionQueryDto, @CurrentUser() u: SessionUser) {
    return this.reqs.list(q, u);
  }

  /** Approved non-stock lines waiting to be put on a purchase requisition. */
  @Get('queue') @RequirePermissions(P.STAFF_REQUISITION_READ_ALL)
  queue(@Query() q: QueueQueryDto) {
    return this.reqs.queue(q);
  }

  /** Consolidates queue lines (any departments) into one draft purchase requisition. */
  @Post('consolidate') @RequirePermissions(P.PURCHASING_CONSOLIDATE)
  consolidate(@Body() dto: ConsolidateDto, @CurrentUser() u: SessionUser) {
    return this.reqs.consolidate(dto, u);
  }

  @Post() @RequirePermissions(P.STAFF_REQUISITION_CREATE)
  create(@Body() dto: StaffRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.reqs.create(dto, u);
  }

  @Get(':id') @RequirePermissions()
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.reqs.get(id, u);
  }

  @Put(':id') @RequirePermissions(P.STAFF_REQUISITION_CREATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffRequisitionDto, @CurrentUser() u: SessionUser) {
    return this.reqs.update(id, dto, u);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(P.STAFF_REQUISITION_CREATE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.reqs.submit(id, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions()
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto, @CurrentUser() u: SessionUser) {
    return this.reqs.cancel(id, dto.reason, u);
  }

  @Get(':id/pdf') @RequirePermissions()
  async pdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const body = await this.reqs.renderPdf(id, u);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="requisition-${id}.pdf"`);
    return new StreamableFile(body);
  }
}

const ip = (req: Request) => req.ip ?? undefined;

/** Delivery to the final user: hand-over of received non-stock goods, acknowledged in the app or with a one-time code. */
@ApiTags('handovers')
@Controller('handovers')
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  /** ?requisitionId=, ?mine=true (waiting for my confirmation), ?status= */
  @Get() @RequirePermissions()
  list(@Query() q: HandoverQueryDto, @CurrentUser() u: SessionUser) {
    return this.handovers.list(q, u);
  }

  @Get(':id') @RequirePermissions()
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.handovers.get(id, u);
  }

  @Post() @RequirePermissions(P.PURCHASING_HANDOVER)
  create(@Body() dto: HandoverDto, @CurrentUser() u: SessionUser) {
    return this.handovers.create(dto, u);
  }

  /** The receiver confirms they have the items. */
  @Post(':id/acknowledge') @HttpCode(200) @RequirePermissions()
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HandoverAckDto, @CurrentUser() u: SessionUser, @Req() req: Request) {
    return this.handovers.acknowledge(id, dto.comment, u, ip(req));
  }

  /** Sends the receiver a one-time code (hand-over at the counter). */
  @Post(':id/otp') @HttpCode(200) @RequirePermissions(P.PURCHASING_HANDOVER)
  sendOtp(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.handovers.sendOtp(id, u);
  }

  /** The officer enters the code the receiver gives them. */
  @Post(':id/otp/verify') @HttpCode(200) @RequirePermissions(P.PURCHASING_HANDOVER)
  verifyOtp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HandoverOtpDto, @CurrentUser() u: SessionUser, @Req() req: Request) {
    return this.handovers.verifyOtp(id, dto.code, u, ip(req));
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.PURCHASING_HANDOVER)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.handovers.cancel(id, u);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { CancelDto, ConsolidateDto, QueueQueryDto, StaffRequisitionDto, StaffRequisitionQueryDto } from './staff-requisitions.dto';
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

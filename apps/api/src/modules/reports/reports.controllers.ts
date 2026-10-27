import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, ReportFormat, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { DashboardService } from './dashboard.service';
import { DocumentsService } from './documents.service';
import { DocumentQueryDto, ExpiringQueryDto, ScheduleDto } from './reports.dto';
import { ReportsService } from './reports.service';

const P = Permissions;

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Reports this user may run, with their filters and columns. */
  @Get() @RequirePermissions()
  catalog(@CurrentUser() u: SessionUser) {
    return this.reports.catalog(u);
  }

  @Get('schedules') @RequirePermissions(P.REPORTS_SCHEDULE)
  schedules(@CurrentUser() u: SessionUser) {
    return this.reports.schedules(u);
  }

  @Post('schedules') @RequirePermissions(P.REPORTS_SCHEDULE)
  createSchedule(@Body() dto: ScheduleDto, @CurrentUser() u: SessionUser) {
    return this.reports.saveSchedule(null, dto, u);
  }

  @Put('schedules/:id') @RequirePermissions(P.REPORTS_SCHEDULE)
  updateSchedule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleDto, @CurrentUser() u: SessionUser) {
    return this.reports.saveSchedule(id, dto, u);
  }

  @Delete('schedules/:id') @HttpCode(204) @RequirePermissions(P.REPORTS_SCHEDULE)
  deleteSchedule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.reports.deleteSchedule(id, u);
  }

  /** Runs the schedule now (emails it) without waiting for its time. */
  @Post('schedules/:id/send') @HttpCode(200) @RequirePermissions(P.REPORTS_SCHEDULE)
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.reports.sendSchedule(id, u);
  }

  /** Filters as query parameters (from, to, storeId, categoryId, itemId, supplierId, departmentId, groupBy, days, limit, status). */
  @Get(':key') @RequirePermissions()
  run(@Param('key') key: string, @Query() q: Record<string, string>, @CurrentUser() u: SessionUser) {
    return this.reports.run(key, q, u);
  }

  /** ?format=csv|xlsx|pdf plus the report's filters. */
  @Get(':key/export') @RequirePermissions()
  async export(@Param('key') key: string, @Query() q: Record<string, string>, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const { format, ...filters } = q;
    const out = await this.reports.export(key, filters, format as ReportFormat, u);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body);
  }
}

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Tiles and trends for the user's role and stores. */
  @Get() @RequirePermissions()
  get(@CurrentUser() u: SessionUser) {
    return this.dashboard.get(u);
  }
}

@ApiTags('documents')
@Controller('documents/register')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get() @RequirePermissions(P.DOCUMENTS_READ)
  list(@Query() q: DocumentQueryDto, @CurrentUser() u: SessionUser) {
    return this.documents.list(q, u);
  }

  @Get('facets') @RequirePermissions(P.DOCUMENTS_READ)
  facets(@CurrentUser() u: SessionUser) {
    return this.documents.facets(u);
  }

  /** Supplier documents expired or expiring within `days` (default 60). */
  @Get('expiring') @RequirePermissions(P.DOCUMENTS_READ)
  expiring(@Query() q: ExpiringQueryDto) {
    return this.documents.expiring(q.days ?? 60);
  }
}

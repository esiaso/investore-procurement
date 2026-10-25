import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, ReadingSource, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { UPLOAD_HARD_LIMIT } from '../files/files.module';
import { ColdChainService } from './cold-chain.service';
import { ComplaintsService } from './complaints.service';
import { DisposalsService } from './disposals.service';
import { HoldsService } from './holds.service';
import {
  CloseRecallDto,
  CompleteDisposalDto,
  ComplaintDto,
  ComplaintQueryDto,
  ComplaintUpdateDto,
  CsvImportDto,
  DecisionDto,
  DisposalCommitteeDto,
  DisposalDto,
  DisposalUpdateDto,
  ExcursionQueryDto,
  HoldDto,
  HoldQueryDto,
  ReadingQueryDto,
  ReadingsDto,
  RecallDto,
  RecallReturnDto,
  SignDisposalDto,
  StatusQueryDto,
  StorageUnitDto,
} from './quality.dto';
import { RecallsService } from './recalls.service';

const P = Permissions;
const pdfName = (res: Response, name: string) => res.setHeader('Content-Disposition', `inline; filename="${name.replace(/\//g, '-')}.pdf"`);

@ApiTags('quality')
@Controller('quality/holds')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Get() @RequireAnyPermission(P.QUALITY_READ, P.QUALITY_RELEASE)
  list(@Query() q: HoldQueryDto) {
    return this.holds.list(q);
  }

  @Get(':id') @RequireAnyPermission(P.QUALITY_READ, P.QUALITY_RELEASE)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.holds.get(id);
  }

  /** Quarantine a batch pending inspection or a quality investigation. */
  @Post() @RequirePermissions(P.QUALITY_MANAGE)
  create(@Body() dto: HoldDto, @CurrentUser() u: SessionUser) {
    return this.holds.create(dto, u);
  }

  @Post(':id/release') @HttpCode(200) @RequirePermissions(P.QUALITY_RELEASE)
  release(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() u: SessionUser) {
    return this.holds.decide(id, 'RELEASE', dto.note, u);
  }

  /** Reject: the stock is unusable; a draft disposal is raised. */
  @Post(':id/reject') @HttpCode(200) @RequirePermissions(P.QUALITY_RELEASE)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() u: SessionUser) {
    return this.holds.decide(id, 'REJECT', dto.note, u);
  }
}

@ApiTags('cold chain')
@Controller('cold-chain')
export class ColdChainController {
  constructor(private readonly cold: ColdChainService) {}

  @Get('units') @RequireAnyPermission(P.QUALITY_READ, P.INVENTORY_HANDLE_COLD_CHAIN)
  units(@Query('storeId') storeId?: string) {
    return this.cold.units(storeId);
  }

  @Post('units') @RequirePermissions(P.QUALITY_MANAGE)
  createUnit(@Body() dto: StorageUnitDto) {
    return this.cold.saveUnit(null, dto);
  }

  @Put('units/:id') @RequirePermissions(P.QUALITY_MANAGE)
  updateUnit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StorageUnitDto) {
    return this.cold.saveUnit(id, dto);
  }

  @Get('units/:id/readings') @RequireAnyPermission(P.QUALITY_READ, P.INVENTORY_HANDLE_COLD_CHAIN)
  readings(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReadingQueryDto) {
    return this.cold.readings(id, q.from, q.to);
  }

  /** Manual temperature log entries (twice-daily fridge checks). */
  @Post('units/:id/readings') @RequireAnyPermission(P.QUALITY_MANAGE, P.INVENTORY_HANDLE_COLD_CHAIN)
  record(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReadingsDto, @CurrentUser() u: SessionUser) {
    return this.cold.record(id, dto.readings.map((r) => ({ at: r.recordedAt ? new Date(r.recordedAt) : new Date(), t: r.temperatureC, note: r.note })), ReadingSource.MANUAL, u);
  }

  /** Data-logger export (CSV: timestamp, temperature, optional unit / logger column). JSON { csv } or a file upload. */
  @Post('readings/import') @HttpCode(200) @RequireAnyPermission(P.QUALITY_MANAGE, P.INVENTORY_HANDLE_COLD_CHAIN)
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT } }))
  import(@Body() dto: CsvImportDto, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: SessionUser) {
    const csv = file ? file.buffer.toString('utf8') : dto.csv;
    if (!csv) throw new BadRequestException('Upload the logger CSV');
    return this.cold.importCsv(dto.unitId ?? null, csv, u);
  }

  @Get('excursions') @RequireAnyPermission(P.QUALITY_READ, P.INVENTORY_HANDLE_COLD_CHAIN)
  excursions(@Query() q: ExcursionQueryDto) {
    return this.cold.excursions(q);
  }

  @Get('excursions/:id') @RequireAnyPermission(P.QUALITY_READ, P.INVENTORY_HANDLE_COLD_CHAIN)
  excursion(@Param('id', ParseUUIDPipe) id: string) {
    return this.cold.excursion(id);
  }

  @Post('excursions/:id/review') @HttpCode(200) @RequirePermissions(P.QUALITY_RELEASE)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() u: SessionUser) {
    return this.cold.review(id, dto.note, u);
  }
}

@ApiTags('quality')
@Controller('quality/complaints')
export class ComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Get() @RequirePermissions(P.QUALITY_READ)
  list(@Query() q: ComplaintQueryDto) {
    return this.complaints.list(q);
  }

  @Get(':id') @RequirePermissions(P.QUALITY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.complaints.get(id);
  }

  /** Anyone handling stock or patients may report a quality problem. */
  @Post() @RequireAnyPermission(P.QUALITY_MANAGE, P.PHARMACY_READ, P.INVENTORY_READ)
  create(@Body() dto: ComplaintDto, @CurrentUser() u: SessionUser) {
    return this.complaints.create({ ...dto, holdStock: dto.holdStock && u.permissions.includes(P.QUALITY_MANAGE) }, u);
  }

  @Put(':id') @RequirePermissions(P.QUALITY_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplaintUpdateDto) {
    return this.complaints.update(id, dto);
  }

  @Get(':id/pdf') @RequirePermissions(P.QUALITY_READ) @Header('Content-Type', 'application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { number, pdf } = await this.complaints.renderPdf(id);
    pdfName(res, number);
    return new StreamableFile(pdf);
  }
}

@ApiTags('recalls')
@Controller('recalls')
export class RecallsController {
  constructor(private readonly recalls: RecallsService) {}

  @Get() @RequireAnyPermission(P.QUALITY_READ, P.RECALLS_MANAGE)
  list(@Query() q: StatusQueryDto) {
    return this.recalls.list(q);
  }

  @Get('dashboard') @RequireAnyPermission(P.QUALITY_READ, P.RECALLS_MANAGE)
  dashboard() {
    return this.recalls.dashboard();
  }

  @Get(':id') @RequireAnyPermission(P.QUALITY_READ, P.RECALLS_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.recalls.get(id);
  }

  /** Every store holding the batches and every issue, dispense, sale and transfer of them, with patients. */
  @Get(':id/trace') @RequireAnyPermission(P.QUALITY_READ, P.RECALLS_MANAGE)
  trace(@Param('id', ParseUUIDPipe) id: string) {
    return this.recalls.trace(id);
  }

  /** Recall notice: every affected batch is quarantined in every store. */
  @Post() @RequirePermissions(P.RECALLS_MANAGE)
  create(@Body() dto: RecallDto, @CurrentUser() u: SessionUser) {
    return this.recalls.create(dto, u);
  }

  @Post(':id/returns') @RequirePermissions(P.RECALLS_MANAGE)
  recordReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecallReturnDto, @CurrentUser() u: SessionUser) {
    return this.recalls.recordReturn(id, dto, u);
  }

  @Post(':id/close') @HttpCode(200) @RequirePermissions(P.RECALLS_MANAGE)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseRecallDto, @CurrentUser() u: SessionUser) {
    return this.recalls.close(id, dto, u);
  }
}

@ApiTags('disposals')
@Controller('disposals')
export class DisposalsController {
  constructor(private readonly disposals: DisposalsService) {}

  @Get() @RequireAnyPermission(P.DISPOSALS_MANAGE, P.INVENTORY_READ)
  list(@Query() q: StatusQueryDto) {
    return this.disposals.list(q);
  }

  /** Users who may sit on a disposal committee (disposals.manage). */
  @Get('committee-candidates') @RequirePermissions(P.DISPOSALS_MANAGE)
  candidates() {
    return this.disposals.candidates();
  }

  @Get(':id') @RequireAnyPermission(P.DISPOSALS_MANAGE, P.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.disposals.get(id);
  }

  @Post() @RequirePermissions(P.DISPOSALS_MANAGE)
  create(@Body() dto: DisposalDto, @CurrentUser() u: SessionUser) {
    return this.disposals.create(dto, u);
  }

  @Put(':id') @RequirePermissions(P.DISPOSALS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DisposalUpdateDto, @CurrentUser() u: SessionUser) {
    return this.disposals.update(id, dto, u);
  }

  @Put(':id/committee') @RequirePermissions(P.DISPOSALS_MANAGE)
  committee(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DisposalCommitteeDto) {
    return this.disposals.committee(id, dto.members);
  }

  @Post(':id/sign') @HttpCode(200) @RequirePermissions(P.DISPOSALS_MANAGE)
  sign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SignDisposalDto, @CurrentUser() u: SessionUser) {
    return this.disposals.sign(id, u, dto.comment);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(P.DISPOSALS_MANAGE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.disposals.submit(id, u);
  }

  @Post(':id/complete') @HttpCode(200) @RequirePermissions(P.DISPOSALS_MANAGE)
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteDisposalDto, @CurrentUser() u: SessionUser) {
    return this.disposals.complete(id, dto, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.DISPOSALS_MANAGE)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.disposals.cancel(id);
  }

  @Get(':id/certificate') @RequireAnyPermission(P.DISPOSALS_MANAGE, P.INVENTORY_READ) @Header('Content-Type', 'application/pdf')
  async certificate(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { number, body } = await this.disposals.certificate(id);
    pdfName(res, `${number}-certificate`);
    return new StreamableFile(body);
  }
}

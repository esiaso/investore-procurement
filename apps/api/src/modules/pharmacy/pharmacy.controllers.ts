import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions, StoreScoped } from '../../common/decorators';
import { toCsv } from '../../common/csv';
import { DrugInteractionsService } from './drug-interactions.service';
import {
  AlertReportQueryDto,
  CancelLinesDto,
  CreatePrescriptionDto,
  DispenseDto,
  DispenseReturnDto,
  InteractionDto,
  InteractionImportDto,
  InteractionQueryDto,
  OverrideDto,
  PatientDto,
  PatientQueryDto,
  WardSupplyDto,
  WardSupplyQueryDto,
  WorklistQueryDto,
} from './pharmacy.dto';
import { PharmacyService } from './pharmacy.service';

const P = Permissions;

@ApiTags('pharmacy')
@Controller('patients')
export class PatientsController {
  constructor(private readonly pharmacy: PharmacyService) {}

  @Get() @RequireAnyPermission(P.PATIENTS_READ, P.PHARMACY_READ)
  list(@Query() q: PatientQueryDto) {
    return this.pharmacy.patients(q);
  }

  @Get(':id') @RequireAnyPermission(P.PATIENTS_READ, P.PHARMACY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.pharmacy.patient(id);
  }

  @Post() @RequirePermissions(P.PATIENTS_MANAGE)
  create(@Body() dto: PatientDto) {
    return this.pharmacy.savePatient(null, dto);
  }

  @Put(':id') @RequirePermissions(P.PATIENTS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PatientDto) {
    return this.pharmacy.savePatient(id, dto);
  }
}

@ApiTags('pharmacy')
@Controller('pharmacy')
export class PharmacyController {
  constructor(
    private readonly pharmacy: PharmacyService,
    private readonly interactions: DrugInteractionsService,
  ) {}

  /** Outlet worklist: open prescriptions oldest first, with alert badges and waiting time. */
  @Get('prescriptions') @RequirePermissions(P.PHARMACY_READ) @StoreScoped('query.storeId')
  worklist(@Query() q: WorklistQueryDto) {
    return this.pharmacy.worklist(q);
  }

  @Post('prescriptions') @RequirePermissions(P.PHARMACY_PRESCRIPTION) @StoreScoped('body.storeId')
  create(@Body() dto: CreatePrescriptionDto) {
    return this.pharmacy.createPrescription(dto);
  }

  @Get('prescriptions/:id') @RequirePermissions(P.PHARMACY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.pharmacy.get(id);
  }

  /** Brands of each prescribed generic with stock at the outlet. */
  @Get('prescriptions/:id/options') @RequirePermissions(P.PHARMACY_READ)
  options(@Param('id', ParseUUIDPipe) id: string) {
    return this.pharmacy.options(id);
  }

  @Post('prescriptions/:id/check') @HttpCode(200) @RequirePermissions(P.PHARMACY_READ)
  recheck(@Param('id', ParseUUIDPipe) id: string) {
    return this.pharmacy.recheck(id);
  }

  @Post('prescriptions/:id/verify') @HttpCode(200) @RequirePermissions(P.PHARMACY_VERIFY)
  verify(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.pharmacy.verify(id, u);
  }

  /** Pharmacist override of a blocking alert (reason required, logged). */
  @Post('alerts/:id/override') @RequirePermissions(P.PHARMACY_VERIFY)
  override(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideDto, @CurrentUser() u: SessionUser) {
    return this.pharmacy.override(id, dto.reason, u);
  }

  @Post('prescriptions/:id/dispense') @RequirePermissions(P.PHARMACY_DISPENSE)
  dispense(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispenseDto, @CurrentUser() u: SessionUser) {
    return this.pharmacy.dispense(id, dto, u);
  }

  @Post('prescriptions/:id/cancel-lines') @HttpCode(200) @RequirePermissions(P.PHARMACY_DISPENSE)
  cancelLines(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelLinesDto) {
    return this.pharmacy.cancelLines(id, dto);
  }

  /** Unused medicines brought back: credit note + restock. */
  @Post('dispenses/:id/returns') @RequirePermissions(P.PHARMACY_DISPENSE)
  returnDispense(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispenseReturnDto, @CurrentUser() u: SessionUser) {
    return this.pharmacy.returnDispense(id, dto, u);
  }

  /** Inpatient daily / unit-dose lines due today at an outlet (optionally one ward). */
  @Get('ward-supply') @RequirePermissions(P.PHARMACY_READ) @StoreScoped('query.storeId')
  wardSupplyList(@Query() q: WardSupplyQueryDto) {
    return this.pharmacy.wardSupplyList(q);
  }

  /** Dispenses a ward round (one dispense per prescription); returns the result per prescription. */
  @Post('ward-supply') @HttpCode(200) @RequirePermissions(P.PHARMACY_DISPENSE) @StoreScoped('body.storeId')
  wardSupply(@Body() dto: WardSupplyDto, @CurrentUser() u: SessionUser) {
    return this.pharmacy.wardSupply(dto, u);
  }

  @Get('interactions') @RequirePermissions(P.PHARMACY_READ)
  listInteractions(@Query() q: InteractionQueryDto) {
    return this.interactions.list(q);
  }

  @Post('interactions') @RequirePermissions(P.PHARMACY_INTERACTIONS)
  createInteraction(@Body() dto: InteractionDto) {
    return this.interactions.save(null, dto);
  }

  @Put('interactions/:id') @RequirePermissions(P.PHARMACY_INTERACTIONS)
  updateInteraction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: InteractionDto) {
    return this.interactions.save(id, dto);
  }

  @Post('interactions/import') @HttpCode(200) @RequirePermissions(P.PHARMACY_INTERACTIONS)
  importInteractions(@Body() dto: InteractionImportDto) {
    return this.interactions.import(dto);
  }

  /** Alerts raised vs overridden (format=csv for the override log). */
  @Get('reports/alerts') @RequirePermissions(P.PHARMACY_READ) @StoreScoped('query.storeId')
  async alertReport(@Query() q: AlertReportQueryDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.pharmacy.alertReport(q);
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="interaction-overrides.csv"');
      return toCsv(r.overrides);
    }
    return r;
  }

  @Get('reports/turnaround') @RequirePermissions(P.PHARMACY_READ) @StoreScoped('query.storeId')
  turnaround(@Query() q: AlertReportQueryDto) {
    return this.pharmacy.turnaround(q);
  }
}

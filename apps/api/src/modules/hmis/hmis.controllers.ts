import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { API_KEY_HEADER } from '../billing/api-clients.service';
import type { FhirResource } from './fhir';
import { HmisInboundService } from './hmis-inbound.service';
import { HMIS_ASSUMPTIONS } from './hmis-spec';
import {
  ChargeQueryDto,
  ConnectionDto,
  EncounterQueryDto,
  ImportPatientDto,
  MappingDto,
  MappingQueryDto,
  MessageQueryDto,
  PatientSearchDto,
  ReverseChargeDto,
  WardConsumptionDto,
} from './hmis.dto';
import { HmisService } from './hmis.service';
import { PatientChargesService } from './patient-charges.service';

const P = Permissions;
/** API-key scope an HMIS client needs for the inbound endpoints. */
export const HMIS_SCOPE = 'hmis';

@ApiTags('hmis')
@Controller('hmis')
export class HmisController {
  constructor(
    private readonly hmis: HmisService,
    private readonly inbound: HmisInboundService,
  ) {}

  /** Integration dashboard: connection, queue, failures, unmapped drug codes, last 24 h. */
  @Get('dashboard') @RequirePermissions(P.HMIS_READ)
  dashboard() {
    return this.hmis.dashboard();
  }

  @Get('assumptions') @RequirePermissions(P.HMIS_READ)
  assumptions() {
    return HMIS_ASSUMPTIONS;
  }

  @Get('connection') @RequirePermissions(P.HMIS_READ)
  connection() {
    return this.hmis.getConnection();
  }

  @Put('connection') @RequirePermissions(P.HMIS_MANAGE)
  saveConnection(@Body() dto: ConnectionDto) {
    return this.hmis.saveConnection(dto);
  }

  @Post('connection/test') @HttpCode(200) @RequirePermissions(P.HMIS_MANAGE)
  test() {
    return this.hmis.test();
  }

  @Get('mappings') @RequirePermissions(P.HMIS_READ)
  mappings(@Query() q: MappingQueryDto) {
    return this.hmis.mappings(q.kind);
  }

  @Put('mappings') @RequirePermissions(P.HMIS_MANAGE)
  saveMapping(@Body() dto: MappingDto) {
    return this.hmis.saveMapping(dto);
  }

  @Delete('mappings/:id') @HttpCode(204) @RequirePermissions(P.HMIS_MANAGE)
  deleteMapping(@Param('id', ParseUUIDPipe) id: string) {
    return this.hmis.deleteMapping(id);
  }

  /** Every message in and out (filters: direction, type, status, patient, dates, search). */
  @Get('messages') @RequirePermissions(P.HMIS_READ)
  messages(@Query() q: MessageQueryDto) {
    return this.hmis.messages(q);
  }

  @Get('messages/:id') @RequirePermissions(P.HMIS_READ)
  message(@Param('id', ParseUUIDPipe) id: string) {
    return this.hmis.message(id);
  }

  /** Resend (outbound) or process again (inbound, e.g. after mapping a drug code). */
  @Post('messages/:id/reprocess') @HttpCode(200) @RequirePermissions(P.HMIS_MANAGE)
  reprocess(@Param('id', ParseUUIDPipe) id: string) {
    return this.hmis.reprocess(id);
  }

  /** Poll the HMIS for orders and send what is queued, now. */
  @Post('sync') @HttpCode(200) @RequirePermissions(P.HMIS_MANAGE)
  async sync() {
    return { poll: await this.inbound.poll(), dispatch: await this.hmis.dispatch() };
  }

  /** Looks a patient up in the HMIS. */
  @Get('patients/search') @RequireAnyPermission(P.PATIENTS_READ, P.HMIS_READ)
  search(@Query() q: PatientSearchDto) {
    return this.inbound.searchPatients(q.q);
  }

  /** Brings an HMIS patient (with allergies) into the cache, or refreshes it. */
  @Post('patients/import') @RequireAnyPermission(P.PATIENTS_MANAGE, P.HMIS_MANAGE)
  importPatient(@Body() dto: ImportPatientDto) {
    return this.inbound.importPatient(dto.externalId);
  }

  @Get('encounters') @RequireAnyPermission(P.HMIS_READ, P.PATIENTS_READ)
  encounters(@Query() q: EncounterQueryDto) {
    return this.hmis.encounters(q);
  }

  @Get('encounters/:id') @RequireAnyPermission(P.HMIS_READ, P.PATIENTS_READ)
  encounter(@Param('id', ParseUUIDPipe) id: string) {
    return this.hmis.encounter(id);
  }
}

@ApiTags('hmis')
@Controller('patient-charges')
export class PatientChargesController {
  constructor(private readonly charges: PatientChargesService) {}

  @Get() @RequireAnyPermission(P.HMIS_READ, P.BILLING_READ, P.PATIENTS_CHARGE)
  list(@Query() q: ChargeQueryDto) {
    return this.charges.list(q);
  }

  /** Ward / theatre stock used on an admitted patient, charged to the encounter. */
  @Post('ward-consumption') @RequirePermissions(P.PATIENTS_CHARGE)
  wardConsumption(@Body() dto: WardConsumptionDto, @CurrentUser() u: SessionUser) {
    return this.charges.wardConsumption(dto, u);
  }

  /** Reverses (part of) a charge posted to the HMIS bill. */
  @Post(':id/reverse') @RequirePermissions(P.PATIENTS_CHARGE)
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseChargeDto, @CurrentUser() u: SessionUser) {
    return this.charges.reverseById(id, dto, u);
  }
}

/**
 * Inbound HMIS endpoints (API key in `x-api-key`, scope "hmis"): FHIR
 * resources or Bundles, or generic REST events. Each record version is
 * processed once; the response lists what happened to each.
 */
@ApiTags('integration')
@ApiHeader({ name: API_KEY_HEADER, required: true })
@Controller('integration/hmis')
export class HmisIntegrationController {
  constructor(private readonly inbound: HmisInboundService) {}

  private assertClient(req: Request) {
    const client = (req as Request & { apiClient?: { scopes: string[] } }).apiClient;
    if (!client) throw new ForbiddenException('Integration endpoints need an API key');
    if (!client.scopes.includes(HMIS_SCOPE)) throw new ForbiddenException(`API key lacks the ${HMIS_SCOPE} scope`);
  }

  @Post('fhir') @HttpCode(200) @RequirePermissions(P.PHARMACY_PRESCRIPTION)
  fhir(@Body() body: FhirResource, @Req() req: Request) {
    this.assertClient(req);
    return this.inbound.receiveFhir(body);
  }

  /** HL7 v2 message (ER7 text) over HTTP; the reply is the HL7 ACK. MLLP: see HL7_MLLP_PORT. */
  @Post('hl7') @HttpCode(200) @Header('Content-Type', 'application/hl7-v2; charset=utf-8') @RequirePermissions(P.PHARMACY_PRESCRIPTION)
  async hl7(@Body() body: string, @Req() req: Request) {
    this.assertClient(req);
    return (await this.inbound.receiveHl7(typeof body === 'string' ? body : '', 'HTTP')).ack;
  }

  @Post('events') @HttpCode(200) @RequirePermissions(P.PHARMACY_PRESCRIPTION)
  events(@Body() body: { type?: string; data?: unknown }, @Req() req: Request) {
    this.assertClient(req);
    return this.inbound.receiveRest(body);
  }
}

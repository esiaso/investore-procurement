import { Body, Controller, Get, Header, HttpCode, Injectable, Module, OnModuleInit, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Response } from 'express';
import { DocumentType, Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions, StoreScoped } from '../../common/decorators';
import { DocumentLinksService } from '../approvals/document-links.service';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import { NumberingModule } from '../numbering/numbering.module';
import { GrnsService } from '../purchasing/grns.service';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { DistributionService } from './distribution.service';
import {
  CertificateDto,
  CertificateQueryDto,
  DispatchRunDto,
  PackDto,
  PickDtoBody,
  PodDto,
  ReasonBody,
  RouteDto,
  RunDto,
  RunQueryDto,
  ShipmentDto,
  ShipmentQueryDto,
  ShipmentUpdateDto,
} from './logistics.dto';
import { DeliveryRoute, DistributionRun, DistributionStop, InboundShipment, InboundShipmentLine, ServiceCertificate, ServiceCertificateLine } from './logistics.entities';
import { ServiceCertificatesService } from './service-certificates.service';
import { ShipmentsService } from './shipments.service';

export const LOGISTICS_ENTITIES = [DeliveryRoute, DistributionRun, DistributionStop, InboundShipment, InboundShipmentLine, ServiceCertificate, ServiceCertificateLine];

const P = Permissions;
const pdf = (res: Response, name: string, body: Buffer) => {
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/\//g, '-')}.pdf"`);
  return new StreamableFile(body);
};

@ApiTags('distribution')
@Controller('distribution')
export class DistributionController {
  constructor(private readonly dist: DistributionService) {}

  @Get('routes') @RequireAnyPermission(P.DISTRIBUTION_MANAGE, P.INVENTORY_READ)
  routes() {
    return this.dist.routes();
  }

  @Post('routes') @RequirePermissions(P.DISTRIBUTION_MANAGE) @StoreScoped('body.fromStoreId')
  createRoute(@Body() dto: RouteDto) {
    return this.dist.saveRoute(null, dto);
  }

  @Put('routes/:id') @RequirePermissions(P.DISTRIBUTION_MANAGE) @StoreScoped('body.fromStoreId')
  updateRoute(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RouteDto) {
    return this.dist.saveRoute(id, dto);
  }

  /** Transfer requests from a store not yet on a run. */
  @Get('pending') @RequirePermissions(P.DISTRIBUTION_MANAGE) @StoreScoped('query.storeId')
  pending(@Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.dist.pending(storeId);
  }

  @Get('runs') @RequireAnyPermission(P.DISTRIBUTION_MANAGE, P.INVENTORY_READ)
  list(@Query() q: RunQueryDto) {
    return this.dist.list(q);
  }

  @Get('runs/:id') @RequireAnyPermission(P.DISTRIBUTION_MANAGE, P.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.dist.get(id);
  }

  @Post('runs') @RequirePermissions(P.DISTRIBUTION_MANAGE)
  create(@Body() dto: RunDto, @CurrentUser() u: SessionUser) {
    return this.dist.create(dto, u);
  }

  /** FEFO picking list (per stop and line: batch, bin, expiry, quantity). */
  @Get('runs/:id/picking-list') @RequirePermissions(P.DISTRIBUTION_MANAGE)
  pickingList(@Param('id', ParseUUIDPipe) id: string) {
    return this.dist.pickingList(id);
  }

  @Post('runs/:id/stops/:stopId/pick') @HttpCode(200) @RequirePermissions(P.DISTRIBUTION_MANAGE, P.INVENTORY_TRANSFER_DISPATCH)
  pick(@Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string, @Body() dto: PickDtoBody, @CurrentUser() u: SessionUser) {
    return this.dist.pick(id, stopId, dto, u);
  }

  @Post('runs/:id/stops/:stopId/pack') @HttpCode(200) @RequirePermissions(P.DISTRIBUTION_MANAGE)
  pack(@Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string, @Body() dto: PackDto, @CurrentUser() u: SessionUser) {
    return this.dist.pack(id, stopId, dto, u);
  }

  /** Every stop's transfer leaves the store with its picks. */
  @Post('runs/:id/dispatch') @HttpCode(200) @RequirePermissions(P.DISTRIBUTION_MANAGE, P.INVENTORY_TRANSFER_DISPATCH)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchRunDto, @CurrentUser() u: SessionUser) {
    return this.dist.dispatch(id, u, dto);
  }

  /** Proof of delivery at a stop; posts the transfer receipt in the receiving store. */
  @Post('runs/:id/stops/:stopId/deliver') @HttpCode(200) @RequirePermissions(P.INVENTORY_TRANSFER_RECEIVE)
  deliver(@Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string, @Body() dto: PodDto, @CurrentUser() u: SessionUser) {
    return this.dist.deliver(id, stopId, dto, u);
  }

  @Post('runs/:id/cancel') @HttpCode(200) @RequirePermissions(P.DISTRIBUTION_MANAGE)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.dist.cancel(id);
  }

  @Get('runs/:id/dispatch-note') @RequireAnyPermission(P.DISTRIBUTION_MANAGE, P.INVENTORY_READ) @Header('Content-Type', 'application/pdf')
  async note(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.dist.dispatchNote(id);
    return pdf(res, `${r.number}-dispatch`, r.pdf);
  }
}

@ApiTags('shipments')
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get() @RequirePermissions(P.PURCHASING_READ)
  list(@Query() q: ShipmentQueryDto) {
    return this.shipments.list(q);
  }

  /** Supplier lead-time history (PO sent → first GRN) and slipped shipments. */
  @Get('lead-times') @RequireAnyPermission(P.PURCHASING_READ, P.SUPPLIERS_PERFORMANCE)
  leadTimes(@Query('supplierId') supplierId?: string) {
    return this.shipments.leadTimes(supplierId);
  }

  @Get(':id') @RequirePermissions(P.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.get(id);
  }

  @Post() @RequireAnyPermission(P.SHIPMENTS_MANAGE, P.PURCHASING_PO)
  create(@Body() dto: ShipmentDto, @CurrentUser() u: SessionUser) {
    return this.shipments.create(dto, u);
  }

  @Put(':id') @RequireAnyPermission(P.SHIPMENTS_MANAGE, P.PURCHASING_PO)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ShipmentUpdateDto) {
    return this.shipments.update(id, dto);
  }

  @Post(':id/cancel') @HttpCode(200) @RequireAnyPermission(P.SHIPMENTS_MANAGE, P.PURCHASING_PO)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonBody) {
    return this.shipments.cancel(id, dto.reason);
  }
}

@ApiTags('service certificates')
@Controller('service-certificates')
export class ServiceCertificatesController {
  constructor(private readonly certs: ServiceCertificatesService) {}

  @Get() @RequirePermissions(P.PURCHASING_READ)
  list(@Query() q: CertificateQueryDto) {
    return this.certs.list(q);
  }

  @Get('open-orders') @RequirePermissions(P.SERVICES_CERTIFY)
  openOrders() {
    return this.certs.openServiceOrders();
  }

  @Get(':id') @RequirePermissions(P.PURCHASING_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.certs.get(id);
  }

  @Post() @RequirePermissions(P.SERVICES_CERTIFY)
  create(@Body() dto: CertificateDto, @CurrentUser() u: SessionUser) {
    return this.certs.create(dto, u);
  }

  /** Posting counts the certified quantities as received (three-way match). */
  @Post(':id/post') @HttpCode(200) @RequirePermissions(P.SERVICES_CERTIFY)
  post(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.certs.post(id, u);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.SERVICES_CERTIFY)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.certs.cancel(id, u);
  }

  @Get(':id/pdf') @RequirePermissions(P.PURCHASING_READ) @Header('Content-Type', 'application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.certs.renderPdf(id);
    return pdf(res, r.number, r.pdf);
  }
}

/** Jobs, GRN hooks and document links for the logistics module. */
@Injectable()
export class LogisticsWiring implements OnModuleInit {
  constructor(
    private readonly grns: GrnsService,
    private readonly shipments: ShipmentsService,
    private readonly certs: ServiceCertificatesService,
    private readonly jobs: JobsService,
    private readonly links: DocumentLinksService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  onModuleInit() {
    this.grns.registerPostHook(async (m, grn, lines) => {
      if (!grn.shipmentId) return;
      await this.shipments.applyReceipt(m, grn.shipmentId, lines.filter((l) => l.poLineId && l.acceptedBaseQty > 0).map((l) => ({ poLineId: l.poLineId!, baseQty: l.acceptedBaseQty })));
    });
    this.certs.register();
    this.jobs.register('shipments.delays', 'Flag inbound shipments past their expected date', () => this.shipments.flagDelays());
    this.jobs.register('suppliers.leadtimes', 'Update suppliers’ observed lead times from receipt history', () => this.shipments.updateObservedLeadTimes());
    for (const type of [DocumentType.SHIPMENT, DocumentType.SERVICE_CERTIFICATE, DocumentType.DISTRIBUTION_RUN]) {
      this.links.registerResolver(type, async (ids) => {
        const table = type === DocumentType.SHIPMENT ? 'inbound_shipment' : type === DocumentType.SERVICE_CERTIFICATE ? 'service_certificate' : 'distribution_run';
        const rows: { id: string; status: string; d: string }[] = await this.ds.query(`SELECT id, status, to_char(created_at, 'YYYY-MM-DD') AS d FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
        return new Map(rows.map((r) => [r.id, { status: r.status, date: r.d }]));
      });
    }
  }
}

/** Distribution to satellite stores, inbound shipments and service completion certificates. */
@Module({
  imports: [TypeOrmModule.forFeature(LOGISTICS_ENTITIES), NumberingModule, InventoryModule, PurchasingModule, JobsModule],
  controllers: [DistributionController, ShipmentsController, ServiceCertificatesController],
  providers: [DistributionService, ShipmentsService, ServiceCertificatesService, LogisticsWiring],
  exports: [ShipmentsService],
})
export class LogisticsModule {}

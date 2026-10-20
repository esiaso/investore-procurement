import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { EtimsAdapterKind, Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ETIMS_ASSUMPTIONS } from './etims-spec';
import { EtimsService, MAPPING_KINDS, MappingKind } from './etims.service';

const P = Permissions;

class EtimsConfigDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ enum: EtimsAdapterKind }) @IsEnum(EtimsAdapterKind) adapter: EtimsAdapterKind;
  @ApiPropertyOptional({ description: 'OSCU: KRA URL; VSCU: local VSCU server; MOCK: mock-etims URL or empty' }) @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;
  @ApiProperty() @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'KRA PIN must look like P051234567X' }) kraPin: string;
  @ApiProperty({ example: '00' }) @Matches(/^\d{2}$/) branchId: string;
  @ApiProperty() @IsString() @MaxLength(100) deviceSerial: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class MappingDto {
  @ApiProperty({ enum: MAPPING_KINDS }) @IsIn(MAPPING_KINDS as unknown as string[]) kind: MappingKind;
  @ApiProperty({ description: 'Tax category code, UoM code, "category:<code>", "item:<code>"' }) @IsString() @MaxLength(100) localKey: string;
  @ApiProperty() @IsString() @MaxLength(20) etimsCode: string;
}

class OutboxQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) kind?: string;
}

class TransmissionQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() outboxId?: string;
}

class PurchaseQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
}

class DecisionDto {
  @ApiProperty() @IsBoolean() accept: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) note?: string;
}

class LinkImportDto {
  @ApiProperty() @IsUUID() itemId: string;
}

@ApiTags('etims')
@Controller('etims')
export class EtimsController {
  constructor(private readonly etims: EtimsService) {}

  /** Where this implementation had to interpret the KRA specification. */
  @Get('assumptions') @RequirePermissions(P.ETIMS_READ)
  assumptions() {
    return ETIMS_ASSUMPTIONS;
  }

  @Get('configs') @RequirePermissions(P.ETIMS_READ)
  configs() {
    return this.etims.configs();
  }

  @Put('configs') @RequirePermissions(P.ETIMS_MANAGE)
  saveConfig(@Body() dto: EtimsConfigDto) {
    return this.etims.saveConfig(dto);
  }

  @Post('configs/:id/initialise') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  initialise(@Param('id', ParseUUIDPipe) id: string) {
    return this.etims.initialise(id);
  }

  @Get('codes/status') @RequirePermissions(P.ETIMS_READ)
  codeStatus() {
    return this.etims.codeStatus();
  }

  @Post('codes/sync') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  syncCodes() {
    return this.etims.syncCodes();
  }

  @Get('codes') @RequirePermissions(P.ETIMS_READ)
  codes(@Query('cdCls') cdCls?: string) {
    return this.etims.codes(cdCls);
  }

  @Get('item-classes') @RequirePermissions(P.ETIMS_READ)
  itemClasses(@Query('q') q?: string) {
    return this.etims.itemClasses(q);
  }

  @Get('mappings') @RequirePermissions(P.ETIMS_READ)
  mappings() {
    return this.etims.mappings();
  }

  @Put('mappings') @RequirePermissions(P.ETIMS_MANAGE)
  setMapping(@Body() dto: MappingDto) {
    return this.etims.setMapping(dto.kind, dto.localKey, dto.etimsCode);
  }

  /** Items that cannot be invoiced until mapped. */
  @Get('unmapped-items') @RequirePermissions(P.ETIMS_READ)
  unmapped() {
    return this.etims.unmappedItems();
  }

  @Get('outbox') @RequirePermissions(P.ETIMS_READ)
  outbox(@Query() q: OutboxQueryDto) {
    return this.etims.outbox(q);
  }

  @Post('outbox/:id/reprocess') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  reprocess(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.etims.reprocess(id, u);
  }

  /** Send everything due now (normally the etims.dispatch job). */
  @Post('outbox/dispatch') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  dispatch() {
    return this.etims.dispatch();
  }

  @Get('transmissions') @RequirePermissions(P.ETIMS_READ)
  transmissions(@Query() q: TransmissionQueryDto) {
    return this.etims.transmissions(q.outboxId);
  }

  @Post('stock/report') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  reportStock() {
    return this.etims.reportStock();
  }

  @Get('purchases') @RequirePermissions(P.ETIMS_READ)
  purchases(@Query() q: PurchaseQueryDto) {
    return this.etims.purchases(q.status);
  }

  @Post('purchases/fetch') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  fetchPurchases() {
    return this.etims.fetchPurchases();
  }

  /** Confirm (accept) or reject a supplier's sale on eTIMS. */
  @Post('purchases/:id/decision') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() u: SessionUser) {
    return this.etims.decidePurchase(id, dto.accept, dto.note, u);
  }

  @Get('imports') @RequirePermissions(P.ETIMS_READ)
  imports() {
    return this.etims.imports();
  }

  @Post('imports/fetch') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  fetchImports() {
    return this.etims.fetchImports();
  }

  @Post('imports/:id/link') @HttpCode(200) @RequirePermissions(P.ETIMS_MANAGE)
  linkImport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkImportDto, @CurrentUser() u: SessionUser) {
    return this.etims.linkImport(id, dto.itemId, u);
  }
}

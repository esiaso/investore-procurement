import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AssetStatus, Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { JobsModule } from '../jobs/jobs.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { Asset, AssetMaintenance, AssetMovement } from './assets.entities';
import { AssetsService } from './assets.service';

export const ASSET_ENTITIES = [Asset, AssetMovement, AssetMaintenance];

class AssetQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(AssetStatus) status?: string;
  @ApiPropertyOptional({ enum: ['maintenance', 'warranty'] }) @IsOptional() @IsIn(['maintenance', 'warranty']) due?: string;
}

class UpdateAssetDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) serialNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) model?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) warrantyEndsOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(120) maintenanceIntervalMonths?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) nextMaintenanceOn?: string;
  @ApiPropertyOptional({ enum: [AssetStatus.ACTIVE, AssetStatus.IN_REPAIR, AssetStatus.DISPOSED] }) @IsOptional() @IsEnum(AssetStatus) status?: AssetStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

class MoveAssetDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) location?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() custodianUserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) custodianName?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) movedOn?: string;
}

class MaintenanceDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) performedOn?: string;
  @ApiProperty({ enum: ['PREVENTIVE', 'CORRECTIVE', 'CALIBRATION', 'INSPECTION'] }) @IsIn(['PREVENTIVE', 'CORRECTIVE', 'CALIBRATION', 'INSPECTION']) kind: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) performedBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) cost?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ description: 'Default: performed on + maintenance interval' }) @IsOptional() @IsDateString({ strict: true }) nextDueOn?: string;
}

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get() @RequirePermissions(Permissions.ASSETS_READ)
  list(@Query() q: AssetQueryDto) {
    return this.assets.list(q);
  }

  @Get(':id') @RequirePermissions(Permissions.ASSETS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(id);
  }

  @Put(':id') @RequirePermissions(Permissions.ASSETS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssetDto) {
    return this.assets.update(id, dto);
  }

  @Post(':id/move') @HttpCode(200) @RequirePermissions(Permissions.ASSETS_MANAGE)
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveAssetDto, @CurrentUser() u: SessionUser) {
    return this.assets.move(id, { storeId: dto.storeId ?? null, departmentId: dto.departmentId ?? null, location: dto.location ?? null, custodianUserId: dto.custodianUserId ?? null, custodianName: dto.custodianName ?? null, reason: dto.reason, movedOn: dto.movedOn }, u);
  }

  @Post(':id/maintenance') @HttpCode(200) @RequirePermissions(Permissions.ASSETS_MANAGE)
  maintain(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaintenanceDto) {
    return this.assets.maintain(id, dto);
  }
}

/** Basic fixed-asset register (tagging from GRNs, location / custodian, warranty and maintenance). */
@Module({
  imports: [TypeOrmModule.forFeature(ASSET_ENTITIES), NumberingModule, PurchasingModule, JobsModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}

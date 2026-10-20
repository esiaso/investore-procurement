import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ForecastMethod, QuantificationMethod } from '@sil/shared';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class RunForecastDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: ForecastMethod, description: 'Default: setting forecast.defaultMethod' }) @IsOptional() @IsEnum(ForecastMethod) method?: ForecastMethod;
}

export class ForecastQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() onlySuggested?: boolean;
}

export class AccuracyQueryDto {
  @ApiProperty({ example: '2026-01' }) @Matches(MONTH) fromMonth: string;
  @ApiProperty({ example: '2026-06' }) @Matches(MONTH) toMonth: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

export class TrackAccuracyDto {
  @ApiPropertyOptional({ description: 'Default: last month' }) @IsOptional() @Matches(MONTH) month?: string;
}

export class AdjustmentDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiProperty({ example: 'MORBIDITY' }) @IsString() @Matches(/^[A-Z_]{2,40}$/) reasonCode: string;
  @ApiProperty() @IsString() @MaxLength(500) description: string;
  @ApiProperty({ example: 1.2 }) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) factor: number;
  @ApiProperty() @Matches(MONTH) fromMonth: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONTH) toMonth?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ForecastRequisitionDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiProperty({ type: [String], description: 'Forecasts whose suggested quantities to order' }) @IsArray() @ArrayMinSize(1) @IsUUID('4', { each: true }) forecastIds: string[];
}

export class SupplyPlanQueryDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class ScheduleQueryDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() itemId: string;
}

export class ProgrammeCommodityDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitsPerPatientMonth: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) regimenSharePercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) protocolNotes?: string;
}

export class ProgrammeDto {
  @ApiProperty() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ type: [ProgrammeCommodityDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ProgrammeCommodityDto) commodities?: ProgrammeCommodityDto[];
}

export class QuantifyDto {
  @ApiProperty() @IsUUID() programmeId: string;
  @ApiPropertyOptional({ description: 'Consumption from this store (default: all)' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty() @IsInt() @Min(1) @Max(60) periodMonths: number;
  @ApiProperty() @IsInt() @Min(0) targetPopulation: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) coveragePercent: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) wastagePercent?: number;
  @ApiPropertyOptional({ enum: QuantificationMethod }) @IsOptional() @IsEnum(QuantificationMethod) method?: QuantificationMethod;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class FundingSourceDto {
  @ApiProperty() @IsString() @MaxLength(100) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) donor?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() programmeId?: string;
  @ApiPropertyOptional({ description: 'False: the stock may not be sold or dispensed on invoice' }) @IsOptional() @IsBoolean() allowSale?: boolean;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) allowedStoreIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) allowedDepartmentIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class DonorStockQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) fundingSource?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

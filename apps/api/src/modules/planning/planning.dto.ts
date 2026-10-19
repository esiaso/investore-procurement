import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { StockSettingMode } from '@sil/shared';

const QTY = { maxDecimalPlaces: 4 } as const;
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);

export class SettingsQueryDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class UpdateStoreItemSettingDto {
  @ApiPropertyOptional({ enum: StockSettingMode }) @IsOptional() @IsEnum(StockSettingMode) mode?: StockSettingMode;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) minLevel?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) maxLevel?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) reorderLevel?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) reorderQty?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) safetyStock?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(365) reviewPeriodDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReorderQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ description: 'Only items at or below their reorder level' }) @IsOptional() @Transform(toBool) @IsBoolean() belowOnly?: boolean;
  @ApiPropertyOptional({ enum: ['json', 'csv', 'xlsx'] }) @IsOptional() @IsIn(['json', 'csv', 'xlsx']) format?: 'json' | 'csv' | 'xlsx';
}

export class ReorderLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0) quantity: number;
}

export class CreateReorderRequisitionDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional({ description: 'Purchase requisitions: department charged (default: your department)' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) justification?: string;
  @ApiProperty({ type: [ReorderLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReorderLineDto)
  lines: ReorderLineDto[];
}

export class ExpiryQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ description: 'Expiring within N days (default: the largest warning horizon)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650)
  horizonDays?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() includeExpired?: boolean;
  @ApiPropertyOptional({ enum: ['json', 'csv', 'xlsx'] }) @IsOptional() @IsIn(['json', 'csv', 'xlsx']) format?: 'json' | 'csv' | 'xlsx';
}

export class RedistributeDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiProperty() @IsUUID() fromStoreId: string;
  @ApiProperty() @IsUUID() toStoreId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class WriteOffLineDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class WriteOffDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [WriteOffLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => WriteOffLineDto)
  lines: WriteOffLineDto[];
}

export class AlertQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) type?: string;
  @ApiPropertyOptional({ enum: ['OPEN', 'RESOLVED'] }) @IsOptional() @IsIn(['OPEN', 'RESOLVED']) status?: string;
}

export class DashboardQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

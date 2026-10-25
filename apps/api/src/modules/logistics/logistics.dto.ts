import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const QTY = { maxDecimalPlaces: 4 } as const;

export class RouteDto {
  @ApiProperty() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsUUID() fromStoreId: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsUUID('4', { each: true }) stopStoreIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class RunDto {
  @ApiProperty() @IsUUID() fromStoreId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() routeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) runDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) vehicle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) driver?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [String], description: 'Transfer requests to deliver' }) @IsArray() @ArrayMinSize(1) @IsUUID('4', { each: true }) transferIds: string[];
}

export class PickLinePickDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class PickLineDto {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiPropertyOptional({ description: 'Quantity found (default: requested), picked in FEFO order' }) @IsOptional() @IsNumber(QTY) @Min(0) quantity?: number;
  @ApiPropertyOptional({ type: [PickLinePickDto], description: 'Batches actually picked' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PickLinePickDto) picks?: PickLinePickDto[];
}

export class PickDtoBody {
  @ApiPropertyOptional({ type: [PickLineDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PickLineDto) lines?: PickLineDto[];
}

export class PackDto {
  @ApiProperty() @IsInt() @Min(1) @Max(500) packages: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class WitnessBody {
  @ApiProperty() @IsString() @MaxLength(100) username: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

export class DispatchRunDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) fefoOverrideReason?: string;
  @ApiPropertyOptional({ type: WitnessBody }) @IsOptional() @ValidateNested() @Type(() => WitnessBody) witness?: WitnessBody;
}

export class PodAllocationDto {
  @ApiProperty() @IsUUID() allocationId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0) receivedQty: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) discrepancyReasonCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) discrepancyNotes?: string;
}

export class PodDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) receivedByName: string;
  @ApiProperty({ description: 'Name as signed on the dispatch note' }) @IsString() @MinLength(2) @MaxLength(200) signatureName: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() deliveredAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() toBinId?: string;
  @ApiPropertyOptional({ type: [PodAllocationDto], description: 'Default: everything arrived' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PodAllocationDto) allocations?: PodAllocationDto[];
  @ApiPropertyOptional({ type: WitnessBody }) @IsOptional() @ValidateNested() @Type(() => WitnessBody) witness?: WitnessBody;
}

export class RunQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

export class ShipmentLineDto {
  @ApiProperty() @IsUUID() poLineId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class ShipmentDto {
  @ApiProperty() @IsUUID() purchaseOrderId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) shippedOn?: string;
  @ApiProperty() @IsDateString({ strict: true }) expectedOn: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) carrier?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) trackingRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ type: [ShipmentLineDto], description: 'Default: everything outstanding' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ShipmentLineDto) lines?: ShipmentLineDto[];
}

export class ShipmentUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) expectedOn?: string;
  @ApiPropertyOptional({ description: 'Why the date moved' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) shippedOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) carrier?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) trackingRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ShipmentQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;
}

export class ReasonBody {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}

export class CertificateLineDto {
  @ApiProperty() @IsUUID() poLineId: string;
  @ApiProperty({ description: 'In the PO line unit' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) remarks?: string;
}

export class CertificateDto {
  @ApiProperty() @IsUUID() purchaseOrderId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) periodFrom?: string;
  @ApiProperty() @IsDateString({ strict: true }) periodTo: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) workDone: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(5) qualityRating?: number;
  @ApiProperty({ type: [CertificateLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CertificateLineDto) lines: CertificateLineDto[];
}

export class CertificateQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
}

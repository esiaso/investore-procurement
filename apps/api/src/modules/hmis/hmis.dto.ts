import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { EncounterStatus, HmisAdapterKind, HmisBillingMode, HmisDirection, HmisMappingKind, HmisMessageStatus, HmisMessageType } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const QTY = { maxDecimalPlaces: 4 } as const;

export class ConnectionDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) name: string;
  @ApiProperty({ enum: HmisAdapterKind }) @IsEnum(HmisAdapterKind) adapter: HmisAdapterKind;
  @ApiPropertyOptional({ description: 'FHIR or REST base URL; empty for the in-process mock' }) @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;
  @ApiPropertyOptional({ description: 'Token / API key for the HMIS; "" clears it; omit to keep' }) @IsOptional() @IsString() @MaxLength(500) authToken?: string;
  @ApiPropertyOptional({ default: 'Authorization' }) @IsOptional() @IsString() @MaxLength(60) authHeader?: string;
  @ApiPropertyOptional({ default: 'urn:sil:hospital-no' }) @IsOptional() @IsString() @MaxLength(200) hospitalNoSystem?: string;
  @ApiProperty({ enum: HmisBillingMode }) @IsEnum(HmisBillingMode) billingMode: HmisBillingMode;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sendDispenses?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pollOrders?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MappingDto {
  @ApiProperty({ enum: HmisMappingKind }) @IsEnum(HmisMappingKind) kind: HmisMappingKind;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) externalCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) externalDisplay?: string;
  @ApiProperty({ description: 'Generic / item, store, department or payer id' }) @IsUUID() localId: string;
  @ApiPropertyOptional({ description: 'DRUG: localId is a brand item' }) @IsOptional() @IsBoolean() isItem?: boolean;
}

export class MappingQueryDto {
  @ApiPropertyOptional({ enum: HmisMappingKind }) @IsOptional() @IsEnum(HmisMappingKind) kind?: HmisMappingKind;
}

export class MessageQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: HmisDirection }) @IsOptional() @IsEnum(HmisDirection) direction?: HmisDirection;
  @ApiPropertyOptional({ enum: HmisMessageType }) @IsOptional() @IsEnum(HmisMessageType) type?: HmisMessageType;
  @ApiPropertyOptional({ enum: HmisMessageStatus }) @IsOptional() @IsEnum(HmisMessageStatus) status?: HmisMessageStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class EncounterQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional({ description: 'Ward' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ enum: EncounterStatus }) @IsOptional() @IsEnum(EncounterStatus) status?: EncounterStatus;
}

export class PatientSearchDto {
  @ApiProperty({ description: 'Hospital number or name' }) @IsString() @MinLength(2) @MaxLength(100) q: string;
}

export class ImportPatientDto {
  @ApiProperty({ description: 'HMIS patient id' }) @IsString() @MinLength(1) @MaxLength(100) externalId: string;
}

export class ChargeLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
}

/** Ward / theatre stock used on a patient: charged to the encounter (the stock was issued to the ward already). */
export class WardConsumptionDto {
  @ApiProperty() @IsUUID() encounterId: string;
  @ApiProperty({ description: 'Ward / theatre where it was used' }) @IsUUID() departmentId: string;
  @ApiProperty({ description: 'Store that issued the stock (selling outlet for a local invoice)' }) @IsUUID() storeId: string;
  @ApiProperty({ type: [ChargeLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ChargeLineDto) lines: ChargeLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ReverseChargeDto {
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ChargeQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() encounterId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
}

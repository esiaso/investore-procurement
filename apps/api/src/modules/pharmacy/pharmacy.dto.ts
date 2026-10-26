import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { InteractionSeverity, PrescriptionStatus, Sex, SupplyMode } from '@sil/shared';
import { PaymentDto } from '../billing/billing.dto';
import { PageQueryDto } from '../../common/pagination';

const QTY = { maxDecimalPlaces: 4 } as const;

export class PatientDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(40) hospitalNo: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) dateOfBirth?: string;
  @ApiPropertyOptional({ enum: Sex }) @IsOptional() @IsEnum(Sex) sex?: Sex;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(500) weightKg?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPregnant?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() payerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) memberNo?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(100, { each: true }) allergies?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'KRA PIN must look like P051234567X' }) kraPin?: string;
}

export class PatientQueryDto extends PageQueryDto {}

export class PrescriptionLineDto {
  @ApiProperty() @IsUUID() genericId: string;
  @ApiPropertyOptional({ description: 'Brand asked for' }) @IsOptional() @IsUUID() preferredItemId?: string;
  @ApiProperty({ example: '500 mg' }) @IsString() @MaxLength(100) dose: string;
  @ApiProperty({ example: 'TDS' }) @IsString() @MaxLength(60) frequency: string;
  @ApiPropertyOptional({ example: '5 days' }) @IsOptional() @IsString() @MaxLength(60) duration?: string;
  @ApiPropertyOptional({ example: 'PO' }) @IsOptional() @IsString() @MaxLength(60) route?: string;
  @ApiProperty({ description: 'Base units to supply' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Daily / unit-dose supply: base units per day' }) @IsOptional() @IsNumber(QTY) @Min(0.0001) dailyQuantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) instructions?: string;
}

export class CreatePrescriptionDto {
  @ApiProperty() @IsUUID() patientId: string;
  @ApiProperty({ description: 'Dispensing outlet' }) @IsUUID() storeId: string;
  @ApiProperty() @IsString() @MaxLength(200) prescriber: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) prescriberRegNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) encounterRef?: string;
  @ApiPropertyOptional({ description: 'HMIS encounter (visit / admission)' }) @IsOptional() @IsUUID() encounterId?: string;
  @ApiPropertyOptional({ enum: SupplyMode, description: 'DAILY / UNIT_DOSE: supplied to the ward each day' }) @IsOptional() @IsEnum(SupplyMode) supplyMode?: SupplyMode;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) externalRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [PrescriptionLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PrescriptionLineDto) lines: PrescriptionLineDto[];
}

export class WorklistQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: PrescriptionStatus, isArray: true }) @IsOptional() @IsEnum(PrescriptionStatus, { each: true }) status?: PrescriptionStatus | PrescriptionStatus[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
}

export class OverrideDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) reason: string;
}

export class PickDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() binId?: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class DispenseLineDto {
  @ApiProperty() @IsUUID() prescriptionLineId: string;
  @ApiProperty({ description: 'Brand given (any item of the prescribed generic)' }) @IsUUID() itemId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ type: [PickDto], description: 'Batches; default FEFO' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PickDto) picks?: PickDto[];
}

export class DispenseDto {
  @ApiProperty({ type: [DispenseLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DispenseLineDto) lines: DispenseLineDto[];
  @ApiPropertyOptional({ type: [PaymentDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentDto) payments?: PaymentDto[];
  @ApiPropertyOptional({ description: 'Required when picks differ from FEFO' }) @IsOptional() @IsString() @MaxLength(500) fefoOverrideReason?: string;
  @ApiPropertyOptional({ description: 'Second person (controlled drugs)' }) @IsOptional() @IsUUID() witnessId?: string;
}

export class ReturnLineDto {
  @ApiProperty() @IsUUID() prescriptionLineId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class DispenseReturnDto {
  @ApiProperty({ type: [ReturnLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines: ReturnLineDto[];
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) reason: string;
  @ApiPropertyOptional({ description: 'Back into sellable stock (false: quarantine/destroy separately)' }) @IsOptional() @IsBoolean() restock?: boolean;
}

export class CancelLinesDto {
  @ApiProperty({ type: [String], description: 'Prescription lines whose undispensed balance is cancelled' }) @IsArray() @ArrayMinSize(1) @IsUUID('4', { each: true }) lineIds: string[];
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class InteractionDto {
  @ApiProperty({ description: 'INN or "class:<therapeutic class>"' }) @IsString() @MaxLength(200) innA: string;
  @ApiProperty() @IsString() @MaxLength(200) innB: string;
  @ApiProperty({ enum: InteractionSeverity }) @IsEnum(InteractionSeverity) severity: InteractionSeverity;
  @ApiProperty() @IsString() @MaxLength(1000) mechanism: string;
  @ApiProperty() @IsString() @MaxLength(1000) management: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class InteractionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: InteractionSeverity }) @IsOptional() @IsEnum(InteractionSeverity) severity?: InteractionSeverity;
}

export class InteractionImportDto {
  @ApiProperty({ description: 'CSV text: inn_a,inn_b,severity,mechanism,management[,source]' }) @IsString() @MaxLength(5_000_000) csv: string;
  @ApiPropertyOptional({ description: 'Validate only' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class AlertReportQueryDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class WardSupplyQueryDto {
  @ApiProperty({ description: 'Dispensing outlet' }) @IsUUID() storeId: string;
  @ApiPropertyOptional({ description: 'Ward' }) @IsOptional() @IsUUID() departmentId?: string;
}

export class WardSupplyLineDto extends DispenseLineDto {}

/** One round of daily / unit-dose supply: lines across several patients, dispensed per prescription. */
export class WardSupplyDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ type: [WardSupplyLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => WardSupplyLineDto) lines: WardSupplyLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) fefoOverrideReason?: string;
  @ApiPropertyOptional({ description: 'Second person (controlled drugs)' }) @IsOptional() @IsUUID() witnessId?: string;
}

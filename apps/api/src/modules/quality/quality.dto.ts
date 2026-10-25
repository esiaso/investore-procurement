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
import { ComplaintCategory, ComplaintStatus, DisposalMethod, HoldReason, RecallClass, RecallReturnSource, RecallSource, StorageUnitType } from '@sil/shared';

const QTY = { maxDecimalPlaces: 4 } as const;

export class HoldDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiProperty({ enum: [HoldReason.INSPECTION, HoldReason.INVESTIGATION, HoldReason.COMPLAINT, HoldReason.EXCURSION] }) @IsEnum(HoldReason) reason: HoldReason;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) details: string;
}

export class DecisionDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) note: string;
}

export class HoldQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;
}

export class StorageUnitDto {
  @ApiProperty() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ enum: StorageUnitType }) @IsEnum(StorageUnitType) type: StorageUnitType;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) binIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) loggerSerial?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReadingDto {
  @ApiPropertyOptional({ description: 'Default: now' }) @IsOptional() @IsDateString() recordedAt?: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-90) @Max(80) temperatureC: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ReadingsDto {
  @ApiProperty({ type: [ReadingDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReadingDto) readings: ReadingDto[];
}

export class CsvImportDto {
  @ApiPropertyOptional({ description: 'Unit (else a unit / logger column in the file)' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ description: 'CSV text (or upload a file)' }) @IsOptional() @IsString() @MaxLength(5_000_000) csv?: string;
}

export class ReadingQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class ExcursionQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
}

export class ComplaintDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiProperty({ enum: ComplaintCategory }) @IsEnum(ComplaintCategory) category: ComplaintCategory;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(4000) description: string;
  @ApiProperty() @IsString() @MaxLength(200) reportedByName: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) reportedOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional({ enum: ['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'] }) @IsOptional() @IsIn(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING']) severity?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sampleRetained?: boolean;
  @ApiPropertyOptional({ description: 'Quarantine the batch pending investigation' }) @IsOptional() @IsBoolean() holdStock?: boolean;
}

export class ComplaintUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) investigation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) outcome?: string;
  @ApiPropertyOptional({ enum: ['PQM', 'ADR'] }) @IsOptional() @IsIn(['PQM', 'ADR']) ppbReportType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) ppbReference?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) reportedToPpbOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING']) severity?: string;
  @ApiPropertyOptional({ enum: ComplaintStatus }) @IsOptional() @IsEnum(ComplaintStatus) status?: ComplaintStatus;
}

export class ComplaintQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
}

export class RecallDto {
  @ApiProperty({ enum: RecallSource }) @IsEnum(RecallSource) source: RecallSource;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) noticeReference?: string;
  @ApiProperty() @IsDateString({ strict: true }) noticeDate: string;
  @ApiProperty({ enum: RecallClass }) @IsEnum(RecallClass) classification: RecallClass;
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional({ type: [String], description: 'Batch numbers in the notice (empty = all batches)' }) @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(100, { each: true }) batchNos?: string[];
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() patientLevel?: boolean;
}

export class RecallReturnDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiProperty({ enum: RecallReturnSource }) @IsEnum(RecallReturnSource) source: RecallReturnSource;
  @ApiPropertyOptional({ description: 'Department, patient or store id' }) @IsOptional() @IsUUID() fromId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) fromName?: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Post the returned quantity into this store (stays on recall hold)' }) @IsOptional() @IsUUID() intoStoreId?: string;
  @ApiPropertyOptional({ example: 'RETURNED_TO_SUPPLIER' }) @IsOptional() @IsString() @MaxLength(40) outcome?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) returnedOn?: string;
}

export class CloseRecallDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) outcome: string;
  @ApiPropertyOptional({ description: 'The recall was withdrawn: release the stock' }) @IsOptional() @IsBoolean() withdrawn?: boolean;
}

export class StatusQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

export class DisposalLineDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class DisposalDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ enum: DisposalMethod }) @IsEnum(DisposalMethod) method: DisposalMethod;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) recipient?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) publicNoticeRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [DisposalLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DisposalLineDto) lines: DisposalLineDto[];
}

export class DisposalUpdateDto {
  @ApiPropertyOptional({ enum: DisposalMethod }) @IsOptional() @IsEnum(DisposalMethod) method?: DisposalMethod;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) recipient?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) publicNoticeRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ type: [DisposalLineDto] }) @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DisposalLineDto) lines?: DisposalLineDto[];
}

export class DisposalMemberDto {
  @ApiProperty() @IsUUID() userId: string;
  @ApiProperty({ enum: ['CHAIR', 'MEMBER', 'SECRETARY', 'WITNESS'] }) @IsIn(['CHAIR', 'MEMBER', 'SECRETARY', 'WITNESS']) role: string;
}

export class DisposalCommitteeDto {
  @ApiProperty({ type: [DisposalMemberDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DisposalMemberDto) members: DisposalMemberDto[];
}

export class SignDisposalDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

export class CompleteDisposalDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) completedOn?: string;
  @ApiProperty() @IsString() @MaxLength(300) place: string;
  @ApiProperty({ description: 'Disposal agent / licensed waste handler / buyer' }) @IsString() @MaxLength(300) agent: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) wasteTransferNote?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) proceeds?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequisitionPriority, ReturnCondition, ReturnReasonKind } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';
import { WitnessDto } from '../inventory/inventory.dto';

const QTY = { maxDecimalPlaces: 4 } as const;
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

// ------------------------------------------------------------------ internal requisitions

export class StoreRequisitionLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Patient / encounter reference (free text; filled from the encounter when one is given)' })
  @IsOptional() @IsString() @MaxLength(100) patientRef?: string;
  @ApiPropertyOptional({ description: 'HMIS encounter: the patient is charged when the line is issued' }) @IsOptional() @IsUUID() encounterId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateStoreRequisitionDto {
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty({ description: 'Store or pharmacy that issues' }) @IsUUID() storeId: string;
  @ApiPropertyOptional({ enum: RequisitionPriority }) @IsOptional() @IsEnum(RequisitionPriority) priority?: RequisitionPriority;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) requiredBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [StoreRequisitionLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => StoreRequisitionLineDto)
  lines: StoreRequisitionLineDto[];
  @ApiPropertyOptional({ description: 'Submit for approval straight away', default: false }) @IsOptional() @IsBoolean() submit?: boolean;
}

export class StoreRequisitionQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) status?: string;
  @ApiPropertyOptional({ description: 'Only requisitions with something left to issue' })
  @IsOptional() @Transform(toBool) @IsBoolean() open?: boolean;
}

export class CancelLinesDto {
  @ApiPropertyOptional({ type: [String], description: 'Lines whose back-order to cancel (default: all outstanding)' })
  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  lineIds?: string[];
  @ApiProperty() @IsString() @MaxLength(500) reason: string;
}

// ------------------------------------------------------------------ issues

export class IssuePickDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Code scanned to confirm the pick: item barcode/GTIN/code or batch number' })
  @IsOptional() @IsString() @MaxLength(100) scannedCode?: string;
}

export class IssueLineDto {
  @ApiProperty() @IsUUID() requisitionLineId: string;
  @ApiPropertyOptional({ description: 'Quantity to issue now (default: as much of the outstanding as is available)' })
  @IsOptional() @IsNumber(QTY) @Min(0) quantity?: number;
  @ApiPropertyOptional({ type: [IssuePickDto], description: 'Batch picks; FEFO is suggested, other picks override it' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IssuePickDto)
  picks?: IssuePickDto[];
}

export class CreateIssueDto {
  @ApiPropertyOptional({ type: [IssueLineDto], description: 'Default: every outstanding line, FEFO, as much as available' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto)
  lines?: IssueLineDto[];
  @ApiPropertyOptional({ description: 'Required when picks differ from FEFO' }) @IsOptional() @IsString() @MaxLength(500) fefoOverrideReason?: string;
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
  @ApiPropertyOptional({ description: 'Who collected for the department' }) @IsOptional() @IsString() @MaxLength(200) collectedBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class IssueQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() requisitionId?: string;
}

// ------------------------------------------------------------------ department returns

export class DepartmentReturnLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional({ description: 'Issue line the stock came from' }) @IsOptional() @IsUUID() issueVoucherLineId?: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiProperty() @IsString() @MaxLength(40) reasonCode: string;
  @ApiProperty({ enum: ReturnCondition }) @IsEnum(ReturnCondition) condition: ReturnCondition;
  @ApiPropertyOptional({ description: 'Put-away bin for resaleable stock' }) @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) patientRef?: string;
}

export class CreateDepartmentReturnDto {
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [DepartmentReturnLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DepartmentReturnLineDto)
  lines: DepartmentReturnLineDto[];
}

export class PostDepartmentReturnDto {
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) returnDate?: string;
}

export class DocQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) status?: string;
}

// ------------------------------------------------------------------ return reasons

export class ReturnReasonDto {
  @ApiProperty() @IsString() @MaxLength(40) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: ReturnReasonKind }) @IsEnum(ReturnReasonKind) kind: ReturnReasonKind;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReturnReasonQueryDto {
  @ApiPropertyOptional({ enum: ['DEPARTMENT', 'SUPPLIER'] }) @IsOptional() @IsIn(['DEPARTMENT', 'SUPPLIER']) for?: 'DEPARTMENT' | 'SUPPLIER';
}

// ------------------------------------------------------------------ consumption

export class ConsumptionQueryDto {
  @ApiProperty({ example: '2026-10-01' }) @IsDateString({ strict: true }) from: string;
  @ApiProperty({ example: '2026-10-31' }) @IsDateString({ strict: true }) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ description: 'Only movements with this patient reference' }) @IsOptional() @IsString() @MaxLength(100) patientRef?: string;
  @ApiPropertyOptional({ enum: ['department', 'period', 'item', 'patient'], default: 'department' })
  @IsOptional() @IsIn(['department', 'period', 'item', 'patient'])
  groupBy?: 'department' | 'period' | 'item' | 'patient';
  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

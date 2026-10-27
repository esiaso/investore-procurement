import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PurchaseLineType, RequisitionPriority, StaffRequisitionStatus } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const QTY = { maxDecimalPlaces: 4 } as const;
const MONEY = { maxDecimalPlaces: 2 } as const;

export class StaffRequisitionLineDto {
  @ApiProperty({ enum: PurchaseLineType, description: 'STOCK lines go to the store; the others to procurement' }) @IsEnum(PurchaseLineType) lineType: PurchaseLineType;
  @ApiPropertyOptional({ description: 'Catalog item (required for STOCK lines)' }) @IsOptional() @Transform(emptyToNull) @IsUUID() itemId?: string | null;
  @ApiPropertyOptional({ description: 'What is needed (required for non-stock lines; default: the item name)' }) @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() categoryId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Unit of measure (non-stock lines; stock lines use the base unit)' }) @IsOptional() @Transform(emptyToNull) @IsUUID() uomId?: string | null;
  @ApiPropertyOptional({ description: 'Estimated cost per unit (stock lines default to the store cost)' }) @IsOptional() @IsNumber(MONEY) @Min(0) estimatedUnitCost?: number;
  @ApiPropertyOptional({ description: 'GL account (expense / asset) for non-stock lines' }) @IsOptional() @Transform(emptyToNull) @IsUUID() glAccountId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class StaffRequisitionDto {
  @ApiProperty({ description: 'Department / cost centre charged' }) @IsUUID() departmentId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() projectId?: string | null;
  @ApiPropertyOptional({ description: 'Store that issues stock lines (required when there are any)' }) @IsOptional() @Transform(emptyToNull) @IsUUID() storeId?: string | null;
  @ApiPropertyOptional({ description: 'Department budget line to check against' }) @IsOptional() @Transform(emptyToNull) @IsUUID() budgetId?: string | null;
  @ApiPropertyOptional({ enum: RequisitionPriority }) @IsOptional() @IsEnum(RequisitionPriority) priority?: RequisitionPriority;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) requiredBy?: string | null;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) justification: string;
  @ApiProperty({ type: [StaffRequisitionLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => StaffRequisitionLineDto)
  lines: StaffRequisitionLineDto[];
  @ApiPropertyOptional({ description: 'Submit for approval straight away' }) @IsOptional() @IsBoolean() submit?: boolean;
}

export class StaffRequisitionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['mine', 'department', 'all'], description: 'Default: mine (all needs requisitions.read_all)' }) @IsOptional() @IsIn(['mine', 'department', 'all']) scope?: 'mine' | 'department' | 'all';
  @ApiPropertyOptional({ enum: StaffRequisitionStatus }) @IsOptional() @IsEnum(StaffRequisitionStatus) status?: StaffRequisitionStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
}

export class QueueQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ enum: PurchaseLineType }) @IsOptional() @IsEnum(PurchaseLineType) lineType?: PurchaseLineType;
}

export class ConsolidateDto {
  @ApiProperty({ type: [String], description: 'Approved non-stock requisition lines (any departments)' }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) lineIds: string[];
  @ApiProperty({ description: 'Department that owns the purchase requisition (usually procurement)' }) @IsUUID() departmentId: string;
  @ApiProperty({ description: 'Delivery location' }) @IsUUID() storeId: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) justification: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() budgetId?: string | null;
  @ApiPropertyOptional({ enum: RequisitionPriority }) @IsOptional() @IsEnum(RequisitionPriority) priority?: RequisitionPriority;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) requiredBy?: string | null;
  @ApiPropertyOptional({ description: 'Sourcing method (DIRECT, RFQ, OPEN_TENDER…); default: recommended by value' }) @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) sourcingMethod?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) sourcingJustification?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) suggestedSupplierIds?: string[];
}

export class CancelDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}

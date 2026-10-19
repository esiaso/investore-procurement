import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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
import { BatchHoldStatus, StockReceiptType, StockTakeType, TransferStatus } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const QTY = { maxDecimalPlaces: 4 } as const;

/** Second person signing off a controlled-drug movement. */
export class WitnessDto {
  @ApiProperty() @IsString() @MaxLength(60) username: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

// ------------------------------------------------------------------ queries

export class StockQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() binId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() genericId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: BatchHoldStatus }) @IsOptional() @IsEnum(BatchHoldStatus) holdStatus?: BatchHoldStatus;
  @ApiPropertyOptional({ description: 'Batches expiring within N days (includes expired)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650)
  expiringWithinDays?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() expired?: boolean;
  @ApiPropertyOptional({ enum: ['batch', 'item'], default: 'batch' }) @IsOptional() @IsIn(['batch', 'item']) groupBy?: 'batch' | 'item';
}

export class LedgerQueryDto extends PageQueryDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class ValuationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD; default today' }) @IsOptional() @IsDateString({ strict: true }) asOf?: string;
  @ApiPropertyOptional({ enum: ['store', 'category', 'item'], default: 'store' })
  @IsOptional() @IsIn(['store', 'category', 'item'])
  groupBy?: 'store' | 'category' | 'item';
}

export class FefoQueryDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @Type(() => Number) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) asOf?: string;
}

export class ReconcileQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

export class BatchQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional({ enum: BatchHoldStatus }) @IsOptional() @IsEnum(BatchHoldStatus) holdStatus?: BatchHoldStatus;
}

export class SetHoldDto {
  @ApiProperty({ enum: BatchHoldStatus }) @IsEnum(BatchHoldStatus) holdStatus: BatchHoldStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PeriodLockDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ example: '2026-09-30' }) @IsDateString({ strict: true }) lockedUntil: string;
}

// ------------------------------------------------------------------ receipts

export class ReceiptLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional({ description: 'Required for batch-tracked items' }) @IsOptional() @IsString() @MaxLength(60) batchNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) expiryDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) manufactureDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) fundingSource?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiProperty() @IsNumber(QTY) @Min(0) unitCost: number;
}

export class CreateReceiptDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ enum: StockReceiptType }) @IsEnum(StockReceiptType) type: StockReceiptType;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) receiptDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiProperty({ type: [ReceiptLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto)
  lines: ReceiptLineDto[];
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
}

// ------------------------------------------------------------------ adjustments

export class AdjustmentLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional({ description: 'Existing batch (required for decreases)' }) @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional({ description: 'New batch number (increases only)' }) @IsOptional() @IsString() @MaxLength(60) newBatchNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) newBatchExpiryDate?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty({ description: 'Signed: negative = decrease' }) @IsNumber(QTY) quantity: number;
}

export class CreateAdjustmentDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsString() @MaxLength(40) reasonCode: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) adjustmentDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [AdjustmentLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => AdjustmentLineDto)
  lines: AdjustmentLineDto[];
  @ApiPropertyOptional({ description: 'false = save as draft', default: true }) @IsOptional() @IsBoolean() submit?: boolean;
}

export class RejectDto {
  @ApiProperty() @IsString() @MaxLength(500) reason: string;
}

export class DocQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) status?: string;
}

// ------------------------------------------------------------------ transfers

export class TransferLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class CreateTransferDto {
  @ApiProperty({ description: 'Store sending the stock' }) @IsUUID() fromStoreId: string;
  @ApiProperty({ description: 'Store requesting the stock' }) @IsUUID() toStoreId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [TransferLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TransferLineDto)
  lines: TransferLineDto[];
}

export class PickDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class DispatchLineDto {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiPropertyOptional({ description: 'Quantity to send (default: requested). Picked by FEFO unless picks are given.' })
  @IsOptional() @IsNumber(QTY) @Min(0) quantity?: number;
  @ApiPropertyOptional({ type: [PickDto], description: 'Manual batch picks (FEFO override)' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PickDto)
  picks?: PickDto[];
}

export class DispatchTransferDto {
  @ApiPropertyOptional({ type: [DispatchLineDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DispatchLineDto)
  lines?: DispatchLineDto[];
  @ApiPropertyOptional({ description: 'Required when picks differ from FEFO' }) @IsOptional() @IsString() @MaxLength(500) fefoOverrideReason?: string;
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
}

export class ReceiveAllocationDto {
  @ApiProperty() @IsUUID() allocationId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0) receivedQty: number;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() toBinId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) discrepancyReasonCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) discrepancyNotes?: string;
}

export class ReceiveTransferDto {
  @ApiPropertyOptional({ type: [ReceiveAllocationDto], description: 'Default: everything received in full' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveAllocationDto)
  allocations?: ReceiveAllocationDto[];
  @ApiPropertyOptional({ description: 'Default bin for put-away' }) @IsOptional() @Transform(emptyToNull) @IsUUID() toBinId?: string | null;
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
}

export class TransferQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Transfers from or to this store' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: TransferStatus }) @IsOptional() @IsEnum(TransferStatus) status?: TransferStatus;
}

// ------------------------------------------------------------------ stock takes

export class CreateStockTakeDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ enum: StockTakeType }) @IsEnum(StockTakeType) type: StockTakeType;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() blind?: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Cycle counts: items to count' })
  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  itemIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CountLineDto {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0) countedQty: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class FoundLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty() @IsNumber(QTY) @Min(0) countedQty: number;
}

export class RecordCountsDto {
  @ApiPropertyOptional({ type: [CountLineDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CountLineDto)
  lines?: CountLineDto[];
  @ApiPropertyOptional({ type: [FoundLineDto], description: 'Stock found that was not in the snapshot' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FoundLineDto)
  found?: FoundLineDto[];
}

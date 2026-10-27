import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AccountingProvider, AccountMappingKind, PostingDocType, PostingStatus, QboEnvironment } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const MONEY = { maxDecimalPlaces: 2 } as const;

export class ConnectionDto {
  @ApiProperty({ enum: AccountingProvider }) @IsEnum(AccountingProvider) provider: AccountingProvider;
  @ApiPropertyOptional({ enum: QboEnvironment }) @IsOptional() @IsEnum(QboEnvironment) environment?: QboEnvironment;
  @ApiPropertyOptional({ description: 'Intuit app client id' }) @IsOptional() @IsString() @MaxLength(100) clientId?: string;
  @ApiPropertyOptional({ description: 'Intuit app client secret (kept encrypted; leave out to keep the current one)' }) @IsOptional() @IsString() @MaxLength(200) clientSecret?: string;
  @ApiPropertyOptional({ description: 'Redirect URI registered with Intuit (…/api/v1/callbacks/quickbooks)' }) @IsOptional() @IsString() @MaxLength(300) redirectUri?: string;
  @ApiPropertyOptional({ description: 'Go-live: inventory journals start on this date' }) @IsOptional() @IsDateString() journalsFrom?: string;
  @ApiPropertyOptional({ description: 'Books closed up to (QuickBooks closing date is read on refresh)', nullable: true }) @IsOptional() @IsDateString() closingDate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MappingDto {
  @ApiProperty({ enum: AccountMappingKind }) @IsEnum(AccountMappingKind) kind: AccountMappingKind;
  @ApiProperty({ description: 'Category / store / department / tax category / payment mode code, or a system key' }) @IsString() @MaxLength(60) localKey: string;
  @ApiProperty({ description: 'QuickBooks account, class or tax code id' }) @IsString() @MaxLength(40) externalId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) externalName?: string;
}

export class PreviewDto {
  @ApiProperty() @IsDateString() from: string;
  @ApiProperty() @IsDateString() to: string;
  @ApiPropertyOptional({ isArray: true, enum: ['PURCHASES', 'SALES', 'INVENTORY', 'PETTY_CASH'], description: 'All when left out. PURCHASES: purchase orders, bills, vendor credits, bill payments (with WHT) and M-PESA charges' })
  @IsOptional()
  @IsArray()
  @IsIn(['PURCHASES', 'SALES', 'INVENTORY', 'PETTY_CASH'], { each: true })
  kinds?: string[];
}

export class PostingQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PostingStatus }) @IsOptional() @IsEnum(PostingStatus) status?: PostingStatus;
  @ApiPropertyOptional({ enum: PostingDocType }) @IsOptional() @IsEnum(PostingDocType) docType?: PostingDocType;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export class PeriodQueryDto {
  @ApiProperty() @IsDateString() from: string;
  @ApiProperty() @IsDateString() to: string;
}

export class AllocationDto {
  @ApiProperty() @IsUUID() invoiceId: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0.01) amount: number;
}

export class SettlementDto {
  @ApiProperty() @IsUUID() payerId: string;
  @ApiProperty() @IsDateString() receivedOn: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0.01) amount: number;
  @ApiProperty({ example: 'BANK' }) @IsString() @MaxLength(20) modeCode: string;
  @ApiProperty({ description: 'Remittance / EFT reference' }) @IsString() @MinLength(2) @MaxLength(100) reference: string;
  @ApiProperty({ type: [AllocationDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations: AllocationDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class SyncStatusQueryDto {
  @ApiProperty({ description: 'Comma-separated local document ids' }) @IsString() @MaxLength(4000) ids: string;
}

export class VendorSyncDto {
  @ApiProperty({ enum: ['PULL', 'PUSH'] }) @IsIn(['PULL', 'PUSH']) direction: 'PULL' | 'PUSH';
}

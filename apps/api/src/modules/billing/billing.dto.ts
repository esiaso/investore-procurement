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
  ValidateNested,
} from 'class-validator';
import { PayerType, PriceListType, SalesSource } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const QTY = { maxDecimalPlaces: 4 } as const;
const MONEY = { maxDecimalPlaces: 2 } as const;

export class PaymentDto {
  @ApiProperty({ example: 'MPESA' }) @IsString() @MaxLength(20) modeCode: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) amount: number;
  @ApiPropertyOptional({ description: 'M-Pesa / card slip reference' }) @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

export class SaleLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'VAT inclusive; default: the price list' }) @IsOptional() @IsNumber(MONEY) @Min(0) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) @Max(100) discountPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
}

export class CustomerDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional({ description: 'Buyer KRA PIN (B2B); optional for B2C' }) @IsOptional() @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'KRA PIN must look like P051234567X' }) kraPin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() payerId?: string;
}

/** OTC sale, patient-chargeable consumables, or (via the integration API) HMIS charges. */
export class CreateSaleDto {
  @ApiProperty({ description: 'Selling outlet' }) @IsUUID() storeId: string;
  @ApiProperty({ enum: [SalesSource.OTC, SalesSource.CONSUMABLE, SalesSource.HMIS] }) @IsIn([SalesSource.OTC, SalesSource.CONSUMABLE, SalesSource.HMIS]) source: SalesSource;
  @ApiPropertyOptional({ type: CustomerDto }) @IsOptional() @ValidateNested() @Type(() => CustomerDto) customer?: CustomerDto;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceListId?: string;
  @ApiProperty({ type: [SaleLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SaleLineDto) lines: SaleLineDto[];
  @ApiPropertyOptional({ type: [PaymentDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentDto) payments?: PaymentDto[];
  @ApiPropertyOptional({ description: 'Take the stock out (FEFO). Default: yes for OTC/consumables, no for HMIS charges' }) @IsOptional() @IsBoolean() deductStock?: boolean;
  @ApiPropertyOptional({ description: "Caller's idempotency key" }) @IsOptional() @IsString() @MaxLength(100) externalRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreditLineDto {
  @ApiProperty() @IsUUID() invoiceLineId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class CreateCreditNoteDto {
  @ApiPropertyOptional({ type: [CreditLineDto], description: 'Default: everything not yet credited' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreditLineDto) lines?: CreditLineDto[];
  @ApiPropertyOptional({ description: 'eTIMS credit note reason (code class 32), default 06 Refund' }) @IsOptional() @IsString() @MaxLength(5) reasonCode?: string;
  @ApiPropertyOptional({ description: 'Put the stock back on its batch' }) @IsOptional() @IsBoolean() restock?: boolean;
  @ApiProperty() @IsString() @MaxLength(1000) reason: string;
}

export class InvoiceQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) docType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) etimsStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) source?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class PriceListDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: PriceListType }) @IsEnum(PriceListType) type: PriceListType;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(-100) @Max(1000) adjustPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PriceListItemDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'VAT inclusive per base unit' }) @IsNumber(MONEY) @Min(0) price: number;
}

export class PayerDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: PayerType }) @IsEnum(PayerType) type: PayerType;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[AP]\d{9}[A-Z]$/) kraPin?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceListId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) @Max(100) coPayPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) etimsInsuranceCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReportQueryDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
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
import { MpesaEnvironment } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const QTY = { maxDecimalPlaces: 4 } as const;
const MONEY = { maxDecimalPlaces: 2 } as const;

export class CredentialsDto {
  @ApiProperty() @IsString() @MaxLength(100) username: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

export class TerminalDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() defaultPriceListId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class OpenShiftDto {
  @ApiProperty() @IsUUID() terminalId: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) openingFloat: number;
}

export class CloseShiftDto {
  @ApiProperty({ description: 'Cash counted in the drawer' }) @IsNumber(MONEY) @Min(0) countedCash: number;
  @ApiPropertyOptional({ description: 'Denomination → count (e.g. {"1000": 3, "50": 4})' }) @IsOptional() @IsObject() denominations?: Record<string, number>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class VarianceDecisionDto {
  @ApiProperty() @IsBoolean() approve: boolean;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) note: string;
}

export class PosLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units (loose tablets allowed)' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Manual discount % (promotions are applied automatically)' }) @IsOptional() @IsNumber(MONEY) @Min(0) @Max(100) discountPercent?: number;
}

export class PosPaymentDto {
  @ApiProperty({ example: 'CASH' }) @IsString() @MaxLength(20) modeCode: string;
  @ApiProperty({ description: 'Amount tendered (cash may exceed the total: change is given)' }) @IsNumber(MONEY) @Min(0.01) amount: number;
  @ApiPropertyOptional({ description: 'M-Pesa code typed, card slip number…' }) @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @ApiPropertyOptional({ description: 'M-Pesa STK push that was paid' }) @IsOptional() @IsUUID() mpesaTransactionId?: string;
}

export class QuickCustomerDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'KRA PIN must look like P051234567X' }) kraPin?: string;
}

export class VoidedLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class PosSaleDto {
  @ApiProperty() @IsUUID() terminalId: string;
  @ApiProperty({ description: 'Id made by the till; the same sale sent again is recorded once' }) @IsString() @MinLength(8) @MaxLength(100) clientRef: string;
  @ApiPropertyOptional({ description: 'Sold while offline (till clock)' }) @IsOptional() @IsBoolean() offline?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() soldAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ type: QuickCustomerDto, description: 'Capture a new customer with the sale' }) @IsOptional() @ValidateNested() @Type(() => QuickCustomerDto) newCustomer?: QuickCustomerDto;
  @ApiPropertyOptional({ description: 'Price list (default: the customer’s, else the till’s)' }) @IsOptional() @IsUUID() priceListId?: string;
  @ApiProperty({ type: [PosLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PosLineDto) lines: PosLineDto[];
  @ApiProperty({ type: [PosPaymentDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PosPaymentDto) payments: PosPaymentDto[];
  @ApiPropertyOptional({ description: 'Prescription reference for prescription-only items' }) @IsOptional() @IsString() @MaxLength(100) prescriptionRef?: string;
  @ApiPropertyOptional({ type: CredentialsDto, description: 'Pharmacist approving pharmacy-only / prescription-only items or an interaction (not needed when the seller is one)' }) @IsOptional() @ValidateNested() @Type(() => CredentialsDto) pharmacist?: CredentialsDto;
  @ApiPropertyOptional({ type: CredentialsDto, description: 'Supervisor authorising a discount above the cashier’s limit' }) @IsOptional() @ValidateNested() @Type(() => CredentialsDto) supervisor?: CredentialsDto;
  @ApiPropertyOptional({ description: 'Reason for selling despite a blocking interaction' }) @IsOptional() @IsString() @MinLength(5) @MaxLength(500) interactionOverrideReason?: string;
  @ApiPropertyOptional({ description: 'Loyalty points to redeem' }) @IsOptional() @IsInt() @Min(1) redeemPoints?: number;
  @ApiPropertyOptional({ type: [VoidedLineDto], description: 'Lines removed from the basket before payment (logged)' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VoidedLineDto) voidedLines?: VoidedLineDto[];
}

export class BasketCheckDto {
  @ApiProperty() @IsUUID() terminalId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceListId?: string;
  @ApiProperty({ type: [PosLineDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => PosLineDto) lines: PosLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) redeemPoints?: number;
}

export class SyncDto {
  @ApiProperty({ type: [PosSaleDto] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PosSaleDto) sales: PosSaleDto[];
}

export class VoidSaleDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @ApiPropertyOptional({ type: CredentialsDto, description: 'Supervisor, when the seller may not void' }) @IsOptional() @ValidateNested() @Type(() => CredentialsDto) supervisor?: CredentialsDto;
}

export class RefundLineDto {
  @ApiProperty() @IsUUID() invoiceLineId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
}

export class RefundDto {
  @ApiProperty({ type: [RefundLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RefundLineDto) lines: RefundLineDto[];
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @ApiPropertyOptional({ description: 'Back into sellable stock' }) @IsOptional() @IsBoolean() restock?: boolean;
  @ApiPropertyOptional({ description: 'Till / shift paying the refund out' }) @IsOptional() @IsUUID() terminalId?: string;
}

export class CustomerDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'KRA PIN must look like P051234567X' }) kraPin?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceListId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() creditAllowed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) creditLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CustomerQueryDto extends PageQueryDto {}

export class AccountPaymentDto {
  @ApiProperty() @IsNumber(MONEY) @Min(0.01) amount: number;
  @ApiProperty() @IsIn(['CASH', 'MPESA', 'CARD']) modeCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @ApiPropertyOptional({ description: 'Till taking the cash' }) @IsOptional() @IsUUID() terminalId?: string;
}

export class PromotionDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0.01) @Max(100) discountPercent: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0.0001) minQty?: number;
  @ApiProperty() @IsDateString({ strict: true }) startsOn: string;
  @ApiProperty() @IsDateString({ strict: true }) endsOn: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ItemSearchDto {
  @ApiProperty() @IsUUID() terminalId: string;
  @ApiProperty({ description: 'Name, generic, code, barcode or GTIN' }) @IsString() @MinLength(1) @MaxLength(100) q: string;
}

export class MpesaConfigDto {
  @ApiProperty({ enum: MpesaEnvironment }) @IsEnum(MpesaEnvironment) environment: MpesaEnvironment;
  @ApiProperty() @IsString() @Matches(/^\d{5,7}$/) shortcode: string;
  @ApiPropertyOptional({ enum: ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'] }) @IsOptional() @IsIn(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']) transactionType?: string;
  @ApiPropertyOptional({ description: 'Till number (buy goods)' }) @IsOptional() @IsString() @Matches(/^\d{5,8}$/) partyB?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) apiBaseUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) callbackBaseUrl?: string;
  @ApiPropertyOptional({ description: 'Leave out to keep' }) @IsOptional() @IsString() @MaxLength(200) consumerKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) consumerSecret?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) passkey?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() rotateCallbackToken?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class StkPushDto {
  @ApiProperty() @IsUUID() terminalId: string;
  @ApiProperty({ example: '0712345678' }) @IsString() @MaxLength(20) phone: string;
  @ApiProperty() @IsNumber(MONEY) @Min(1) @Max(250_000) amount: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(12) accountRef?: string;
}

export class PosReportDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiProperty({ enum: ['cashier', 'shift', 'item', 'category', 'mode', 'hour'] }) @IsIn(['cashier', 'shift', 'item', 'category', 'mode', 'hour']) groupBy: 'cashier' | 'shift' | 'item' | 'category' | 'mode' | 'hour';
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class PosEventsQueryDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

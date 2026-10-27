import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PaymentMethod, PaymentVoucherStatus } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const MONEY = { maxDecimalPlaces: 2 } as const;

export class VoucherInvoiceDto {
  @ApiProperty() @IsUUID() invoiceId: string;
  @ApiPropertyOptional({ description: 'Settled against the invoice (incl. its WHT share); default: everything still to pay' }) @IsOptional() @IsNumber(MONEY) @Min(0.01) amount?: number;
}

export class CreateVoucherDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method: PaymentMethod;
  @ApiProperty({ type: [VoucherInvoiceDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VoucherInvoiceDto) invoices: VoucherInvoiceDto[];
  @ApiPropertyOptional({ description: 'B2C: payee mobile (07…, 01…, 2547…)' }) @IsOptional() @IsString() @MaxLength(20) payeePhone?: string;
  @ApiPropertyOptional({ description: 'B2B: PayBill or Till number' }) @IsOptional() @Matches(/^\d{5,7}$/) payeeShortcode?: string;
  @ApiPropertyOptional({ description: 'B2B PayBill: account number' }) @IsOptional() @IsString() @MaxLength(40) payeeAccountRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) payeeName?: string;
  @ApiPropertyOptional({ description: 'Scheduled payment date' }) @IsOptional() @IsDateString({ strict: true }) dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) narrative?: string;
}

export class ReleaseDto {
  @ApiPropertyOptional({ description: 'Bank / cheque reference (not for M-PESA)' }) @IsOptional() @IsString() @MaxLength(100) paymentReference?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) paidOn?: string;
}

export class ResolveDto {
  @ApiProperty({ enum: ['PAID', 'FAILED'] }) @IsIn(['PAID', 'FAILED']) outcome: 'PAID' | 'FAILED';
  @ApiPropertyOptional({ description: 'M-PESA receipt / bank reference (PAID)' }) @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) paidOn?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) note: string;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) reason: string;
}

export class VoucherQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentVoucherStatus }) @IsOptional() @IsEnum(PaymentVoucherStatus) status?: PaymentVoucherStatus;
  @ApiPropertyOptional({ description: 'Failed / needing review only' }) @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() review?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ enum: PaymentMethod }) @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
}

export class PayablesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
}

export class StatementImportDto {
  @ApiProperty({ description: 'M-PESA organisation statement export (CSV text): Receipt No., Completion Time, Details, Paid In, Withdrawn' })
  @IsString()
  @MinLength(10)
  @MaxLength(5_000_000)
  csv: string;
}

export class ReconcileDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
}

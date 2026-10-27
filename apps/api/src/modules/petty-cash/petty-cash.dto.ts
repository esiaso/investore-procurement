import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PaymentMethod, PettyCashKind, PettyCashStatus } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const MONEY = { maxDecimalPlaces: 2 } as const;

export class FloatDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9-]{2,30}$/) code: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(150) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) location?: string;
  @ApiProperty() @IsUUID() custodianId: string;
  @ApiProperty() @IsNumber(MONEY) @Min(1) floatLimit: number;
  @ApiProperty() @IsNumber(MONEY) @Min(1) perTransactionLimit: number;
  @ApiProperty() @IsNumber(MONEY) @Min(0) replenishThreshold: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() glAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mpesaEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{5,7}$/) mpesaShortcode?: string;
  @ApiPropertyOptional({ description: 'New floats: cash handed to the custodian (cash book OPENING)' }) @IsOptional() @IsNumber(MONEY) @Min(0) openingBalance?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PettyCashDto {
  @ApiProperty() @IsUUID() floatId: string;
  @ApiProperty({ enum: PettyCashKind }) @IsEnum(PettyCashKind) kind: PettyCashKind;
  @ApiProperty({ enum: ['STAFF', 'VENDOR'] }) @IsIn(['STAFF', 'VENDOR']) payeeType: 'STAFF' | 'VENDOR';
  @ApiPropertyOptional({ description: 'Staff payee (default: the requester)' }) @IsOptional() @IsUUID() payeeUserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ description: 'Vendor / payee name (staff: their name)' }) @IsOptional() @IsString() @MaxLength(200) payeeName?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) purpose: string;
  @ApiPropertyOptional({ description: 'Expense category (GL account)' }) @IsOptional() @IsUUID() glAccountId?: string;
  @ApiPropertyOptional({ description: 'Cost centre (default: your department)' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiProperty() @IsNumber(MONEY) @Min(1) amount: number;
  @ApiProperty({ enum: [PaymentMethod.CASH, PaymentMethod.MPESA_B2C, PaymentMethod.MPESA_PAYBILL, PaymentMethod.MPESA_TILL] }) @IsEnum(PaymentMethod) method: PaymentMethod;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) payeePhone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{5,7}$/) payeeShortcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) payeeAccountRef?: string;
  @ApiPropertyOptional({ description: 'Required when the same payee was paid the same amount recently' }) @IsOptional() @IsString() @MinLength(5) @MaxLength(500) duplicateJustification?: string;
  @ApiPropertyOptional({ description: 'Submit for approval straight away' }) @IsOptional() @IsBoolean() submit?: boolean;
}

export class DisburseDto {
  @ApiPropertyOptional({ description: 'Cash: who collected it (as signed)' }) @IsOptional() @IsString() @MaxLength(200) receivedByName?: string;
  @ApiPropertyOptional({ description: 'Cash voucher / receipt reference' }) @IsOptional() @IsString() @MaxLength(60) reference?: string;
}

export class RetirementLineDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(300) description: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) amount: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() glAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) receiptRef?: string;
}

export class RetirementDto {
  @ApiProperty({ type: [RetirementLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RetirementLineDto) lines: RetirementLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class VerifyRetirementDto {
  @ApiProperty() @IsBoolean() accept: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class ResolvePettyCashDto {
  @ApiProperty({ enum: ['PAID', 'FAILED'] }) @IsIn(['PAID', 'FAILED']) outcome: 'PAID' | 'FAILED';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) note: string;
}

export class PettyReasonDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(1000) reason: string;
}

export class ReplenishmentDto {
  @ApiProperty() @IsUUID() floatId: string;
  @ApiPropertyOptional({ description: 'Default: up to the float limit' }) @IsOptional() @IsNumber(MONEY) @Min(1) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ReceiveDto {
  @ApiProperty({ description: 'Cheque / transfer reference of the cash received' }) @IsString() @MinLength(2) @MaxLength(100) reference: string;
}

export class CountDto {
  @ApiProperty() @IsNumber(MONEY) @Min(0) counted: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class StatementQueryDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
}

export class PettyCashQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['mine', 'custodian', 'all'], description: 'mine (default), custodian (floats I hold), all (pettycash.manage)' }) @IsOptional() @IsIn(['mine', 'custodian', 'all']) scope?: 'mine' | 'custodian' | 'all';
  @ApiPropertyOptional({ enum: PettyCashStatus }) @IsOptional() @IsEnum(PettyCashStatus) status?: PettyCashStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() floatId?: string;
  @ApiPropertyOptional({ enum: PettyCashKind }) @IsOptional() @IsEnum(PettyCashKind) kind?: PettyCashKind;
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() review?: boolean;
}

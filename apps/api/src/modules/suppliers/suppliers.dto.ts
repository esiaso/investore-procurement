import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AgpoCategory, KRA_PIN_PATTERN, NationalAgency, PrequalificationStatus, SupplierStatus } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class SupplierContactDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) role?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @ValidateIf((o) => o.email !== null) @IsEmail() email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class CreateSupplierDto {
  @ApiPropertyOptional({ description: 'Auto-numbered when omitted' }) @IsOptional() @Transform(emptyToNull) @Matches(/^[A-Za-z0-9._/-]{1,40}$/) code?: string | null;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ example: 'P051234567X' }) @Transform(upper) @Matches(KRA_PIN_PATTERN, { message: 'KRA PIN looks like P051234567X' }) kraPin: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @ValidateIf((o) => o.email !== null) @IsEmail() email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @ApiPropertyOptional({ enum: PrequalificationStatus }) @IsOptional() @IsEnum(PrequalificationStatus) prequalificationStatus?: PrequalificationStatus;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) prequalifiedUntil?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) bankName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) bankBranch?: string | null;
  @ApiPropertyOptional({ description: 'Stored encrypted' }) @IsOptional() @Transform(emptyToNull) @Matches(/^[0-9 -]{5,34}$/) bankAccountNo?: string | null;
  @ApiPropertyOptional({ type: [SupplierContactDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SupplierContactDto)
  contacts?: SupplierContactDto[];
  @ApiPropertyOptional({ enum: NationalAgency, nullable: true, description: 'KEMSA / MEDS' }) @IsOptional() @Transform(emptyToNull) @IsEnum(NationalAgency) nationalAgency?: NationalAgency | null;
  @ApiPropertyOptional({ enum: AgpoCategory, nullable: true, description: 'Optional PPADA rule set' }) @IsOptional() @Transform(emptyToNull) @IsEnum(AgpoCategory) agpoCategory?: AgpoCategory | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) agpoCertificateNo?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) agpoValidUntil?: string | null;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class SupplierStatusDto {
  @ApiProperty({ enum: SupplierStatus }) @IsEnum(SupplierStatus) status: SupplierStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SupplierQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: SupplierStatus }) @IsOptional() @IsEnum(SupplierStatus) status?: SupplierStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
}

export class SupplierDocumentDto {
  @ApiProperty({ example: 'PPB_LICENCE' }) @Transform(upper) @Matches(/^[A-Z0-9_]{2,40}$/) documentType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) reference?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) issuedOn?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expiresOn?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

export class ContractPriceDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Per base unit, excl. VAT' }) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitPrice: number;
  @ApiProperty() @IsDateString({ strict: true }) validFrom: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) validTo?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) contractRef?: string | null;
}

export class ContractPriceQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional({ description: 'Only prices valid on this date' }) @IsOptional() @IsDateString({ strict: true }) on?: string;
}

import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ServicePoint, StoreType } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const CODE = /^[A-Za-z0-9._/-]{1,40}$/;
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class CreateFacilityDto {
  @ApiProperty() @IsString() @Matches(CODE) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @ValidateIf((o) => o.email !== null) @IsEmail() email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) kraPin?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateFacilityDto extends PartialType(CreateFacilityDto) {}

/** Hospital details (Organisation → Hospital details): the main facility and the e-mail sender. */
export class HospitalDetailsDto {
  @ApiProperty() @IsString() @MaxLength(200) @Matches(/\S/, { message: 'name is required' }) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @ValidateIf((o) => o.email !== null) @IsEmail() email?: string | null;
  @ApiPropertyOptional({ example: 'P051234567X' }) @IsOptional() @Transform(emptyToNull) @ValidateIf((o) => o.kraPin !== null) @Matches(/^[AP]\d{9}[A-Z]$/, { message: 'kraPin must look like P051234567X' }) kraPin?: string | null;
  @ApiProperty({ example: 'Procurement <procurement@hospital.org>', description: 'Sender of outgoing e-mail' })
  @IsString() @MaxLength(200) @Matches(/^([^<>@\r\n]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/, { message: 'mailFrom must be an e-mail address, or Name <address>' })
  mailFrom: string;
}

export class LogoDto {
  @ApiProperty({ description: 'data:image/png;base64,… or data:image/jpeg;base64,… (at most 500 KB)' }) @IsString() @MaxLength(700_000) dataUrl: string;
}

export class CreateStoreDto {
  @ApiProperty() @IsUUID() facilityId: string;
  @ApiProperty() @IsString() @Matches(CODE) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: StoreType }) @IsEnum(StoreType) type: StoreType;
  @ApiPropertyOptional({ enum: ServicePoint, nullable: true })
  @IsOptional() @Transform(emptyToNull) @IsEnum(ServicePoint) servicePoint?: ServicePoint | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(emptyToNull) @IsUUID() parentStoreId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateStoreDto extends PartialType(CreateStoreDto) {}

export class StoreQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: StoreType }) @IsOptional() @IsEnum(StoreType) type?: StoreType;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}

export class CreateBinDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsString() @Matches(CODE) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) zone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateBinDto extends PartialType(OmitType(CreateBinDto, ['storeId'] as const)) {}

export class BinQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}

export class CreateDepartmentDto {
  @ApiProperty() @IsUUID() facilityId: string;
  @ApiProperty() @IsString() @Matches(CODE) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsString() @Matches(CODE) costCentreCode: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { GlAccountType } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const bool = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : value === true || value === 'true');

export class GlAccountDto {
  @ApiProperty({ example: '6100' }) @IsString() @Matches(/^[A-Za-z0-9._-]{1,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: GlAccountType }) @IsEnum(GlAccountType) type: GlAccountType;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() parentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'QuickBooks account id' }) @IsOptional() @IsString() @MaxLength(40) qboAccountId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GlAccountQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: GlAccountType }) @IsOptional() @IsEnum(GlAccountType) type?: GlAccountType;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() active?: boolean;
}

export class ProjectDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9._-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() departmentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString({ strict: true }) startsOn?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString({ strict: true }) endsOn?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) budget?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CurrencyDto {
  @ApiProperty({ example: 'USD' }) @IsString() @Matches(/^[A-Z]{3}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ExchangeRateDto {
  @ApiProperty({ example: 'USD' }) @IsString() @Matches(/^[A-Z]{3}$/) currencyCode: string;
  @ApiProperty() @IsDateString({ strict: true }) rateDate: string;
  @ApiProperty({ description: 'Base-currency value of one unit (e.g. 129.45 KES per USD)' }) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) rate: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) source?: string;
}

export class RateQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) date?: string;
}

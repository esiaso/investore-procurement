import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ReportFormat, ReportFrequency, ReportPeriod } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

export class ScheduleDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ example: 'near-expiry' }) @IsString() @MaxLength(60) reportKey: string;
  @ApiPropertyOptional({ description: 'Fixed filters (store, category, groupBy…); the period comes from `period`' }) @IsOptional() @IsObject() filters: Record<string, unknown> = {};
  @ApiProperty({ enum: ReportPeriod }) @IsEnum(ReportPeriod) period: ReportPeriod;
  @ApiProperty({ enum: ReportFormat }) @IsEnum(ReportFormat) format: ReportFormat;
  @ApiProperty({ enum: ReportFrequency }) @IsEnum(ReportFrequency) frequency: ReportFrequency;
  @ApiProperty({ description: 'Local hour 0–23' }) @IsInt() @Min(0) @Max(23) hour: number;
  @ApiPropertyOptional({ description: 'Weekly: 1 Monday … 7 Sunday' }) @IsOptional() @IsInt() @Min(1) @Max(7) weekday?: number;
  @ApiPropertyOptional({ description: 'Monthly: day 1–28' }) @IsOptional() @IsInt() @Min(1) @Max(28) monthDay?: number;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsEmail({}, { each: true }) recipients: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

const bool = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : value === true || value === 'true');

export class DocumentQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) ownerType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
  @ApiPropertyOptional({ description: 'Latest versions only (default true)' }) @IsOptional() @Transform(bool) @IsBoolean() currentOnly?: boolean;
  @ApiPropertyOptional({ description: 'System-generated (certificates…) or uploaded' }) @IsOptional() @Transform(bool) @IsBoolean() generated?: boolean;
}

export class ExpiringQueryDto {
  @ApiPropertyOptional({ default: 60 }) @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(0) @Max(3650) days?: number;
}

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { TaxTreatment } from '@sil/shared';

export class CreateTaxCategoryDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9._/-]{1,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: TaxTreatment }) @IsEnum(TaxTreatment) treatment: TaxTreatment;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateTaxCategoryDto extends PartialType(CreateTaxCategoryDto) {}

export class CreateTaxRateDto {
  @ApiProperty() @IsUUID() taxCategoryId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) ratePercent: number;
  @ApiProperty({ example: '2026-01-01' }) @IsDateString({ strict: true }) effectiveFrom: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString({ strict: true }) effectiveTo?: string | null;
}

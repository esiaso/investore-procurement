import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateNumberingSchemeDto {
  @ApiProperty({ example: 'PO' }) @IsString() @Matches(/^[A-Z0-9_]{1,20}$/) documentType: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() storeId?: string | null;
  @ApiProperty({ example: 'PO' }) @IsString() @MaxLength(20) prefix: string;
  @ApiProperty({ example: '{PREFIX}/{STORE}/{FY}/{SEQ}' }) @IsString() @MaxLength(100) format: string;
  @ApiProperty({ example: 5 }) @IsInt() @Min(1) @Max(12) padding: number;
  @ApiProperty() @IsBoolean() resetEachYear: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateNumberingSchemeDto extends PartialType(
  OmitType(CreateNumberingSchemeDto, ['documentType', 'storeId'] as const),
) {}
